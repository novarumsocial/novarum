import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { sessionCookieName, validateSessionToken, type SessionWithUser } from '../auth/provider';
import { parseFederatedChannelId, parseFederatedGuildId } from '../../utils/federationIds';
import { postSignedFederationJson } from '../../utils/discovery';
import { federationUserPayload } from '../../utils/federationPayload';
import { searchEmojis } from '../../utils/emojiSearch';
import { qualifyEmojiUnicode } from '../../utils/emojiWriter';
import {
  removeVoicePresence,
  setVoicePresence,
  voicePresenceForGuilds,
} from '../../utils/services/livekit';

const activeRealtimeConnections = new Map<string, number>();
const federatedVoiceChannelsByUser = new Map<string, string>();

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

    setInterval(() => {
      ws.send(
        JSON.stringify({
          type: 'misc.ping',
        })
      );
    }, 30_000);
  },
  async message(ws, message) {
    // @ts-ignore stored during open
    const session = ws.data.session as SessionWithUser | undefined;
    if (!session) return;

    if (message.type === 'voice.leave') {
      const previous = removeVoicePresence(session.userId);
      if (previous) {
        publishVoiceState(ws, previous, false);
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
        if (!result?.response.ok || !result.data || typeof result.data !== 'object') return;

        const remoteState = (result.data as { state?: { guildId?: string } }).state;
        if (typeof remoteState?.guildId !== 'string') return;

        const previous = removeVoicePresence(session.userId);
        if (previous && previous.channelId !== message.channelId)
          publishVoiceState(ws, previous, false);
        leaveFederatedVoice(session, message.channelId);
        federatedVoiceChannelsByUser.set(session.userId, message.channelId);
        return;
      }

      leaveFederatedVoice(session);

      const channel = await db.orm.public.Channel.where({ id: message.channelId }).first();
      if (!channel || channel.type !== 'VOICE') return;

      const membership = await db.orm.public.GuildMember.where({
        guildId: channel.guildId,
        userId: session.userId,
      }).first();
      if (!membership) return;

      const previous = removeVoicePresence(session.userId);
      if (previous && previous.channelId !== channel.id) publishVoiceState(ws, previous, false);

      const state = {
        guildId: channel.guildId,
        channelId: channel.id,
        userId: session.userId,
        name: session.user.displayName || session.user.username,
      };
      setVoicePresence(state);
      publishVoiceState(ws, state, true);
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
      const matches = await db.orm.public.Emoji.where((emoji) => emoji.unicode.in(qualified))
        .select('name', 'unicode', 'url')
        .all();
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

    const previous = removeVoicePresence(session.userId);
    if (previous) publishVoiceState(ws, previous, false);
    leaveFederatedVoice(session);

    const becameOffline = removeUserConnection(session.userId);
    if (!becameOffline) return;

    await db.orm.public.User.where({ id: session.userId }).update({ status: 'OFFLINE' });

    const memberships = await db.orm.public.GuildMember.where({ userId: session.userId }).all();
    await publishUserStatus(ws, session, memberships, 'OFFLINE');
  },
});

function publishVoiceState(
  ws: { publish(topic: string, data: string): void; send(data: string): void },
  state: { guildId: string; channelId: string; userId: string; name: string | null },
  connected: boolean
) {
  const event = JSON.stringify({
    type: 'voice.state.changed',
    data: { ...state, connected },
  });

  ws.publish(`guildEvents:${state.guildId}`, event);
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
