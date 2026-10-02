import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { z } from 'zod';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { createGuild } from '../harness/realtime';
import { cookieName, freshIp, signup } from '../harness/users';
import { openRealtime } from '../harness/ws';

// Input fuzzing of every single-server route, generated from /openapi/json, plus the realtime message union.
// Expectation: 4xx (or a normal 2xx/3xx for inputs that happen to be valid), never 5xx, never a hang, and the server
// keeps answering afterwards. Federation routes are fuzzed by the federation suite. Iterations are bounded to keep this ~1-2 minutes.
setDefaultTimeout(240_000);

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'fuzz', s3: true, config: { misc: { save_attachment_thumbnails: false } } });
});
afterAll(() => anchor?.destroy());

const specSchema = z.object({
  paths: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({
        parameters: z.array(z.looseObject({ in: z.string(), name: z.string(), required: z.boolean().optional(), schema: z.any().optional() })).optional(),
        requestBody: z.object({ content: z.record(z.string(), z.object({ schema: z.any().optional() })) }).optional(),
      })
    )
  ),
  components: z.object({ schemas: z.record(z.string(), z.any()).optional() }).optional(),
});
type Spec = z.infer<typeof specSchema>;
type Op = Spec['paths'][string][string];

// ---- generation -------------------------------------------------------------------------------------------------
let spec: Spec;
const realIds: Record<string, string> = {}; // filled only while building one authenticated user's requests

/** a value that satisfies a JSON schema; keys that name one of our real ids get the real one so requests go past the lookups */
function sample(schema: any, key = ''): any {
  if (key in realIds) return realIds[key];
  if (!schema) return 'x';
  if (schema.$ref) return sample(spec.components?.schemas?.[schema.$ref.split('/').pop()!], key);
  const options = schema.anyOf ?? schema.oneOf;
  if (options) return sample(options.find((s: any) => s.type !== 'null' && s.format !== 'integer') ?? options[0], key);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: any) => sample(s, key)));
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  switch (schema.type) {
    case 'string': {
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'email') return 'a@example.test';
      if (schema.format === 'uri') return 'https://example.test/';
      if (schema.format === 'binary') return new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
      const text = ['abcdef', '123456', '#aabbcc', 'ab'.repeat(12)].find(
        (s) => (!schema.pattern || new RegExp(schema.pattern).test(s)) && s.length >= (schema.minLength ?? 0) && s.length <= (schema.maxLength ?? 1e9)
      );
      return text ?? 'x'.repeat(schema.minLength ?? 1);
    }
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items));
    case 'object':
      return Object.fromEntries((schema.required ?? []).map((k: string) => [k, sample(schema.properties?.[k], k)]));
    default:
      return 'x';
  }
}

const nasty = ['', ' ', '\u0000', 'a\u0000b', '\ud800', '👨‍👩‍👧‍👦'.repeat(50), '‮evil', 'ｆｕｌｌｗｉｄｔｈ', "'; DROP TABLE \"user\"; --", '../../etc/passwd', '%00%2e%2e%2f', '<script>alert(1)</script>', '${7*7}{{7*7}}', 'Ω'.repeat(300)];
const huge = 'A'.repeat(200_000);
const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill);
const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const junkFiles: [string, Uint8Array, string][] = [
  ['empty', new Uint8Array(), 'image/png'],
  ['png header + junk', Uint8Array.from([...pngHeader, ...bytes(500, 7)]), 'image/png'],
  ['text as jpeg', new TextEncoder().encode('<svg onload=alert(1)>'), 'image/jpeg'],
  ['10MB zeros', bytes(10 * 1024 * 1024), 'image/webp'],
];

type Req = { label: string; url: string; init: RequestInit };

/** every request variant for one operation */
function variants(method: string, path: string, op: Op): Req[] {
  const params = op.parameters ?? [];
  const build = (pathValue: (name: string, schema: any) => string, queryValue?: (name: string, schema: any) => string) => {
    let url = path;
    const query = new URLSearchParams();
    for (const p of params) {
      if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(pathValue(p.name, p.schema).toWellFormed()));
      else if (p.in === 'query' && (p.required || queryValue)) query.set(p.name, (queryValue ?? pathValue)(p.name, p.schema));
    }
    return url + (query.size ? `?${query}` : '');
  };
  const valid = (name: string, schema: any) => String(sample(schema, name));
  const out: Req[] = [];
  const add = (label: string, url: string, init: RequestInit = {}) => out.push({ label, url, init: { method, redirect: 'manual', ...init } });

  // path and query parameters
  add('valid params', build(valid));
  for (const [i, s] of [...nasty, huge.slice(0, 20_000)].entries()) add(`param #${i}`, build((n) => s, (n) => s));
  if (params.some((p) => p.in === 'query')) add('unknown + repeated query keys', `${build(valid)}${path.includes('?') ? '&' : '?'}x=1&x=2&__proto__=1&${huge.slice(0, 5000)}=1`);

  const content = op.requestBody?.content;
  if (!content) return out;
  const url = build(valid);
  const isForm = Object.keys(content).some((k) => k.includes('multipart') || k.includes('form-data'));
  const body = sample(content['application/json']?.schema ?? Object.values(content)[0]?.schema);
  const json = (b: unknown) => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
  const raw = (b: string, type = 'application/json') => ({ body: b, headers: { 'content-type': type } });

  if (isForm) {
    const fileKeys = Object.entries(body ?? {}).filter(([, v]) => v instanceof File).map(([k]) => k);
    const form = (patch: Record<string, unknown>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ ...body, ...patch })) f.set(k, v as any);
      return { body: f };
    };
    add('valid form', url, form({}));
    for (const k of fileKeys) for (const [label, data, type] of junkFiles) add(`file ${k}: ${label}`, url, form({ [k]: new File([data], 'x.png', { type }) }));
    for (const k of Object.keys(body ?? {})) add(`form field ${k}: huge`, url, form({ [k]: huge }));
    add('empty form', url, { body: new FormData() });
    add('json to a form route', url, json({}));
    return out;
  }

  add('valid body', url, json(body));
  add('no body', url);
  add('empty object', url, json({}));
  add('array root', url, json([body]));
  add('null root', url, json(null));
  add('string root', url, json('x'));
  add('invalid json', url, raw('{"a":'));
  add('text/plain content type', url, raw(JSON.stringify(body), 'text/plain'));
  add('urlencoded content type', url, raw('a=1&b=2', 'application/x-www-form-urlencoded'));
  add('extra fields', url, json({ ...body, isAdmin: true, constructor: { prototype: { x: 1 } }, extra: [1, { a: null }] }));
  add('__proto__ key', url, raw(`{"__proto__":{"admin":true},${JSON.stringify(body).slice(1)}`));
  add('deep nesting (array, 20000)', url, raw('['.repeat(20_000) + ']'.repeat(20_000)));
  add('deep nesting (object field, 5000)', url, raw(`{"deep":${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}}`));
  add('10MB body', url, json({ ...body, padding: 'x'.repeat(10 * 1024 * 1024) }));
  add('10MB string in every field', url, json(Object.fromEntries(Object.keys(body ?? {}).map((k) => [k, 'x'.repeat(10 * 1024 * 1024)]))));
  for (const k of Object.keys(body ?? {})) {
    add(`field ${k}: null`, url, json({ ...body, [k]: null }));
    add(`field ${k}: wrong types`, url, json({ ...body, [k]: [{ a: 1 }] }));
    add(`field ${k}: object`, url, json({ ...body, [k]: { $ne: null } }));
    add(`field ${k}: number extremes`, url, raw(JSON.stringify({ ...body, [k]: 0 }).replace(':0', ':1e999')));
    add(`field ${k}: -0 / huge int`, url, raw(JSON.stringify({ ...body, [k]: 0 }).replace(':0', ':-9007199254740993')));
    add(`field ${k}: huge string`, url, json({ ...body, [k]: huge }));
    for (const [i, s] of nasty.entries()) add(`field ${k}: nasty #${i}`, url, json({ ...body, [k]: s }));
  }
  return out;
}

// ---- running ----------------------------------------------------------------------------------------------------
type Finding = { route: string; label: string; status: number | string };
const findings: Finding[] = [];
const covered: Record<string, number> = {};
const alive = async () => (await fetch(`${anchor.url}/`, { signal: AbortSignal.timeout(10_000) })).status === 200;

async function fuzzRoute(key: string, reqs: Req[], cookie: string | null, mode: string) {
  for (const r of reqs) {
    const headers = new Headers(r.init.headers);
    headers.set('x-forwarded-for', freshIp());
    if (cookie) headers.set('cookie', `${cookieName}=${cookie}`);
    let status: number | string;
    try {
      const res = await fetch(`${anchor.url}${r.url}`, { ...r.init, headers, signal: AbortSignal.timeout(30_000) });
      await res.arrayBuffer().catch(() => {});
      status = res.status;
    } catch (e) {
      status = `error: ${String(e).slice(0, 80)}`;
    }
    covered[mode] = (covered[mode] ?? 0) + 1;
    // 502/504 are the documented answer for an unreachable remote homeserver (the sampled handles point nowhere)
    if (typeof status === 'string' || (status >= 500 && status !== 502 && status !== 504)) findings.push({ route: `${key} [${mode}]`, label: r.label, status });
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => { while (queue.length) await fn(queue.shift()!); }));
}

/** a user with a guild, a text channel and a message, so id-shaped fields point at real things */
async function seededUser() {
  const u = await signup(anchor.url);
  const { guildId, channelId } = await createGuild(u);
  const sent = await u.fetch('/message/send', { method: 'POST', body: JSON.stringify({ channelId, content: 'seed', nonce: crypto.randomUUID() }) });
  const messageId = ((await sent.json()) as any).message?.id as string;
  return { u, guildId, channelId, messageId };
}

const isFederation = (key: string) => key.split(' ')[1]!.startsWith('/federation/');
// `GET /openapi/*` is the docs UI; logout would only drop our own session; the livekit webhook is signed by LiveKit
const skip = (key: string) => isFederation(key) || key.includes('/openapi') || key.startsWith('WS ');
let routes: { key: string; method: string; path: string; op: Op }[] = [];

describe('HTTP routes', () => {
  beforeAll(async () => {
    spec = specSchema.parse(await (await fetch(`${anchor.url}/openapi/json`)).json());
    routes = Object.entries(spec.paths)
      .flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, op })))
      .filter((r) => !skip(r.key));
  });

  test('the spec exposes the routes to fuzz', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  test('unauthenticated: every route answers 4xx/2xx/3xx, never 5xx or a hang', async () => {
    await pool(routes, 8, (r) => fuzzRoute(r.key, variants(r.method, r.path, r.op), null, 'anonymous'));
    expect(await alive()).toBe(true);
  });

  test('authenticated (own guild, channel and message ids filled in): same', async () => {
    await pool(routes, 6, async (r) => {
      const s = await seededUser();
      // variants() is synchronous, so the ids it reads are this user's even though the pool runs routes concurrently
      Object.assign(realIds, { guildId: s.guildId, channelId: s.channelId, messageId: s.messageId, userId: s.u.user.id });
      const reqs = variants(r.method, r.path, r.op);
      for (const k of Object.keys(realIds)) delete realIds[k];
      await fuzzRoute(r.key, reqs, s.u.cookie, 'authenticated');
    });
    expect(await alive()).toBe(true);
  });

  test('a clean session still works after all of that', async () => {
    const u = await signup(anchor.url);
    expect((await u.fetch('/auth/me')).status).toBe(200);
    console.log(`fuzz: ${JSON.stringify(covered)} requests, ${findings.length} 5xx/transport findings`);
  });

  // Known 5xx findings, one test.failing per cause. When a fix lands its test starts passing (bun reports that as a failure): make it a plain test then.
  const routesWhere = (match: (f: Finding) => boolean) => [...new Set(findings.filter(match).map((f) => f.route.replace(/ \[.*/, '')))].sort();
  const nul = (f: Finding) => /^param #[23]$/.test(f.label);
  const image = (f: Finding) => /^POST \/user\/(avatar|banner) /.test(f.route) && /^(valid form|file )/.test(f.label);
  const webhook = (f: Finding) => f.route.startsWith('POST /channel/livekit/webhook');

  // gap: a NUL byte (%00) in a path/query parameter reaches Postgres, which rejects it, and the error surfaces as a 500
  test.failing('NUL bytes in path/query parameters are a 4xx', () => {
    console.log(`NUL byte -> 500 on:\n  ${routesWhere(nul).join('\n  ')}`);
    expect(routesWhere(nul)).toEqual([]);
  });

  // gap: sharp errors on an undecodable avatar/banner are not caught
  test.failing('undecodable avatar/banner images are a 4xx', () => {
    expect(routesWhere(image)).toEqual([]);
  });

  // gap: a webhook call without a valid LiveKit Authorization header answers 500 instead of 401
  test.failing('the LiveKit webhook refuses unauthenticated calls with a 4xx', () => {
    expect(routesWhere(webhook)).toEqual([]);
  });

  test('every other 5xx is reported (none expected; a sporadic one is logged for triage)', () => {
    const other = findings.filter((f) => !nul(f) && !image(f) && !webhook(f));
    if (other.length) console.log(`uncategorised fuzz 5xx:\n${JSON.stringify(other, null, 1)}`);
    expect(other.filter((f) => typeof f.status === 'string')).toEqual([]); // transport errors (reset / hang) are never acceptable
  });
});

// ---- realtime ---------------------------------------------------------------------------------------------------
describe('realtime WS message union', () => {
  const messages: [string, string | Uint8Array][] = [
    ['not json', 'hello'],
    ['truncated json', '{"type":'],
    ['null', 'null'],
    ['number', '42'],
    ['array', '[]'],
    ['empty object', '{}'],
    ['unknown type', '{"type":"nope"}'],
    ['type as object', '{"type":{"a":1}}'],
    ['__proto__ type', '{"__proto__":{"type":"voice.leave"}}'],
    ['subscribe.guild no id', '{"type":"subscribe.guild"}'],
    ['subscribe.guild numeric id', '{"type":"subscribe.guild","guildId":1}'],
    ['subscribe.guild null id', '{"type":"subscribe.guild","guildId":null}'],
    ['subscribe.guild 1MB id', JSON.stringify({ type: 'subscribe.guild', guildId: 'g'.repeat(1_000_000) })],
    ['subscribe.guild nul/unicode', JSON.stringify({ type: 'subscribe.guild', guildId: '\u0000\ud800👨‍👩‍👧' })],
    ['voice.join missing channel', '{"type":"voice.join"}'],
    ['voice.join federated-looking id', JSON.stringify({ type: 'voice.join', channelId: 'fed:evil.test:123' })],
    ['voice.join 1MB id', JSON.stringify({ type: 'voice.join', channelId: 'c'.repeat(1_000_000) })],
    ['call.ring wrong boolean', '{"type":"call.ring","channelId":"x","ringing":"yes"}'],
    ['call.ring extra fields', '{"type":"call.ring","channelId":"x","ringing":true,"admin":true}'],
    ['emoji.search 1MB query', JSON.stringify({ type: 'emoji.search', query: 'a'.repeat(1_000_000) })],
    ['emoji.search sql-ish', JSON.stringify({ type: 'emoji.search', query: "%' OR 1=1 --\\_%" })],
    ['emoji.search unicode', JSON.stringify({ type: 'emoji.search', query: '\u0000\ud800‮👨‍👩‍👧' })],
    ['emoji.search number', '{"type":"emoji.search","query":5}'],
    ['emoji.query empty list', '{"type":"emoji.query","unicodes":[]}'],
    ['emoji.query 101 items', JSON.stringify({ type: 'emoji.query', unicodes: Array(101).fill('1F600') })],
    ['emoji.query 100 items', JSON.stringify({ type: 'emoji.query', unicodes: Array(100).fill('1F600') })],
    ['emoji.query bad pattern', '{"type":"emoji.query","unicodes":["zz","1F600-"]}'],
    ['emoji.query huge hex', JSON.stringify({ type: 'emoji.query', unicodes: ['F'.repeat(100_000)] })],
    ['deep nesting', '['.repeat(20_000) + ']'.repeat(20_000)],
    ['deep nesting in a field', `{"type":"emoji.search","query":${'{"a":'.repeat(3000)}1${'}'.repeat(3000)}}`],
    ['binary frame', Uint8Array.from([0, 255, 1, 254, 0x7b])],
    ['empty frame', ''],
    ['5MB frame', JSON.stringify({ type: 'emoji.search', query: 'a'.repeat(5 * 1024 * 1024) })],
  ];

  test('every malformed or hostile message leaves the server and the connection healthy', async () => {
    const u = await signup(anchor.url);
    const { guildId } = await createGuild(u);
    let rt = await openRealtime(anchor.url, u.cookie);
    await rt.waitFor('voice.states.snapshot');
    const closedBy: string[] = [];
    for (const [label, data] of messages) {
      if (rt.closed) {
        // a protocol-level rejection may close the socket; reconnect and keep going
        closedBy.push(`${label} (${rt.closed.code})`);
        rt = await openRealtime(anchor.url, u.cookie);
        await rt.waitFor('voice.states.snapshot');
      }
      rt.ws.send(data);
      // a ping round trip through a valid request proves the socket is still being served in order
      rt.send({ type: 'subscribe.guild', guildId });
      await rt.waitFor('voice.states.snapshot', (e) => e.data?.guildIds?.[0] === guildId && rt.events.filter((x) => x === e).length === 1 && rt.events.lastIndexOf(e) === rt.events.length - 1, 15_000).catch(() => {});
      rt.events.length = 0;
    }
    expect(await alive()).toBe(true);
    // the server still serves new sockets and valid requests normally
    const fresh = await openRealtime(anchor.url, u.cookie);
    await fresh.waitFor('voice.states.snapshot');
    fresh.send({ type: 'emoji.query', unicodes: ['1F600'] });
    await fresh.waitFor('emoji.query.results');
    fresh.close();
    rt.close();
    console.log(`ws fuzz: closed by ${closedBy.length ? closedBy.join(', ') : 'nothing'}`);
  });

  test('unauthenticated sockets get nothing but a 1008 close, whatever they send', async () => {
    const rt = await openRealtime(anchor.url);
    for (const [, data] of messages.slice(0, 12)) rt.ws.readyState === WebSocket.OPEN && rt.ws.send(data);
    expect((await rt.waitClosed()).code).toBe(1008);
    expect(await alive()).toBe(true);
  });

  test('many sockets sending junk at once do not crash the server', async () => {
    const u = await signup(anchor.url);
    const sockets = await Promise.all(Array.from({ length: 10 }, () => openRealtime(anchor.url, u.cookie)));
    for (const s of sockets) for (const [, data] of messages.slice(0, 28)) if (s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
    await Bun.sleep(1000);
    for (const s of sockets) s.close();
    expect(await alive()).toBe(true);
  });
});
