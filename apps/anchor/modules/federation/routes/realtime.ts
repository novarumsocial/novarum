import Elysia from 'elysia';
import { db } from '../../../src/db';
import { voicePresenceForChannels, voicePresenceForGuilds } from '../../../utils/services/livekit';
import { requestFromSignedQuery, verifyFederationRequest } from '../verify';

// The live event streams other homeservers follow for the guilds and DMs they have members in
// (see utils/federationRealtime.ts for the other end). Events only ever flow from here to the
// remote, never the other way around.

type Source = {
  path: 'guilds' | 'dms';
  // which of these guilds or DMs have a member from this homeserver? A homeserver can only
  // follow what it has members in.
  followable: (ids: string[], homeserver: string) => Promise<Set<string>>;
  topic: (id: string) => string;
  // a new follower gets who is in a call right now, since it missed the events that said so
  voiceSnapshot: (id: string) => {
    guildIds: string[];
    states: ReturnType<typeof voicePresenceForGuilds>;
  };
};

const guildSource: Source = {
  path: 'guilds',
  followable: async (ids, homeserver) => {
    const members = await db.query.guildMembers.findMany({
      where: { guildId: { in: ids }, user: { homeserver } },
      columns: { guildId: true },
    });
    return new Set(members.map((member) => member.guildId));
  },
  topic: (guildId) => `guildEvents:${guildId}`,
  voiceSnapshot: (guildId) => ({ guildIds: [guildId], states: voicePresenceForGuilds([guildId]) }),
};

const dmSource: Source = {
  path: 'dms',
  followable: async (ids, homeserver) => {
    const members = await db.query.channelMembers.findMany({
      where: { channelId: { in: ids }, user: { homeserver } },
      columns: { channelId: true },
    });
    return new Set(members.map((member) => member.channelId));
  },
  topic: (channelId) => `dmEvents:${channelId}`,
  voiceSnapshot: (channelId) => ({ guildIds: [], states: voicePresenceForChannels([channelId]) }),
};

const voiceSnapshotEvent = (source: Source, id: string) =>
  JSON.stringify({ type: 'voice.states.snapshot', data: source.voiceSnapshot(id) });

type Socket = {
  id: string;
  data: { request: Request; query: unknown };
  close(code: number, reason: string): void;
  subscribe(topic: string): void;
  isSubscribed(topic: string): boolean;
  subscriptions: string[];
  send(data: string): void;
};

// 1008 = policy violation: the remote doesn't retry after it, so it must only be used when
// asking again can't help
const policyViolation = 1008;

// checks who is on the other end of a new socket: the signature covers `signedPath`
async function verifySocket(ws: Socket, signedPath: string) {
  const request = requestFromSignedQuery(
    ws.data.request.url,
    ws.data.query as Record<string, string | undefined>
  );
  return verifyFederationRequest(request, '', signedPath);
}

// one socket for one guild or DM
function singleSocket(source: Source) {
  return {
    async open(ws: Socket & { data: { params: { id: string } } }) {
      const id = ws.data.params.id;
      const verification = await verifySocket(
        ws,
        `/federation/realtime/${source.path}/${encodeURIComponent(id)}`
      );
      if (!verification.ok) return ws.close(policyViolation, verification.error);

      const followable = await source.followable([id], verification.origin.homeserver);
      if (!followable.has(id)) return ws.close(policyViolation, 'Forbidden');

      ws.subscribe(source.topic(id));
      ws.send(voiceSnapshotEvent(source, id));
    },
    message() {
      // server-to-server realtime is publish-only for now.
    },
  };
}

export const realtime = new Elysia()
  .ws('/realtime/dms/:id', singleSocket(dmSource))
  .ws('/realtime/guilds/:id', singleSocket(guildSource));
