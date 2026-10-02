import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, api, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, fedChannelId, fedGuildId, pg } from '../harness/fedflows';
import { eventually } from '../harness/wait';
import type { TestUser } from '../harness/users';

// TESTING_PLAN §5.3 flow 4 (user-facing side): a B user joins a guild hosted on A. A is the host.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const hostA = anchors.a.homeserver;

async function hostedGuild() {
  const owner = await signup('a');
  const { guild, channel } = await createGuild(owner, 'hosted');
  const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
  return { owner, guild, channel, code: body.invite.code as string };
}

/** `user` (on B) accepts `code` of a guild on A */
const acceptRemote = (user: TestUser, code: string, homeserver: string = hostA) => call(user, 'POST', '/invite/accept', { code, homeserver });

describe('joining through a federated invite', () => {
  test('creates a shadow guild on B, publishes guild.created, and A lists the B user as a member', async () => {
    const { owner, guild, channel, code } = await hostedGuild();
    const joiner = await signup('b');
    const rt = await connect(joiner);

    const res = await acceptRemote(joiner, code);
    expect(res.status).toBe(200);
    const shadowGuild = fedGuildId(hostA, guild.id);
    const shadowChannel = fedChannelId(hostA, channel.id);
    expect(res.body.guildId).toBe(shadowGuild);
    expect(res.body.guild).toMatchObject({ id: shadowGuild, homeserver: hostA, name: 'hosted' });
    expect(res.body.channels.map((c: any) => [c.id, c.guildId])).toEqual([[shadowChannel, shadowGuild]]);

    const created = await rt.waitFor('guild.created', (e) => e.data.id === shadowGuild);
    expect(created.data.channels[0]).toMatchObject({ id: shadowChannel, guildId: shadowGuild });

    // B lists it
    const list = await call(joiner, 'GET', '/guilds/list');
    expect(list.body.guilds.find((g: any) => g.id === shadowGuild)).toMatchObject({ name: 'hosted', down: false, canManageChannels: false });

    // A's member list includes the B user (as seen by the owner and from the host database)
    const users = await call(owner, 'GET', `/channel/${channel.id}/users`);
    expect(users.body.users.map((u: any) => [u.username, u.homeserver, u.role])).toContainEqual([joiner.user.username, anchors.b.homeserver, 'MEMBER']);
    // and B's member list for the shadow channel is served by A
    const viaB = await call(joiner, 'GET', `/channel/${shadowChannel}/users`);
    expect(viaB.status).toBe(200);
    expect(viaB.body.users.map((u: any) => u.username).sort()).toEqual([owner.user.username, joiner.user.username].sort());
    // the owner gets member.joined only when it is connected; joining twice is idempotent
    expect((await acceptRemote(joiner, code)).status).toBe(200);
    expect((await call(owner, 'GET', `/channel/${channel.id}/users`)).body.users).toHaveLength(2);
    rt.close();
  });

  test('member.joined reaches an A member connected over realtime', async () => {
    const { owner, code } = await hostedGuild();
    const rt = await connect(owner);
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    const joined = await rt.waitFor('member.joined');
    expect(joined.data.user).toMatchObject({ username: joiner.user.username, homeserver: anchors.b.homeserver });
    rt.close();
  });

  test('expired, unknown or foreign invites relay the right error', async () => {
    const { guild, code } = await hostedGuild();
    const joiner = await signup('b');
    const unknown = await acceptRemote(joiner, 'doesnotexist');
    expect(unknown).toMatchObject({ status: 404, body: { error: 'Invite not found' } });

    await pg('a')`UPDATE guild_invite SET "expiresAt" = now() - interval '1 hour' WHERE code = ${code}`;
    expect(await acceptRemote(joiner, code)).toMatchObject({ status: 404, body: { error: 'Invite not found' } });
    // the public lookup agrees, and has no side effects
    expect((await fetch(`${api('a')}/federation/invites/${code}`)).status).toBe(404);
    expect((await call(joiner, 'GET', '/guilds/list')).body.guilds.some((g: any) => g.id === fedGuildId(hostA, guild.id))).toBe(false);
  });

  test('GET /federation/invites/:code is public and describes the guild', async () => {
    const { guild, code } = await hostedGuild();
    const res = await fetch(`${api('a')}/federation/invites/${code}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ invite: { code, expiresAt: null }, guild: { id: guild.id, homeserver: hostA, name: 'hosted', memberCount: 1 } });
  });

  test('an unreachable or unknown homeserver is 502, and a local-only code is not found remotely', async () => {
    const joiner = await signup('b');
    expect((await acceptRemote(joiner, 'abc', 'does-not-exist.test')).status).toBe(502);
    // a code that only exists on A is not found when asked of C
    const { code } = await hostedGuild();
    expect(await acceptRemote(joiner, code, anchors.c.homeserver)).toMatchObject({ status: 404 });
  });
});

describe('shadow guild ownership (the ownerId = joiner concern)', () => {
  test('the joiner has no owner powers on the fed:guild: id', async () => {
    const { guild, channel, code } = await hostedGuild();
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    const shadowGuild = fedGuildId(hostA, guild.id);
    const shadowChannel = fedChannelId(hostA, channel.id);

    // the shadow row is stored with the joiner as ownerId, so every owner-gated route has to refuse on the id alone
    const [row] = await pg('b')`SELECT "ownerId" FROM guild WHERE id = ${shadowGuild}`;
    const [me] = await pg('b')`SELECT id FROM "user" WHERE username = ${joiner.user.username}`;
    expect(row!.ownerId).toBe(me!.id);

    const createChannel = await call(joiner, 'POST', '/channel/create', { guildId: shadowGuild, name: 'mine', type: 'TEXT' });
    expect(createChannel.status).toBe(400);
    const invite = await call(joiner, 'POST', `/guilds/${shadowGuild}/invites`, {});
    expect(invite.status).toBe(400);
    expect((await call(joiner, 'GET', `/guilds/${shadowGuild}/invites`)).status).toBe(400);
    const reorder = await call(joiner, 'PATCH', '/channel/order', { guildId: shadowGuild, channelIds: [shadowChannel] });
    expect(reorder.status).toBe(400);
    const avatar = new FormData();
    avatar.set('avatar', new File([new Uint8Array(8)], 'a.png', { type: 'image/png' }));
    expect((await joiner.fetch(`/guilds/${shadowGuild}/avatar`, { method: 'POST', body: avatar })).status).toBe(400);

    // nothing was created on either side
    expect((await pg('b')`SELECT count(*)::int AS n FROM channel WHERE "guildId" = ${shadowGuild}`)[0]!.n).toBe(1);
    expect((await pg('b')`SELECT count(*)::int AS n FROM guild_invite WHERE "guildId" = ${shadowGuild}`)[0]!.n).toBe(0);
    expect((await pg('a')`SELECT count(*)::int AS n FROM channel WHERE "guildId" = ${guild.id}`)[0]!.n).toBe(1);
    // the UI flag follows
    expect((await call(joiner, 'GET', '/guilds/list')).body.guilds.find((g: any) => g.id === shadowGuild).canManageChannels).toBe(false);
  });

  test('the raw ids of the host guild do not give a B user power on A either', async () => {
    const { guild, code } = await hostedGuild();
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    // B user calling A's routes directly (it has no session on A): rejected
    expect((await fetch(`${api('a')}/guilds/${guild.id}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
});

describe('talking in a remote guild through the user API', () => {
  test('messages, edit and delete go through the host; the host owner sees them', async () => {
    const { owner, channel, code } = await hostedGuild();
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    const shadowChannel = fedChannelId(hostA, channel.id);

    const sent = await send(joiner, shadowChannel, 'hello host');
    expect(sent.status).toBe(200);
    expect(sent.body.message).toMatchObject({ channelId: shadowChannel, content: 'hello host' });
    const onA = await call(owner, 'GET', `/message/list?channelId=${channel.id}&cursor=0&amount=50`);
    expect(onA.body.messages.map((m: any) => m.content)).toEqual(['hello host']);

    const id = sent.body.message.id;
    expect((await call(joiner, 'POST', '/message/edit', { channelId: shadowChannel, messageId: id, content: 'edited' })).status).toBe(200);
    expect((await call(owner, 'GET', `/message/list?channelId=${channel.id}&cursor=0&amount=50`)).body.messages[0]).toMatchObject({ content: 'edited', edited: true });
    // the owner's message can not be edited or deleted by the joiner
    const ownerMsg = await send(owner, channel.id, 'owner says');
    expect((await call(joiner, 'POST', '/message/edit', { channelId: shadowChannel, messageId: ownerMsg.body.message.id, content: 'x' })).status).toBe(403);
    expect((await call(joiner, 'POST', '/message/delete', { channelId: shadowChannel, messageId: ownerMsg.body.message.id })).status).toBe(403);
    expect((await call(joiner, 'POST', '/message/delete', { channelId: shadowChannel, messageId: id })).status).toBe(200);
    const list = await call(joiner, 'GET', `/message/list?channelId=${encodeURIComponent(shadowChannel)}&cursor=0&amount=50`);
    expect(list.body.messages.map((m: any) => m.content)).toEqual(['owner says']);
  });

  test('listing a long history follows the host cursor through every page', async () => {
    const { owner, channel, code } = await hostedGuild();
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    for (let i = 0; i < 130; i++) await send(owner, channel.id, `m${i}`);
    const list = await call(joiner, 'GET', `/message/list?channelId=${encodeURIComponent(fedChannelId(hostA, channel.id))}&cursor=0&amount=50`);
    // B walks A's pages of 100 until nextCursor is null
    expect(list.body.messages).toHaveLength(130);
    expect(list.body.messages[0].content).toBe('m0');
    expect(list.body.messages[129].content).toBe('m129');
  });

  test('presign goes to A, the upload lands in A\'s storage, and the attachment is claimed on send', async () => {
    const { owner, channel, code } = await hostedGuild();
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    const shadowChannel = fedChannelId(hostA, channel.id);

    const presign = await call(joiner, 'POST', '/upload/presign', { channelId: shadowChannel, filename: 'note.txt', contentType: 'text/plain', size: 5 });
    expect(presign.status).toBe(200);
    const [row] = await pg('a')`SELECT status, "channelId" AS channel FROM attachment WHERE id = ${presign.body.attachmentId}`;
    expect(row).toMatchObject({ status: 'PENDING', channel: channel.id });
    expect(await pg('b')`SELECT id FROM attachment WHERE id = ${presign.body.attachmentId}`).toHaveLength(0);

    const put = await fetch(presign.body.uploadUrl, { method: 'PUT', headers: presign.body.headers, body: 'hello' });
    expect(put.status).toBe(200);
    const sent = await send(joiner, shadowChannel, 'with a file', { attachmentIds: [presign.body.attachmentId] });
    expect(sent.status).toBe(200);
    expect(sent.body.message.attachments).toHaveLength(1);
    const onA = await call(owner, 'GET', `/message/list?channelId=${channel.id}&cursor=0&amount=50`);
    expect(onA.body.messages[0].attachments[0]).toMatchObject({ filename: 'note.txt', contentType: 'text/plain', size: 5 });
  });

  test('presign: A\'s size limit and file types are enforced', async () => {
    const { channel, code } = await hostedGuild();
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    const shadowChannel = fedChannelId(hostA, channel.id);
    const info = (await (await fetch(`${api('a')}/.well-known/anchor/info`)).json()) as { maxFileSize: number };
    const max = info.maxFileSize * 1024 * 1024;
    expect((await call(joiner, 'POST', '/upload/presign', { channelId: shadowChannel, filename: 'big', contentType: 'application/pdf', size: max })).status).toBe(200);
    expect((await call(joiner, 'POST', '/upload/presign', { channelId: shadowChannel, filename: 'big', contentType: 'application/pdf', size: max + 1 })).status).not.toBe(200);
    expect((await call(joiner, 'POST', '/upload/presign', { channelId: shadowChannel, filename: 'x.exe', contentType: 'application/x-msdownload', size: 10 })).status).toBe(415);
  });

  test('typing in a remote guild reaches members on A', async () => {
    const { owner, channel, code } = await hostedGuild();
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    const rt = await connect(owner);
    expect((await call(joiner, 'POST', `/channel/${encodeURIComponent(fedChannelId(hostA, channel.id))}/typing`)).status).toBe(200);
    const typing = await rt.waitFor('channel.typing');
    expect(typing.data).toMatchObject({ channelId: channel.id, username: joiner.user.username, homeserver: anchors.b.homeserver });
    rt.close();
  });

  test('unread mentions of the remote guild show up in /guilds/list on B', async () => {
    const { owner, channel, code } = await hostedGuild();
    const joiner = await signup('b');
    await acceptRemote(joiner, code);
    const mentionText = `hey @${joiner.user.username}:${anchors.b.homeserver} look`;
    await send(owner, channel.id, mentionText);
    const list = await eventually(
      async () => {
        const l = await call(joiner, 'GET', '/guilds/list');
        const g = l.body.guilds.find((x: any) => x.channels.some((c: any) => c.id === fedChannelId(hostA, channel.id)));
        return g?.channels[0].mention === 1 ? g : null;
      },
      { message: 'mention counted on B' }
    );
    expect(list.channels[0]).toMatchObject({ unread: false, mention: 1 });
  });
});
