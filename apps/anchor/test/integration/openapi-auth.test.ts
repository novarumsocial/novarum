import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { spawnAnchor } from '../harness/anchor';
import { cookieName, signup } from '../harness/users';

// Every route in /openapi/json is exercised without a session and with forged sessions, so a new
// route is covered automatically. A route is only exempt if it is listed below WITH a reason.
// Otherwise it must answer 401 for both cases (with a request that is otherwise valid, so that
// body/query validation can't answer first).

/** reachable without a session on purpose */
const publicRoutes: Record<string, string> = {
  'GET /': 'health banner',
  'POST /auth/signup': 'creates the account',
  'POST /auth/login': 'creates the session',
  'POST /auth/login/mfa': 'second step of login, authorised by the challenge id',
  'POST /auth/login/mfa/email': 'sends the login code, authorised by the challenge id',
  'POST /auth/logout': 'idempotent, works (and clears the cookie) with no session',
  'POST /auth/reset-password': 'authorised by the mailed OTP',
  'POST /auth/password-reset/request': 'unauthenticated by nature (the user forgot the password)',
  'GET /guilds/avatar/{id}': 'avatars are public images (redirect to a presigned URL)',
  'GET /user/avatar/{userId}': 'avatars are public images (redirect to a presigned URL)',
  'GET /user/banner/{userId}': 'banners are public images (redirect to a presigned URL)',
  'GET /user/about/{userId}': 'profile text is public (also fetched by remote homeservers/clients)',
  'GET /notifications/vapid-key': 'the public VAPID key is what browsers need to subscribe to push',
  'GET /invite/{code}': 'invite preview before joining; the code is the credential',
};

/** authenticated by something other than the session cookie: they must still refuse a bare request */
const otherCredential: Record<string, string> = {
  'GET /attachment/{id}': 'signed URL (exp + sig)',
  'GET /attachment/{id}/preview': 'signed URL (exp + sig)',
  'POST /channel/livekit/webhook': 'LiveKit JWT in the Authorization header',
};
/** not plain HTTP: the WebSocket upgrade's cookie check belongs to the realtime suite */
const websocketRoutes = new Set(['WS /realtime/']);
const isFederation = (key: string) => key.split(' ')[1]!.startsWith('/federation/'); // ed25519-signed homeserver requests

const specSchema = z.object({
  paths: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({
        parameters: z.array(z.looseObject({ in: z.string(), name: z.string(), schema: z.any().optional() })).optional(),
        requestBody: z.object({ content: z.record(z.string(), z.object({ schema: z.any().optional() })) }).optional(),
      })
    )
  ),
  components: z.object({ schemas: z.record(z.string(), z.any()).optional() }).optional(),
});

const anchor = await spawnAnchor({ name: 'openapiauth' });
afterAll(() => anchor.destroy());
const spec = specSchema.parse(await (await fetch(`${anchor.url}/openapi/json`)).json());
const victim = await signup(anchor.url);

// a value that satisfies a JSON schema as far as the validators here care
function sample(schema: any): any {
  if (!schema) return 'x';
  if (schema.$ref) return sample(spec.components?.schemas?.[schema.$ref.split('/').pop()!]);
  const options = schema.anyOf ?? schema.oneOf;
  if (options) return sample(options.find((s: any) => s.type !== 'null' && s.format !== 'integer') ?? options[0]); // t.Integer() also accepts its string form
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map(sample));
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
      return Object.fromEntries((schema.required ?? []).map((k: string) => [k, sample(schema.properties?.[k])]));
    default:
      return 'x';
  }
}

function build(method: string, path: string, op: z.infer<typeof specSchema>['paths'][string][string]) {
  const params = op.parameters ?? [];
  const query = new URLSearchParams();
  let url = path;
  for (const p of params) {
    const value = String(sample(p.schema));
    if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(value));
    else if (p.in === 'query' && p.required) query.set(p.name, value);
  }
  const qs = query.size ? `?${query}` : '';
  const content = op.requestBody?.content;
  if (!content) return { url: url + qs, init: { method } as RequestInit };
  const body = sample(content['application/json']?.schema ?? Object.values(content)[0]?.schema);
  const hasFile = Object.values(body ?? {}).some((v) => v instanceof File);
  if (!hasFile) {
    return { url: url + qs, init: { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } as RequestInit };
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.set(k, v as any);
  return { url: url + qs, init: { method, body: form } as RequestInit };
}

const routes = Object.entries(spec.paths).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, op }))
);

const [victimId, victimSecret] = victim.cookie.split('.') as [string, string];
const sessions: Record<string, string | null> = {
  'no cookie': null,
  'random well-formed token': `${'a'.repeat(24)}.${'b'.repeat(24)}`,
  'real session id, wrong secret': `${victimId}.${'z'.repeat(victimSecret.length)}`,
  'malformed token': 'garbage',
  'empty cookie': '',
};

describe('allow-lists', () => {
  test('the spec lists routes and every allow-list entry still exists', () => {
    expect(routes.length).toBeGreaterThan(40);
    const keys = new Set(routes.map((r) => r.key));
    for (const key of [...Object.keys(publicRoutes), ...Object.keys(otherCredential), ...websocketRoutes]) {
      expect(keys.has(key), `stale allow-list entry: ${key}`).toBe(true);
    }
  });

  test('the victim session used for forging is itself valid', async () => {
    expect((await victim.fetch('/auth/me')).status).toBe(200);
  });
});

// guilds/channels/messages/DMs/realtime behaviour beyond the 401 contract is covered by their own suites
describe('authenticated routes answer 401 without a valid session', () => {
  for (const r of routes) {
    if (r.key in publicRoutes || r.key in otherCredential || isFederation(r.key) || websocketRoutes.has(r.key)) continue;
    for (const [label, token] of Object.entries(sessions)) {
      test(`${r.key} (${label})`, async () => {
        const { url, init } = build(r.method, r.path, r.op);
        const headers = new Headers(init.headers);
        if (token !== null) headers.set('cookie', `${cookieName}=${token}`);
        const res = await fetch(`${anchor.url}${url}`, { ...init, headers, redirect: 'manual' });
        expect(res.status, await res.clone().text()).toBe(401);
      });
    }
  }
});

describe('routes with another credential refuse a bare request', () => {
  for (const r of routes) {
    if (!(r.key in otherCredential) && !isFederation(r.key)) continue;
    test(`${r.key} (${otherCredential[r.key] ?? 'signed homeserver request'})`, async () => {
      const { url, init } = build(r.method, r.path, r.op);
      const res = await fetch(`${anchor.url}${url}`, { ...init, redirect: 'manual' });
      // never a success or a redirect; the exact 4xx/5xx is the owning suite's business
      expect(res.status, await res.clone().text()).toBeGreaterThanOrEqual(400);
    });
  }
});
