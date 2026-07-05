import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { sessionCookieName, validateSessionToken, type SessionWithUser } from '../auth/provider';
import { parseFederatedGuildId } from '../../utils/federationIds';
import { postSignedFederationJson } from '../../utils/discovery';
import { federationUserPayload } from '../../utils/federationPayload';
import { voicePresenceForGuilds } from '../../utils/services/livekit';

const activeRealtimeConnections = new Map<string, number>();

function addUserConnection(userId: string) {
  const nextCount = (activeRealtimeConnections.get(userId) ?? 0) + 1;
  activeRealtimeConnections.set(userId, nextCount);

  return nextCount === 1;
}

function removeUserConnection(userId: string) {
  const currentCount = activeRealtimeConnections.get(userId) ?? 0;
  if (currentCount <= 1) {
    activeRealtimeConnections.delete(userId);
    return currentCount === 1;
  }

  activeRealtimeConnections.set(userId, currentCount - 1);
  return false;
}

export const realtime = new Elysia({ prefix: '/realtime' }).ws('/', {
  cookie: t.Cookie({
    [sessionCookieName]: t.Optional(t.String()),
  }),
  body: t.Object({
    type: t.Literal('subscribe.guild'),
    guildId: t.String(),
  }),
  async open(ws) {
    const token = ws.data.cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    // @ts-ignore fuh ts
    ws.data.session = session;

    const memberships = await db.orm.public.GuildMember.where({ userId: session.userId }).all();

    ws.subscribe(`userEvents:${session.userId}`);
    for (const membership of memberships) {
      ws.subscribe(`guildEvents:${membership.guildId}`);
    }

    const guildIds = memberships.map((membership) => membership.guildId);
    ws.send(
      JSON.stringify({
        type: 'voice.states.snapshot',
        data: { guildIds, states: voicePresenceForGuilds(guildIds) },
      })
    );

    const becameOnline = addUserConnection(session.userId);
    if (!becameOnline) return;

    await db.orm.public.User.where({ id: session.userId }).update({ status: 'ONLINE' });

    await publishUserStatus(ws, session, memberships, 'ONLINE');
  },
  async message(ws, message) {
    // @ts-ignore stored during open
    const session = ws.data.session as SessionWithUser | undefined;
    if (!session) return;

    const membership = await db.orm.public.GuildMember.where({
      guildId: message.guildId,
      userId: session.userId,
    }).first();
    if (!membership) return;

    ws.subscribe(`guildEvents:${message.guildId}`);
    ws.send(
      JSON.stringify({
        type: 'voice.states.snapshot',
        data: { guildIds: [message.guildId], states: voicePresenceForGuilds([message.guildId]) },
      })
    );
  },
  async close(ws) {
    // @ts-ignore using it here
    const session = ws.data.session as SessionWithUser;
    if (!session) return;

    const becameOffline = removeUserConnection(session.userId);
    if (!becameOffline) return;

    await db.orm.public.User.where({ id: session.userId }).update({ status: 'OFFLINE' });

    const memberships = await db.orm.public.GuildMember.where({ userId: session.userId }).all();
    await publishUserStatus(ws, session, memberships, 'OFFLINE');
  },
});

async function publishUserStatus(
  ws: { publish(topic: string, data: string): void },
  session: SessionWithUser,
  memberships: { guildId: string }[],
  status: 'ONLINE' | 'OFFLINE'
) {
  for (const membership of memberships) {
    ws.publish(
      `guildEvents:${membership.guildId}`,
      JSON.stringify({
        type: 'user.status.changed',
        data: {
          userId: session.userId,
          status,
        },
      })
    );

    const federatedGuild = parseFederatedGuildId(membership.guildId);
    if (!federatedGuild) continue;

    void postSignedFederationJson(
      federatedGuild.homeserver,
      `/federation/guilds/${encodeURIComponent(federatedGuild.id)}/users/status`,
      {
        user: federationUserPayload(session),
        status,
      }
    ).catch(() => null);
  }
}
