import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { signup } from '../harness/users';
import { befriend, unfriend } from '../harness/friends';
import { anonymous, call, createGuild, join, send } from '../harness/chat';

// §7 authz matrix for the routes of §4.3. Each cell uses a fresh actor, so cells can't influence each other.
// Statuses were pinned from the code: note the deliberate-looking inconsistencies (401 vs 403 for "not a member").

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'authz' });
});
afterAll(() => anchor.destroy());

type Actor = Pick<Awaited<ReturnType<typeof signup>>, 'fetch'>;
type Fx = Awaited<ReturnType<typeof guildFixture>>;

async function guildFixture() {
  const owner = await signup(anchor.url);
  const { guild, channel } = await createGuild(owner);
  const voice = (await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'voice', type: 'VOICE' })).body;
  const member = await signup(anchor.url);
  const code = await join(owner, guild.id, member);
  const refreshCode = async () => (fx.code = (await call(owner, 'POST', `/guilds/${guild.id}/invites`, {})).body.invite.code as string);
  const memberMessage = (await send(member, channel.id, 'by member')).body.message;
  const fx = {
    refreshCode,
    owner,
    guild,
    channel,
    voice,
    code: code as string,
    memberMessage,
    ownerMessage: async () => (await send(owner, channel.id, 'by owner')).body.message,
    channelIds: async () =>
      (await call(owner, 'GET', '/guilds/list')).body.guilds.find((g: any) => g.id === guild.id).channels.map((c: any) => c.id),
  };
  return fx;
}

type Expected = [anonymous: number, nonMember: number, member: number, owner: number];
type Route = {
  key: string; // as in the OpenAPI document
  method: string;
  path: (fx: Fx) => string;
  body?: (fx: Fx) => unknown | Promise<unknown>;
  expected: Expected;
};

const json = (body: unknown) => JSON.stringify(body);
const textFile = () => {
  const form = new FormData();
  form.set('avatar', new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }));
  return form;
};

const guildRoutes: Route[] = [
  { key: 'POST /guilds/create', method: 'POST', path: () => '/guilds/create', body: () => ({ name: 'x' }), expected: [401, 200, 200, 200] },
  { key: 'GET /guilds/list', method: 'GET', path: () => '/guilds/list', expected: [401, 200, 200, 200] },
  { key: 'GET /guilds/avatar/{id}', method: 'GET', path: (fx) => `/guilds/avatar/${fx.guild.id}`, expected: [404, 404, 404, 404] },
  // owner reaches the 415 type check (jpeg), so owner passed every permission check
  { key: 'POST /guilds/{id}/avatar', method: 'POST', path: (fx) => `/guilds/${fx.guild.id}/avatar`, body: textFile, expected: [401, 403, 403, 415] },
  { key: 'GET /guilds/{id}/invites', method: 'GET', path: (fx) => `/guilds/${fx.guild.id}/invites`, expected: [401, 401, 401, 200] },
  { key: 'POST /guilds/{id}/invites', method: 'POST', path: (fx) => `/guilds/${fx.guild.id}/invites`, body: () => ({}), expected: [401, 403, 403, 200] },
  { key: 'GET /invite/{code}', method: 'GET', path: (fx) => `/invite/${fx.code}`, expected: [200, 200, 200, 200] },
  { key: 'POST /invite/accept', method: 'POST', path: () => '/invite/accept', body: (fx) => ({ code: fx.code }), expected: [401, 200, 200, 200] },
  { key: 'POST /channel/create', method: 'POST', path: () => '/channel/create', body: (fx) => ({ guildId: fx.guild.id, name: 'c', type: 'TEXT' }), expected: [401, 403, 403, 200] },
  { key: 'PATCH /channel/order', method: 'PATCH', path: () => '/channel/order', body: async (fx) => ({ guildId: fx.guild.id, channelIds: await fx.channelIds() }), expected: [401, 403, 403, 200] },
  { key: 'GET /channel/{id}/users', method: 'GET', path: (fx) => `/channel/${fx.channel.id}/users`, expected: [401, 401, 200, 200] },
  {
    key: 'POST /channel/{id}/read',
    method: 'POST',
    path: (fx) => `/channel/${fx.channel.id}/read`,
    body: (fx) => ({ messageId: fx.memberMessage.id, createdAt: fx.memberMessage.createdAt }),
    expected: [401, 403, 200, 200],
  },
  { key: 'POST /channel/{id}/typing', method: 'POST', path: (fx) => `/channel/${fx.channel.id}/typing`, expected: [401, 401, 200, 200] },
  { key: 'GET /channel/{id}/call/token', method: 'GET', path: (fx) => `/channel/${fx.voice.id}/call/token`, expected: [401, 401, 200, 200] },
  { key: 'GET /message/list', method: 'GET', path: (fx) => `/message/list?channelId=${fx.channel.id}&cursor=0&amount=20`, expected: [401, 403, 200, 200] },
  { key: 'POST /message/send', method: 'POST', path: () => '/message/send', body: (fx) => ({ channelId: fx.channel.id, content: 'hi', nonce: `n${Math.random()}` }), expected: [401, 403, 200, 200] },
  // messages below are authored by the guild owner: only the author (owner column) may change them
  {
    key: 'POST /message/edit',
    method: 'POST',
    path: () => '/message/edit',
    body: async (fx) => ({ channelId: fx.channel.id, messageId: (await fx.ownerMessage()).id, content: 'edited' }),
    expected: [401, 403, 403, 200],
  },
  {
    key: 'POST /message/delete',
    method: 'POST',
    path: () => '/message/delete',
    body: async (fx) => ({ channelId: fx.channel.id, messageId: (await fx.ownerMessage()).id }),
    expected: [401, 403, 403, 200],
  },
];

// not in the table on purpose: the matrix needs each of these to have another test
const covered = new Set([
  'PATCH /guilds/order', // body must equal the caller's memberships, so it is actor specific (guilds.test.ts)
  'GET /channel/{id}/call/participants', // needs a livekit server (voice tests)
  'POST /channel/livekit/webhook', // signature auth, no session (voice tests)
]);

describe('guild routes: anonymous / non-member / member / owner', () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await guildFixture();
  });
  // POST .../invites regenerates the one invite, so make sure the code is valid before every cell
  beforeEach(() => fx.refreshCode());
  const actors = ['anonymous', 'non-member', 'member', 'owner'] as const;
  const actorFor = async (who: (typeof actors)[number]): Promise<Actor> =>
    who === 'anonymous'
      ? anonymous(anchor.url)
      : who === 'owner'
        ? fx.owner
        : who === 'member'
          ? await (async () => {
              const u = await signup(anchor.url);
              await call(u, 'POST', '/invite/accept', { code: fx.code });
              return u;
            })()
          : await signup(anchor.url);

  for (const route of guildRoutes) {
    actors.forEach((who, i) => {
      test(`${route.key} as ${who} -> ${route.expected[i]}`, async () => {
        const actor = await actorFor(who);
        const body = await route.body?.(fx);
        const res = await actor.fetch(route.path(fx), {
          method: route.method,
          body: body === undefined ? undefined : body instanceof FormData ? body : json(body),
        });
        expect(res.status, await res.clone().text()).toBe(route.expected[i]!);
      });
    });
  }

  test('a forged or malformed session cookie behaves like anonymous on every route', async () => {
    for (const route of guildRoutes.filter((r) => r.expected[0] === 401)) {
      for (const token of ['forged.token', 'x', 'a.b.c.d', '']) {
        const body = await route.body?.(fx);
        const res = await fetch(`${anchor.url}${route.path(fx)}`, {
          method: route.method,
          headers: { cookie: `session_token=${token}`, ...(typeof body === 'object' && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
          body: body === undefined ? undefined : body instanceof FormData ? body : json(body),
        });
        expect(res.status, `${route.key} with token "${token}"`).toBe(401);
      }
    }
  });

  test('every OpenAPI route of the area is in the table or explicitly excluded', async () => {
    const doc = (await (await fetch(`${anchor.url}/openapi/json`)).json()) as { paths: Record<string, Record<string, unknown>> };
    const keys = Object.entries(doc.paths)
      .filter(([path]) => /^\/(guilds|channel|message|invite)\//.test(path))
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`));
    const known = new Set([...guildRoutes.map((r) => r.key), ...covered]);
    expect(keys.filter((k) => !known.has(k))).toEqual([]);
    expect([...known].filter((k) => !keys.includes(k))).toEqual([]);
  });
});

describe('dm channel routes: anonymous / outsider / participant / ex-friend', () => {
  type DmFx = { a: Awaited<ReturnType<typeof signup>>; dmId: string; message: any };
  const outcomes: {
    name: string;
    request: (fx: DmFx) => { method: string; path: string; body?: unknown };
    expected: Expected; // the 4th column is a participant whose friendship ended
  }[] = [
    { name: 'GET /message/list', request: (fx) => ({ method: 'GET', path: `/message/list?channelId=${fx.dmId}&cursor=0&amount=20` }), expected: [401, 403, 200, 200] },
    { name: 'POST /message/send', request: (fx) => ({ method: 'POST', path: '/message/send', body: { channelId: fx.dmId, content: 'x', nonce: `n${Math.random()}` } }), expected: [401, 403, 200, 403] },
    { name: 'POST /channel/{id}/typing', request: (fx) => ({ method: 'POST', path: `/channel/${fx.dmId}/typing` }), expected: [401, 401, 200, 401] },
    {
      name: 'POST /channel/{id}/read',
      request: (fx) => ({ method: 'POST', path: `/channel/${fx.dmId}/read`, body: { messageId: fx.message.id, createdAt: fx.message.createdAt } }),
      expected: [401, 403, 200, 200],
    },
    { name: 'GET /channel/{id}/users', request: (fx) => ({ method: 'GET', path: `/channel/${fx.dmId}/users` }), expected: [401, 404, 404, 404] },
    { name: 'POST /dm/{id}/close', request: (fx) => ({ method: 'POST', path: `/dm/${fx.dmId}/close` }), expected: [401, 404, 200, 200] },
  ];
  const actors = ['anonymous', 'outsider', 'participant', 'ex-friend'] as const;

  for (const outcome of outcomes) {
    actors.forEach((who, i) => {
      test(`${outcome.name} as ${who} -> ${outcome.expected[i]}`, async () => {
        const [a, b, outsider] = await Promise.all([signup(anchor.url), signup(anchor.url), signup(anchor.url)]);
        await befriend(a, b);
        const dmId = (await call(a, 'POST', '/dm', { userId: b.user.id })).body.id;
        const message = (await send(b, dmId, 'hello')).body.message;
        const actor = { anonymous: anonymous(anchor.url), outsider, participant: a, 'ex-friend': a }[who];
        if (who === 'ex-friend') await unfriend(a, b);
        const { method, path, body } = outcome.request({ a, dmId, message });
        const res = await actor.fetch(path, { method, body: body === undefined ? undefined : json(body) });
        expect(res.status, await res.clone().text()).toBe(outcome.expected[i]!);
      });
    });
  }

  test('POST /dm: anonymous 401, non-friend 403, friend 200', async () => {
    const [a, friend, stranger] = await Promise.all([signup(anchor.url), signup(anchor.url), signup(anchor.url)]);
    await befriend(a, friend);
    const open = (actor: Actor, userId: string) => call(actor, 'POST', '/dm', { userId });
    expect((await open(anonymous(anchor.url), friend.user.id)).status).toBe(401);
    expect((await open(a, stranger.user.id)).status).toBe(403);
    expect((await open(a, friend.user.id)).status).toBe(200);
  });
});
