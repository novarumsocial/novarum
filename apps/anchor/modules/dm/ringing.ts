import type { Server } from 'elysia/universal';
import { db } from '../../src/db';
import { getConfig } from '../../utils/config';
import { notifyCall } from '../../utils/notify';
import type { PublicUser } from '../../utils/publicUser';
import { publishRealtime, publishToChannel } from '../../utils/publishRealtime';
import { voicePresenceForChannels, watchVoicePresence } from '../../utils/services/livekit';
import type { RealtimeEvent } from '../../utils/types';

// Who is ringing in which DM. Every homeserver that sees a ring keeps it, so its own people get a
// push and a device that connects mid-ring still rings. The DM's host decides when it ends: after
// the timeout, once the caller hangs up, or once someone answers a 1:1; it then publishes
// `ringing: false` for the caller, which the other homeservers follow.

type Ring = {
  caller: PublicUser;
  group: boolean;
  host: boolean;
  callerSeen: boolean;
  // people whose phones were told to stop: they declined or answered
  stopped: Set<string>;
  timer: ReturnType<typeof setTimeout>;
};

export const ringTimeoutMs = 30_000;
const rings = new Map<string, Ring>();
// set once at startup by trackRings; rings end on timers, long after the request that started them
let server: Server | null = null;
const publishTo = (channelId: string, event: RealtimeEvent) =>
  server ? publishToChannel(server, { id: channelId, guildId: null }, event) : undefined;

const sameUser = (a: Pick<PublicUser, 'username' | 'homeserver'>, b: typeof a) =>
  a.username === b.username && a.homeserver.toLowerCase() === b.homeserver.toLowerCase();

const ringEvent = (channelId: string, user: PublicUser, ringing: boolean): RealtimeEvent => ({
  type: 'call.ringing',
  data: { channelId, user, ringing },
});

async function localMembers(channelId: string) {
  const homeserver = getConfig().server.homeserver.toLowerCase();
  const members = await db.query.channelMembers.findMany({
    where: { channelId },
    with: { user: true },
  });
  return members
    .map(({ user }) => user)
    .filter((user) => user.homeserver.toLowerCase() === homeserver);
}

/** The DM's host: `user` starts or stops ringing in a DM or group DM we host. */
export async function ring(
  channel: { id: string; type: string },
  user: PublicUser,
  ringing: boolean
) {
  const current = rings.get(channel.id);
  const declined = !ringing && current && !sameUser(current.caller, user);

  // one person in a group saying no doesn't stop it for the others, only on their own devices
  if (declined && channel.type === 'GROUP_DM') return declinedBy(channel.id, user);

  await publishTo(channel.id, ringEvent(channel.id, user, ringing));
  await followRing(channel.id, channel.type === 'GROUP_DM', user, ringing, true);
  if (declined) await endRing(channel.id);
}

/** Every homeserver: a ring started or stopped, as published here (host) or relayed by the host. */
export async function followRing(
  channelId: string,
  group: boolean,
  user: PublicUser,
  ringing: boolean,
  host = false
) {
  const current = rings.get(channelId);
  if (!ringing) {
    if (!current || !sameUser(current.caller, user)) {
      // someone declined: their other devices stop
      const members = await localMembers(channelId);
      return stopRingingFor(
        channelId,
        members.filter((member) => sameUser(member, user)).map((member) => member.id)
      );
    }
    clearTimeout(current.timer);
    rings.delete(channelId);
    const members = await localMembers(channelId);
    return notifyCall(
      members.filter((member) => !sameUser(member, user)).map((member) => member.id),
      { channelId, caller: user, ringing: false }
    );
  }

  if (current) clearTimeout(current.timer);
  const ring: Ring = {
    caller: user,
    group,
    host,
    callerSeen: false,
    stopped: new Set(),
    // a ring that never ends (the host went away) is forgotten a bit after it should have ended
    timer: setTimeout(
      () => (host ? void endRing(channelId) : rings.delete(channelId)),
      host ? ringTimeoutMs : ringTimeoutMs + 15_000
    ),
  };
  rings.set(channelId, ring);

  const inCall = new Set(voicePresenceForChannels([channelId]).map((state) => state.userId));
  const members = await localMembers(channelId);
  await notifyCall(
    members
      .filter((member) => !sameUser(member, user) && !inCall.has(member.id))
      .map((member) => member.id),
    { channelId, caller: user, ringing: true }
  );
  if (host) await checkAnswered(channelId);
}

async function endRing(channelId: string) {
  const ring = rings.get(channelId);
  if (!ring) return;
  await publishTo(channelId, ringEvent(channelId, ring.caller, false));
  await followRing(channelId, ring.group, ring.caller, false, true);
}

/** `user` said no to someone else's ring: their own devices stop, it keeps ringing for the rest. */
export async function declinedBy(channelId: string, user: PublicUser) {
  const ring = rings.get(channelId);
  if (!ring || sameUser(ring.caller, user)) return;
  if (server)
    publishRealtime(server, `userEvents:${user.userId}`, ringEvent(channelId, user, false));
  await stopRingingFor(channelId, [user.userId]);
}

/** These people answered or declined somewhere: their phones stop ringing. */
export async function stopRingingFor(channelId: string, userIds: string[]) {
  const ring = rings.get(channelId);
  if (!ring) return;
  const fresh = userIds.filter((id) => !ring.stopped.has(id));
  for (const id of fresh) ring.stopped.add(id);
  await notifyCall(fresh, { channelId, caller: ring.caller, ringing: false });
}

// the host watches who is in the call: the caller hanging up ends the ring, and so does anyone
// answering a 1:1. In a group, whoever answered stops ringing and the rest keep going.
async function checkAnswered(channelId: string) {
  const ring = rings.get(channelId);
  if (!ring?.host) return;
  const present = voicePresenceForChannels([channelId]).map((state) => state.userId);
  if (present.includes(ring.caller.userId)) ring.callerSeen = true;
  else if (ring.callerSeen) return endRing(channelId);

  const answered = present.filter((id) => id !== ring.caller.userId);
  if (!ring.group && answered.length) return endRing(channelId);
  await stopRingingFor(channelId, answered);
}

export function trackRings(appServer: Server) {
  server = appServer;
  watchVoicePresence((channelId) => {
    if (rings.get(channelId)?.host)
      void checkAnswered(channelId).catch((error) =>
        console.warn('Could not update a ring:', error)
      );
  });
}

/** What still rings for this user in these DMs, for a device that just connected. */
export function activeRings(
  user: { id: string; username: string; homeserver: string },
  channelIds: string[]
): RealtimeEvent[] {
  return channelIds.flatMap((channelId) => {
    const ring = rings.get(channelId);
    // a ring relayed by another host carries that host's id for the caller, so match the handle
    if (!ring || sameUser(ring.caller, user) || ring.stopped.has(user.id)) return [];
    return [ringEvent(channelId, ring.caller, true)];
  });
}
