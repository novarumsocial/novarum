import Elysia from 'elysia';
import { db } from '../../../src/db';
import {
  maxSubscriptionsPerSocket,
  sharedEventFrame,
  sharedRefusedFrame,
  sharedSocketTopic,
  subscribeMessageSchema,
  type SharedKind,
} from '../../../utils/federationSharedSocket';
import { voicePresenceForChannels, voicePresenceForGuilds } from '../../../utils/services/livekit';
import { requestFromSignedQuery, verifyFederationRequest, type FederationOrigin } from '../verify';

// The live event streams other homeservers follow for the guilds and DMs they have members in
// (see utils/federationRealtime.ts for the other end). Events only ever flow from here to the
// remote, never the other way around.
//
// There are two ways to follow, and a homeserver can use either:
//   /realtime/guilds/:id and /realtime/dms/:id   one socket for one guild or DM
//   /realtime                                    one socket for any number of them (see federationSharedSocket.ts)

type Source = {
  kind: SharedKind;
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
  kind: 'guild',
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
  kind: 'dm',
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

// who is on the other end of each shared socket, once known. A message can arrive while the
// signature is still being checked, so it waits for the answer here.
const sharedSocketOrigins = new Map<string, Promise<FederationOrigin | null>>();

// one socket for any number of guilds and DMs: the remote says which ones it wants
const sharedSocket = {
  open(ws: Socket) {
    const origin = verifySocket(ws, '/federation/realtime')
      .then((verification) => {
        if (!verification.ok) {
          ws.close(policyViolation, verification.error);
          return null;
        }
        return verification.origin;
      })
      .catch((error) => {
        // not the remote's fault (the database is down, say), so it is free to try again
        console.warn('Could not verify a federation socket:', error);
        ws.close(1011, 'Could not verify the request');
        return null;
      });
    sharedSocketOrigins.set(ws.id, origin);
  },
  async message(ws: Socket, message: unknown) {
    const origin = await sharedSocketOrigins.get(ws.id);
    const request = subscribeMessageSchema.safeParse(message);
    if (!origin || !request.success) return;

    for (const [source, ids] of [
      [guildSource, request.data.guilds],
      [dmSource, request.data.dms],
    ] as const) {
      const wanted = ids.filter((id) => !ws.isSubscribed(sharedSocketTopic(source.kind, id)));
      if (!wanted.length) continue;

      // one query for all of them, then each is checked on its own: the same rule as a single socket
      const followable = await source.followable(wanted, origin.homeserver);
      for (const id of wanted) {
        const topic = sharedSocketTopic(source.kind, id);
        // an overlapping subscribe may have got there while we were querying
        if (ws.isSubscribed(topic)) continue;
        if (!followable.has(id) || ws.subscriptions.length >= maxSubscriptionsPerSocket) {
          ws.send(sharedRefusedFrame(source.kind, id));
          continue;
        }
        ws.subscribe(topic);
        ws.send(sharedEventFrame(source.kind, id, voiceSnapshotEvent(source, id)));
      }
    }
  },
  close(ws: Socket) {
    sharedSocketOrigins.delete(ws.id);
  },
};

export const realtime = new Elysia()
  .ws('/realtime/dms/:id', singleSocket(dmSource))
  .ws('/realtime/guilds/:id', singleSocket(guildSource))
  .ws('/realtime', sharedSocket);
