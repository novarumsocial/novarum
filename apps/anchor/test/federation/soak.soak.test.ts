import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { anchors, exec, federationDir, logs, resetHarness, restart, signup, stackIsUp } from '../harness/federation';
import { closePg, fedChannelId, fedGuildId, pg } from '../harness/fedflows';
import { cookieName, type TestUser } from '../harness/users';
import { eventually } from '../harness/wait';

// TESTING_PLAN §8 federation soak (weekly / manual): 3 anchors, simulated users, mixed traffic, anchor-b restarts,
// clients reconnecting. Run it with `FED_SUITE=soak bun test/federation/run.ts`, or against a running stack:
//   SOAK_USERS=10 SOAK_MINUTES=2 SOAK_B_RESTART_MINUTES=1 flock <lock> bun test test/federation/soak.soak.test.ts
//
// Process-internal state (activeBridges, bridgedVoicePresence, activeRealtimeConnections, pingIntervals) is not exposed, so memory is
// judged from outside: RSS and established sockets are read from /proc inside each container, the nonce table from its database.
const env = z
  .object({
    SOAK_USERS: z.coerce.number().int().min(6).default(200),
    SOAK_MINUTES: z.coerce.number().positive().default(30),
    SOAK_B_RESTART_MINUTES: z.coerce.number().min(0).default(5), // 0 disables restarts
    SOAK_ACTION_SECONDS: z.coerce.number().positive().default(8), // mean time between one user's actions
    SOAK_RECONNECT_SECONDS: z.coerce.number().positive().default(150), // mean time between one user's socket reconnects
    SOAK_SAMPLE_SECONDS: z.coerce.number().positive().default(15),
  })
  .parse(process.env);
const durationMs = env.SOAK_MINUTES * 60_000;
const deliverMs = 20_000; // a delivery counts as live when it arrives within this
const outageGraceMs = { before: 3_000, after: 45_000 }; // anchor-b outage window extended by the bridge backoff (1s, 2s, 4s ... after b is back)
const runId = Date.now().toString(36);
type Home = 'a' | 'b' | 'c';
const homes: Home[] = ['a', 'b', 'c'];

const rand = (n: number) => Math.floor(Math.random() * n);
const jitter = (meanMs: number) => meanMs * (0.5 + Math.random());
const pick = <T>(xs: T[]) => xs[rand(xs.length)]!;
const log = (...args: unknown[]) => console.log(`[soak +${Math.round((Date.now() - t0) / 1000)}s]`, ...args);
let t0 = Date.now();

// ---- model ------------------------------------------------------------------------------------------------------
type Guild = { host: Home; id: string; members: Sim[] };
type Membership = { guild: Guild; guildId: string; channelId: string; mi: number };
type Sent = { guild: Guild; sentAt: number; ok: boolean; got: Uint8Array };
type Sim = {
  idx: number;
  home: Home;
  user: TestUser;
  memberships: Membership[];
  ws: WebSocket | null;
  /** periods in which the socket was not subscribed (between close and the connect snapshot) */
  gaps: [number, number][];
  gapStart: number | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
};

const sims: Sim[] = [];
const guilds = new Map<Home, Guild>();
const sent = new Map<string, Sent>();
const stats = { messages: 0, messageFailures: 0, typing: 0, churn: 0, churnFailures: 0, connects: { a: 0, b: 0, c: 0 } as Record<Home, number>, connectFailures: 0, duplicates: 0, events: 0, dupBy: {} as Record<string, number> };
const outages: [number, number][] = [];
let running = false;
let seq = 0;

const urlOf = (h: Home) => anchors[h].url;

// ---- websocket clients ------------------------------------------------------------------------------------------
const eventSchema = z.object({ type: z.string(), data: z.object({ nonce: z.string().optional() }).loose().optional() });

function connect(sim: Sim, attempt = 0) {
  if (!running || sim.ws) return;
  stats.connects[sim.home]++;
  if (sim.gapStart === null) sim.gapStart = Date.now();
  const ws = new WebSocket(`${urlOf(sim.home).replace(/^http/, 'ws')}/realtime`, { headers: { cookie: `${cookieName}=${sim.user.cookie}` } } as any);
  sim.ws = ws;
  let ready = false;
  ws.onmessage = (e) => {
    const parsed = eventSchema.safeParse(JSON.parse(String(e.data)));
    if (!parsed.success) return;
    stats.events++;
    const { type, data } = parsed.data;
    if (type === 'voice.states.snapshot' && !ready) {
      ready = true;
      sim.gaps.push([sim.gapStart!, Date.now()]);
      sim.gapStart = null;
      // a client refreshes its guild list when it connects; this is also what recreates the remote guild bridges after a restart of this anchor
      void sim.user.fetch('/guilds/list').then((r) => r.arrayBuffer()).catch(() => {});
      sim.reconnectTimer = setTimeout(() => cycle(sim), jitter(env.SOAK_RECONNECT_SECONDS * 1000));
    }
    if (type === 'message.created' && data?.nonce) {
      const rec = sent.get(data.nonce);
      const m = rec && sim.memberships.find((x) => x.guild === rec.guild);
      if (!rec || !m) return;
      if (rec.got[m.mi]!++ > 0) {
        stats.duplicates++;
        const k = `${rec.guild.host}-guild -> ${sim.home}-user`;
        stats.dupBy[k] = (stats.dupBy[k] ?? 0) + 1;
      }
    }
  };
  ws.onclose = () => {
    if (sim.ws !== ws) return;
    sim.ws = null;
    if (sim.reconnectTimer) clearTimeout(sim.reconnectTimer);
    if (!ready) stats.connectFailures++;
    // like a real client: back off 1s, 2s, 4s ... capped at 5s, with jitter
    setTimeout(() => connect(sim, ready ? 0 : attempt + 1), Math.min(1000 * 2 ** (ready ? 0 : attempt), 5000) * (0.5 + Math.random()));
  };
  ws.onerror = () => {};
}

/** the periodic client-side reconnect: drop the socket, onclose opens a new one */
function cycle(sim: Sim) {
  if (!running || !sim.ws) return;
  sim.gapStart = Date.now();
  sim.ws.close();
}

// ---- traffic ----------------------------------------------------------------------------------------------------
const words = ['hello', 'federation', 'soak', 'ünïcödé', '👋', 'ping', 'ok', 'lgtm', '日本語', 'bridge'];
const text = () => Array.from({ length: 1 + rand(30) }, () => pick(words)).join(' ');

async function sendMessage(sim: Sim) {
  const m = pick(sim.memberships);
  const nonce = `soak-${runId}-${seq++}`;
  const rec: Sent = { guild: m.guild, sentAt: Date.now(), ok: false, got: new Uint8Array(m.guild.members.length) };
  sent.set(nonce, rec);
  stats.messages++;
  const res = await sim.user.fetch('/message/send', { method: 'POST', body: JSON.stringify({ channelId: m.channelId, content: text(), nonce }) }).catch(() => null);
  await res?.arrayBuffer().catch(() => {});
  rec.ok = res?.status === 200;
  if (!rec.ok) stats.messageFailures++;
}

async function typing(sim: Sim) {
  stats.typing++;
  await sim.user.fetch(`/channel/${encodeURIComponent(pick(sim.memberships).channelId)}/typing`, { method: 'POST' }).then((r) => r.arrayBuffer()).catch(() => {});
}

/** request, accept, remove between two random users (usually on different anchors) */
async function churn(sim: Sim) {
  const other = pick(sims.filter((s) => s !== sim));
  stats.churn++;
  const call = async (u: Sim, method: string, p: string, body?: unknown) => {
    const res = await u.user.fetch(p, { method, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    return { status: res?.status ?? 0, json: json as any };
  };
  const idOn = async (viewer: Sim, who: Sim) => {
    const l = (await call(viewer, 'GET', '/friends')).json;
    const all = [...(l?.accepted ?? []), ...(l?.incoming ?? []), ...(l?.outgoing ?? [])];
    return all.find((e: any) => e.user.username === who.user.user.username)?.user.userId as string | undefined;
  };
  try {
    const req = await call(sim, 'POST', '/friends/request', { username: other.user.user.username, homeserver: other.user.user.homeserver });
    if (req.status !== 200) return void stats.churnFailures++;
    const id = await eventually(() => idOn(other, sim), { timeout: 10_000, message: 'incoming request' });
    if ((await call(other, 'POST', `/friends/requests/${id}/accept`)).status !== 200) stats.churnFailures++;
    await Bun.sleep(500 + rand(3000));
    const mine = await idOn(sim, other);
    if (mine && (await call(sim, 'DELETE', `/friends/${mine}`)).status !== 200) stats.churnFailures++;
  } catch {
    stats.churnFailures++;
  }
}

async function userLoop(sim: Sim) {
  await Bun.sleep(rand(env.SOAK_ACTION_SECONDS * 1000));
  while (running) {
    const r = Math.random();
    if (r < 0.55) await sendMessage(sim);
    else if (r < 0.8) await typing(sim);
    else if (r < 0.9) await churn(sim);
    await Bun.sleep(jitter(env.SOAK_ACTION_SECONDS * 1000));
  }
}

async function restarter() {
  if (!env.SOAK_B_RESTART_MINUTES) return;
  const every = env.SOAK_B_RESTART_MINUTES * 60_000;
  // keep the last stretch calm so the final delivery check is not dominated by an outage
  for (let next = t0 + every; running && next < t0 + durationMs - 60_000; next += every) {
    while (running && Date.now() < next) await Bun.sleep(500);
    if (!running) return;
    const start = Date.now();
    log('restarting anchor-b');
    await restart('b');
    outages.push([start, Date.now()]);
    log(`anchor-b back after ${Date.now() - start}ms`);
  }
}

// ---- measurements -----------------------------------------------------------------------------------------------
type Sample = { t: number; rssMb: Record<Home, number>; established: Record<Home, { host: number; peers: number }>; nonces: Record<Home, { rows: number; stale: number }>; openWs: number };
const samples: Sample[] = [];
const peerIps = new Set<string>(homes.map((h) => anchors[h].ip));
const hexIp = (h: string) => [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join('.');
const nonceMaxAgeSeconds = 300; // test/federation/.run/config/*/config.toml (the stack default)

/** RSS (largest process) and the ESTABLISHED sockets on :80 of one container, split into those from other anchors and the rest (the clients) */
async function inspect(h: Home) {
  const res = await exec(h, 'grep -h VmRSS /proc/[0-9]*/status; echo ---; cat /proc/net/tcp /proc/net/tcp6');
  const [mem = '', tcp = ''] = res.stdout.split('---\n');
  const rssKb = Math.max(0, ...[...mem.matchAll(/VmRSS:\s+(\d+)/g)].map((m) => Number(m[1])));
  const established = { host: 0, peers: 0 };
  for (const line of tcp.split('\n').slice(1)) {
    const [, local, remote, state] = line.trim().split(/\s+/);
    if (state !== '01' || !local?.endsWith(':0050')) continue;
    // tcp6 lists IPv4 peers as ::ffff:a.b.c.d (the last 8 hex digits, same byte order as /proc/net/tcp)
    peerIps.has(hexIp(remote!.split(':')[0]!.slice(-8))) ? established.peers++ : established.host++;
  }
  return { rssMb: rssKb / 1024, established };
}

async function nonceRows(h: Home) {
  const [row] = await pg(h)`SELECT count(*)::int AS rows, (count(*) FILTER (WHERE "createdAt" < now() - make_interval(secs => ${nonceMaxAgeSeconds + 150})))::int AS stale FROM federation_nonce`;
  return row as { rows: number; stale: number };
}

async function sample() {
  const [a, b, c] = await Promise.all(homes.map(inspect));
  const [na, nb, nc] = await Promise.all(homes.map(nonceRows));
  const s: Sample = {
    t: Date.now() - t0,
    rssMb: { a: a!.rssMb, b: b!.rssMb, c: c!.rssMb },
    established: { a: a!.established, b: b!.established, c: c!.established },
    nonces: { a: na!, b: nb!, c: nc! },
    openWs: sims.filter((x) => x.ws?.readyState === WebSocket.OPEN).length,
  };
  samples.push(s);
  log(`rss(MB) a=${s.rssMb.a.toFixed(0)} b=${s.rssMb.b.toFixed(0)} c=${s.rssMb.c.toFixed(0)} | sockets host/peers a=${s.established.a.host}/${s.established.a.peers} b=${s.established.b.host}/${s.established.b.peers} c=${s.established.c.host}/${s.established.c.peers} | open ws=${s.openWs} | nonce rows a=${na!.rows} b=${nb!.rows} c=${nc!.rows} | msgs=${stats.messages} fail=${stats.messageFailures} events=${stats.events}`);
}

// ---- setup ------------------------------------------------------------------------------------------------------
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => { while (queue.length) await fn(queue.shift()!); }));
}

async function setup() {
  await pool(Array.from({ length: env.SOAK_USERS }, (_, idx) => idx), 8, async (idx) => {
    const home = homes[idx % 3]!;
    sims[idx] = { idx, home, user: await signup(home), memberships: [], ws: null, gaps: [], gapStart: null, reconnectTimer: null };
  });

  // one guild per anchor, owned by the first user homed there
  for (const h of homes) {
    const owner = sims[homes.indexOf(h)]!;
    const created = await owner.user.fetch('/guilds/create', { method: 'POST', body: JSON.stringify({ name: `soak-${h}` }) });
    const { guild } = (await created.json()) as { guild: { id: string } };
    guilds.set(h, { host: h, id: guild.id, members: [] });
  }
  const invites = new Map<Home, string>();
  for (const [h, g] of guilds) {
    const res = await sims[homes.indexOf(h)]!.user.fetch(`/guilds/${g.id}/invites`, { method: 'POST', body: '{}' });
    invites.set(h, ((await res.json()) as { invite: { code: string } }).invite.code);
  }

  // every user joins two of the three guilds, so every guild has members from every anchor
  const wants = (sim: Sim) => homes.filter((h) => !(h === homes[Math.floor(sim.idx / 3) % 3] && sim.idx >= 3) && !(h === sim.home && sim.idx < 3)); // owners already are in their own guild
  const joined = new Set<string>();
  const join = async (sim: Sim, h: Home) => {
    joined.add(`${sim.idx}${h}`);
    const res = await sim.user.fetch('/invite/accept', { method: 'POST', body: JSON.stringify({ code: invites.get(h), ...(h === sim.home ? {} : { homeserver: anchors[h].homeserver }) }) });
    if (res.status !== 200) throw new Error(`user ${sim.idx} (${sim.home}) could not join guild ${h}: ${res.status} ${await res.text()}`);
  };
  // the first remote join of a guild per anchor goes alone: concurrent first joins race on the shadow guild insert (see join-race.test.ts)
  for (const h of homes) for (const r of homes) {
    const first = sims.find((x) => x.home === r && r !== h && wants(x).includes(h));
    if (first) await join(first, h);
  }
  await pool(sims, 8, async (sim) => {
    for (const h of wants(sim)) if (!joined.has(`${sim.idx}${h}`)) await join(sim, h);
    const list = (await (await sim.user.fetch('/guilds/list')).json()) as { guilds: { id: string; channels: { id: string }[] }[] };
    for (const [h, g] of guilds) {
      const id = h === sim.home ? g.id : fedGuildId(anchors[h].homeserver, g.id);
      const entry = list.guilds.find((x) => x.id === id);
      if (!entry) continue;
      sim.memberships.push({ guild: g, guildId: id, channelId: entry.channels[0]!.id, mi: -1 });
    }
  });
  // member index per guild (stable order), used by the delivery bitsets
  for (const sim of sims) for (const m of sim.memberships) m.mi = m.guild.members.push(sim) - 1;
  const bad = sims.filter((s) => s.memberships.length < 2);
  if (bad.length) throw new Error(`${bad.length} users are missing guild memberships, e.g. user ${bad[0]!.idx} (${bad[0]!.home}) has ${bad[0]!.memberships.length}`);
  log(`setup done: ${sims.length} users, guild members ${[...guilds.values()].map((g) => `${g.host}:${g.members.length}`).join(' ')}`);
}

beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(async () => {
  running = false;
  for (const s of sims) {
    if (s?.reconnectTimer) clearTimeout(s.reconnectTimer);
    s?.ws?.close();
  }
  await closePg();
  // leave the stack as found: anchor-b is restarted synchronously by the harness, so nothing is stopped here
});

// ---- the soak ---------------------------------------------------------------------------------------------------
test(
  `federation soak: ${env.SOAK_USERS} users, ${env.SOAK_MINUTES} min, anchor-b restart every ${env.SOAK_B_RESTART_MINUTES || 'never'} min`,
  async () => {
    await setup();
    t0 = Date.now();
    running = true;
    // stagger the first connects: 200 simultaneous handshakes on a shared CI runner is a thundering herd, not the steady state we soak
    sims.forEach((sim, i) => setTimeout(() => connect(sim), (i * 10_000) / sims.length));
    await eventually(() => sims.every((s) => s.ws?.readyState === WebSocket.OPEN && s.gapStart === null), { timeout: 120_000, message: 'all clients connected' });
    for (const s of sims) s.gaps.length = 0;
    t0 = Date.now();

    const loops = [...sims.map(userLoop), restarter()];
    const sampler = (async () => {
      while (running) {
        await sample().catch((e) => log('sample failed', String(e)));
        await Bun.sleep(env.SOAK_SAMPLE_SECONDS * 1000);
      }
    })();
    while (Date.now() < t0 + durationMs) await Bun.sleep(1000);
    running = false;
    await Promise.all([...loops, sampler]);
    const endedAt = Date.now();

    // drain: connections stay up while late deliveries arrive (b may still be recovering its bridges)
    await Bun.sleep(deliverMs + 5_000);
    const final = await Promise.all(homes.map(inspect));
    log(`traffic stopped; ${sent.size} messages sent`);
    for (const sim of sims) sim.ws?.close(); // the socket accounting below needs every client gone

    // ---- message loss ----
    const excused = (rec: Sent, sim: Sim) => {
      const window: [number, number] = [rec.sentAt, rec.sentAt + deliverMs];
      const overlaps = (p: [number, number], pad = 0, after = 0) => p[0] - pad < window[1] && p[1] + after > window[0];
      if (sim.gaps.some((g) => overlaps(g)) || (sim.gapStart !== null && sim.gapStart < window[1])) return true; // not subscribed at the time
      const touchesB = rec.guild.host === 'b' || sim.home === 'b';
      return touchesB && outages.some((o) => overlaps(o, outageGraceMs.before, outageGraceMs.after));
    };
    let expected = 0;
    let liveMisses = 0;
    let excusedMisses = 0;
    const hard: string[] = [];
    const missed = new Map<string, Sent>();
    for (const [nonce, rec] of sent) {
      if (!rec.ok || rec.sentAt > endedAt - deliverMs) continue;
      rec.guild.members.forEach((sim, mi) => {
        expected++;
        if (rec.got[mi]) return;
        missed.set(nonce, rec);
        if (excused(rec, sim)) excusedMisses++;
        else { liveMisses++; if (hard.length < 15) hard.push(`${nonce} ${rec.guild.host}-guild -> user ${sim.idx} (${sim.home})`); }
      });
    }
    // everything that was sent (200) must also be stored on the guild's host, whatever the clients saw
    const stored = new Set<string>();
    for (const h of homes) for (const row of await pg(h)`SELECT nonce FROM message WHERE nonce LIKE ${`soak-${runId}-%`}`) stored.add(row.nonce as string);
    const lost = [...sent].filter(([nonce, rec]) => rec.ok && !stored.has(nonce)).map(([nonce]) => nonce);

    // ---- sockets, memory, nonces, reconnects ----
    const quiet = await eventually(async () => {
      const now = await Promise.all(homes.map(inspect));
      return now.every((x) => x.established.host <= 25) ? now : null;
    }, { timeout: 90_000, message: 'client sockets closed after the run' }).catch(() => null);
    const connectsExpected = env.SOAK_USERS * (1 + (2 * durationMs) / (env.SOAK_RECONNECT_SECONDS * 1000)) + outages.length * env.SOAK_USERS * 6;
    const connectsTotal = stats.connects.a + stats.connects.b + stats.connects.c;
    const appLogs = await Promise.all(homes.map((h) => logs(h)));
    const crashes = appLogs.map((l) => l.match(/Unhandled|uncaught|panic|Segmentation/gi)?.length ?? 0);

    const peak = (f: (s: Sample) => number) => Math.max(0, ...samples.map(f));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
    const quarter = Math.floor(samples.length / 4);
    const growth = Object.fromEntries((['a', 'c'] as Home[]).map((h) => [h, { early: avg(samples.slice(quarter, quarter * 2).map((s) => s.rssMb[h])), late: avg(samples.slice(-quarter).map((s) => s.rssMb[h])) }]));

    const metrics = {
      params: env,
      runId,
      messages: { sent: sent.size, failed: stats.messageFailures, expectedDeliveries: expected, liveMisses, excusedMisses, duplicates: stats.duplicates, duplicatesBy: stats.dupBy, lost },
      typing: stats.typing,
      friendChurn: { runs: stats.churn, failures: stats.churnFailures },
      connects: { ...stats.connects, failures: stats.connectFailures, expectedAtMost: Math.round(connectsExpected) },
      outages: outages.map(([s, e]) => ({ startS: Math.round((s - t0) / 1000), durationMs: e - s })),
      peaks: { rssMb: Object.fromEntries(homes.map((h) => [h, Math.round(peak((s) => s.rssMb[h]))])), peerSockets: Object.fromEntries(homes.map((h) => [h, peak((s) => s.established[h].peers)])), nonceRows: Object.fromEntries(homes.map((h) => [h, peak((s) => s.nonces[h].rows)])) },
      rssGrowthMb: growth,
      finalClientSockets: Object.fromEntries(homes.map((h, i) => [h, (quiet ?? final)[i]!.established.host])),
      crashes,
      samples,
    };
    mkdirSync(path.join(federationDir, 'artifacts'), { recursive: true });
    writeFileSync(path.join(federationDir, 'artifacts', 'soak-metrics.json'), JSON.stringify(metrics, null, 1));
    log(`result: ${JSON.stringify({ ...metrics, samples: undefined })}`);

    // no message loss: persisted, and live to every subscriber that was connected and not behind an anchor-b outage
    expect(lost, 'messages answered 200 but not stored').toEqual([]);
    expect(hard, `${liveMisses} of ${expected} live deliveries missing`).toEqual([]);
    expect(expected).toBeGreaterThan(0);
    // sockets: nothing is left open server-side once every client is gone (the per-socket ping interval is cleared on close)
    expect(quiet, 'client sockets still open after every client disconnected').not.toBeNull();
    // bounded federation_nonce table: cleanup works (nothing older than max age + cleanup interval), and no runaway growth
    for (const h of homes) expect(samples.every((s) => s.nonces[h].stale === 0), `stale nonce rows on ${h}`).toBe(true);
    const nonceCap = Math.max(50_000, 50 * env.SOAK_USERS * env.SOAK_MINUTES);
    for (const h of homes) expect(peak((s) => s.nonces[h].rows)).toBeLessThan(nonceCap);
    // no reconnect storms: client connect attempts stay near the schedule, and anchors hold about one bridge socket per remote guild and peer
    expect(connectsTotal).toBeLessThanOrEqual(connectsExpected);
    for (const h of homes) expect(peak((s) => s.established[h].peers), `socket count to peer anchors on ${h}`).toBeLessThanOrEqual(64 + 2 * env.SOAK_USERS);
    // memory: no sustained growth on the anchors that were never restarted (needs enough samples to compare)
    if (samples.length >= 16) for (const h of ['a', 'c'] as Home[]) expect(growth[h]!.late, `RSS of anchor-${h}`).toBeLessThan(growth[h]!.early * 1.5 + 100);
    expect(crashes.reduce((x, y) => x + y, 0), 'unhandled errors in anchor logs').toBe(0);
  },
  (env.SOAK_MINUTES + 15) * 60_000
);

// gap: a message sent through a remote guild is published locally by the sender's anchor and again by the host's bridge echo (see join-race.test.ts for the minimal repro)
test.failing('no message is delivered twice to a subscriber', () => {
  expect(sent.size).toBeGreaterThan(0);
  expect(stats.dupBy, 'duplicate live deliveries by direction').toEqual({});
});
