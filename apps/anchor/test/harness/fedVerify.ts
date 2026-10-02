// Shared helpers for the federation request-verification tests (5.2, impersonation, replay, fuzz).
import { SQL } from 'bun';
import { anchors, api, canary, fake, resetHarness, restart, signup, stackIsUp, type AnchorName, type FakeIdentity, type SignInput } from './federation';
import { uniqueName } from './users';
import { eventually } from './wait';

/** public user payload of a fake-homeserver user (`homeserver` = the sender unless overridden) */
export const fakeUser = (homeserver: string, username = uniqueName('fk')) => ({
  username,
  homeserver,
  displayName: null,
  avatarUrl: null,
  avatarColor: null,
  speakingRingColor: null,
  isBot: false,
});

/** `POST /federation/unread-mentions` with an empty channel list: the cheapest request that verifies and answers 200 without writing anything,
 * as long as the user exists on the target (`ensurePingUser`; an unknown user is a verified-but-403 request) */
export const pingBody = (homeserver: string) => ({ user: fakeUser(homeserver, 'fkping'), channels: [] });
export const pingPath = '/federation/unread-mentions';

const hostOf = (target: AnchorName) => new URL(anchors[target].baseUrl).host;

/** signs once and returns what is needed to send (and re-send) the exact same request */
export async function signed(
  identity: FakeIdentity,
  target: AnchorName,
  path: string,
  body: unknown,
  sign: Partial<SignInput> = {},
  method = 'POST'
) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const { headers } = await fake.sign({ identity, method, path, host: hostOf(target), body: text, ...sign });
  return { target, path, method, headers: { ...headers, 'content-type': 'application/json' } as Record<string, string>, text };
}
export type Signed = Awaited<ReturnType<typeof signed>>;

/** sends a signed request (headers can be edited first via `mutate`); returns status and parsed body */
export async function sendSigned(s: Signed, mutate?: (headers: Record<string, string>) => void, extra: Record<string, string> = {}) {
  const headers = { ...s.headers, ...extra };
  mutate?.(headers);
  const res = await fetch(`${api(s.target)}${s.path}`, { method: s.method, headers, body: s.method === 'GET' ? undefined : s.text });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text) as { error?: string }; } catch { return null; } })() };
}

/** one-shot: sign + send */
export const sendFrom = async (identity: FakeIdentity, target: AnchorName, path: string, body: unknown, sign: Partial<SignInput> = {}) =>
  sendSigned(await signed(identity, target, path, body, sign));

export const dbUrl = (name: AnchorName) => `postgresql://novarum:novarum@${anchors[name].pg}:5432/${anchors[name].db}`;

/** runs `fn` with a connection to the anchor's database (the stack's postgres at 172.30.0.5) */
export async function withDb<T>(name: AnchorName, fn: (sql: SQL) => Promise<T>) {
  const sql = new SQL(dbUrl(name));
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

/** row count of every public table, minus the ones federation traffic legitimately touches (nonces) or that live traffic changes (sessions) */
export async function rowCounts(name: AnchorName, skip = ['federation_nonce', 'session']) {
  return withDb(name, async (sql) => {
    const tables = (await sql`select tablename from pg_tables where schemaname = 'public' order by 1`) as { tablename: string }[];
    const counts: Record<string, number> = {};
    for (const { tablename } of tables) {
      if (skip.includes(tablename)) continue;
      const [row] = (await sql.unsafe(`select count(*)::int as n from "${tablename}"`)) as { n: number }[];
      counts[tablename] = row!.n;
    }
    return counts;
  });
}

/** `restart(name)` plus a wait until the anchor's canary sidecar (a, p) answers again, so a following `resetHarness()` cannot hit a restarting canary */
export async function restartAnchor(name: AnchorName) {
  await restart(name);
  if (name === 'a' || name === 'p') await eventually(async () => (await canary.hits(name), true), { timeout: 20_000, message: `canary-${name} up` });
}

/** makes `fkping@<identity homeserver>` exist on `target` (a friend request from it to a fresh local user upserts it) */
export async function ensurePingUser(target: AnchorName, identity: FakeIdentity) {
  const peer = (await signup(target)).user.username;
  const homeserver = fake.identityInfo(identity).homeserver;
  const body = { commandId: crypto.randomUUID(), actor: fakeUser(homeserver, 'fkping'), peerUsername: peer, action: 'REQUEST', expectedVersion: 0 };
  const res = await sendFrom(identity, target, '/federation/friends/command', body);
  if (res.status !== 200) throw new Error(`could not create the ping user: ${res.status} ${res.text}`);
  const ping = await sendFrom(identity, target, pingPath, pingBody(homeserver));
  if (ping.status !== 200) throw new Error(`ping user not usable: ${ping.status} ${ping.text}`);
}

/** case-insensitive header edit on a plain record: `value` undefined removes it */
export function editHeader(headers: Record<string, string>, name: string, value?: string) {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  if (value !== undefined) headers[name] = value;
}

/** stackIsUp + wait until every harness process (incl. canary sidecars another test may have just restarted) answers a reset */
export async function ready() {
  await stackIsUp();
  await eventually(async () => (await resetHarness(), true), { timeout: 30_000, message: 'harness reset' });
}
