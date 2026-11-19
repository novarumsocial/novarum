import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, list, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, fakeSend, fedChannelId, fedGuildId, pg } from '../harness/fedflows';
import { eventually } from '../harness/wait';
import type { TestUser } from '../harness/users';

// Leaving, kicking and banning across homeservers: a B user in a guild hosted on A.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const hostA = anchors.a.homeserver;

async function remoteMember() {
  const owner = await signup('a');
  const { guild, channel } = await createGuild(owner, 'hosted');
  const code = async () =>
    (await call(owner, 'POST', `/guilds/${guild.id}/invites`, {})).body.invite.code as string;
  const member = await signup('b');
  const accept = async () =>
    call(member, 'POST', '/invite/accept', { code: await code(), homeserver: hostA });
  expect((await accept()).status).toBe(200);
  const [row] = await pg('a')`SELECT id FROM "user" WHERE username = ${member.user.username}`;
  return {
    owner,
    member,
    guild,
    channel,
    accept,
    hostUserId: row!.id as string,
    shadowGuild: fedGuildId(hostA, guild.id),
    shadowChannel: fedChannelId(hostA, channel.id),
  };
}

const guildIds = async (user: TestUser) =>
  ((await call(user, 'GET', '/guilds/list')).body.guilds as { id: string }[]).map((g) => g.id);
const hostMembers = async (owner: TestUser, channelId: string) =>
  ((await call(owner, 'GET', `/channel/${channelId}/users`)).body.users as any[]).map(
    (u) => u.username
  );
const shadowRows = async (shadowGuild: string) =>
  (await pg('b')`SELECT count(*)::int AS n FROM guild WHERE id = ${shadowGuild}`)[0]!.n;

describe('federated moderation', () => {
  test('a remote member leaves through their homeserver: the host and the mirror both drop it', async () => {
    const fx = await remoteMember();
    const ownerRt = await connect(fx.owner);
    const memberRt = await connect(fx.member);
    // our copy names the joiner as owner, but they don't own it and so may leave
    const listed = (await call(fx.member, 'GET', '/guilds/list')).body.guilds[0];
    expect(listed).toMatchObject({ id: fx.shadowGuild, owner: false });

    expect((await call(fx.member, 'POST', `/guilds/${fx.shadowGuild}/leave`)).status).toBe(200);
    await memberRt.waitFor('guild.deleted', (e) => e.data.guildId === fx.shadowGuild);
    await ownerRt.waitFor('member.left', (e) => e.data.userId === fx.hostUserId, 15_000);
    expect(await hostMembers(fx.owner, fx.channel.id)).toEqual([fx.owner.user.username]);
    expect(await guildIds(fx.member)).toEqual([]);
    expect(await shadowRows(fx.shadowGuild)).toBe(0);
    expect((await list(fx.member, fx.shadowChannel)).status).toBeGreaterThanOrEqual(400);

    // and can come back with an invite
    expect((await fx.accept()).status).toBe(200);
    expect(await guildIds(fx.member)).toEqual([fx.shadowGuild]);
    ownerRt.close();
    memberRt.close();
  });

  test('the host kicks a remote member: their homeserver drops the guild and they stop getting events', async () => {
    const fx = await remoteMember();
    const memberRt = await connect(fx.member);
    // the bridge is up once a message from A reaches B
    await send(fx.owner, fx.channel.id, 'before');
    await memberRt.waitFor('message.created', (e) => e.data.content === 'before', 15_000);

    expect(
      (await call(fx.owner, 'DELETE', `/guilds/${fx.guild.id}/members/${fx.hostUserId}`)).status
    ).toBe(200);
    await memberRt.waitFor(
      'guild.deleted',
      (e) => e.data.guildId === fx.shadowGuild && e.data.reason === 'kicked',
      15_000
    );
    expect(await guildIds(fx.member)).toEqual([]);
    expect(await shadowRows(fx.shadowGuild)).toBe(0);
    expect(await hostMembers(fx.owner, fx.channel.id)).toEqual([fx.owner.user.username]);

    await send(fx.owner, fx.channel.id, 'secret after kick');
    await Bun.sleep(1000);
    expect(memberRt.events.some((e) => e.data?.content === 'secret after kick')).toBe(false);
    // asking A directly through B is refused as well
    expect((await list(fx.member, fx.shadowChannel)).status).toBeGreaterThanOrEqual(400);
    memberRt.close();
  });

  test('a banned remote user cannot rejoin through the federated invite until unbanned', async () => {
    const fx = await remoteMember();
    const memberRt = await connect(fx.member);

    expect(
      (
        await call(fx.owner, 'PUT', `/guilds/${fx.guild.id}/bans/${fx.hostUserId}`, {
          reason: 'spam',
        })
      ).status
    ).toBe(200);
    await memberRt.waitFor(
      'guild.deleted',
      (e) => e.data.guildId === fx.shadowGuild && e.data.reason === 'banned',
      15_000
    );
    await eventually(async () => (await shadowRows(fx.shadowGuild)) === 0, {
      timeout: 15_000,
      message: 'mirror dropped',
    });

    const rejoin = await fx.accept();
    expect(rejoin.status).toBe(403);
    expect(rejoin.body.error).toMatch(/banned/);
    expect(await guildIds(fx.member)).toEqual([]);

    const { bans } = (await call(fx.owner, 'GET', `/guilds/${fx.guild.id}/bans`)).body;
    expect(bans).toEqual([
      expect.objectContaining({
        reason: 'spam',
        user: expect.objectContaining({
          username: fx.member.user.username,
          homeserver: anchors.b.homeserver,
        }),
      }),
    ]);

    expect(
      (await call(fx.owner, 'DELETE', `/guilds/${fx.guild.id}/bans/${fx.hostUserId}`)).status
    ).toBe(200);
    expect((await fx.accept()).status).toBe(200);
    expect(await guildIds(fx.member)).toEqual([fx.shadowGuild]);
    memberRt.close();
  });

  test('another B member keeps the mirror and the event stream when one is kicked', async () => {
    const fx = await remoteMember();
    const other = await signup('b');
    const code = (await call(fx.owner, 'POST', `/guilds/${fx.guild.id}/invites`, {})).body.invite
      .code;
    expect((await call(other, 'POST', '/invite/accept', { code, homeserver: hostA })).status).toBe(
      200
    );
    const otherRt = await connect(other);
    await send(fx.owner, fx.channel.id, 'warmup');
    await otherRt.waitFor('message.created', (e) => e.data.content === 'warmup', 15_000);

    expect(
      (await call(fx.owner, 'DELETE', `/guilds/${fx.guild.id}/members/${fx.hostUserId}`)).status
    ).toBe(200);
    await otherRt.waitFor('member.left', (e) => e.data.guildId === fx.shadowGuild, 15_000);
    expect(await shadowRows(fx.shadowGuild)).toBe(1);
    await send(fx.owner, fx.channel.id, 'still flowing');
    await otherRt.waitFor('message.created', (e) => e.data.content === 'still flowing', 15_000);
    otherRt.close();
  });

  test('a homeserver can only drop guilds that the caller hosts', async () => {
    const fx = await remoteMember();
    // another homeserver names A's guild id: the id is scoped to the signer, so B's copy of A's guild is untouched
    const res = await fakeSend(1, 'b', `/federation/members/${fx.member.user.username}/removed`, {
      guildId: fx.guild.id,
      reason: 'kicked',
    });
    expect(res.status).toBe(200);
    expect(await guildIds(fx.member)).toEqual([fx.shadowGuild]);
  });
});
