import Elysia, { t } from 'elysia';
import { z } from 'zod';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import { randomString } from '../../utils/randomString';
import { db, channels, channelMembers, messages } from '../../src/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { publicUser } from '../../utils/publicUser';
import { findFriendship, friendAuthority } from '../friends/model';
import { isMessageAfter } from '../../utils/messageCursor';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { dmLatestResponseSchema, dmOpenResponseSchema, dmResponseSchema } from '../../src/db/zod';
import { getConfig } from '../../utils/config';
import { postSignedFederationJson } from '../../utils/discovery';
import { federationUserPayload, upsertFederatedUser } from '../../utils/federationPayload';
import { makeFederatedChannelId, parseFederatedChannelId } from '../../utils/federationIds';
import { publishRealtime } from '../../utils/publishRealtime';
import { ensureFederatedDmRealtimeBridge } from '../../utils/federationRealtime';

const successResponseSchema = z.object({ success: z.boolean() });
const dmListResponseSchema = z.object({ dms: z.array(dmResponseSchema) });

export const dm = new Elysia({ prefix: '/dm', tags: ['DM'] })
  .resolve(async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
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

        // this side is authoritative for the DM; if the other participant is remote and this
        // is a brand new DM, give their homeserver a heads up so it shows up for them too.
        if (created && isRemote) {
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
  channel: { id: string; type: string },
  joinedAt: Date,
  participants: Parameters<typeof publicUser>[0][]
) {
  return {
    id: channel.id,
    type: channel.type as 'DM' | 'GROUP_DM',
    participants: participants.map(publicUser),
    lastMessageAt: null,
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
    .selectDistinctOn([messages.channelId])
    .from(messages)
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

  const latestByChannel = new Map<string, { createdAt: Date; id: string; own: boolean }>();
  if (homeserver) {
    const result = await postSignedFederationJson(homeserver, '/federation/dms/latest', {
      user: federationUserPayload(session),
      channelIds: channelIds.map((id) => parseFederatedChannelId(id)!.id),
    }).catch(() => null);
    const latest = dmLatestResponseSchema.safeParse(result?.data);
    for (const message of result?.response.ok && latest.success ? latest.data.channels : []) {
      latestByChannel.set(makeFederatedChannelId(homeserver, message.channelId), {
        createdAt: new Date(message.createdAt),
        id: message.id,
        own: message.own,
      });
    }
  } else {
    for (const message of await latestMessages(channelIds)) {
      latestByChannel.set(message.channelId, {
        createdAt: message.createdAt,
        id: message.id,
        own: message.authorId === session.userId,
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
