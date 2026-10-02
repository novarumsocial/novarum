// Helpers for the functional federation flows (TESTING_PLAN §5.3): direct database access to the stack's anchors,
// signing as a REAL anchor (a/b/c) by reading its private key out of the container, bridge sockets, and small
// shortcuts over the user-facing API.
import { SQL } from 'bun';
import { anchors, api, exec, fake, ips, signup, type AnchorName } from './federation';
import { call, createGuild } from './chat';
import { connect } from './realtime';
import { signFederationRequestWith } from './signer';
import type { TestUser } from './users';
import { eventually } from './wait';

// ---- database ---------------------------------------------------------------------------------------------------

const conns = new Map<AnchorName, SQL>();
/** shared connection to an anchor's database (172.30.0.5 is reachable from the host); close with `closePg()` */
export function pg(name: AnchorName) {
  const a = anchors[name];
  if (!conns.has(name)) conns.set(name, new SQL(`postgresql://novarum:novarum@${a.pg}:5432/${a.db}`));
  return conns.get(name)!;
}
export async function closePg() {
  for (const sql of conns.values()) await sql.close();
  conns.clear();
}

/** the friend_relationship row between two usernames as `name` sees it */
export async function relationOn(name: AnchorName, x: string, y: string) {
  const [row] = await pg(name)`
    SELECT r.status, r.version, r."syncPending" AS "syncPending", rb.username AS "requestedBy", r."lastCommandId" AS "lastCommandId"
    FROM friend_relationship r
    JOIN "user" u1 ON u1.id = r."userOneId" JOIN "user" u2 ON u2.id = r."userTwoId" JOIN "user" rb ON rb.id = r."requestedById"
    WHERE (u1.username = ${x} AND u2.username = ${y}) OR (u1.username = ${y} AND u2.username = ${x})`;
  return row as { status: string; version: number; syncPending: boolean; requestedBy: string; lastCommandId: string | null } | undefined;
}

// ---- friends ----------------------------------------------------------------------------------------------------

export type FriendList = { accepted: any[]; incoming: any[]; outgoing: any[] };
export const friendList = async (u: TestUser) => (await call(u, 'GET', '/friends')).body as FriendList;
export const listHas = (list: any[], other: TestUser) => list.some((e) => e.user.username === other.user.username);

/** how `viewer`'s homeserver knows `other` (its local id for the possibly shadow user), taken from the friend lists */
export async function idOf(viewer: TestUser, other: TestUser) {
  const l = await friendList(viewer);
  const hit = [...l.accepted, ...l.incoming, ...l.outgoing].find((e) => e.user.username === other.user.username);
  if (!hit) throw new Error(`${other.user.username} is not in ${viewer.user.username}'s friend lists`);
  return hit.user.userId as string;
}

export const requestFriend = (from: TestUser, to: TestUser) =>
  call(from, 'POST', '/friends/request', { username: to.user.username, homeserver: to.user.homeserver });

/** a requests b, b accepts, and waits until both sides list each other as accepted */
export async function makeFriends(a: TestUser, b: TestUser) {
  const req = await requestFriend(a, b);
  if (req.status !== 200) throw new Error(`friend request failed: ${req.status} ${JSON.stringify(req.body)}`);
  const id = await eventually(async () => idOf(b, a), { message: `${b.user.username} sees the request` });
  const acc = await call(b, 'POST', `/friends/requests/${id}/accept`);
  if (acc.status !== 200) throw new Error(`friend accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
  await eventually(async () => listHas((await friendList(a)).accepted, b) && listHas((await friendList(b)).accepted, a), {
    timeout: 10_000,
    message: 'both sides accepted',
  });
}

// ---- payloads and real-anchor signing -----------------------------------------------------------------------------

/** the `user` object a federation request carries for a real user */
export const userPayload = (u: { username: string; homeserver: string }, over: object = {}) => ({
  username: u.username,
  homeserver: u.homeserver.toLowerCase(),
  displayName: null,
  avatarUrl: null,
  avatarColor: null,
  speakingRingColor: null,
  isBot: false,
  ...over,
});

/** the `user` object of a fake-anchor identity's user */
export const fakeUser = (username: string, identity: 1 | 2 = 1) => userPayload({ username, homeserver: ips.fake[identity] });

type Method = 'GET' | 'POST';
/**
 * Signs requests as one of the real anchors, using its private key read out of the container (keys/ dir) and its active
 * key id from its database, e.g. to send B something only A may send. Call again after a key rotation.
 */
export async function signerFor(name: 'a' | 'b' | 'c') {
  const [key] = await pg(name)`SELECT id, "privateKeyFilename" AS file FROM homeserver_keys WHERE active ORDER BY "createdAt" DESC`;
  const { stdout } = await exec(name, `cat keys/${key!.file}`);
  const privateKeyB64 = stdout.trim();
  const homeserver = anchors[name].homeserver;
  const headersFor = (target: AnchorName, method: Method, path: string, body = '', o: { keyId?: string; homeserver?: string; privateKeyB64?: string; date?: string } = {}) =>
    signFederationRequestWith({
      privateKeyB64: o.privateKeyB64 ?? privateKeyB64,
      keyId: o.keyId ?? key!.id,
      method,
      path,
      host: new URL(anchors[target].baseUrl).host,
      homeserver: o.homeserver ?? homeserver,
      body,
      date: o.date,
    }).headers;
  return {
    keyId: key!.id as string,
    privateKeyB64,
    headersFor,
    /** signs and sends; `json` is the parsed body (or the raw text) */
    async send(target: AnchorName, method: Method, path: string, body?: unknown, o: Parameters<typeof headersFor>[4] = {}) {
      const text = body === undefined ? '' : JSON.stringify(body);
      const res = await fetch(`${api(target)}${path}`, {
        method,
        headers: { ...headersFor(target, method, path, text, o), ...(text ? { 'content-type': 'application/json' } : {}) },
        body: text || undefined,
      });
      const raw = await res.text();
      let json: any = raw;
      try {
        json = JSON.parse(raw);
      } catch {}
      return { status: res.status, json: json as any };
    },
  };
}

/**
 * a fake-anchor identity sending to a real anchor; returns the status and the parsed body. The shared stack may have seen
 * another suite break fake's discovery moments ago (anchors cache a failed discovery for 30s), so that one error is retried.
 */
export async function fakeSend(identity: 1 | 2, target: AnchorName, path: string, body: unknown, o: Parameters<typeof fake.send>[5] = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fake.send(identity, target, 'POST', path, body, o);
    if (res.status === 400 && /Could not discover/.test(res.text) && attempt < 4) {
      await Bun.sleep(10_000);
      continue;
    }
    let json: any = res.text;
    try {
      json = JSON.parse(res.text);
    } catch {}
    return { status: res.status, json };
  }
}

// ---- bridges ------------------------------------------------------------------------------------------------------

/** headers for a signed GET (empty body) on `path`, as received by `target` */
export type BridgeSigner = (target: AnchorName, path: string) => Promise<Record<string, string>>;
export const fakeBridgeSigner =
  (identity: 1 | 2 = 1, homeserver?: string): BridgeSigner =>
  async (target, path) =>
    (await fake.sign({ identity, method: 'GET', path, host: new URL(anchors[target].baseUrl).host, homeserver, body: '' })).headers;

/** opens a federation realtime bridge socket (the WS A/B open towards each other), signed by `sign` */
export async function openBridge(target: AnchorName, kind: 'guilds' | 'dms', id: string, sign: BridgeSigner) {
  const path = `/federation/realtime/${kind}/${encodeURIComponent(id)}`;
  const url = new URL(`${api(target).replace(/^http/, 'ws')}${path}`);
  for (const [k, v] of Object.entries(await sign(target, path))) url.searchParams.set(k, v);
  const events: { type: string; data?: any }[] = [];
  let closed: { code: number; reason: string } | null = null;
  const ws = new WebSocket(url);
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)));
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
    ws.onclose = (e) => {
      closed = { code: e.code, reason: e.reason };
      resolve();
    };
  });
  const prior = ws.onclose;
  ws.onclose = (e) => {
    closed = { code: e.code, reason: e.reason };
    (prior as any)?.(e);
  };
  return {
    ws,
    events,
    get closed() {
      return closed;
    },
    waitClosed: (timeout = 5000) => eventually(() => closed, { timeout, message: 'bridge close' }),
    waitFor: (type: string, timeout = 5000) => eventually(() => events.find((e) => e.type === type), { timeout, message: `bridge event ${type}` }),
    close: () => ws.close(),
  };
}

/** fed:<kind>:<homeserver>:<id> as the shadow rows are named */
export const fedGuildId = (homeserver: string, id: string) => `fed:guild:${encodeURIComponent(homeserver)}:${encodeURIComponent(id)}`;
export const fedChannelId = (homeserver: string, id: string) => `fed:channel:${encodeURIComponent(homeserver)}:${encodeURIComponent(id)}`;

/** an A guild with a B member whose realtime socket is connected and whose bridge is up (probed through typing events) */
export async function joinedRoom() {
  const owner = await signup('a');
  const { guild, channel } = await createGuild(owner, 'bridged');
  const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
  const member = await signup('b');
  const accepted = await call(member, 'POST', '/invite/accept', { code: body.invite.code, homeserver: anchors.a.homeserver });
  if (accepted.status !== 200) throw new Error(`invite accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  const shadowGuild = fedGuildId(anchors.a.homeserver, guild.id);
  const shadowChannel = fedChannelId(anchors.a.homeserver, channel.id);
  const rt = await connect(member);
  await eventually(
    async () => {
      await call(owner, 'POST', `/channel/${channel.id}/typing`);
      return rt.events.some((e) => e.type === 'channel.typing');
    },
    { timeout: 15_000, interval: 300, message: 'bridge up on b' }
  );
  return { owner, guild, channel, member, shadowGuild, shadowChannel, rt, invite: body.invite.code as string };
}
