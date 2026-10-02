// Helpers for the SSRF matrix (TESTING_PLAN.md 5.4): drives the trigger table T1-T6 against any of the real anchors
// (anchor-q is only reachable through `fetchIn`, so every request goes through `call`, which hides that).
import { createHash, randomUUID } from 'node:crypto';
import { SQL } from 'bun';
import { expect } from 'bun:test';
import { z } from 'zod';
import { anchors, api, canary, compose, dns, exec, fake, fetchIn, ips, restart, type AnchorName } from './federation';
import { freshIp, uniqueName } from './users';
import { eventually } from './wait';

export type Probe = { status: number; text: string };

/** one request to an anchor; anchor-q goes through fetchIn (docker exec) */
export async function call(
  name: AnchorName,
  path: string,
  { method = 'GET', headers = {}, json, body }: { method?: string; headers?: Record<string, string>; json?: unknown; body?: string } = {}
): Promise<Probe & { setCookie: string }> {
  const payload = json === undefined ? body : JSON.stringify(json);
  const h = { ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  if (name !== 'q') {
    const r = await fetch(api(name) + path, { method, headers: h, body: payload });
    return { status: r.status, text: await r.text(), setCookie: r.headers.getSetCookie().join(', ') };
  }
  const r = await fetchIn('q', `http://127.0.0.1${path}`, { method, headers: h, body: payload, timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`call(q ${path}): ${r.error}`);
  return { status: r.status, text: r.body, setCookie: r.headers['set-cookie'] ?? '' };
}

/** runs a script with bun inside a container and returns the last JSON line it printed. HTTP(S)_PROXY is dropped unless `env` sets it */
export async function bunIn(service: Parameters<typeof exec>[0], script: string, arg: unknown = null, env: Record<string, string | null> = {}) {
  const e = { HTTP_PROXY: null, HTTPS_PROXY: null, ...env };
  const unset = Object.entries(e).filter(([, v]) => v === null).flatMap(([k]) => ['-u', k]);
  const set = Object.entries(e).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`);
  const res = await exec(service, ['env', ...unset, ...set, 'bun', '-e', script, JSON.stringify(arg)]);
  try {
    return JSON.parse(res.stdout.trim().split('\n').pop()!) as any;
  } catch {
    throw new Error(`bunIn(${service}) failed: ${res.stderr}${res.stdout}`);
  }
}

export const pgFor = (name: AnchorName) => new SQL(`postgresql://novarum:novarum@${ips.postgres}:5432/${anchors[name].db}`);

const signupResponse = z.object({ user: z.object({ id: z.string() }) });

/** a fresh local user on one anchor, with an authenticated request helper */
export async function makeActor(name: AnchorName) {
  const username = uniqueName('s');
  const res = await call(name, '/auth/signup', {
    method: 'POST',
    headers: { 'x-forwarded-for': freshIp() },
    json: { username, email: `${username}@example.test`, password: 'correct-horse-battery' },
  });
  if (res.status !== 200) throw new Error(`signup on ${name} failed: ${res.status} ${res.text}`);
  const cookie = /session_token=([^;,\s]+)/.exec(res.setCookie)![1]!;
  const id = signupResponse.parse(JSON.parse(res.text)).user.id;
  return {
    name,
    id,
    username,
    as: (path: string, init: Parameters<typeof call>[2] = {}) => call(name, path, { ...init, headers: { cookie: `session_token=${cookie}`, ...init.headers } }),
  };
}
export type Actor = Awaited<ReturnType<typeof makeActor>>;

/** a shadow guild with one channel for `homeserver`, seeded straight into the anchor's database with `actor` as its only member */
export async function seedShadow(pg: SQL, actor: Actor, homeserver: string) {
  const tag = randomUUID().slice(0, 8);
  const guildId = `fed:guild:${encodeURIComponent(homeserver)}:g${tag}`;
  const channelId = `fed:channel:${encodeURIComponent(homeserver)}:c${tag}`;
  await pg`insert into guild (id, name, "ownerId") values (${guildId}, 'shadow', ${actor.id})`;
  await pg`insert into guild_member ("guildId", "userId", position) values (${guildId}, ${actor.id}, 0)`;
  await pg`insert into channel (id, "guildId", name) values (${channelId}, ${guildId}, 'general')`;
  return { guildId, channelId };
}

/** removes the shadow guilds (and, by cascade, their channels and memberships) that `actor` was seeded into */
export const dropShadows = (pg: SQL, actor: Actor) => pg`delete from guild where "ownerId" = ${actor.id} and id like 'fed:guild:%'`;

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64');

/** all federation headers present, fresh date and nonce, garbage signature: enough to reach discovery (verifyFederationRequest) */
export const garbageFederationHeaders = (homeserver: string, body = '') => ({
  'X-Novarum-Homeserver': homeserver,
  'X-Novarum-Key-Id': 'garbage-key',
  'X-Novarum-Date': new Date().toISOString(),
  'X-Novarum-Nonce': randomUUID(),
  'X-Novarum-Body-SHA256': sha256(body),
  'X-Novarum-Signature': 'garbage',
});

const wsScript = `
  const url = JSON.parse(process.argv[1]);
  const done = (status, text) => { console.log(JSON.stringify({ status, text })); process.exit(0); };
  const ws = new WebSocket(url);
  setTimeout(() => done(-1, 'timeout'), 20000);
  ws.onclose = (e) => done(e.code, e.reason);
  ws.onerror = () => done(0, 'error');`;

/** opens the unauthenticated bridge WebSocket on an anchor; resolves with the close code (1008 = refused) */
export async function bridgeSocket(name: AnchorName, homeserver: string, guildId = 'x'): Promise<Probe> {
  const query = new URLSearchParams(garbageFederationHeaders(homeserver));
  const path = `/federation/realtime/guilds/${guildId}?${query}`;
  if (name === 'q') return bunIn('q', wsScript, `ws://127.0.0.1${path}`);
  const url = `${api(name).replace(/^http/, 'ws')}${path}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => (ws.close(), resolve({ status: -1, text: 'timeout' })), 20_000);
    const finish = (status: number, text: string) => (clearTimeout(timer), resolve({ status, text }));
    ws.onclose = (e) => finish(e.code, e.reason);
    ws.onerror = () => finish(0, 'error');
  });
}

type Ctx = { actor: Actor; pg: SQL };
const asciiOnly = (s: string) => /^[\x00-\xff]*$/.test(s);

/**
 * Plan 5.4 triggers. Each returns every probe the trigger made (T6 makes several), so a test can assert all of them
 * failed cleanly. `status` is the HTTP status, or the WebSocket close code for T2.
 */
export const triggers = {
  /** T1: pre-auth discovery. Skipped (null) for names that cannot be put into an HTTP header */
  T1: async ({ actor }: Ctx, hs: string) =>
    asciiOnly(hs) ? [await call(actor.name, '/federation/friends/command', { method: 'POST', body: '{}', headers: { ...garbageFederationHeaders(hs, '{}'), 'content-type': 'application/json' } })] : null,
  T2: async ({ actor }: Ctx, hs: string) => [await bridgeSocket(actor.name, hs)],
  T3: async ({ actor }: Ctx, hs: string) => [await actor.as('/friends/request', { method: 'POST', json: { username: 'alice', homeserver: hs } })],
  T4: async ({ actor }: Ctx, hs: string) => [await actor.as('/invite/accept', { method: 'POST', json: { code: 'code1', homeserver: hs } })],
  T5: async ({ actor, pg }: Ctx, hs: string) => {
    await seedShadow(pg, actor, hs);
    return [await actor.as('/guilds/list')];
  },
  T6: async ({ actor, pg }: Ctx, hs: string) => {
    const { channelId: c } = await seedShadow(pg, actor, hs);
    return [
      await actor.as('/message/send', { method: 'POST', json: { channelId: c, content: 'hi', nonce: randomUUID() } }),
      await actor.as(`/channel/${encodeURIComponent(c)}/typing`, { method: 'POST' }),
      await actor.as(`/channel/${encodeURIComponent(c)}/call/token`),
      await actor.as(`/channel/${encodeURIComponent(c)}/users`),
    ];
  },
};
export type TriggerName = keyof typeof triggers;
export const triggerNames = Object.keys(triggers) as TriggerName[];

/** the clean-failure statuses of each trigger when the target is refused */
export const refusedStatus: Record<TriggerName, number> = { T1: 400, T2: 1008, T3: 502, T4: 502, T5: 200, T6: 502 };

/** runs the given triggers (default all) against one target and returns `{T1: [...], ...}` */
export async function runTriggers(ctx: Ctx, hs: string, names: readonly TriggerName[] = triggerNames) {
  const out: Partial<Record<TriggerName, Probe[]>> = {};
  for (const n of names) {
    const r = await triggers[n](ctx, hs);
    if (r) out[n] = r;
  }
  return out;
}

/** every probe of every trigger failed the way a refused target fails (a flat `{trigger: [status...]}` view makes mismatches readable) */
export function statuses(results: Partial<Record<TriggerName, Probe[]>>) {
  return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v!.map((p) => p.status)]));
}
export function expectedStatuses(results: Partial<Record<TriggerName, Probe[]>>) {
  return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v!.map(() => refusedStatus[k as TriggerName])]));
}

/** service log lines written since `since` */
export async function logsSince(service: Parameters<typeof exec>[0], since: Date) {
  const serviceName = service in anchors ? anchors[service as AnchorName].service : service;
  const { stdout, stderr } = await compose(['logs', '--no-color', '--no-log-prefix', '--since', since.toISOString(), serviceName], { allowFail: true });
  return stdout + stderr;
}

/** publishes `evil.test` as a well-formed public homeserver (discovery says homeserver=evil.test, baseUrl=https://evil.test unless overridden) */
export const publicDiscovery = (discovery: Record<string, unknown> = {}, identity: 1 | 2 = 1) =>
  fake.respond(identity, '/.well-known/anchor/info', {
    discovery: { homeserver: identity === 1 ? 'evil.test' : 'evil2.test', baseUrl: identity === 1 ? 'https://evil.test' : 'https://evil2.test', ...discovery },
  });

/**
 * what reached any canary or either fake identity, as readable strings. Friend-sync retries and bridge reconnects that other
 * suites leave pending in the shared databases are not ours: only traffic addressed to a public name (https, evil.test...) is counted
 */
export async function strayTraffic(ignore?: RegExp) {
  const [hits, f1, f2] = await Promise.all([canary.allHits(), fake.requests(1), fake.requests(2)]);
  const seen = (rs: typeof f1) => rs.filter((r) => !r.path.startsWith('/federation/friends/sync') && !ignore?.test(r.path) && !r.host.startsWith('172.30.')).map((r) => `${r.method} ${r.host}${r.path}`);
  return { canary: hits, fake1: seen(f1), fake2: seen(f2) };
}
export const noStray = { canary: [], fake1: [], fake2: [] };

/** clears dns/canaries/fake and the query log between rows */
export const clean = async () => {
  await Promise.all([fake.reset(), dns.reset(), canary.reset()]);
};

/**
 * Runs the triggers against a target that must be refused: every probe fails cleanly (no 500), nothing reaches a canary or
 * the fakes, and (with `reason`) the anchor's log names why. The log line is written by the first trigger that reaches
 * discovery; later ones hit the 30s failure cache, so the reason is only checked once.
 */
export async function expectRefused(ctx: Ctx, hs: string, { reason, logHost = hs, names, ignoreFake }: { reason?: string | RegExp; logHost?: string; names?: readonly TriggerName[]; ignoreFake?: RegExp } = {}) {
  const since = new Date();
  const results = await runTriggers(ctx, hs, names);
  expect(statuses(results)).toEqual(expectedStatuses(results));
  expect(await strayTraffic(ignoreFake)).toEqual(noStray);
  if (reason) {
    const prefix = `https://${logHost}/.well-known/anchor/info: `;
    const matches = (l: string) => l.includes(prefix) && (typeof reason === 'string' ? l.includes(prefix + reason) : reason.test(l));
    await eventually(async () => (await logsSince(ctx.actor.name, since)).split('\n').some(matches), { timeout: 10_000, message: `log line "${prefix}${reason}"` });
  }
  return results;
}

/** restarts an anchor (empty discovery cache, no bridge timers) and waits until its canary sidecar answers again, then resets the harness */
export async function freshAnchor(name: AnchorName) {
  await restart(name);
  if (name === 'p' || name === 'a') await eventually(() => canary.hits(name).then(() => true), { timeout: 20_000, message: `canary-${name} up` });
  await clean();
}

/** resident memory (MB) of an anchor process, from /proc/1/status inside its container (`bun run src/index.ts` is PID 1) */
export async function rssMb(name: AnchorName) {
  const { stdout } = await exec(name, 'grep VmRSS /proc/1/status');
  return Number(/(\d+)\s*kB/.exec(stdout)?.[1]) / 1024;
}

/** runs `fn(i)` for i in [0, n) with at most `limit` in flight */
export async function pool<T>(n: number, limit: number, fn: (i: number) => Promise<T>) {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < n) {
        const i = next++;
        out[i] = await fn(i);
      }
    })
  );
  return out;
}
