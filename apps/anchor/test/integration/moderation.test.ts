import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { signup, type TestUser } from '../harness/users';
import { call, createGuild, join, list, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { addBot, createBot } from '../harness/bots';
import { connect as pg } from '../harness/db';

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'moderation' });
});
afterAll(() => anchor.destroy());

const sql = async (query: string) => {
  const db = pg(anchor.databaseUrl);
  try {
    return await db.unsafe(query);
  } finally {
    await db.close();
  }
};

const guildIds = async (user: TestUser) =>
  ((await call(user, 'GET', '/guilds/list')).body.guilds as { id: string }[]).map((g) => g.id);
const kick = (actor: Pick<TestUser, 'fetch'>, guildId: string, userId: string) =>
  call(actor, 'DELETE', `/guilds/${guildId}/members/${userId}`);
const ban = (actor: Pick<TestUser, 'fetch'>, guildId: string, userId: string, reason?: string) =>
  call(actor, 'PUT', `/guilds/${guildId}/bans/${userId}`, reason === undefined ? {} : { reason });
const invite = async (owner: TestUser, guildId: string) =>
  (await call(owner, 'POST', `/guilds/${guildId}/invites`, {})).body.invite.code as string;
const accept = (user: TestUser, code: string) => call(user, 'POST', '/invite/accept', { code });

async function guildWithMember() {
  const [owner, member] = await Promise.all([signup(anchor.url), signup(anchor.url)]);
  const { guild, channel } = await createGuild(owner);
  await join(owner, guild.id, member);
  return { owner, member, guild, channel };
}

describe('leave', () => {
  test('a member leaves: the guild, its read states and notification settings are gone', async () => {
    const { owner, member, guild, channel } = await guildWithMember();
    await send(owner, channel.id, 'hello');
    await call(member, 'GET', '/guilds/list'); // pins a read state
    await call(member, 'PUT', `/notifications/settings/${guild.id}`, { level: 'NONE' });
    await call(member, 'PUT', `/notifications/settings/${channel.id}`, { level: 'MENTIONS' });
    const ownerRt = await connect(owner);
    const memberRt = await connect(member);

    expect((await call(member, 'POST', `/guilds/${guild.id}/leave`)).status).toBe(200);
    await memberRt.waitFor('guild.deleted', (e) => e.data.guildId === guild.id && !e.data.reason);
    await ownerRt.waitFor('member.left', (e) => e.data.userId === member.user.id);

    expect(await guildIds(member)).toEqual([]);
    expect(
      await sql(`SELECT 1 FROM channel_read_state WHERE "userId" = '${member.user.id}'`)
    ).toHaveLength(0);
    expect(
      await sql(`SELECT 1 FROM notification_setting WHERE "userId" = '${member.user.id}'`)
    ).toHaveLength(0);
    const { users } = (await call(owner, 'GET', `/channel/${channel.id}/users`)).body;
    expect(users.map((u: any) => u.userId)).toEqual([owner.user.id]);
    expect((await list(member, channel.id)).status).toBe(403);
    memberRt.close();
    ownerRt.close();
  });

  test('the owner cannot leave, and the guild list says who owns it', async () => {
    const { owner, member, guild } = await guildWithMember();
    const owned = async (user: TestUser) =>
      (await call(user, 'GET', '/guilds/list')).body.guilds.find((g: any) => g.id === guild.id)
        .owner;
    expect(await owned(owner)).toBe(true);
    expect(await owned(member)).toBe(false);
    const res = await call(owner, 'POST', `/guilds/${guild.id}/leave`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/i);
    expect(await guildIds(owner)).toEqual([guild.id]);
  });

  test('leaving a guild you are not in is a 404', async () => {
    const { guild } = await guildWithMember();
    const stranger = await signup(anchor.url);
    expect((await call(stranger, 'POST', `/guilds/${guild.id}/leave`)).status).toBe(404);
    expect((await call(stranger, 'POST', `/guilds/nope/leave`)).status).toBe(404);
  });

  test('someone who left can join again with an invite', async () => {
    const { owner, member, guild } = await guildWithMember();
    await call(member, 'POST', `/guilds/${guild.id}/leave`);
    expect((await accept(member, await invite(owner, guild.id))).status).toBe(200);
    expect(await guildIds(member)).toEqual([guild.id]);
  });
});

describe('kick', () => {
  test('the owner kicks a member, who loses channels, messages and realtime', async () => {
    const { owner, member, guild, channel } = await guildWithMember();
    const ownerRt = await connect(owner);
    const memberRt = await connect(member);

    expect((await kick(owner, guild.id, member.user.id)).status).toBe(200);
    await memberRt.waitFor(
      'guild.deleted',
      (e) => e.data.guildId === guild.id && e.data.reason === 'kicked'
    );
    await ownerRt.waitFor('member.left', (e) => e.data.userId === member.user.id);

    await send(owner, channel.id, 'secret after kick');
    await Bun.sleep(300);
    expect(memberRt.events.some((e) => e.data?.content === 'secret after kick')).toBe(false);
    expect(await guildIds(member)).toEqual([]);
    expect((await list(member, channel.id)).status).toBe(403);
    expect((await send(member, channel.id, 'still here?')).status).toBe(403);
    expect((await call(member, 'GET', `/channel/${channel.id}/users`)).status).toBe(401);
    // subscribing again is refused too
    memberRt.send({ type: 'subscribe.guild', guildId: guild.id });
    await Bun.sleep(200);
    await send(owner, channel.id, 'secret after resubscribe');
    await Bun.sleep(300);
    expect(memberRt.events.some((e) => e.data?.content === 'secret after resubscribe')).toBe(false);

    // a kick is not a ban
    expect((await accept(member, await invite(owner, guild.id))).status).toBe(200);
    expect(await guildIds(member)).toEqual([guild.id]);
    memberRt.close();
    ownerRt.close();
  });

  test('members cannot kick, nobody kicks the owner or themselves, admins not other admins', async () => {
    const { owner, member, guild } = await guildWithMember();
    const [other, admin, otherAdmin] = await Promise.all([
      signup(anchor.url),
      signup(anchor.url),
      signup(anchor.url),
    ]);
    for (const u of [other, admin, otherAdmin]) await join(owner, guild.id, u);
    await sql(
      `UPDATE guild_member SET role = 'ADMIN' WHERE "userId" IN ('${admin.user.id}', '${otherAdmin.user.id}')`
    );

    expect((await kick(member, guild.id, other.user.id)).status).toBe(403);
    expect((await kick(member, guild.id, owner.user.id)).status).toBe(403);
    expect((await kick(owner, guild.id, owner.user.id)).status).toBe(400);
    expect((await kick(admin, guild.id, owner.user.id)).status).toBe(403);
    expect((await kick(admin, guild.id, admin.user.id)).status).toBe(400);
    expect((await kick(admin, guild.id, otherAdmin.user.id)).status).toBe(403);
    expect((await kick(admin, guild.id, 'nobody')).status).toBe(404);
    expect(await guildIds(other)).toEqual([guild.id]);

    expect((await kick(admin, guild.id, other.user.id)).status).toBe(200);
    expect(await guildIds(other)).toEqual([]);
    // the owner can kick admins
    expect((await kick(owner, guild.id, otherAdmin.user.id)).status).toBe(200);
    expect(await guildIds(otherAdmin)).toEqual([]);
  });

  test('outsiders get a 404 and the guild is untouched', async () => {
    const { member, guild } = await guildWithMember();
    const stranger = await signup(anchor.url);
    expect((await kick(stranger, guild.id, member.user.id)).status).toBe(404);
    expect((await kick(stranger, 'nope', member.user.id)).status).toBe(404);
    expect(await guildIds(member)).toEqual([guild.id]);
  });

  test('an ADMIN bot can kick members; a MEMBER bot cannot', async () => {
    const { owner, member, guild } = await guildWithMember();
    const adminBot = await createBot(owner);
    const memberBot = await createBot(owner);
    await addBot(owner, guild.id, adminBot.bot, 'ADMIN');
    await addBot(owner, guild.id, memberBot.bot);
    expect((await kick(memberBot, guild.id, member.user.id)).status).toBe(403);
    expect((await kick(adminBot, guild.id, owner.user.id)).status).toBe(403);
    expect((await kick(adminBot, guild.id, member.user.id)).status).toBe(200);
  });

  test('kicking someone in a voice channel takes them out of the call', async () => {
    const { owner, member, guild } = await guildWithMember();
    const voice = (
      await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'v', type: 'VOICE' })
    ).body;
    const ownerRt = await connect(owner);
    const memberRt = await connect(member);
    memberRt.send({ type: 'voice.join', channelId: voice.id });
    await ownerRt.waitFor(
      'voice.state.changed',
      (e) => e.data.userId === member.user.id && e.data.connected
    );

    expect((await kick(owner, guild.id, member.user.id)).status).toBe(200);
    await ownerRt.waitFor(
      'voice.state.changed',
      (e) => e.data.userId === member.user.id && !e.data.connected
    );
    memberRt.close();
    ownerRt.close();
  });
});

describe('ban', () => {
  test('a banned member is removed, cannot rejoin until unbanned, and is listed with the reason', async () => {
    const { owner, member, guild } = await guildWithMember();
    const memberRt = await connect(member);
    const code = await invite(owner, guild.id);

    expect((await ban(owner, guild.id, member.user.id, '  spam  ')).status).toBe(200);
    await memberRt.waitFor(
      'guild.deleted',
      (e) => e.data.guildId === guild.id && e.data.reason === 'banned'
    );
    expect(await guildIds(member)).toEqual([]);

    const rejoin = await accept(member, code);
    expect(rejoin.status).toBe(403);
    expect(rejoin.body.error).toMatch(/banned/);
    expect(await guildIds(member)).toEqual([]);

    const { bans } = (await call(owner, 'GET', `/guilds/${guild.id}/bans`)).body;
    expect(bans).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ userId: member.user.id }),
        bannedBy: expect.objectContaining({ userId: owner.user.id }),
        reason: 'spam',
      }),
    ]);

    expect((await call(owner, 'DELETE', `/guilds/${guild.id}/bans/${member.user.id}`)).status).toBe(
      200
    );
    expect((await call(owner, 'GET', `/guilds/${guild.id}/bans`)).body.bans).toEqual([]);
    expect((await accept(member, code)).status).toBe(200);
    expect(await guildIds(member)).toEqual([guild.id]);
    memberRt.close();
  });

  test('someone who already left can be banned, and banning twice updates the ban', async () => {
    const { owner, member, guild } = await guildWithMember();
    await call(member, 'POST', `/guilds/${guild.id}/leave`);
    expect((await ban(owner, guild.id, member.user.id)).status).toBe(200);
    expect((await ban(owner, guild.id, member.user.id, 'again')).status).toBe(200);
    const { bans } = (await call(owner, 'GET', `/guilds/${guild.id}/bans`)).body;
    expect(bans).toHaveLength(1);
    expect(bans[0].reason).toBe('again');
    expect((await accept(member, await invite(owner, guild.id))).status).toBe(403);
    expect((await ban(owner, guild.id, 'nobody')).status).toBe(404);
  });

  test('ban permissions follow kick permissions, and only moderators see or lift bans', async () => {
    const { owner, member, guild } = await guildWithMember();
    const [victim, admin, stranger] = await Promise.all([
      signup(anchor.url),
      signup(anchor.url),
      signup(anchor.url),
    ]);
    await join(owner, guild.id, victim);
    await join(owner, guild.id, admin);
    await sql(`UPDATE guild_member SET role = 'ADMIN' WHERE "userId" = '${admin.user.id}'`);

    expect((await ban(member, guild.id, victim.user.id)).status).toBe(403);
    expect((await ban(stranger, guild.id, victim.user.id)).status).toBe(404);
    expect((await ban(owner, guild.id, owner.user.id)).status).toBe(400);
    expect((await ban(admin, guild.id, owner.user.id)).status).toBe(403);
    expect((await ban(admin, guild.id, victim.user.id, 'x'.repeat(513))).status).toBe(422);
    expect((await ban(admin, guild.id, victim.user.id)).status).toBe(200);

    expect((await call(member, 'GET', `/guilds/${guild.id}/bans`)).status).toBe(403);
    expect((await call(stranger, 'GET', `/guilds/${guild.id}/bans`)).status).toBe(404);
    expect((await call(admin, 'GET', `/guilds/${guild.id}/bans`)).body.bans).toHaveLength(1);
    const unban = (actor: TestUser) =>
      call(actor, 'DELETE', `/guilds/${guild.id}/bans/${victim.user.id}`);
    expect((await unban(member)).status).toBe(403);
    expect((await unban(stranger)).status).toBe(404);
    expect((await unban(admin)).status).toBe(200);
    expect((await unban(admin)).status).toBe(404);
  });

  test('a banned bot cannot be added back', async () => {
    const { owner, guild } = await guildWithMember();
    const bot = await createBot(owner);
    await addBot(owner, guild.id, bot.bot);
    expect((await ban(owner, guild.id, bot.bot.userId)).status).toBe(200);
    expect((await addBot(owner, guild.id, bot.bot)).status).toBe(403);
    await call(owner, 'DELETE', `/guilds/${guild.id}/bans/${bot.bot.userId}`);
    expect((await addBot(owner, guild.id, bot.bot)).status).toBe(200);
  });

  test('deleting the guild drops its bans', async () => {
    const { owner, member, guild } = await guildWithMember();
    await ban(owner, guild.id, member.user.id);
    await sql(`DELETE FROM guild WHERE id = '${guild.id}'`);
    expect(await sql(`SELECT 1 FROM guild_ban WHERE "guildId" = '${guild.id}'`)).toHaveLength(0);
  });
});

test('moderation routes refuse federated guild ids', async () => {
  const user = await signup(anchor.url);
  const id = encodeURIComponent('fed:guild:example.test:abc');
  expect((await kick(user, id, 'x')).status).toBe(400);
  expect((await ban(user, id, 'x')).status).toBe(400);
  expect((await call(user, 'GET', `/guilds/${id}/bans`)).status).toBe(400);
  expect((await call(user, 'POST', `/guilds/${id}/leave`)).status).toBe(404);
});
