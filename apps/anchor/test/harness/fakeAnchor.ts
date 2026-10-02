// Hostile/controllable homeservers. Runs INSIDE docker as service `fake` (see test/federation/compose.yml).
// Two identities with separate ed25519 keys:
//   1: 172.30.0.66 (http :80) / 203.0.113.66 = evil.test  (https :443)
//   2: 172.30.0.67 (http :80) / 203.0.113.67 = evil2.test (https :443)
// Controlled over an admin HTTP port (default 9000); the typed host-side client is test/harness/federation.ts.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { z } from 'zod';
import { addIp, json, runSetup } from './net';

const certDir = process.env.FAKE_CERT_DIR ?? '/certs';
const adminPort = Number(process.env.FAKE_ADMIN_PORT ?? 9000);

export const identityIds = ['1', '2'] as const;
const identityConfig = {
  '1': { privateIp: '172.30.0.66', publicIp: '203.0.113.66', publicName: 'evil.test' },
  '2': { privateIp: '172.30.0.67', publicIp: '203.0.113.67', publicName: 'evil2.test' },
} as const;

const newKey = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    id: crypto.randomUUID(),
    privateKey,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
};
type Key = ReturnType<typeof newKey>;

export const behaviourSchema = z.object({
  /** response status (default 200) */
  status: z.number().int().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** raw text body */
  body: z.string().optional(),
  /** JSON body (sets content-type) */
  json: z.unknown().optional(),
  bodyBase64: z.string().optional(),
  /** answer with this Location (status default 302) */
  redirect: z.string().optional(),
  /** wait this long before responding; `-1` never responds */
  hangMs: z.number().optional(),
  /** stream `bytes` bytes in `chunkBytes` chunks every `intervalMs` (slowloris-style response; bytes -1 = forever) */
  drip: z
    .object({ bytes: z.number().default(-1), chunkBytes: z.number().default(1), intervalMs: z.number().default(100) })
    .optional(),
  /** stream a JSON-looking body of this many bytes as fast as the reader pulls */
  hugeBytes: z.number().optional(),
  /** content-encoding: gzip body that inflates to this many bytes */
  gzipBombBytes: z.number().optional(),
  /** `<html>` body, content-type text/html */
  nonJson: z.boolean().optional(),
  /** valid-looking JSON containing the bytes 0xff 0xfe */
  invalidUtf8: z.boolean().optional(),
  /** `{"a":{"a":...}}` nested this deep */
  deepJson: z.number().optional(),
  /** discovery only: serve a public key that does not match the one used for signing */
  badKey: z.boolean().optional(),
  /** discovery only: override fields of the discovery document (publicKey is merged) */
  discovery: z
    .object({
      app: z.unknown().optional(),
      homeserver: z.unknown().optional(),
      baseUrl: z.unknown().optional(),
      version: z.unknown().optional(),
      maxFileSize: z.unknown().optional(),
      publicKey: z.unknown().optional(),
    })
    .optional(),
  /** apply to the first N matching requests only, then fall through to the previous rule/default */
  times: z.number().int().positive().optional(),
  /** WebSocket upgrade requests on the route are accepted: every message is sent (strings raw, anything else as JSON), then the socket closes with `close` if given */
  ws: z
    .object({
      messages: z.array(z.unknown()).default([]),
      close: z.object({ code: z.number().int(), reason: z.string().default('') }).optional(),
    })
    .optional(),
});
export type Behaviour = z.input<typeof behaviourSchema>;

const signSchema = z.object({
  identity: z.coerce.string().pipe(z.enum(identityIds)),
  method: z.string(),
  path: z.string(),
  host: z.string(),
  /** sender homeserver, defaults to the identity's private IP */
  homeserver: z.string().optional(),
  body: z.string().default(''),
  date: z.string().optional(),
  dateOffsetSeconds: z.number().optional(),
  nonce: z.string().optional(),
  /** header value for X-Novarum-Body-SHA256 (and what is signed); default: sha256 of body */
  bodyHash: z.string().optional(),
  /** header value for X-Novarum-Key-Id; default: the signing key's id */
  keyId: z.string().optional(),
  /** which key signs: `current` (default), `previous` (before the last rotation) or `random` (unknown key) */
  key: z.enum(['current', 'previous', 'random']).default('current'),
  /** flip a byte of the signature */
  tamper: z.boolean().optional(),
});

type RouteRule = { method?: string; path: string; prefix: boolean; behaviour: z.output<typeof behaviourSchema>; left?: number };
type Recorded = {
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

const identities = Object.fromEntries(
  identityIds.map((id) => [
    id,
    {
      id,
      ...identityConfig[id],
      key: newKey() as Key,
      previousKey: null as Key | null,
      rules: [] as RouteRule[],
      requests: [] as Recorded[],
    },
  ])
) as Record<(typeof identityIds)[number], { id: string; privateIp: string; publicIp: string; publicName: string; key: Key; previousKey: Key | null; rules: RouteRule[]; requests: Recorded[] }>;
type Identity = (typeof identities)['1'];

let requestCounter = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const infoPath = '/.well-known/anchor/info';

const discoveryDoc = (identity: Identity, b?: z.output<typeof behaviourSchema>) => {
  const key = b?.badKey ? newKey() : identity.key;
  const doc: Record<string, unknown> = {
    app: { name: 'novarum-anchor', description: 'fake anchor for tests' },
    publicKey: { id: identity.key.id, algorithm: 'ed25519', key: key.publicKey },
    maxFileSize: 10,
    homeserver: identity.privateIp,
    baseUrl: `http://${identity.privateIp}`,
    version: '0.0.0-fake',
  };
  const { publicKey, ...rest } = b?.discovery ?? {};
  Object.assign(doc, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
  if (publicKey !== undefined) {
    doc.publicKey =
      publicKey && typeof publicKey === 'object' ? { ...(doc.publicKey as object), ...publicKey } : publicKey;
  }
  return doc;
};

const stream = (pull: (controller: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) =>
  new ReadableStream<Uint8Array>({ pull });

function bodyFor(b: z.output<typeof behaviourSchema>, defaultJson: unknown): { body: ConstructorParameters<typeof Response>[0]; type?: string; extra?: Record<string, string> } {
  if (b.drip) {
    let sent = 0;
    const chunk = new Uint8Array(b.drip.chunkBytes).fill(0x20);
    return {
      body: stream(async (c) => {
        if (b.drip!.bytes >= 0 && sent >= b.drip!.bytes) return c.close();
        await sleep(b.drip!.intervalMs);
        sent += chunk.length;
        c.enqueue(chunk);
      }),
      type: 'application/json',
    };
  }
  if (b.hugeBytes !== undefined) {
    const total = b.hugeBytes;
    const chunk = new TextEncoder().encode('a'.repeat(64 * 1024));
    let sent = 0;
    return {
      body: stream((c) => {
        if (sent === 0) c.enqueue(new TextEncoder().encode('{"x":"'));
        if (sent >= total) {
          c.enqueue(new TextEncoder().encode('"}'));
          return c.close();
        }
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        c.enqueue(n === chunk.length ? chunk : chunk.subarray(0, n));
      }),
      type: 'application/json',
    };
  }
  if (b.gzipBombBytes !== undefined) {
    const gz = createGzip();
    const chunk = Buffer.alloc(64 * 1024, 'a');
    gz.write('{"x":"');
    let left = b.gzipBombBytes;
    (async () => {
      while (left > 0 && !gz.destroyed) {
        const n = Math.min(chunk.length, left);
        left -= n;
        if (!gz.write(n === chunk.length ? chunk : chunk.subarray(0, n))) await new Promise((r) => gz.once('drain', r));
      }
      gz.end('"}');
    })().catch(() => null);
    return { body: Readable.toWeb(gz) as unknown as ReadableStream, type: 'application/json', extra: { 'content-encoding': 'gzip' } };
  }
  if (b.bodyBase64 !== undefined) return { body: Buffer.from(b.bodyBase64, 'base64') };
  if (b.body !== undefined) return { body: b.body, type: 'text/plain' };
  if (b.json !== undefined) return { body: JSON.stringify(b.json), type: 'application/json' };
  if (b.nonJson) return { body: '<html><body>not json</body></html>', type: 'text/html' };
  if (b.invalidUtf8) return { body: Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]), type: 'application/json' };
  if (b.deepJson !== undefined) return { body: '{"a":'.repeat(b.deepJson) + '1' + '}'.repeat(b.deepJson), type: 'application/json' };
  return { body: JSON.stringify(defaultJson), type: 'application/json' };
}

type WsData = NonNullable<z.output<typeof behaviourSchema>['ws']>;

async function respond(identity: Identity, req: Request, scheme: 'http' | 'https', localIp: string, sourceIp: string, server: Bun.Server<WsData>): Promise<Response | undefined> {
  const url = new URL(req.url);
  const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  identity.requests.push({
    id: ++requestCounter,
    ts: Date.now(),
    scheme,
    method: req.method,
    path: url.pathname + url.search,
    host: req.headers.get('host') ?? '',
    headers: Object.fromEntries(req.headers),
    body: bodyText.slice(0, 256 * 1024),
    sourceIp,
    localIp,
  });

  const rule = [...identity.rules]
    .reverse()
    .find(
      (r) =>
        (!r.method || r.method === req.method) &&
        (r.prefix ? url.pathname.startsWith(r.path) : r.path === url.pathname) &&
        (r.left === undefined || r.left > 0)
    );
  if (rule?.left !== undefined) rule.left--;
  const b = rule?.behaviour ?? {};
  const isInfo = req.method === 'GET' && url.pathname === infoPath;

  if (b.hangMs !== undefined) {
    if (b.hangMs < 0) return new Promise<Response>(() => {});
    await sleep(b.hangMs);
  }
  if (b.redirect) return new Response(null, { status: b.status ?? 302, headers: { location: b.redirect } });
  if (b.ws && req.headers.get('upgrade')?.toLowerCase() === 'websocket' && server.upgrade(req, { data: b.ws })) return undefined;

  const defaultJson = isInfo ? discoveryDoc(identity, b) : { error: 'not found' };
  const { body, type, extra } = bodyFor(b, defaultJson);
  const status = b.status ?? (isInfo || rule ? 200 : 404);
  const headers = new Headers({ ...(type ? { 'content-type': type } : {}), ...extra, ...b.headers });
  return new Response(body, { status, headers });
}

async function sign(input: z.output<typeof signSchema>) {
  const identity = identities[input.identity];
  const key = input.key === 'random' ? newKey() : input.key === 'previous' ? identity.previousKey : identity.key;
  if (!key) throw new Error('no previous key (rotate first)');
  const bodyHash = input.bodyHash ?? crypto.createHash('sha256').update(input.body, 'utf8').digest('base64');
  const homeserver = input.homeserver ?? identity.privateIp;
  const date = input.date ?? new Date(Date.now() + (input.dateOffsetSeconds ?? 0) * 1000).toISOString();
  const nonce = input.nonce ?? crypto.randomBytes(16).toString('hex');
  const signingString = ['v1', input.method.toUpperCase(), input.path, input.host, homeserver, date, nonce, bodyHash].join('\n');
  let signature = crypto.sign(null, Buffer.from(signingString, 'utf8'), key.privateKey);
  if (input.tamper) signature[0]! ^= 0xff;
  return {
    signingString,
    headers: {
      'X-Novarum-Homeserver': homeserver,
      'X-Novarum-Key-Id': input.keyId ?? key.id,
      'X-Novarum-Date': date,
      'X-Novarum-Nonce': nonce,
      'X-Novarum-Body-SHA256': bodyHash,
      'X-Novarum-Signature': signature.toString('base64'),
    },
  };
}

const ruleSchema = z.object({ route: z.string(), behaviour: behaviourSchema.default({}) });
const parseRoute = (route: string) => {
  const m = /^(?:([A-Z]+) )?(\S+)$/.exec(route);
  if (!m) throw new Error(`bad route ${route}`);
  const prefix = m[2]!.endsWith('*');
  return { method: m[1], path: prefix ? m[2]!.slice(0, -1) : m[2]!, prefix };
};

const idFrom = (s: string | undefined) => {
  const id = z.enum(identityIds).parse(s);
  return identities[id];
};

async function admin(req: Request) {
  const url = new URL(req.url);
  const p = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/reset' && req.method === 'POST') {
      for (const i of Object.values(identities)) {
        i.rules = [];
        i.requests = [];
      }
      return json({ ok: true });
    }
    if (url.pathname === '/sign' && req.method === 'POST') return json(await sign(signSchema.parse(await req.json())));
    if (p[0] === 'identity') {
      const identity = idFrom(p[1]);
      const sub = p[2];
      if (!sub && req.method === 'GET')
        return json({ id: identity.id, privateIp: identity.privateIp, publicIp: identity.publicIp, publicName: identity.publicName, keyId: identity.key.id, publicKey: identity.key.publicKey });
      if (sub === 'routes' && req.method === 'PUT') {
        const { route, behaviour } = ruleSchema.parse(await req.json());
        const rule = { ...parseRoute(route), behaviour: behaviourSchema.parse(behaviour), left: behaviour.times };
        identity.rules.push(rule);
        return json({ ok: true });
      }
      if (sub === 'routes' && req.method === 'DELETE') {
        identity.rules = [];
        return json({ ok: true });
      }
      if (sub === 'requests' && req.method === 'GET') {
        const prefix = url.searchParams.get('path');
        const since = Number(url.searchParams.get('since') ?? 0);
        return json(identity.requests.filter((r) => r.id > since && (!prefix || r.path.startsWith(prefix))));
      }
      if (sub === 'requests' && req.method === 'DELETE') {
        identity.requests = [];
        return json({ ok: true });
      }
      if (sub === 'rotate' && req.method === 'POST') {
        identity.previousKey = identity.key;
        identity.key = newKey();
        return json({ keyId: identity.key.id, publicKey: identity.key.publicKey, previousKeyId: identity.previousKey.id });
      }
    }
    return json({ error: 'not found' }, 404);
  } catch (error) {
    return json({ error: String(error) }, 400);
  }
}

if (import.meta.main) {
  runSetup(process.env.FAKE_SETUP);
  // the compose file assigns .66 on each network; .67 is added here
  for (const cidr of (process.env.FAKE_EXTRA_IPS ?? '172.30.0.67/24,203.0.113.67/24').split(',')) addIp(cidr);

  const certs = (name: string) => ({ serverName: name, cert: readFileSync(`${certDir}/${name}.crt`), key: readFileSync(`${certDir}/${name}.key`) });
  const names = ['evil.test', 'evil2.test', 'wrongcert.test', 'selfsigned.test', 'expired.test'];

  for (const identity of Object.values(identities)) {
    for (const [hostname, port, scheme] of [
      [identity.privateIp, 80, 'http'],
      [identity.publicIp, 80, 'http'],
      [identity.publicIp, 443, 'https'],
    ] as const) {
      Bun.serve<WsData>({
        hostname,
        port,
        idleTimeout: 0,
        websocket: {
          async open(ws) {
            // frames sent in the same tick as the upgrade can be lost by the client (seen with Bun 1.3.9), so give it a moment
            await sleep(150);
            for (const m of ws.data.messages) ws.send(typeof m === 'string' ? m : JSON.stringify(m));
            if (ws.data.close) ws.close(ws.data.close.code, ws.data.close.reason);
          },
          message() {},
        },
        // the identity's own name first so it is the default for unknown SNI / IP-literal requests
        tls:
          scheme === 'https'
            ? [certs(identity.publicName), ...names.filter((n) => n !== identity.publicName).map(certs)]
            : undefined,
        fetch: (req, server) => respond(identity, req, scheme, hostname, server.requestIP(req)?.address ?? '', server),
      });
    }
  }
  Bun.serve({ hostname: '0.0.0.0', port: adminPort, idleTimeout: 30, fetch: admin });
  console.log(`[fake] up, admin on ${adminPort}`);
}
