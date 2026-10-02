import Elysia, { t } from 'elysia';
import { sessionCookieName, validateSessionToken, type SessionWithUser } from '../auth/provider';
import { parseFederatedChannelId, parseFederatedGuildId } from '../../utils/federationIds';
import { postSignedFederationJson } from '../../utils/discovery';
import { federationUserPayload } from '../../utils/federationPayload';
import { searchEmojis } from '../../utils/emojiSearch';
import { qualifyEmojiUnicode } from '../../utils/emojiWriter';
import {
  removeVoicePresence,
  setVoicePresence,
  voicePresenceForChannels,
  voicePresenceForGuilds,
} from '../../utils/services/livekit';
import { channelTopics } from '../../utils/publishRealtime';
import { bridgedVoicePresenceFor } from '../../utils/federationRealtime';
import { clearOnlineUsers, getOnlineUsers } from '../../utils/clearOnlineUsers';
import { canAccessChannel } from '../../utils/channelAccess';
import { db, users } from '../../src/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getConfig } from '../../utils/config';
import type { VoicePresence } from '../../utils/types';
import { publicUser } from '../../utils/publicUser';

const activeRealtimeConnections = new Map<string, number>();
const federatedVoiceChannelsByUser = new Map<string, string>();
const voiceSocketByUser = new Map<string, string>();
const pingIntervals = new Map<string, ReturnType<typeof setInterval>>();
const voiceStateResponseSchema = z.object({
  state: z.object({
    guildId: z.string().nullable(),
    channelId: z.string(),
    userId: z.string(),
    name: z.string().nullable(),
  }),
});

setInterval(async () => {
  const dbOnlineUsers = (await getOnlineUsers()).map((u) => u.id);
  await clearOnlineUsers(dbOnlineUsers.filter((userId) => !activeRealtimeConnections.has(userId)));
}, 3000);

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

export const realtime = new Elysia({ prefix: '/realtime', tags: ['Realtime'] }).ws('/', {
  cookie: t.Cookie({
    [sessionCookieName]: t.Optional(t.String()),
  }),
  body: t.Union([
    t.Object({
      type: t.Literal('subscribe.guild'),
      guildId: t.String(),
    }),
    t.Object({
      type: t.Literal('voice.join'),
      channelId: t.String(),
    }),
    t.Object({
      type: t.Literal('voice.leave'),
    }),
    t.Object({
      type: t.Literal('call.ring'),
      channelId: t.String(),
      ringing: t.Boolean(),
    }),
    t.Object({
      type: t.Literal('emoji.search'),
      query: t.String(),
    }),
    t.Object({
      type: t.Literal('emoji.query'),
      unicodes: t.Array(t.String({ pattern: '^[0-9A-Fa-f]+(?:-[0-9A-Fa-f]+)*$' }), {
        minItems: 1,
        maxItems: 100,
      }),
    }),
  ]),
  async open(ws) {
    const token = ws.data.cookie[sessionCookieName]?.value as string | undefined;
    // @ts-ignore messages can arrive before open finishes, so they await this instead
    ws.data.sessionReady = validateSessionToken(token);
    // @ts-ignore same
    const session = (await ws.data.sessionReady) as SessionWithUser | null;
    if (!session) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    // @ts-ignore fuh ts
    ws.data.session = session;

    const memberships = await db.query.guildMembers.findMany({
      where: { userId: session.userId },
    });

    ws.subscribe(`userEvents:${session.userId}`);
    for (const membership of memberships) {
      ws.subscribe(`guildEvents:${membership.guildId}`);
    }

    const guildIds = memberships.map((membership) => membership.guildId);
    const dmIds = (
      await db.query.channelMembers.findMany({ where: { userId: session.userId } })
    ).map((membership) => membership.channelId);
    ws.send(
      JSON.stringify({
        type: 'voice.states.snapshot',
        data: {
          guildIds,
          dmIds,
          states: [
            ...voicePresenceForGuilds(guildIds),
            ...voicePresenceForChannels(dmIds),
            ...bridgedVoicePresenceFor([...guildIds, ...dmIds]),
          ],
        },
      })
    );

    pingIntervals.set(
      ws.id,
      setInterval(() => ws.send(JSON.stringify({ type: 'misc.ping' })), 30_000)
    );

    const becameOnline = addUserConnection(session.userId);
    if (!becameOnline) return;

    await db.update(users).set({ status: 'ONLINE' }).where(eq(users.id, session.userId));

    await publishUserStatus(ws, session, memberships, 'ONLINE');
  },
  async message(ws, message) {
    // @ts-ignore stored during open
    const session = (await ws.data.sessionReady) as SessionWithUser | null;
    if (!session) return;

    if (message.type === 'voice.leave') {
      voiceSocketByUser.delete(session.userId);
      const previous = removeVoicePresence(session.userId);
      if (previous) {
        await publishVoiceState(ws, previous, false);
      }

      leaveFederatedVoice(session);
      return;
    }

    if (message.type === 'voice.join') {
      const federatedChannel = parseFederatedChannelId(message.channelId);
      if (federatedChannel) {
        const result = await postSignedFederationJson(
          federatedChannel.homeserver,
          `/federation/channels/${encodeURIComponent(federatedChannel.id)}/voice-state`,
          { user: federationUserPayload(session), connected: true }
        ).catch(() => null);
        if (!result?.response.ok || !voiceStateResponseSchema.safeParse(result.data).success)
          return;

        const previous = removeVoicePresence(session.userId);
        if (previous && previous.channelId !== message.channelId)
          await publishVoiceState(ws, previous, false);
        leaveFederatedVoice(session, message.channelId);
        federatedVoiceChannelsByUser.set(session.userId, message.channelId);
        voiceSocketByUser.set(session.userId, ws.id);
        return;
      }

      leaveFederatedVoice(session);

      const channel = await db.query.channels.findFirst({
        where: { id: message.channelId },
      });
      if (!channel || (channel.type !== 'VOICE' && channel.type !== 'DM')) return;

      if (!(await canAccessChannel(channel, session.userId, true))) return;

      const previous = removeVoicePresence(session.userId);
      if (previous && previous.channelId !== channel.id)
        await publishVoiceState(ws, previous, false);

      const state = {
        guildId: channel.guildId,
        channelId: channel.id,
        userId: session.userId,
        name: session.user.displayName || session.user.username,
      };
      setVoicePresence(state);
      voiceSocketByUser.set(session.userId, ws.id);
      await publishVoiceState(ws, state, true);
      return;
    }

    if (message.type === 'call.ring') {
      const federatedChannel = parseFederatedChannelId(message.channelId);
      if (federatedChannel) {
        void postSignedFederationJson(
          federatedChannel.homeserver,
          `/federation/channels/${encodeURIComponent(federatedChannel.id)}/ring`,
          { user: federationUserPayload(session), ringing: message.ringing }
        ).catch(() => null);
        return;
      }

      const channel = await db.query.channels.findFirst({ where: { id: message.channelId } });
      if (!channel || channel.type !== 'DM') return;
      if (!(await canAccessChannel(channel, session.userId, true))) return;

      const event = JSON.stringify({
        type: 'call.ringing',
        data: { channelId: channel.id, user: publicUser(session.user), ringing: message.ringing },
      });
      for (const topic of await channelTopics(channel)) ws.publish(topic, event);
      return;
    }

    if (message.type === 'emoji.search') {
      ws.send(
        JSON.stringify({
          type: 'emoji.search.results',
          data: { query: message.query, emojis: await searchEmojis(message.query) },
        })
      );
      return;
    }

    if (message.type === 'emoji.query') {
      const unicodes = [...new Set(message.unicodes.map((unicode) => unicode.toUpperCase()))];
      const qualified = unicodes.map(qualifyEmojiUnicode);
      const matches = await db.query.emojis.findMany({
        where: { unicode: { in: qualified } },
        columns: { name: true, unicode: true, url: true },
      });
      const byUnicode = new Map(matches.map((emoji) => [emoji.unicode, emoji]));
      const emojis = unicodes.flatMap((unicode) => {
        const emoji = byUnicode.get(qualifyEmojiUnicode(unicode));
        return emoji ? [{ ...emoji, unicode }] : [];
      });
      ws.send(
        JSON.stringify({
          type: 'emoji.query.results',
          data: { unicodes, emojis },
        })
      );
      return;
    }

    const membership = await db.query.guildMembers.findFirst({
      where: { guildId: message.guildId, userId: session.userId },
    });
    if (!membership) return;

    ws.subscribe(`guildEvents:${message.guildId}`);
    ws.send(
      JSON.stringify({
        type: 'voice.states.snapshot',
        data: {
          guildIds: [message.guildId],
          states: [
            ...voicePresenceForGuilds([message.guildId]),
            ...bridgedVoicePresenceFor([message.guildId]),
          ],
        },
      })
    );
  },
  async close(ws) {
    clearInterval(pingIntervals.get(ws.id));
    pingIntervals.delete(ws.id);
    // @ts-ignore using it here
    const session = ws.data.session as SessionWithUser;
    if (!session) return;

    // only the socket that joined the call ends it; a stale or second socket closing shouldn't.
    if (voiceSocketByUser.get(session.userId) === ws.id) {
      voiceSocketByUser.delete(session.userId);
      const previous = removeVoicePresence(session.userId);
      if (previous) await publishVoiceState(ws, previous, false);
      leaveFederatedVoice(session);
    }

    const becameOffline = removeUserConnection(session.userId);
    if (!becameOffline) return;

    await db.update(users).set({ status: 'OFFLINE' }).where(eq(users.id, session.userId));

    const memberships = await db.query.guildMembers.findMany({
      where: { userId: session.userId },
    });
    await publishUserStatus(ws, session, memberships, 'OFFLINE');
  },
});

async function publishVoiceState(
  ws: { publish(topic: string, data: string): void; send(data: string): void },
  state: VoicePresence,
  connected: boolean
) {
  const event = JSON.stringify({
    type: 'voice.state.changed',
    data: { ...state, connected },
  });

  for (const topic of await channelTopics({ id: state.channelId, guildId: state.guildId })) {
    ws.publish(topic, event);
  }
  ws.send(event);
}

function leaveFederatedVoice(session: SessionWithUser, exceptChannelId?: string) {
  const channelId = federatedVoiceChannelsByUser.get(session.userId);
  if (!channelId || channelId === exceptChannelId) return;

  federatedVoiceChannelsByUser.delete(session.userId);
  const federatedChannel = parseFederatedChannelId(channelId);
  if (!federatedChannel) return;

  void postSignedFederationJson(
    federatedChannel.homeserver,
    `/federation/channels/${encodeURIComponent(federatedChannel.id)}/voice-state`,
    { user: federationUserPayload(session), connected: false }
  ).catch(() => null);
}

async function publishUserStatus(
  ws: { publish(topic: string, data: string): void },
  session: SessionWithUser,
  memberships: { guildId: string }[],
  status: 'ONLINE' | 'OFFLINE'
) {
  const friendships = await db.query.friendRelationships.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ userOneId: session.userId }, { userTwoId: session.userId }],
    },
    with: { userOne: true, userTwo: true },
  });
  const statusEvent = JSON.stringify({
    type: 'user.status.changed',
    data: { userId: session.userId, status },
  });
  const localHomeserver = getConfig().server.homeserver.toLowerCase();
  const remoteHomeservers = new Set<string>();
  for (const { userOne, userTwo } of friendships) {
    const friend = userOne.id === session.userId ? userTwo : userOne;
    const homeserver = friend.homeserver.toLowerCase();
    if (homeserver === localHomeserver) ws.publish(`userEvents:${friend.id}`, statusEvent);
    else remoteHomeservers.add(homeserver);
  }
  for (const homeserver of remoteHomeservers) {
    void postSignedFederationJson(homeserver, '/federation/friends/status', {
      user: federationUserPayload(session),
      status,
    }).catch(() => null);
  }

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
