import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { signup } from '../harness/users';
import { openRealtime } from '../harness/ws';
import { anonymous, call, createGuild } from '../harness/chat';

let anchor: RunningAnchor;
let sql: ReturnType<typeof connect>;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'invites' });
  sql = connect(anchor.databaseUrl);
});
afterAll(async () => {
  await sql.close();
  await anchor.destroy();
});

async function world() {
  const [owner, joiner, stranger] = await Promise.all([signup(anchor.url), signup(anchor.url), signup(anchor.url)]);
  const { guild, channel } = await createGuild(owner);
  return { owner, joiner, stranger, guild, channel };
}
const createInvite = async (owner: Awaited<ReturnType<typeof signup>>, guildId: string, body: object = {}) =>
  (await call(owner, 'POST', `/guilds/${guildId}/invites`, body)).body.invite;
const memberRows = (guildId: string) => sql`SELECT "userId", position FROM guild_member WHERE "guildId" = ${guildId}`;

describe('create and read', () => {
  test('only the owner can create an invite (403 member and non-member, 404 unknown guild)', async () => {
    const { owner, joiner, stranger, guild } = await world();
    const invite = await createInvite(owner, guild.id);
    await call(joiner, 'POST', '/invite/accept', { code: invite.code });
    expect((await call(joiner, 'POST', `/guilds/${guild.id}/invites`, {})).status).toBe(403);
    expect((await call(stranger, 'POST', `/guilds/${guild.id}/invites`, {})).status).toBe(403);
    expect((await call(owner, 'POST', '/guilds/nope/invites', {})).status).toBe(404);
    expect((await call(anonymous(anchor.url), 'POST', `/guilds/${guild.id}/invites`, {})).status).toBe(401);
  });

  test('GET /guilds/:id/invites: owner 404 before creation then 200; non-owners get 401 (not 403)', async () => {
    const { owner, joiner, stranger, guild } = await world();
    expect((await call(owner, 'GET', `/guilds/${guild.id}/invites`)).status).toBe(404);
    const invite = await createInvite(owner, guild.id);
    const read = await call(owner, 'GET', `/guilds/${guild.id}/invites`);
    expect(read.body.invite).toMatchObject({ id: invite.id, code: invite.code, guildId: guild.id });
    await call(joiner, 'POST', '/invite/accept', { code: invite.code });
    expect((await call(joiner, 'GET', `/guilds/${guild.id}/invites`)).status).toBe(401);
    expect((await call(stranger, 'GET', `/guilds/${guild.id}/invites`)).status).toBe(401);
    expect((await call(owner, 'GET', '/guilds/nope/invites')).status).toBe(404);
  });

  test('a new invite without expiry has an 8 char alphanumeric code and expiresAt null', async () => {
    const { owner, guild } = await world();
    const invite = await createInvite(owner, guild.id);
    expect(invite.code).toMatch(/^[a-z0-9]{8}$/);
    expect(invite.expiresAt).toBeNull();
    expect(invite.creatorId).toBe(owner.user.id);
  });

  test('creating without a body works', async () => {
    const { owner, guild } = await world();
    const res = await owner.fetch(`/guilds/${guild.id}/invites`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  // known gap: the body's expiresAt is accepted by the schema but never stored
  test.failing('an expiresAt in the create body is stored on the invite', async () => {
    const { owner, guild } = await world();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const invite = await createInvite(owner, guild.id, { expiresAt });
    expect(invite.expiresAt).toBe(expiresAt);
  });

  test('regenerating deletes the old invite: one invite per owner and guild', async () => {
    const { owner, guild } = await world();
    const first = await createInvite(owner, guild.id);
    const second = await createInvite(owner, guild.id);
    expect(second.code).not.toBe(first.code);
    expect((await call(anonymous(anchor.url), 'GET', `/invite/${first.code}`)).status).toBe(404);
    expect((await call(anonymous(anchor.url), 'GET', `/invite/${second.code}`)).status).toBe(200);
    const rows = await sql`SELECT code FROM guild_invite WHERE "guildId" = ${guild.id}`;
    expect(rows.map((r: any) => r.code)).toEqual([second.code]);
  });

  test('a federated guild id is refused with 400', async () => {
    const { owner } = await world();
    expect((await call(owner, 'POST', '/guilds/fed:guild:example.test:abc/invites', {})).status).toBe(400);
    expect((await call(owner, 'GET', '/guilds/fed:guild:example.test:abc/invites')).status).toBe(400);
  });
});

describe('preview', () => {
  test('GET /invite/:code needs no session and shows guild, creator and member count', async () => {
    const { owner, joiner, guild } = await world();
    const invite = await createInvite(owner, guild.id);
    const anon = anonymous(anchor.url);
    const before = await call(anon, 'GET', `/invite/${invite.code}`);
    expect(before.status).toBe(200);
    expect(before.body.guild).toMatchObject({ id: guild.id, name: guild.name, memberCount: 1 });
    expect(before.body.invite.creator).toMatchObject({ id: owner.user.id, username: owner.user.username });
    await call(joiner, 'POST', '/invite/accept', { code: invite.code });
    expect((await call(anon, 'GET', `/invite/${invite.code}`)).body.guild.memberCount).toBe(2);
  });

  test('the preview does not leak credentials of the creator', async () => {
    const { owner, guild } = await world();
    const invite = await createInvite(owner, guild.id);
    const { body } = await call(anonymous(anchor.url), 'GET', `/invite/${invite.code}`);
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|email|totp/i);
  });

  test('unknown code is 404', async () => {
    expect((await call(anonymous(anchor.url), 'GET', '/invite/nonexistent')).status).toBe(404);
  });
});

describe('accept', () => {
  test('joining adds a MEMBER and reports the guild id', async () => {
    const { owner, joiner, guild, channel } = await world();
    const invite = await createInvite(owner, guild.id);
    const res = await call(joiner, 'POST', '/invite/accept', { code: invite.code });
    expect(res).toEqual({ status: 200, body: { guildId: guild.id } });
    const { users } = (await call(joiner, 'GET', `/channel/${channel.id}/users`)).body;
    expect(users.find((u: any) => u.userId === joiner.user.id).role).toBe('MEMBER');
  });

  test('accepting twice is idempotent: no duplicate row, position unchanged', async () => {
    const { owner, joiner, guild } = await world();
    const invite = await createInvite(owner, guild.id);
    await createGuild(joiner, 'other');
    await call(joiner, 'POST', '/invite/accept', { code: invite.code });
    const before = await memberRows(guild.id);
    const again = await call(joiner, 'POST', '/invite/accept', { code: invite.code });
    expect(again).toEqual({ status: 200, body: { guildId: guild.id } });
    expect(await memberRows(guild.id)).toEqual(before);
    const list = (await call(joiner, 'GET', '/guilds/list')).body.guilds;
    expect(list.map((g: any) => g.id)).toEqual([guild.id, expect.any(String)]);
  });

  // real bug (not in the plan): check-then-insert race on guild_member's primary key makes parallel accepts return 500
  test.failing('concurrent accepts by one user never fail and leave one membership', async () => {
    const { owner, joiner, guild } = await world();
    const { code } = await createInvite(owner, guild.id);
    const results = await Promise.all(Array.from({ length: 8 }, () => call(joiner, 'POST', '/invite/accept', { code })));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(await memberRows(guild.id)).toHaveLength(2);
  });

  test('the owner accepting their own invite changes nothing', async () => {
    const { owner, guild } = await world();
    const invite = await createInvite(owner, guild.id);
    expect((await call(owner, 'POST', '/invite/accept', { code: invite.code })).status).toBe(200);
    expect(await memberRows(guild.id)).toHaveLength(1);
  });

  test('new guild lands at position 0 and shifts the joiner other guilds down', async () => {
    const { owner, joiner, guild } = await world();
    const mine = await createGuild(joiner, 'mine');
    await call(joiner, 'POST', '/invite/accept', { code: (await createInvite(owner, guild.id)).code });
    const rows = await sql`SELECT "guildId", position FROM guild_member WHERE "userId" = ${joiner.user.id} ORDER BY position`;
    expect(rows.map((r: any) => [r.guildId, r.position])).toEqual([
      [guild.id, 0],
      [mine.guild.id, 1],
    ]);
  });

  test('an invite stays usable by several users', async () => {
    const { owner, joiner, stranger, guild } = await world();
    const { code } = await createInvite(owner, guild.id);
    expect((await call(joiner, 'POST', '/invite/accept', { code })).status).toBe(200);
    expect((await call(stranger, 'POST', '/invite/accept', { code })).status).toBe(200);
    expect(await memberRows(guild.id)).toHaveLength(3);
  });

  test('naming our own homeserver explicitly takes the local path', async () => {
    const { owner, joiner, guild } = await world();
    const { code } = await createInvite(owner, guild.id);
    const res = await call(joiner, 'POST', '/invite/accept', { code, homeserver: joiner.user.homeserver });
    expect(res).toEqual({ status: 200, body: { guildId: guild.id } });
  });

  test('unknown code 404, anonymous 401, empty code rejected', async () => {
    const { joiner } = await world();
    expect((await call(joiner, 'POST', '/invite/accept', { code: 'nonexistent' })).status).toBe(404);
    expect((await call(anonymous(anchor.url), 'POST', '/invite/accept', { code: 'x' })).status).toBe(401);
    expect((await call(joiner, 'POST', '/invite/accept', { code: '' })).status).toBe(422);
  });

  test('existing members are told about the new member over realtime', async () => {
    const { owner, joiner, guild } = await world();
    const ws = await openRealtime(anchor.url, owner.cookie);
    try {
      await Bun.sleep(200);
      await call(joiner, 'POST', '/invite/accept', { code: (await createInvite(owner, guild.id)).code });
      const event = await ws.waitFor('member.joined', (e) => e.data?.guildId === guild.id);
      expect(event.data.user).toMatchObject({ username: joiner.user.username });
    } finally {
      ws.close();
    }
  });
});

describe('expiry', () => {
  const expire = (code: string, when: string) =>
    sql`UPDATE guild_invite SET "expiresAt" = ${new Date(when)} WHERE code = ${code}`;

  test('an expired invite is 404 for preview and accept, and nobody joins', async () => {
    const { owner, joiner, guild } = await world();
    const { code } = await createInvite(owner, guild.id);
    await expire(code, '2020-01-01T00:00:00Z');
    expect((await call(anonymous(anchor.url), 'GET', `/invite/${code}`)).status).toBe(404);
    expect((await call(joiner, 'POST', '/invite/accept', { code })).status).toBe(404);
    expect(await memberRows(guild.id)).toHaveLength(1);
  });

  test('an invite expiring in the future still works and shows expiresAt', async () => {
    const { owner, joiner, guild } = await world();
    const { code } = await createInvite(owner, guild.id);
    const future = new Date(Date.now() + 3600_000);
    await expire(code, future.toISOString());
    const preview = await call(anonymous(anchor.url), 'GET', `/invite/${code}`);
    expect(preview.body.invite.expiresAt).toBe(future.toISOString());
    expect((await call(joiner, 'POST', '/invite/accept', { code })).status).toBe(200);
  });

  test('an already-joined member keeps access after the invite expires', async () => {
    const { owner, joiner, guild, channel } = await world();
    const { code } = await createInvite(owner, guild.id);
    await call(joiner, 'POST', '/invite/accept', { code });
    await expire(code, '2020-01-01T00:00:00Z');
    expect((await call(joiner, 'GET', `/channel/${channel.id}/users`)).status).toBe(200);
  });
});
