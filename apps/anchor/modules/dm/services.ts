import Elysia, { t } from 'elysia';
import { z } from 'zod';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { randomString } from '../../utils/randomString';
import { db, attachments, channels, channelMembers, messages, users } from '../../src/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { publicUser } from '../../utils/publicUser';
import { findFriendship, friendAuthority } from '../friends/model';
import { isMessageAfter } from '../../utils/messageCursor';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import {
  dmLastMessageSchema,
  dmLatestResponseSchema,
  dmOpenResponseSchema,
  dmResponseSchema,
} from '../../src/db/zod';
import { getConfig } from '../../utils/config';
import { postSignedFederationJson } from '../../utils/discovery';
import { federationUserPayload, upsertFederatedUser } from '../../utils/federationPayload';
import { makeFederatedChannelId, parseFederatedChannelId } from '../../utils/federationIds';
import { publishRealtime } from '../../utils/publishRealtime';
import { ensureFederatedDmRealtimeBridge } from '../../utils/federationRealtime';
import { callRemote, passThrough } from '../../utils/federationClient';
import { processImage } from '../../utils/optimizeWebp';
import { noStoreRedirect, publicPresign, storage } from '../../utils/services/storage';
import { okResponseSchema } from '../federation/schemas';
import { createGrant } from '../bots/membership';
import {
  hostAddBot,
  hostAddMembers,
  hostCreateGroup,
  hostLeave,
  hostRemoveMember,
  hostTransferOwner,
  hostUpdateGroup,
  userRef,
  type GroupResult,
} from './groups';
import { messagePreview } from '../../utils/messagePreview';

const successResponseSchema = z.object({ success: z.boolean() });
const dmListResponseSchema = z.object({ dms: z.array(dmResponseSchema) });
const maxIconSize = getConfig().files.max_avatar_size * 1024 * 1024;
const groupErrors = {
  400: genericResponseErrorSchema,
  401: genericResponseErrorSchema,
  403: genericResponseErrorSchema,
  404: genericResponseErrorSchema,
  409: genericResponseErrorSchema,
  429: genericResponseErrorSchema,
  502: genericResponseErrorSchema,
};

type Session = NonNullable<Awaited<ReturnType<typeof validateSessionToken>>>;
type Group = typeof channels.$inferSelect;

// runs a group change here when we host the group, or asks its host to (as `session`'s user)
async function onGroup(
  session: Session,
  id: string,
  local: (group: Group, actor: Session['user']) => Promise<GroupResult>,
  remote: { action: string; body?: Record<string, unknown> }
): Promise<GroupResult> {
  const membership = await db.query.channelMembers.findFirst({
    where: { channelId: id, userId: session.userId },
    with: { channel: true },
  });
  if (membership?.channel.type !== 'GROUP_DM')
    return { ok: false, status: 404, error: 'DM not found' };

  const federated = parseFederatedChannelId(id);
  if (!federated) return local(membership.channel, session.user);
  const result = await callRemote(
    federated.homeserver,
    `/federation/dms/${encodeURIComponent(federated.id)}/${remote.action}`,
    session,
    remote.body ?? {},
    {
      response: okResponseSchema,
      forward: passThrough(400, 403, 404, 409, 429),
      errors: { failed: 'The group could not be changed', invalid: 'Invalid answer from the host' },
    }
  );
  return result.ok ? { ok: true } : { ok: false, status: result.status, error: result.error.error };
}

// the users behind `userIds`, which must all be friends of `session`'s user
async function friendsById(session: Session, userIds: string[]) {
  const targets = await db.query.users.findMany({ where: { id: { in: userIds } } });
  if (targets.length !== new Set(userIds).size) return null;
  for (const target of targets) {
    if ((await findFriendship(session.userId, target.id))?.status !== 'ACCEPTED') return null;
  }
  return targets;
}

const memberById = async (groupId: string, userId: string) =>
  (
    await db.query.channelMembers.findFirst({
      where: { channelId: groupId, userId },
      with: { user: true },
    })
  )?.user;

export const dm = new Elysia({ prefix: '/dm', tags: ['DM'] })
  .get(
    '/icon/:key',
    ({ params, status }) => {
      if (!/^[A-Za-z0-9]+$/.test(params.key)) return status(404, { error: 'Icon not found' });
      return noStoreRedirect(
        publicPresign(`dm-icons/${params.key}.webp`, {
          method: 'GET',
          expiresIn: 5 * 60,
          type: 'image/webp',
          contentDisposition: 'inline',
        })
      );
    },
    { response: { 302: t.Void(), 404: genericResponseErrorSchema } }
  )
  .resolve(async ({ cookie, status }) => {
    const session = await validateSessionToken(
      cookie[sessionCookieName]?.value as string | undefined
    );
    if (!session) return status(401, { error: 'Unauthorized' });
    return { session };
  })
  .get(
    '/',
    async ({ session, server }) => {
      const dmMemberships = await dmMembershipsOf(session.userId);
      const open = dmMemberships.filter((m) => !m.closed);

      // DMs hosted on other homeservers need a remote round trip for their latest message,
      // so the client fetches those per homeserver instead of waiting on the slowest one here.
      const pending = [
        ...new Set(open.flatMap((m) => parseFederatedChannelId(m.channelId)?.homeserver ?? [])),
      ];
      const dms = await buildDms(
        session,
        open.filter((m) => !parseFederatedChannelId(m.channelId))
      );

      // closed DMs still need their bridge, or a new message could never reopen them.
      if (server) {
        for (const { channel } of dmMemberships) {
          if (parseFederatedChannelId(channel.id)) {
            void ensureFederatedDmRealtimeBridge(server, channel.id).catch(() => null);
          }
        }
      }

      return { dms, pending };
    },
    {
      response: {
        200: dmListResponseSchema.extend({ pending: z.array(z.string()) }),
        401: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/homeserver/:homeserver',
    async ({ session, params }) => {
      const open = (await dmMembershipsOf(session.userId)).filter(
        (m) => !m.closed && parseFederatedChannelId(m.channelId)?.homeserver === params.homeserver
      );
      return { dms: await buildDms(session, open, params.homeserver) };
    },
    {
      response: {
        200: dmListResponseSchema,
        401: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/',
    async ({ body, session, server, status }) => {
      const target = await db.query.users.findFirst({ where: { id: body.userId } });
      if (!target || target.isBot || target.id === session.userId) {
        return status(404, { error: 'User not found' });
      }

      const friendship = await findFriendship(session.userId, target.id);
      if (friendship?.status !== 'ACCEPTED') {
        return status(403, { error: 'You must be friends to start a DM' });
      }

      const localHomeserver = getConfig().server.homeserver;
      const isRemote = target.homeserver.toLowerCase() !== localHomeserver.toLowerCase();
      const isHost =
        !isRemote ||
        friendAuthority(localHomeserver, target.homeserver) === localHomeserver.toLowerCase();

      if (isHost) {
        const { channel, joinedAt, created } = await openLocalDm(session.userId, target.id);

        // this side is authoritative for the DM; if the other participant is remote, give their
        // homeserver a heads up so it shows up for them too (every time, in case a notify failed).
        if (isRemote) {
          void postSignedFederationJson(target.homeserver, '/federation/dms/notify', {
            channelId: channel.id,
            participants: [federationUserPayload(session), federationUserPayload({ user: target })],
          }).catch(() => null);
        } else if (created && server) {
          publishRealtime(server, `userEvents:${target.id}`, {
            type: 'dm.created',
            data: dmResponse(channel, joinedAt, [session.user]),
          });
        }

        return dmResponse(channel, joinedAt, [target]);
      }

      const result = await postSignedFederationJson(target.homeserver, '/federation/dms/open', {
        user: federationUserPayload(session),
        peerUsername: target.username,
      }).catch(() => null);
      if (!result) return status(502, { error: 'Could not reach remote homeserver' });
      if (!result.response.ok) {
        return status(result.response.status === 404 ? 404 : 502, {
          error: 'Could not open the remote DM',
        });
      }

      const opened = dmOpenResponseSchema.safeParse(result.data);
      if (!opened.success)
        return status(502, { error: 'Remote homeserver returned an invalid DM' });

      const refreshed = await Promise.all(
        opened.data.participants
          .filter((p) => p.homeserver.toLowerCase() !== localHomeserver.toLowerCase())
          .map(upsertFederatedUser)
      );

      const shadowId = makeFederatedChannelId(target.homeserver, opened.data.id);
      const membership = await upsertDmShadow(shadowId, session.userId, [
        session.userId,
        ...refreshed.map((user) => user.id),
      ]);
      if (server) void ensureFederatedDmRealtimeBridge(server, shadowId).catch(() => null);

      return dmResponse({ id: shadowId, type: 'DM' }, membership.joinedAt, [
        refreshed[0] ?? target,
      ]);
    },
    {
      body: t.Object({ userId: t.String() }),
      response: {
        200: dmResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        502: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/group',
    async ({ body, session, server, status }) => {
      const targets = await friendsById(session, body.userIds);
      if (!targets) return status(403, { error: 'You can only add your friends' });
      const result = await hostCreateGroup(server, session.user, targets, body.name ?? '');
      return result.ok ? result.dm : status(result.status, { error: result.error });
    },
    {
      body: t.Object({
        userIds: t.Array(t.String(), { minItems: 1, maxItems: 100 }),
        name: t.Optional(t.String({ maxLength: 100 })),
      }),
      response: { 200: dmResponseSchema, ...groupErrors },
    }
  )
  .patch(
    '/:id',
    async ({ params, body, session, server, status }) => {
      const result = await onGroup(
        session,
        params.id,
        (group, actor) => hostUpdateGroup(server, group, actor, body),
        { action: 'update', body }
      );
      return result.ok ? { ok: true } : status(result.status, { error: result.error });
    },
    {
      body: t.Object({ name: t.String({ maxLength: 100 }) }),
      response: { 200: okResponseSchema, ...groupErrors },
    }
  )
  // the icon is stored here, on the owner's homeserver, and the host only keeps its url
  .post(
    '/:id/icon',
    async ({ params, body, session, server, status }) => {
      const membership = await db.query.channelMembers.findFirst({
        where: { channelId: params.id, userId: session.userId },
        with: { channel: true },
      });
      if (membership?.channel.type !== 'GROUP_DM') return status(404, { error: 'DM not found' });
      if (membership.channel.ownerId !== session.userId) {
        return status(403, { error: 'Only the group owner can change the group' });
      }
      if (body.icon.type !== 'image/png' && body.icon.type !== 'image/gif') {
        return status(415, { error: 'Group icon must be a PNG or GIF image' });
      }
      if (body.icon.size > maxIconSize) return status(413, { error: 'Group icon is too large' });

      const key = randomString();
      const image = await processImage(await body.icon.arrayBuffer());
      await storage.write(`dm-icons/${key}.webp`, image.data, { type: 'image/webp' });
      const iconUrl = new URL(`/dm/icon/${key}`, getConfig().server.base_url).toString();

      const result = await onGroup(
        session,
        params.id,
        (group, actor) => hostUpdateGroup(server, group, actor, { iconUrl }),
        { action: 'update', body: { iconUrl } }
      );
      return result.ok ? { iconUrl } : status(result.status, { error: result.error });
    },
    {
      body: t.Object({ icon: t.File({ maxSize: maxIconSize }) }),
      response: {
        200: z.object({ iconUrl: z.url() }),
        ...groupErrors,
        413: genericResponseErrorSchema,
        415: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/:id/members',
    async ({ params, body, session, server, status }) => {
      const targets = await friendsById(session, body.userIds);
      if (!targets) return status(403, { error: 'You can only add your friends' });
      const result = await onGroup(
        session,
        params.id,
        (group, actor) => hostAddMembers(server, group, actor, targets),
        { action: 'members', body: { users: targets.map(userRef) } }
      );
      return result.ok ? { ok: true } : status(result.status, { error: result.error });
    },
    {
      body: t.Object({ userIds: t.Array(t.String(), { minItems: 1, maxItems: 100 }) }),
      response: { 200: okResponseSchema, ...groupErrors },
    }
  )
  .delete(
    '/:id/members/:userId',
    async ({ params, session, server, status }) => {
      const target = await memberById(params.id, params.userId);
      if (!target) return status(404, { error: 'Member not found' });
      const result = await onGroup(
        session,
        params.id,
        (group, actor) => hostRemoveMember(server, group, actor, target),
        { action: 'members/remove', body: { target: userRef(target) } }
      );
      return result.ok ? { ok: true } : status(result.status, { error: result.error });
    },
    { response: { 200: okResponseSchema, ...groupErrors } }
  )
  .post(
    '/:id/bots',
    async ({ params, body, session, server, status }) => {
      const ref = userRef(body);
      // our own private bot in a group hosted elsewhere: leave a grant for the host to bring back
      const federated = parseFederatedChannelId(params.id);
      let grant: string | undefined;
      if (federated && ref.homeserver === getConfig().server.homeserver.toLowerCase()) {
        const bot = await db.query.users.findFirst({
          where: { username: ref.username, homeserver: getConfig().server.homeserver, isBot: true },
          with: { bot: true },
        });
        if (bot?.bot?.ownerId === session.userId) {
          grant = createGrant(bot.id, federated.homeserver, federated.id);
        }
      }
      const result = await onGroup(
        session,
        params.id,
        (group, actor) => hostAddBot(server, group, actor, ref),
        { action: 'bots', body: { ...ref, grant } }
      );
      return result.ok ? { ok: true } : status(result.status, { error: result.error });
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1, maxLength: 64 }),
        homeserver: t.String({ minLength: 1, maxLength: 255 }),
      }),
      response: { 200: okResponseSchema, ...groupErrors },
    }
  )
  .post(
    '/:id/owner',
    async ({ params, body, session, server, status }) => {
      const target = await memberById(params.id, body.userId);
      if (!target) return status(404, { error: 'Member not found' });
      const result = await onGroup(
        session,
        params.id,
        (group, actor) => hostTransferOwner(server, group, actor, target),
        { action: 'owner', body: { target: userRef(target) } }
      );
      return result.ok ? { ok: true } : status(result.status, { error: result.error });
    },
    {
      body: t.Object({ userId: t.String() }),
      response: { 200: okResponseSchema, ...groupErrors },
    }
  )
  .post(
    '/:id/leave',
    async ({ params, session, server, status }) => {
      const result = await onGroup(
        session,
        params.id,
        (group, actor) => hostLeave(server, group, actor),
        { action: 'leave' }
      );
      return result.ok ? { ok: true } : status(result.status, { error: result.error });
    },
    { response: { 200: okResponseSchema, ...groupErrors } }
  )
  .post(
    '/:id/close',
    async ({ params, session, status }) => {
      const membership = await db.query.channelMembers.findFirst({
        where: { channelId: params.id, userId: session.userId },
      });
      if (!membership) return status(404, { error: 'DM not found' });

      await db
        .update(channelMembers)
        .set({ closed: true })
        .where(
          and(eq(channelMembers.channelId, params.id), eq(channelMembers.userId, session.userId))
        );

      return { success: true };
    },
    {
      response: {
        200: successResponseSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  );

export function dmResponse(
  channel: {
    id: string;
    type: string;
    name?: string;
    iconUrl?: string | null;
    ownerId?: string | null;
  },
  joinedAt: Date,
  participants: Parameters<typeof publicUser>[0][]
) {
  const group = channel.type === 'GROUP_DM';
  return {
    id: channel.id,
    type: channel.type as 'DM' | 'GROUP_DM',
    participants: participants.map(publicUser),
    name: group ? (channel.name ?? '') : null,
    iconUrl: group ? (channel.iconUrl ?? null) : null,
    ownerId: group ? (channel.ownerId ?? null) : null,
    lastMessageAt: null,
    lastMessage: null as z.infer<typeof dmLastMessageSchema> | null,
    unread: false,
    joinedAt: joinedAt.toISOString(),
  };
}

// finds or creates the 1:1 DM between two local users, and makes sure both are members.
// dmKey is unique, so a race just means one insert wins and the other reads it back.
export async function openLocalDm(userOneId: string, userTwoId: string) {
  const dmKey = [userOneId, userTwoId].sort().join(':');

  let channel = await db.query.channels.findFirst({ where: { dmKey } });
  let created = false;
  if (!channel) {
    const [inserted] = await db
      .insert(channels)
      .values({ id: randomString(), guildId: null, name: dmKey, type: 'DM', dmKey })
      .onConflictDoNothing({ target: channels.dmKey })
      .returning();
    channel = inserted ?? (await db.query.channels.findFirst({ where: { dmKey } }));
    created = !!inserted;
  }
  if (!channel) throw new Error('Could not create DM channel');

  await db
    .insert(channelMembers)
    .values([
      { channelId: channel.id, userId: userOneId },
      { channelId: channel.id, userId: userTwoId },
    ])
    .onConflictDoNothing();

  const membership = await reopenDm(channel.id, userOneId);
  if (!membership) throw new Error('Could not create DM membership');

  return { channel, joinedAt: membership.joinedAt, created };
}

// makes sure a shadow row exists locally for a DM that's actually hosted on another
// homeserver, so the local participant can see and use it like any other DM.
export async function upsertDmShadow(
  channelId: string,
  localUserId: string,
  participantIds: string[] = [localUserId]
) {
  const existing = await db.query.channels.findFirst({ where: { id: channelId } });
  if (!existing) {
    await db
      .insert(channels)
      .values({ id: channelId, guildId: null, name: channelId, type: 'DM' })
      .onConflictDoNothing();
  }

  await db
    .insert(channelMembers)
    .values(participantIds.map((userId) => ({ channelId, userId })))
    .onConflictDoNothing();

  const membership = await reopenDm(channelId, localUserId);
  if (!membership) throw new Error('Could not create DM shadow membership');

  return membership;
}

async function reopenDm(channelId: string, userId: string) {
  const [membership] = await db
    .update(channelMembers)
    .set({ closed: false })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .returning();
  return membership;
}

export async function latestMessages(channelIds: string[]) {
  if (!channelIds.length) return [];
  return db
    .selectDistinctOn([messages.channelId], {
      id: messages.id,
      channelId: messages.channelId,
      authorId: messages.authorId,
      author: { username: users.username, homeserver: users.homeserver },
      content: messages.content,
      system: messages.system,
      createdAt: messages.createdAt,
      attachmentCount: db.$count(attachments, eq(attachments.messageId, messages.id)),
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.authorId))
    .where(inArray(messages.channelId, channelIds))
    .orderBy(messages.channelId, desc(messages.createdAt), desc(messages.id));
}

async function dmMembershipsOf(userId: string) {
  const memberships = await db.query.channelMembers.findMany({
    where: { userId },
    with: { channel: { with: { members: { with: { user: true } } } } },
  });
  return memberships.filter((m) => m.channel.members.length > 1);
}

// latest messages come from our db, or from `homeserver` when the DMs are hosted there.
async function buildDms(
  session: NonNullable<Awaited<ReturnType<typeof validateSessionToken>>>,
  memberships: Awaited<ReturnType<typeof dmMembershipsOf>>,
  homeserver?: string
) {
  const channelIds = memberships.map((m) => m.channelId);
  if (!channelIds.length) return [];

  const readStates = await db.query.channelReadStates.findMany({
    where: { userId: session.userId, channelId: { in: channelIds } },
  });
  const readStateByChannel = new Map(readStates.map((state) => [state.channelId, state]));

  const latestByChannel = new Map<
    string,
    {
      createdAt: Date;
      id: string;
      own: boolean;
      preview: z.infer<typeof dmLastMessageSchema> | null;
    }
  >();
  if (homeserver) {
    const result = await postSignedFederationJson(homeserver, '/federation/dms/latest', {
      user: federationUserPayload(session),
      channelIds: channelIds.map((id) => parseFederatedChannelId(id)!.id),
    }).catch(() => null);
    const latest = dmLatestResponseSchema.safeParse(result?.data);
    for (const message of result?.response.ok && latest.success ? latest.data.channels : []) {
      const channelId = makeFederatedChannelId(homeserver, message.channelId);
      const others =
        memberships
          .find((m) => m.channelId === channelId)
          ?.channel.members.filter((m) => m.userId !== session.userId) ?? [];
      // the host names the author; an older one only says whether it was us, which is enough in a 1:1
      const { author } = message;
      const authorId = message.own
        ? session.userId
        : author
          ? others.find(
              ({ user }) =>
                user.username === author.username &&
                user.homeserver.toLowerCase() === author.homeserver.toLowerCase()
            )?.userId
          : others.length === 1
            ? others[0]!.userId
            : undefined;
      latestByChannel.set(channelId, {
        createdAt: new Date(message.createdAt),
        id: message.id,
        own: message.own,
        preview:
          message.content !== undefined && authorId
            ? {
                id: message.id,
                authorId,
                content: messagePreview(message.content),
                attachmentCount: message.attachmentCount ?? 0,
                system: message.system ?? null,
              }
            : null,
      });
    }
  } else {
    for (const message of await latestMessages(channelIds)) {
      latestByChannel.set(message.channelId, {
        createdAt: message.createdAt,
        id: message.id,
        own: message.authorId === session.userId,
        preview: {
          id: message.id,
          authorId: message.authorId,
          content: messagePreview(message.content),
          attachmentCount: message.attachmentCount,
          system: message.system,
        },
      });
    }
  }

  return memberships
    .map(({ channel, joinedAt }) => {
      const latest = latestByChannel.get(channel.id);
      const readState = readStateByChannel.get(channel.id);
      return {
        ...dmResponse(
          channel,
          joinedAt,
          channel.members.filter((m) => m.userId !== session.userId).map((m) => m.user)
        ),
        lastMessageAt: latest ? latest.createdAt.toISOString() : null,
        lastMessage: latest?.preview ?? null,
        unread: Boolean(
          latest &&
          !latest.own &&
          isMessageAfter(
            latest,
            readState && { createdAt: readState.lastReadCreatedAt, id: readState.lastReadMessageId }
          )
        ),
      };
    })
    .sort(
      (a, b) =>
        new Date(b.lastMessageAt ?? b.joinedAt).getTime() -
        new Date(a.lastMessageAt ?? a.joinedAt).getTime()
    );
}
