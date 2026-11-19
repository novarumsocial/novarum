import type { Server } from 'elysia/universal';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { channelMembers, channels, db, users } from '../../src/db';
import { getConfig } from '../../utils/config';
import { discoverRemoteAnchor, postSignedFederationJson } from '../../utils/discovery';
import { remoteSupports } from '../../utils/federationFeatures';
import { makeFederatedChannelId, parseFederatedChannelId } from '../../utils/federationIds';
import {
  federationUserPayload,
  federationUserSchema,
  fetchFederatedUser,
  upsertFederatedUser,
} from '../../utils/federationPayload';
import { ensureFederatedDmRealtimeBridge } from '../../utils/federationRealtime';
import { messagePayload } from '../../utils/messagePayload';
import { publishRealtime, publishToChannel } from '../../utils/publishRealtime';
import { randomString } from '../../utils/randomString';
import { rateLimiter } from '../../utils/rateLimit';
import { systemTarget, type SystemMessage } from '../../utils/systemMessage';
import { consumeGrant } from '../bots/membership';
import { findFriendship } from '../friends/model';
import { createMessage } from '../message/store';
import { stopFollowingDm } from '../federation/routes/realtime';
import { dmResponse } from './services';

// Group DMs. The homeserver of whoever created a group hosts it: it keeps the members, owner,
// name, icon and messages, and decides every change. After each change it pushes the whole
// state to the homeservers of the members (/federation/dms/sync), which keep a "shadow" copy so
// the group shows up for their users, the same way they do for 1:1 DMs.

type User = typeof users.$inferSelect;
type Group = typeof channels.$inferSelect;
type Member = Awaited<ReturnType<typeof membersOf>>[number];
type Failure = { ok: false; status: 400 | 403 | 404 | 409 | 429 | 502; error: string };
export type GroupResult = { ok: true } | Failure;

const fail = (status: Failure['status'], error: string): Failure => ({ ok: false, status, error });
const ours = (homeserver: string) =>
  homeserver.toLowerCase() === getConfig().server.homeserver.toLowerCase();
export const maxGroupMembers = () => getConfig().dms.max_group_members;

// creating groups and adding people to them notifies (and federates to) everyone involved
export const allowGroupChange = rateLimiter(20);

export const userRefSchema = z.object({
  username: z.string().min(1).max(64),
  homeserver: z.string().min(1).max(255),
});
export type UserRef = z.infer<typeof userRefSchema>;
export const userRef = (user: UserRef): UserRef => ({
  username: user.username,
  homeserver: user.homeserver.toLowerCase(),
});

export function membersOf(groupId: string) {
  return db.query.channelMembers.findMany({
    where: { channelId: groupId },
    with: { user: true },
    orderBy: { joinedAt: 'asc' },
  });
}

/** The group as `viewerId` sees it in their DM list: everyone but them is a participant. */
export function groupView(group: Group, members: Member[], viewerId: string) {
  const viewer = members.find((member) => member.userId === viewerId);
  return dmResponse(
    group,
    viewer?.joinedAt ?? new Date(),
    members.filter((member) => member.userId !== viewerId).map((member) => member.user)
  );
}

/** Our own user, or our copy of a remote one (fetching it from its homeserver the first time). */
export async function resolveUserRef(ref: UserRef) {
  if (ours(ref.homeserver)) {
    return db.query.users.findFirst({
      where: { username: ref.username, homeserver: getConfig().server.homeserver },
    });
  }
  const [known] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.username, ref.username),
        sql`lower(${users.homeserver}) = ${ref.homeserver.toLowerCase()}`
      )
    )
    .limit(1);
  if (known) return known;
  const fetched = await fetchFederatedUser(ref.homeserver, ref.username).catch(() => null);
  return fetched ? upsertFederatedUser(fetched) : undefined;
}

// ---- telling people about changes ---------------------------------------------------------------

/** Sends our own members the group as each of them sees it. */
function announce(
  server: Server | null,
  group: Group,
  members: Member[],
  change: { created?: string[]; removed?: string[] } = {}
) {
  if (!server) return;
  for (const member of members) {
    if (!ours(member.user.homeserver)) continue;
    const view = groupView(group, members, member.userId);
    publishRealtime(
      server,
      `userEvents:${member.userId}`,
      change.created?.includes(member.userId)
        ? { type: 'dm.created', data: view }
        : {
            type: 'dm.updated',
            data: {
              id: view.id,
              name: view.name,
              iconUrl: view.iconUrl,
              ownerId: view.ownerId,
              participants: view.participants,
            },
          }
    );
  }
  for (const userId of change.removed ?? []) {
    publishRealtime(server, `userEvents:${userId}`, { type: 'dm.removed', data: { id: group.id } });
  }
}

/** Writes a system message like "Ana added Leo", sent like any other message. */
export async function postSystemMessage(
  server: Server | null,
  group: { id: string; guildId: string | null },
  author: User,
  system: SystemMessage
) {
  const message = await createMessage({
    channel: group,
    authorId: author.id,
    content: null,
    replyTo: null,
    nonce: `system:${randomString()}`,
    pingRecipients: [],
    attachments: [],
    system,
  });
  if (server) {
    await publishToChannel(server, group, {
      type: 'message.created',
      data: messagePayload({ ...message, attachments: [] }, group, author),
    });
  }
  return message;
}

type Added = { user: User; by: User; grant?: string };

/**
 * Pushes the group's state to the homeservers of its members, and of `gone` (homeservers that just
 * lost members, so they drop them). Each homeserver checks the people of theirs in `added`: they
 * must be friends with whoever added them (or, for a bot, be allowed to join). Returns the ids of
 * the added users whose homeserver refused, or couldn't be reached.
 */
async function pushState(groupId: string, added: Added[] = [], gone: string[] = []) {
  const group = await db.query.channels.findFirst({ where: { id: groupId } });
  const members = group ? await membersOf(groupId) : [];
  const owner = members.find((member) => member.userId === group?.ownerId)?.user;
  const homeservers = new Set(
    [...members.map((member) => member.user.homeserver), ...gone]
      .map((homeserver) => homeserver.toLowerCase())
      .filter((homeserver) => !ours(homeserver))
  );

  const refused = new Set<string>();
  await Promise.all(
    [...homeservers].map(async (homeserver) => {
      const theirs = added.filter((a) => a.user.homeserver.toLowerCase() === homeserver);
      const remote = await discoverRemoteAnchor(homeserver).catch(() => null);
      const result =
        remote && remoteSupports(remote, 'group-dms')
          ? await postSignedFederationJson(homeserver, '/federation/dms/sync', {
              channelId: groupId,
              name: group?.name ?? '',
              iconUrl: group?.iconUrl ?? null,
              owner: owner ? federationUserPayload({ user: owner }) : null,
              participants: members.map((member) => federationUserPayload(member)),
              added: theirs.map((a) => ({
                user: userRef(a.user),
                by: federationUserPayload({ user: a.by }),
                grant: a.grant,
              })),
            }).catch(() => null)
          : null;
      if (!result?.response.ok) for (const a of theirs) refused.add(a.user.id);
      if (!members.some((member) => member.user.homeserver.toLowerCase() === homeserver)) {
        stopFollowingDm(groupId, homeserver);
      }
    })
  );
  return refused;
}

/** Adds `targets` to the group, taking out again the ones their own homeserver refused. */
async function addMembers(group: Group, by: User, targets: User[], grant?: string) {
  if (!targets.length) return [];
  await db
    .insert(channelMembers)
    .values(targets.map((user) => ({ channelId: group.id, userId: user.id })))
    .onConflictDoNothing();

  const refused = await pushState(
    group.id,
    targets.filter((user) => !ours(user.homeserver)).map((user) => ({ user, by, grant }))
  );
  if (refused.size) {
    await db
      .delete(channelMembers)
      .where(
        and(eq(channelMembers.channelId, group.id), inArray(channelMembers.userId, [...refused]))
      );
    await pushState(
      group.id,
      [],
      targets.filter((user) => refused.has(user.id)).map((user) => user.homeserver)
    );
  }
  return targets.filter((user) => !refused.has(user.id));
}

// ---- what the host does -------------------------------------------------------------------------

// friendships between two users of other homeservers aren't stored here, so for those the
// homeserver of the added user checks instead, when the new state is pushed to it
async function checkFriends(actor: User, targets: User[]) {
  for (const target of targets) {
    if (!ours(actor.homeserver) && !ours(target.homeserver)) continue;
    const friendship = await findFriendship(actor.id, target.id);
    if (friendship?.status !== 'ACCEPTED') return false;
  }
  return true;
}

function checkTargets(actor: User, targets: User[]): Failure | null {
  if (targets.some((user) => user.isBot)) return fail(400, 'Add bots from the group settings');
  if (targets.some((user) => user.id === actor.id)) return fail(400, 'You are already in it');
  return null;
}

/** `creator` (one of our users) starts a group with `targets`, all of them their friends. */
export async function hostCreateGroup(
  server: Server | null,
  creator: User,
  targets: User[],
  name: string
): Promise<Failure | { ok: true; dm: ReturnType<typeof groupView> }> {
  if (!allowGroupChange(creator.id)) return fail(429, 'Too many changes, try again later');
  const unique = [...new Map(targets.map((user) => [user.id, user])).values()];
  const invalid = checkTargets(creator, unique);
  if (invalid) return invalid;
  if (unique.length + 1 > maxGroupMembers()) {
    return fail(400, `A group can have at most ${maxGroupMembers()} members`);
  }
  if (!(await checkFriends(creator, unique))) return fail(403, 'You can only add your friends');

  const [group] = await db
    .insert(channels)
    .values({
      id: randomString(),
      guildId: null,
      name: name.trim(),
      type: 'GROUP_DM',
      ownerId: creator.id,
    })
    .returning();
  if (!group) throw new Error('Could not create group DM');
  await db.insert(channelMembers).values({ channelId: group.id, userId: creator.id });

  await postSystemMessage(server, group, creator, { type: 'group.created' });
  await addMembers(group, creator, unique);

  const members = await membersOf(group.id);
  announce(server, group, members, { created: members.map((member) => member.userId) });
  return { ok: true, dm: groupView(group, members, creator.id) };
}

/** Any member adds friends of theirs. */
export async function hostAddMembers(
  server: Server | null,
  group: Group,
  actor: User,
  targets: User[]
): Promise<GroupResult> {
  if (!allowGroupChange(actor.id)) return fail(429, 'Too many changes, try again later');
  const members = await membersOf(group.id);
  const fresh = [...new Map(targets.map((user) => [user.id, user])).values()].filter(
    (user) => !members.some((member) => member.userId === user.id)
  );
  if (!fresh.length) return fail(409, 'They are already in the group');
  const invalid = checkTargets(actor, fresh);
  if (invalid) return invalid;
  if (members.length + fresh.length > maxGroupMembers()) {
    return fail(400, `A group can have at most ${maxGroupMembers()} members`);
  }
  if (!(await checkFriends(actor, fresh))) return fail(403, 'You can only add your friends');

  const added = await addMembers(group, actor, fresh);
  if (!added.length) return fail(403, "Their homeserver didn't let them join");

  await postSystemMessage(server, group, actor, {
    type: 'member.added',
    targets: added.map(systemTarget),
  });
  announce(server, group, await membersOf(group.id), { created: added.map((user) => user.id) });
  return { ok: true };
}

/**
 * The owner adds a bot. Ours must be public or theirs; a remote bot's homeserver decides the
 * same, with `grant` standing for its owner's say (see createGrant in modules/bots/membership.ts).
 */
export async function hostAddBot(
  server: Server | null,
  group: Group,
  actor: User,
  ref: UserRef,
  grant?: string
): Promise<GroupResult> {
  if (group.ownerId !== actor.id) return fail(403, 'Only the group owner can add bots');
  const bot = await resolveUserRef(userRef(ref));
  if (!bot?.isBot) return fail(404, 'Bot not found');
  if (ours(bot.homeserver)) {
    const row = await db.query.bots.findFirst({ where: { userId: bot.id } });
    if (!row) return fail(404, 'Bot not found');
    if (!row.public && row.ownerId !== actor.id) return fail(403, 'This bot is private');
  }
  const members = await membersOf(group.id);
  if (members.some((member) => member.userId === bot.id)) {
    return fail(409, 'This bot is already in the group');
  }
  if (members.length + 1 > maxGroupMembers()) {
    return fail(400, `A group can have at most ${maxGroupMembers()} members`);
  }
  const added = await addMembers(group, actor, [bot], grant);
  if (!added.length) return fail(403, "The bot's homeserver didn't let it join");

  await postSystemMessage(server, group, actor, {
    type: 'bot.added',
    targets: [systemTarget(bot)],
  });
  announce(server, group, await membersOf(group.id), { created: [bot.id] });
  return { ok: true };
}

/** The owner removes someone, or a bot. */
export async function hostRemoveMember(
  server: Server | null,
  group: Group,
  actor: User,
  target: User
): Promise<GroupResult> {
  if (group.ownerId !== actor.id) return fail(403, 'Only the group owner can remove members');
  if (target.id === actor.id) return fail(400, 'Leave the group instead');
  const [removed] = await db
    .delete(channelMembers)
    .where(and(eq(channelMembers.channelId, group.id), eq(channelMembers.userId, target.id)))
    .returning();
  if (!removed) return fail(404, 'Member not found');

  await postSystemMessage(server, group, actor, {
    type: target.isBot ? 'bot.removed' : 'member.removed',
    targets: [systemTarget(target)],
  });
  await pushState(group.id, [], [target.homeserver]);
  announce(server, group, await membersOf(group.id), {
    removed: ours(target.homeserver) ? [target.id] : [],
  });
  return { ok: true };
}

/** A member leaves. The oldest member left takes over a leaving owner; without people left, the group goes. */
export async function hostLeave(
  server: Server | null,
  group: Group,
  user: User
): Promise<GroupResult> {
  const before = await membersOf(group.id);
  if (!before.some((member) => member.userId === user.id)) return fail(404, 'DM not found');
  const remaining = before.filter((member) => member.userId !== user.id);
  const people = remaining.filter((member) => !member.user.isBot);
  const localIds = (list: Member[]) =>
    list.filter((member) => ours(member.user.homeserver)).map((member) => member.userId);

  if (!people.length) {
    await db.delete(channels).where(eq(channels.id, group.id));
    await pushState(
      group.id,
      [],
      before.map((member) => member.user.homeserver)
    );
    announce(server, group, [], { removed: localIds(before) });
    return { ok: true };
  }

  await db
    .delete(channelMembers)
    .where(and(eq(channelMembers.channelId, group.id), eq(channelMembers.userId, user.id)));
  let updated = group;
  if (group.ownerId === user.id) {
    [updated = group] = await db
      .update(channels)
      .set({ ownerId: people[0]!.userId })
      .where(eq(channels.id, group.id))
      .returning();
  }

  await postSystemMessage(server, group, user, { type: 'member.left' });
  await pushState(group.id, [], [user.homeserver]);
  announce(server, updated, remaining, { removed: ours(user.homeserver) ? [user.id] : [] });
  return { ok: true };
}

/** `user` (one of ours) leaves a group, here or on its host. */
export async function leaveGroup(server: Server | null, user: User, groupId: string) {
  const federated = parseFederatedChannelId(groupId);
  if (!federated) {
    const group = await db.query.channels.findFirst({ where: { id: groupId } });
    return group ? hostLeave(server, group, user) : fail(404, 'DM not found');
  }
  const result = await postSignedFederationJson(
    federated.homeserver,
    `/federation/dms/${encodeURIComponent(federated.id)}/leave`,
    { user: federationUserPayload({ user }) }
  ).catch(() => null);
  return result?.response.ok ? { ok: true as const } : fail(502, 'Could not reach the host');
}

/** The owner renames the group or changes its icon. */
export async function hostUpdateGroup(
  server: Server | null,
  group: Group,
  actor: User,
  change: { name?: string; iconUrl?: string | null }
): Promise<GroupResult> {
  if (group.ownerId !== actor.id) return fail(403, 'Only the group owner can change the group');
  const name = change.name?.trim();
  const [updated] = await db
    .update(channels)
    .set({ name, iconUrl: change.iconUrl })
    .where(eq(channels.id, group.id))
    .returning();
  if (!updated) return fail(404, 'DM not found');

  if (name !== undefined && name !== group.name) {
    await postSystemMessage(server, group, actor, { type: 'group.renamed', name });
  }
  if (change.iconUrl !== undefined && change.iconUrl !== group.iconUrl) {
    await postSystemMessage(server, group, actor, { type: 'group.icon' });
  }
  await pushState(group.id);
  announce(server, updated, await membersOf(group.id));
  return { ok: true };
}

/** The owner hands the group over to another (human) member. */
export async function hostTransferOwner(
  server: Server | null,
  group: Group,
  actor: User,
  target: User
): Promise<GroupResult> {
  if (group.ownerId !== actor.id) return fail(403, 'Only the group owner can transfer it');
  const members = await membersOf(group.id);
  if (!members.some((member) => member.userId === target.id)) {
    return fail(404, 'Member not found');
  }
  if (target.isBot || target.id === actor.id) return fail(400, 'Choose another person');

  const [updated] = await db
    .update(channels)
    .set({ ownerId: target.id })
    .where(eq(channels.id, group.id))
    .returning();
  if (!updated) return fail(404, 'DM not found');

  await postSystemMessage(server, group, actor, {
    type: 'owner.changed',
    targets: [systemTarget(target)],
  });
  await pushState(group.id);
  announce(server, updated, members);
  return { ok: true };
}

// ---- keeping our shadow copy of a group hosted elsewhere ----------------------------------------

export const groupSyncSchema = z.object({
  channelId: z.string().min(1).max(64),
  name: z.string().max(100),
  iconUrl: z.url().nullable(),
  owner: federationUserSchema.nullable(),
  // the host caps its own groups; this only stops a hostile one from sending huge lists
  participants: z.array(federationUserSchema).max(500),
  added: z
    .array(
      z.object({ user: userRefSchema, by: federationUserSchema, grant: z.string().optional() })
    )
    .max(500)
    .default([]),
});

// one of our bots joins a group hosted elsewhere when it is public, or its owner asked for it
async function botMayJoin(bot: User, host: string, groupId: string, grant?: string) {
  const row = await db.query.bots.findFirst({ where: { userId: bot.id } });
  return !!row && (row.public || consumeGrant(grant, bot.id, host, groupId));
}

// a host may tell us about remote users we don't know yet. For users of its own homeserver it is
// the authority; for third homeservers, it can only create our first copy, not change one we have.
async function ensureParticipant(user: z.infer<typeof federationUserSchema>, origin: string) {
  const ref = userRef(user);
  if (ours(ref.homeserver)) return resolveUserRef(ref);
  if (ref.homeserver === origin) return upsertFederatedUser(user);
  const [known] = await db
    .select()
    .from(users)
    .where(
      and(eq(users.username, ref.username), sql`lower(${users.homeserver}) = ${ref.homeserver}`)
    )
    .limit(1);
  return known ?? upsertFederatedUser(user);
}

/** On a member's homeserver: the host pushed the group's state. */
export async function acceptGroupSync(
  server: Server | null,
  origin: string,
  sync: z.infer<typeof groupSyncSchema>
): Promise<GroupResult> {
  // the id is rebuilt from the sender, so a homeserver can only push the groups it hosts
  const shadowId = makeFederatedChannelId(origin, sync.channelId);
  const existing = await db.query.channels.findFirst({ where: { id: shadowId } });
  if (existing && existing.type !== 'GROUP_DM') return fail(409, 'This is not a group DM');
  const before = existing ? await membersOf(shadowId) : [];

  const participants = (
    await Promise.all(sync.participants.map((user) => ensureParticipant(user, origin)))
  ).filter((user) => user !== undefined);
  const local = participants.filter((user) => ours(user.homeserver));

  // nobody of ours joins a group without a friend (or, for bots, its own say) letting them
  for (const user of local) {
    if (before.some((member) => member.userId === user.id)) continue;
    const added = sync.added.find(
      (a) => a.user.username === user.username && ours(a.user.homeserver)
    );
    if (!added) return fail(403, `${user.username} was not added by anyone`);
    // whoever added them is in the group, and if they are one of ours, they already were here
    const byRef = userRef(added.by);
    const by = participants.find(
      (p) => p.username === byRef.username && p.homeserver.toLowerCase() === byRef.homeserver
    );
    if (!by || (ours(by.homeserver) && !before.some((member) => member.userId === by.id))) {
      return fail(403, `${user.username} can't be added to this group`);
    }
    const allowed = user.isBot
      ? await botMayJoin(user, origin, sync.channelId, added.grant)
      : (await findFriendship(user.id, by.id))?.status === 'ACCEPTED';
    if (!allowed) return fail(403, `${user.username} can't be added to this group`);
  }

  const removed = before.filter(
    (member) => ours(member.user.homeserver) && !local.some((user) => user.id === member.userId)
  );
  if (!local.length) {
    if (existing) await db.delete(channels).where(eq(channels.id, shadowId));
    if (existing) announce(server, existing, [], { removed: removed.map((m) => m.userId) });
    return { ok: true };
  }

  const owner = sync.owner ? await ensureParticipant(sync.owner, origin) : undefined;
  const values = {
    name: sync.name,
    iconUrl: sync.iconUrl,
    ownerId: owner && participants.some((user) => user.id === owner.id) ? owner.id : null,
  };
  const [group] = await db
    .insert(channels)
    .values({ id: shadowId, guildId: null, type: 'GROUP_DM', ...values })
    .onConflictDoUpdate({ target: channels.id, set: values })
    .returning();
  if (!group) throw new Error('Could not save group DM');

  const ids = participants.map((user) => user.id);
  await db.delete(channelMembers).where(
    and(
      eq(channelMembers.channelId, shadowId),
      sql`${channelMembers.userId} NOT IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    )
  );
  await db
    .insert(channelMembers)
    .values(ids.map((userId) => ({ channelId: shadowId, userId })))
    .onConflictDoNothing();

  const members = await membersOf(shadowId);
  announce(server, group, members, {
    created: local
      .filter((user) => !before.some((member) => member.userId === user.id))
      .map((user) => user.id),
    removed: removed.map((member) => member.userId),
  });
  if (server) void ensureFederatedDmRealtimeBridge(server, shadowId).catch(() => null);
  return { ok: true };
}
