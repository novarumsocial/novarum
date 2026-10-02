// Host-side client for the federation docker stack (test/federation/compose.yml). See test/federation/README.md.
// Everything goes over the stack's fixed IPs (reachable from a Linux host, or from a `runner` container on the
// `anchor-fed_fed` network); only restart/stop/pause/exec/logs need the docker CLI.
import { setDefaultTimeout } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { anchorRoot } from './env';
import { writeConfig, type ConfigOverrides } from './config';
import { signup as signupAt } from './users';
import type { Behaviour } from './fakeAnchor';
import { eventually } from './wait';

// container restarts, pauses and 10s federation timeouts do not fit bun's 5s default; importing this file raises it
setDefaultTimeout(60_000);

export const federationDir = path.join(anchorRoot, 'test/federation');
export const runDir = path.join(federationDir, '.run');
export const configDir = path.join(runDir, 'config');
export const certDir = path.join(federationDir, 'certs/out');
export const composeFile = path.join(federationDir, 'compose.yml');
export const project = 'anchor-fed';

export type AnchorName = 'a' | 'b' | 'c' | 'p' | 'q';
export type Service = AnchorName | 'fake' | 'dns' | 'canary' | 'canary-a' | 'canary-p' | 'canary-meta' | 'proxy' | 'b-proxy' | 'postgres' | 'garage' | 'mailpit';
export type FakeIdentity = 1 | 2;

/** addressing of every anchor. `url` is how the host reaches it over plain http (q is on an internal network: use fetchIn) */
export const anchors = {
  a: { service: 'anchor-a', ip: '172.30.0.11', homeserver: '172.30.0.11', baseUrl: 'http://172.30.0.11', url: 'http://172.30.0.11', db: 'anchor_a', pg: '172.30.0.5', smtp: '172.30.0.7' },
  b: { service: 'anchor-b', ip: '172.30.0.12', homeserver: '172.30.0.12', baseUrl: 'http://172.30.0.12', url: 'http://172.30.0.12', db: 'anchor_b', pg: '172.30.0.5', smtp: '172.30.0.7' },
  c: { service: 'anchor-c', ip: '172.30.0.13', homeserver: '172.30.0.13', baseUrl: 'http://172.30.0.13', url: 'http://172.30.0.13', db: 'anchor_c', pg: '172.30.0.5', smtp: '172.30.0.7' },
  p: { service: 'anchor-p', ip: '172.30.0.20', homeserver: 'p.test', baseUrl: 'https://p.test', url: 'http://172.30.0.20', db: 'anchor_p', pg: '172.30.0.5', smtp: '172.30.0.7' },
  q: { service: 'anchor-q', ip: '172.31.0.10', homeserver: 'q.test', baseUrl: 'https://q.test', url: 'http://172.31.0.10', db: 'anchor_q', pg: '172.31.0.5', smtp: '172.31.0.7' },
} as const;

export const ips = {
  postgres: '172.30.0.5',
  garage: '172.30.0.6',
  mailpit: '172.30.0.7',
  fake: { 1: '172.30.0.66', 2: '172.30.0.67' },
  fakePublic: { 1: '203.0.113.66', 2: '203.0.113.67' },
  fakeName: { 1: 'evil.test', 2: 'evil2.test' },
  canary: '172.30.0.99',
  canaryMeta: '169.254.169.254',
  dns: { fed: '172.30.0.53', pub: '203.0.113.53', egress: '172.31.0.53' },
  proxy: { fed: '172.30.0.80', pub: '203.0.113.80', egress: '172.31.0.80' },
  bProxy: '203.0.113.12',
} as const;

export const mailpitUrl = `http://${ips.mailpit}:8025`;
const fakeAdmin = `http://${ips.fake[1]}:9000`;
const dnsAdmin = `http://${ips.dns.fed}:9053`;
const canaryAdmin = { meta: `http://172.30.0.98:9999`, net: `http://${ips.canary}:9999`, p: `http://${anchors.p.ip}:9999`, a: `http://${anchors.a.ip}:9999` } as const;

const composeEnv = () => ({ ...process.env, FED_CONFIG_DIR: configDir, FED_CERT_DIR: certDir, COMPOSE_PROJECT_NAME: project });

async function run(cmd: string[], { env = composeEnv(), cwd = federationDir, stdin }: { env?: Record<string, string | undefined>; cwd?: string; stdin?: string } = {}) {
  const p = Bun.spawn(cmd, { cwd, env: env as Record<string, string>, stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : new Blob([stdin]) });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

/** `docker compose -f test/federation/compose.yml ...` with the right env; throws on a non-zero exit unless `allowFail` */
export async function compose(args: string[], { allowFail = false } = {}) {
  const res = await run(['docker', 'compose', '-f', composeFile, '-p', project, ...args]);
  if (res.code !== 0 && !allowFail) throw new Error(`docker compose ${args.join(' ')} failed (${res.code}):\n${res.stderr}${res.stdout}`);
  return res;
}

const serviceName = (s: Service) => (s in anchors ? anchors[s as AnchorName].service : s);

/** per-anchor config overrides, merged over the defaults below */
export type StackConfig = Partial<Record<AnchorName, ConfigOverrides>>;

/** writes <configDir>/<name>/config.toml for every anchor */
export function writeStackConfigs(overrides: StackConfig = {}) {
  rmSync(configDir, { recursive: true, force: true });
  for (const [name, a] of Object.entries(anchors) as [AnchorName, (typeof anchors)[AnchorName]][]) {
    const o = overrides[name] ?? {};
    writeConfig(path.join(configDir, name), {
      ...o,
      server: { database_url: `postgresql://novarum:novarum@${a.pg}:5432/${a.db}`, homeserver: a.homeserver, base_url: a.baseUrl, listen_port: 80, ...o.server },
      federation: { key_dir: './keys', ...o.federation },
      // only anchor-a covers attachments, so only it configures bucket CORS against garage
      files: { s3_endpoint: `http://${ips.garage}:3900`, s3_disable_cors: name !== 'a', ...o.files },
      email: { smtp_host: a.smtp, smtp_port: 1025, ...o.email },
      voice: { livekit_url: 'ws://172.30.0.200:7880', ...o.voice },
      network: { ...(name === 'q' ? { proxy_url: `http://${ips.proxy.egress}:3128` } : {}), ...o.network },
      misc: o.misc ?? {},
    });
  }
}

export async function genCerts() {
  const res = await run(['bash', path.join(federationDir, 'certs/gen.sh')]);
  if (res.code !== 0) throw new Error(`certs/gen.sh failed:\n${res.stderr}`);
}

/** (re)builds the three images; docker's layer cache makes this fast when nothing changed */
export async function buildImages() {
  const root = path.resolve(anchorRoot, '../..');
  for (const [tag, args] of [
    ['anchor-test:local', ['-f', 'apps/anchor/Dockerfile', '.']],
    ['fed-tools:local', ['apps/anchor/test/federation/tools']],
    ['smokescreen:local', ['apps/anchor/test/federation/proxy']],
  ] as const) {
    const res = await run(['docker', 'build', '-t', tag, ...args], { cwd: root });
    if (res.code !== 0) throw new Error(`docker build ${tag} failed:\n${res.stderr}${res.stdout}`);
  }
}

/** writes configs and certs, builds the images, then `docker compose up -d --wait` (`build: false` skips the image builds) */
export async function startStack({ config = {}, build = true, timeoutSeconds = 240 }: { config?: StackConfig; build?: boolean; timeoutSeconds?: number } = {}) {
  mkdirSync(runDir, { recursive: true });
  await genCerts();
  writeStackConfigs(config);
  if (build) await buildImages();
  await compose(['up', '-d', '--wait', '--wait-timeout', String(timeoutSeconds), '--remove-orphans']);
}

/** `docker compose down -v` (removes tmpfs state, networks and anonymous volumes) */
export async function stopStack() {
  await compose(['down', '-v', '-t', '1', '--remove-orphans'], { allowFail: true });
}

/** resolves when the harness processes answer; throws a helpful message if the stack is not up */
export async function stackIsUp() {
  const ok = await fetch(`${fakeAdmin}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (!ok) throw new Error('federation stack is not running: start it with `bun test/federation/run.ts up` (or run via `bun run test:fed`)');
}

/** base URL (plain http) of an anchor as reachable from the runner. q has none: use fetchIn('q', ...) */
export function api(name: AnchorName) {
  if (name === 'q') throw new Error("anchor-q is on an internal network; use fetchIn('q', url, init)");
  return anchors[name].url;
}

/** users.ts `signup` against one of the real anchors (p works; q throws) */
export const signup = (name: AnchorName, overrides?: Parameters<typeof signupAt>[1]) => signupAt(api(name), overrides);

// ---- lifecycle -------------------------------------------------------------------------------------------------

// canary-a / canary-p share their anchor's network namespace, which a restart replaces: they must follow it
const sidecar = (s: Service) => (s === 'a' ? ['canary-a'] : s === 'p' ? ['canary-p'] : []);

export const restart = async (s: Service) => {
  await compose(['restart', '-t', '1', serviceName(s)]);
  if (s in anchors) await waitForAnchor(s as AnchorName);
  for (const c of sidecar(s)) await compose(['restart', '-t', '1', c]);
};
export const stop = async (s: Service) => {
  for (const c of sidecar(s)) await compose(['stop', '-t', '1', c]);
  await compose(['stop', '-t', '1', serviceName(s)]);
};
export const start = async (s: Service) => {
  await compose(['start', serviceName(s)]);
  if (s in anchors) await waitForAnchor(s as AnchorName);
  for (const c of sidecar(s)) await compose(['start', c]);
};
export const pause = (s: Service) => compose(['pause', serviceName(s)]);
export const unpause = (s: Service) => compose(['unpause', serviceName(s)]);

export async function waitForAnchor(name: AnchorName, timeout = 60_000) {
  const up = async () =>
    name === 'q'
      ? ((await fetchIn('q', 'http://127.0.0.1/')) as { body?: string }).body === 'this is anchor'
      : (await (await fetch(`${api(name)}/`, { signal: AbortSignal.timeout(1000) })).text()) === 'this is anchor';
  await eventually(up, { timeout, interval: 200, message: `anchor-${name} up` });
}

/** `docker compose exec -T <service> <cmd...>`; cmd may be a string (run with sh -c) or an argv array */
export async function exec(s: Service, cmd: string | string[], { env = {} }: { env?: Record<string, string> } = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const argv = typeof cmd === 'string' ? ['sh', '-c', cmd] : cmd;
  return compose(['exec', '-T', ...envArgs, serviceName(s), ...argv], { allowFail: true });
}

/** all logs of a service since the stack came up (stdout + stderr, no prefixes) */
export async function logs(s: Service) {
  const { stdout, stderr } = await compose(['logs', '--no-color', '--no-log-prefix', serviceName(s)], { allowFail: true });
  return stdout + stderr;
}

/**
 * Makes an HTTP request FROM INSIDE a container (default curl-less: runs bun there), e.g. anchor-p calling evil.test
 * with its real DNS and CA settings. `env` can set or (with value `null`) unset variables for that process; the
 * container's HTTP(S)_PROXY (only set on anchor-q) is unset unless `inheritProxy: true`.
 */
export async function fetchIn(
  s: Service,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; env?: Record<string, string | null>; inheritProxy?: boolean } = {}
) {
  const { env: extraEnv = {}, inheritProxy = false, ...rest } = init;
  // anchor-q's container has HTTP(S)_PROXY set for the anchor process; a probe only uses it when asked to
  const noProxy: Record<string, null> = inheritProxy ? {} : { HTTP_PROXY: null, HTTPS_PROXY: null };
  const env: Record<string, string | null> = { ...noProxy, ...extraEnv };
  const script = `
    const [url, init] = JSON.parse(process.argv[1]);
    try {
      const r = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs ?? 10000) });
      console.log(JSON.stringify({ ok: true, status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() }));
    } catch (e) { console.log(JSON.stringify({ ok: false, error: String(e), code: e?.code })); }`;
  const unset = Object.entries(env).filter(([, v]) => v === null).flatMap(([k]) => ['-u', k]);
  const set = Object.entries(env).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`);
  const res = await exec(s, ['env', ...unset, ...set, 'bun', '-e', script, JSON.stringify([url, rest])]);
  try {
    return JSON.parse(res.stdout.trim().split('\n').pop()!) as { ok: true; status: number; headers: Record<string, string>; body: string } | { ok: false; error: string; code?: string };
  } catch {
    throw new Error(`fetchIn(${s}) failed: ${res.stderr}${res.stdout}`);
  }
}

// ---- fake anchor -----------------------------------------------------------------------------------------------

export type FakeRequest = {
  id: number;
  ts: number;
  scheme: 'http' | 'https';
  method: string;
  path: string;
  host: string;
  headers: Record<string, string>;
  body: string;
  sourceIp: string;
  localIp: string;
};

export type SignInput = {
  identity: FakeIdentity;
  method: string;
  path: string;
  host: string;
  /** sender homeserver (default: the identity's IP, e.g. 172.30.0.66) */
  homeserver?: string;
  body?: string;
  /** exact X-Novarum-Date value (may be garbage) */
  date?: string;
  dateOffsetSeconds?: number;
  nonce?: string;
  /** exact X-Novarum-Body-SHA256 (and signed) value, e.g. to simulate a body mismatch */
  bodyHash?: string;
  /** exact X-Novarum-Key-Id header value */
  keyId?: string;
  /** which key signs; `random` = a key nobody has heard of */
  key?: 'current' | 'previous' | 'random';
  /** corrupt the signature */
  tamper?: boolean;
};

const post = async <T>(url: string, body: unknown, method = 'POST'): Promise<T> => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${json.error ?? ''}`);
  return json;
};
const getJson = async <T>(url: string) => (await fetch(url)).json() as Promise<T>;
const del = (url: string) => fetch(url, { method: 'DELETE' });

export const fake = {
  /** homeserver names of the identity: private (http) and public (https) side */
  identityInfo: (identity: FakeIdentity) => ({ homeserver: ips.fake[identity], baseUrl: `http://${ips.fake[identity]}`, publicHomeserver: ips.fakeName[identity], publicIp: ips.fakePublic[identity] }),
  /**
   * Sets a behaviour for a route of one identity (later rules win; rules without `times` stay until reset).
   * route: `/path`, `METHOD /path`, or a prefix with a trailing `*` (`POST /federation/*`).
   * Behaviour fields: status, headers, body, json, bodyBase64, redirect, hangMs (-1 = never), drip, hugeBytes,
   * gzipBombBytes, nonJson, invalidUtf8, deepJson, badKey, discovery {homeserver, baseUrl, version, publicKey...}, times.
   * Unmatched routes answer 404; /.well-known/anchor/info answers a valid document by default.
   */
  respond: (identity: FakeIdentity, route: string, behaviour: Behaviour = {}) => post<{ ok: true }>(`${fakeAdmin}/identity/${identity}/routes`, { route, behaviour }, 'PUT'),
  /** removes all rules of an identity */
  clearRoutes: (identity: FakeIdentity) => del(`${fakeAdmin}/identity/${identity}/routes`),
  /** every request the identity received (both http and https, all hosts), optionally filtered by path prefix */
  requests: (identity: FakeIdentity, { path: prefix, since }: { path?: string; since?: number } = {}) =>
    getJson<FakeRequest[]>(`${fakeAdmin}/identity/${identity}/requests?${new URLSearchParams({ ...(prefix ? { path: prefix } : {}), ...(since ? { since: String(since) } : {}) })}`),
  clearRequests: (identity: FakeIdentity) => del(`${fakeAdmin}/identity/${identity}/requests`),
  /** drops all rules and recorded requests of both identities. Does not rotate keys */
  reset: () => post<{ ok: true }>(`${fakeAdmin}/reset`, {}),
  info: (identity: FakeIdentity) => getJson<{ keyId: string; publicKey: string }>(`${fakeAdmin}/identity/${identity}`),
  /** generates a new signing key; discovery now serves it, the old one stays usable via sign({ key: 'previous' }) */
  rotateKey: (identity: FakeIdentity) => post<{ keyId: string; publicKey: string; previousKeyId: string }>(`${fakeAdmin}/identity/${identity}/rotate`, {}),
  /** signs a v1 federation request as an identity; returns the headers to attach and the signing string */
  sign: (input: SignInput) => post<{ headers: Record<string, string>; signingString: string }>(`${fakeAdmin}/sign`, input),
  /**
   * sign + send, e.g. `fake.send(1, 'a', 'POST', '/federation/friends/command', { ... })` posts JSON to anchor-a as identity 1.
   * `host` defaults to the target's host as the target sees it; override any SignInput field via `sign`.
   */
  async send(identity: FakeIdentity, target: AnchorName, method: string, path: string, body?: unknown, sign: Partial<SignInput> = {}) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const host = new URL(anchors[target].baseUrl).host;
    const { headers } = await fake.sign({ identity, method, path, host, body: text, ...sign });
    const res = await fetch(`${api(target)}${path}`, { method, headers: { ...headers, ...(text ? { 'content-type': 'application/json' } : {}) }, body: text || undefined });
    return { status: res.status, text: await res.text(), headers: res.headers };
  },
};

// ---- dns -------------------------------------------------------------------------------------------------------

export type DnsRecord = { value: string; type?: 'A' | 'AAAA' | 'CNAME' | 'TXT' };
export type DnsQuery = { ts: number; name: string; type: string; transport: 'udp' | 'tcp'; source: string; rcode: string; answers: string[] };
const asRecords = (r: string | DnsRecord | (string | DnsRecord)[]) => (Array.isArray(r) ? r : [r]).map((x) => (typeof x === 'string' ? { value: x } : x));

/** Authoritative resolver for *.test. Defaults: b.test, p.test, q.test, evil.test, evil2.test, wrongcert.test, selfsigned.test, expired.test. Unknown names: NXDOMAIN. */
export const dns = {
  /** answers A/AAAA/CNAME records for `name` (`*.suffix` wildcards allowed); IPs auto-typed, `{type:'CNAME', value}` for CNAMEs */
  set: (name: string, records: string | DnsRecord | (string | DnsRecord)[], ttl = 60) => post(`${dnsAdmin}/records`, { name, records: asRecords(records), ttl }, 'PUT'),
  /** each A lookup returns the next set (the last repeats): `dns.rebind('r.test', ['203.0.113.66', '127.0.0.1'])`, TTL 0 by default */
  rebind: (name: string, sequence: (string | string[])[], ttl = 0) => post(`${dnsAdmin}/records`, { name, sequence: sequence.map((s) => asRecords(s)), ttl }, 'PUT'),
  nxdomain: (name: string) => post(`${dnsAdmin}/records`, { name, rcode: 'NXDOMAIN' }, 'PUT'),
  servfail: (name: string) => post(`${dnsAdmin}/records`, { name, rcode: 'SERVFAIL' }, 'PUT'),
  /** never answers (timeout) */
  drop: (name: string) => post(`${dnsAdmin}/records`, { name, drop: true }, 'PUT'),
  /** answers after a delay */
  slow: (name: string, delayMs: number, records: string | string[]) => post(`${dnsAdmin}/records`, { name, records: asRecords(records), delayMs }, 'PUT'),
  remove: (name: string) => del(`${dnsAdmin}/records?name=${encodeURIComponent(name)}`),
  /** every query the server saw (optionally one name), with its answers */
  queries: (name?: string) => getJson<DnsQuery[]>(`${dnsAdmin}/queries${name ? `?name=${encodeURIComponent(name)}` : ''}`),
  /** restores the default records and clears the query log */
  reset: () => post(`${dnsAdmin}/reset`, {}),
};

// ---- canaries --------------------------------------------------------------------------------------------------

export type CanaryHit = { ts: number; listener: string; port: number; source: string; method?: string; path?: string; host?: string; headers?: Record<string, string>; firstBytes?: string };
export type CanaryWhere = keyof typeof canaryAdmin;

/**
 * `net` (default): 172.30.0.99 listening on 80/443/6379/8080 (listeners http80, tcp443, tcp6379, http8080).
 * `meta`: 169.254.169.254 on its own `meta` network shared with anchor-a and anchor-p (listeners metadata :80, metadata8080).
 * `p` / `a`: inside anchor-p / anchor-a's network namespace: listeners loopback8080 (127.0.0.1:8080) and loopback443
 * (127.0.0.1:443).
 */
export const canary = {
  hits: (where: CanaryWhere = 'net', listener?: string) => getJson<CanaryHit[]>(`${canaryAdmin[where]}/hits${listener ? `?listener=${listener}` : ''}`),
  /** resets one (or, with no argument, all) canaries */
  reset: async (where?: CanaryWhere) => {
    await Promise.all((where ? [where] : (Object.keys(canaryAdmin) as CanaryWhere[])).map((w) => del(`${canaryAdmin[w]}/hits`)));
  },
  /** hits across all four canaries, tagged by where they landed; must be empty after every SSRF case */
  async allHits() {
    const all = await Promise.all((Object.keys(canaryAdmin) as CanaryWhere[]).map(async (where) => (await canary.hits(where)).map((h) => ({ where, ...h }))));
    return all.flat();
  },
};

/** smokescreen's log (JSON lines on stderr); denies carry `"decision_reason"`/`"allow":false` fields */
export const proxy = {
  logs: () => logs('proxy'),
  async denies() {
    return (await logs('proxy')).split('\n').filter((l) => /"allow":\s*false|deny|denied/i.test(l) && l.startsWith('{'));
  },
};

/** resets fake, dns and canaries to a clean slate (call in beforeEach/afterEach of tests that touch them) */
export async function resetHarness() {
  await Promise.all([fake.reset(), dns.reset(), canary.reset()]);
}
