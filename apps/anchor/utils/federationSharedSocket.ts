import { z } from 'zod';

// The "shared socket" lets a homeserver follow all the guilds and DMs it has members in on another
// homeserver through ONE WebSocket (`/federation/realtime`), instead of one socket per guild or DM.
// It is listed as the `realtime-mux` feature, see federationFeatures.ts.
//
//   follower -> host   { type: 'subscribe', guilds: [id...], dms: [id...] }
//   host -> follower   { type: 'event', kind, id, event }   an event, with the guild or DM it belongs to
//   host -> follower   { type: 'refused', kind, id }         that one can't be followed (no members there)
//
// The wrapper is needed because not every event says which guild it is about (a user going
// online doesn't). The ids are the ones of the host.

export type SharedKind = 'guild' | 'dm';

// a homeserver can have thousands of guilds, so subscribing happens in chunks, with a ceiling per socket
export const maxIdsPerSubscribe = 500;
export const maxSubscriptionsPerSocket = 5000;

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  guilds: z.array(z.string()).max(maxIdsPerSubscribe).default([]),
  dms: z.array(z.string()).max(maxIdsPerSubscribe).default([]),
});

/** The pub/sub topic every socket following this guild or DM listens to. */
export const sharedSocketTopic = (kind: SharedKind, id: string) => `sharedSocket:${kind}:${id}`;

/** An event wrapped for the shared socket. `eventJson` is the event as it is already serialized. */
export const sharedEventFrame = (kind: SharedKind, id: string, eventJson: string) =>
  `{"type":"event","kind":"${kind}","id":${JSON.stringify(id)},"event":${eventJson}}`;

export const sharedRefusedFrame = (kind: SharedKind, id: string) =>
  JSON.stringify({ type: 'refused', kind, id });

/** `subscribe` messages that ask for all of these ids, `maxIdsPerSubscribe` at a time. */
export function subscribeMessages(guilds: string[], dms: string[]) {
  const messages: string[] = [];
  for (let start = 0; start < Math.max(guilds.length, dms.length); start += maxIdsPerSubscribe) {
    messages.push(
      JSON.stringify({
        type: 'subscribe',
        guilds: guilds.slice(start, start + maxIdsPerSubscribe),
        dms: dms.slice(start, start + maxIdsPerSubscribe),
      })
    );
  }
  return messages;
}
