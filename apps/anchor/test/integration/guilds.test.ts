import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { signup } from '../harness/users';
import { call, createGuild, join } from '../harness/chat';
import { z } from 'zod';

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'guilds' });
});
afterAll(() => anchor.destroy());

const listSchema = z.object({
  guilds: z.array(z.object({ id: z.string(), name: z.string(), canManageChannels: z.boolean() })),
});
const guildIds = async (user: Awaited<ReturnType<typeof signup>>) =>
  listSchema.parse((await call(user, 'GET', '/guilds/list')).body).guilds.map((g) => g.id);

describe('create', () => {
  test('creates a guild owned by the caller with a default general channel', async () => {
    const owner = await signup(anchor.url);
    const { guild, channel } = await createGuild(owner, 'My guild');
    expect(guild).toMatchObject({ name: 'My guild', ownerId: owner.user.id });

    const { guilds } = (await call(owner, 'GET', '/guilds/list')).body;
    expect(guilds).toHaveLength(1);
    expect(guilds[0]).toMatchObject({ id: guild.id, canManageChannels: true });
    expect(guilds[0].channels).toEqual([
      expect.objectContaining({ id: channel.id, name: 'general', type: 'TEXT', position: 0, unread: false, mention: 0 }),
    ]);
  });

  test('the owner is listed with the OWNER role', async () => {
    const owner = await signup(anchor.url);
    const { channel } = await createGuild(owner);
    const { users } = (await call(owner, 'GET', `/channel/${channel.id}/users`)).body;
    expect(users).toEqual([expect.objectContaining({ userId: owner.user.id, role: 'OWNER' })]);
  });

  test.each([
    ['empty name', ''],
    ['name over 100 chars', 'x'.repeat(101)],
    ['missing name', undefined],
    ['non-string name', 5],
  ])('rejects %s', async (_, name) => {
    const owner = await signup(anchor.url);
    const res = await call(owner, 'POST', '/guilds/create', { name });
    expect(res.status).toBe(422);
  });

  test('accepts a 100 char name', async () => {
    const owner = await signup(anchor.url);
    expect((await call(owner, 'POST', '/guilds/create', { name: 'x'.repeat(100) })).status).toBe(200);
  });
});

describe('list and order', () => {
  test('every new guild goes to position 0, older ones shift down', async () => {
    const user = await signup(anchor.url);
    const a = await createGuild(user, 'a');
    const b = await createGuild(user, 'b');
    const owner = await signup(anchor.url);
    const c = await createGuild(owner, 'c');
    await join(owner, c.guild.id, user);
    const d = await createGuild(user, 'd');
    expect(await guildIds(user)).toEqual([d.guild.id, c.guild.id, b.guild.id, a.guild.id]);
  });

  test('guild list only contains guilds the user is a member of', async () => {
    const a = await signup(anchor.url);
    const b = await signup(anchor.url);
    await createGuild(a);
    expect(await guildIds(b)).toEqual([]);
  });

  test('PATCH /guilds/order reorders the caller list and persists it', async () => {
    const user = await signup(anchor.url);
    const ids = [(await createGuild(user)).guild.id, (await createGuild(user)).guild.id, (await createGuild(user)).guild.id];
    const wanted = [ids[1]!, ids[0]!, ids[2]!];
    expect((await call(user, 'PATCH', '/guilds/order', { guildIds: wanted })).body).toEqual({ success: true });
    expect(await guildIds(user)).toEqual(wanted);
  });

  test('reordering is per user', async () => {
    const owner = await signup(anchor.url);
    const other = await signup(anchor.url);
    const first = await createGuild(owner);
    const second = await createGuild(owner);
    await join(owner, first.guild.id, other);
    await join(owner, second.guild.id, other);
    const before = await guildIds(other);
    await call(owner, 'PATCH', '/guilds/order', { guildIds: [first.guild.id, second.guild.id] });
    expect(await guildIds(other)).toEqual(before);
  });

  test('order must list every membership exactly once', async () => {
    const user = await signup(anchor.url);
    const stranger = await signup(anchor.url);
    const a = (await createGuild(user)).guild.id;
    const b = (await createGuild(user)).guild.id;
    const foreign = (await createGuild(stranger)).guild.id;
    for (const guildIds of [[], [a], [a, a], [a, b, b], [a, b, a], [a, foreign], [a, b, foreign], [a, b, 'nope']]) {
      expect((await call(user, 'PATCH', '/guilds/order', { guildIds })).status).toBe(400);
    }
    // a rejected reorder changes nothing
    expect(await guildIds(user)).toEqual([b, a]);
  });
});

describe('patch', () => {
  // known gap: the plan lists "guild patch" but no route exists (only /order and /:id/avatar)
  test.failing('PATCH /guilds/:id lets the owner rename the guild', async () => {
    const owner = await signup(anchor.url);
    const { guild } = await createGuild(owner);
    const res = await call(owner, 'PATCH', `/guilds/${guild.id}`, { name: 'renamed' });
    expect(res.status).toBe(200);
  });
});

describe('avatar permissions', () => {
  const upload = (user: Awaited<ReturnType<typeof signup>>, guildId: string, file: File) => {
    const form = new FormData();
    form.set('avatar', file);
    return user.fetch(`/guilds/${guildId}/avatar`, { method: 'POST', body: form });
  };
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });

  test('GET /guilds/avatar/:id is 404 without an avatar and for unknown guilds (no auth needed)', async () => {
    const owner = await signup(anchor.url);
    const { guild } = await createGuild(owner);
    expect((await fetch(`${anchor.url}/guilds/avatar/${guild.id}`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${anchor.url}/guilds/avatar/nope`, { redirect: 'manual' })).status).toBe(404);
  });

  test('non-owners (member or not) get 403, unknown guild 404, anonymous 401', async () => {
    const owner = await signup(anchor.url);
    const member = await signup(anchor.url);
    const stranger = await signup(anchor.url);
    const { guild } = await createGuild(owner);
    await join(owner, guild.id, member);
    expect((await upload(member, guild.id, png())).status).toBe(403);
    expect((await upload(stranger, guild.id, png())).status).toBe(403);
    expect((await upload(owner, 'nope', png())).status).toBe(404);
    const form = new FormData();
    form.set('avatar', png());
    const anon = await fetch(`${anchor.url}/guilds/${guild.id}/avatar`, { method: 'POST', body: form });
    expect(anon.status).toBe(401);
  });

  test('the owner is limited to png and gif', async () => {
    const owner = await signup(anchor.url);
    const { guild } = await createGuild(owner);
    const jpeg = new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' });
    expect((await upload(owner, guild.id, jpeg)).status).toBe(415);
  });

  test('a federated guild id is refused with 400', async () => {
    const owner = await signup(anchor.url);
    expect((await upload(owner, 'fed:guild:example.test:abc', png())).status).toBe(400);
  });
});

test('every guild route needs a session', async () => {
  // bodies are valid on purpose: schema validation runs before the session check (invalid body -> 422)
  for (const [method, path, body] of [
    ['POST', '/guilds/create', { name: 'x' }],
    ['GET', '/guilds/list'],
    ['PATCH', '/guilds/order', { guildIds: [] }],
    ['GET', '/guilds/x/invites'],
    ['POST', '/guilds/x/invites', {}],
  ] as const) {
    const res = await fetch(`${anchor.url}${path}`, {
      method,
      headers: { cookie: 'session_token=forged.token', 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    expect(res.status, `${method} ${path}`).toBe(401);
  }
});

describe('avatar upload (needs Garage)', () => {
  let s3: RunningAnchor;
  beforeAll(async () => {
    s3 = await spawnAnchor({ name: 'guilds-s3', s3: true });
  });
  afterAll(() => s3.destroy());

  // 1x1 transparent png
  const png = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0)
  );

  test('the owner uploads a png, the guild gets an avatarUrl that redirects to storage', async () => {
    const owner = await signup(s3.url);
    const { guild } = await createGuild(owner);
    const form = new FormData();
    form.set('avatar', new File([png], 'a.png', { type: 'image/png' }));
    const res = await owner.fetch(`/guilds/${guild.id}/avatar`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const { avatarUrl } = (await res.json()) as { avatarUrl: string };
    expect(avatarUrl).toContain(`/guilds/avatar/${guild.id}`);

    const { guilds } = (await call(owner, 'GET', '/guilds/list')).body;
    expect(guilds[0].avatarUrl).toBe(avatarUrl);
    const redirect = await fetch(`${s3.url}/guilds/avatar/${guild.id}`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('cache-control')).toContain('no-store');
  });
});
