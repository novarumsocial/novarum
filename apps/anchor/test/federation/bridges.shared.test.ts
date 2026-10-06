import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, fake, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import {
  closePg,
  fakeBridgeSigner,
  fakeSend,
  fakeUser,
  joinedRoom,
  openBridge,
} from '../harness/fedflows';
import { eventually } from '../harness/wait';
import { uniqueName } from '../harness/users';

// The shared socket: one signed WebSocket (/federation/realtime) through which a homeserver follows every guild and DM it has
// members in on another homeserver. A and B both support it, so they use it between themselves; the fake anchor drives the
// wire format by hand. The one-socket-per-guild endpoints keep working and are covered in bridges.test.ts.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(async () => {
  await fake.reset();
  await closePg();
});

const signer = fakeBridgeSigner(1);

/** an A guild owned by a local user, with the fake anchor's user as a member */
async function room() {
  const owner = await signup('a');
  const { guild, channel } = await createGuild(owner, 'shared');
  const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
  const member = fakeUser(uniqueName('fk'));
  expect(
    (await fakeSend(1, 'a', `/federation/invites/${body.invite.code}/accept`, { user: member }))
      .status
  ).toBe(200);
  return { owner, guild, channel, member };
}

describe('the socket itself (a hostile homeserver talking to A)', () => {
  test('a socket that is not signed, or signed wrongly, is closed with 1008', async () => {
    const unsigned = await openBridge('a', 'shared', '', async () => ({}));
    expect(await unsigned.waitClosed()).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/Missing/),
    });

    const tampered = await openBridge(
      'a',
      'shared',
      '',
      async (t, path) =>
        (
          await fake.sign({
            identity: 1,
            method: 'GET',
            path,
            host: new URL(anchors[t].baseUrl).host,
            body: '',
            tamper: true,
          })
        ).headers
    );
    expect(await tampered.waitClosed()).toMatchObject({ code: 1008, reason: 'Invalid signature' });

    // a signature made for a single guild's socket does not open the shared one
    const otherPath = await openBridge(
      'a',
      'shared',
      '',
      async (t) =>
        (
          await fake.sign({
            identity: 1,
            method: 'GET',
            path: '/federation/realtime/guilds/x',
            host: new URL(anchors[t].baseUrl).host,
            body: '',
          })
        ).headers
    );
    expect(await otherPath.waitClosed()).toMatchObject({ code: 1008, reason: 'Invalid signature' });
  });

  test('subscribing: a guild with a member gets a presence snapshot, everything else is refused', async () => {
    const { guild } = await room();
    const notMember = await signup('a');
    const other = (await createGuild(notMember, 'private')).guild;

    const socket = await openBridge('a', 'shared', '', signer);
    // sent straight away, while the signature may still be being checked: it must not be lost
    socket.send({
      type: 'subscribe',
      guilds: [guild.id, other.id, 'does-not-exist'],
      dms: ['no-such-dm'],
    });
    await eventually(() => socket.events.length >= 4, { message: 'one answer per id' });

    const frames = socket.events as any[];
    const about = (kind: string, id: string) =>
      frames.filter((f) => f.kind === kind && f.id === id);
    expect(about('guild', guild.id)).toEqual([
      {
        type: 'event',
        kind: 'guild',
        id: guild.id,
        event: { type: 'voice.states.snapshot', data: { guildIds: [guild.id], states: [] } },
      },
    ]);
    expect(about('guild', other.id)).toEqual([{ type: 'refused', kind: 'guild', id: other.id }]);
    expect(about('guild', 'does-not-exist')).toEqual([
      { type: 'refused', kind: 'guild', id: 'does-not-exist' },
    ]);
    expect(about('dm', 'no-such-dm')).toEqual([{ type: 'refused', kind: 'dm', id: 'no-such-dm' }]);
    expect(socket.closed).toBeNull(); // a refusal does not end the socket, the other guilds are unaffected
    socket.close();
  });

  test('events carry the guild they belong to, and only subscribed guilds are sent', async () => {
    const first = await room();
    const second = await room();
    const socket = await openBridge('a', 'shared', '', signer);
    socket.send({ type: 'subscribe', guilds: [first.guild.id] });
    await socket.waitFor('event');

    await send(second.owner, second.channel.id, 'not followed');
    const msg = (await send(first.owner, first.channel.id, 'followed')).body.message;
    await eventually(
      () => (socket.events as any[]).some((f) => f.event?.type === 'message.created'),
      { message: 'message frame' }
    );

    const messages = (socket.events as any[]).filter((f) => f.event?.type === 'message.created');
    expect(messages).toEqual([
      {
        type: 'event',
        kind: 'guild',
        id: first.guild.id,
        event: expect.objectContaining({
          type: 'message.created',
          data: expect.objectContaining({ id: msg.id, content: 'followed' }),
        }),
      },
    ]);
    socket.close();
  });

  test('events without an id of their own still say which guild they are about', async () => {
    const { guild, member } = await room();
    const socket = await openBridge('a', 'shared', '', signer);
    socket.send({ type: 'subscribe', guilds: [guild.id] });
    await socket.waitFor('event');

    // the fake anchor's user going online has no guild or channel in the event itself
    expect(
      (
        await fakeSend(1, 'a', `/federation/guilds/${guild.id}/users/status`, {
          user: member,
          status: 'ONLINE',
        })
      ).status
    ).toBe(200);
    await eventually(
      () => (socket.events as any[]).some((f) => f.event?.type === 'user.status.changed'),
      { message: 'status frame' }
    );
    const frame = (socket.events as any[]).find((f) => f.event?.type === 'user.status.changed');
    expect(frame).toMatchObject({
      type: 'event',
      kind: 'guild',
      id: guild.id,
      event: { data: { status: 'ONLINE' } },
    });
    socket.close();
  });

  test('subscribing twice does not repeat the snapshot, and bad messages are ignored', async () => {
    const { guild } = await room();
    const socket = await openBridge('a', 'shared', '', signer);
    socket.send({ type: 'subscribe', guilds: [guild.id] });
    await socket.waitFor('event');
    for (const junk of [
      'not even json',
      { type: 'subscribe', guilds: 'x' },
      { type: 'nope' },
      null,
      [1],
    ])
      socket.send(junk);
    socket.send({ type: 'subscribe', guilds: [guild.id] });
    await Bun.sleep(1000);
    expect((socket.events as any[]).filter((f) => f.id === guild.id)).toHaveLength(1);
    expect(socket.closed).toBeNull();
    socket.close();
  });
});

describe('between two real homeservers', () => {
  test('one B user follows several A guilds, and each one reaches them with mapped ids', async () => {
    const first = await joinedRoom();
    // the same B member joins a second and third guild of A: their events arrive over the same socket
    const others = [];
    for (const name of ['second', 'third']) {
      const owner = await signup('a');
      const { guild, channel } = await createGuild(owner, name);
      const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
      const accepted = await call(first.member, 'POST', '/invite/accept', {
        code: body.invite.code,
        homeserver: anchors.a.homeserver,
      });
      expect(accepted.status).toBe(200);
      others.push({ owner, channel, shadowChannel: accepted.body.channels[0].id as string });
    }
    const rt = await connect(first.member);
    for (const { owner, channel, shadowChannel } of others) {
      await eventually(
        async () => {
          await send(owner, channel.id, `hello ${shadowChannel}`);
          return rt.events.some(
            (e) => e.type === 'message.created' && e.data.channelId === shadowChannel
          );
        },
        { timeout: 20_000, interval: 300, message: 'events of a followed guild' }
      );
    }
    rt.close();
    first.rt.close();
  });

  test('a user going online is announced to a homeserver with one request', async () => {
    const owner = await signup('a');
    const { guild } = await createGuild(owner, 'status');
    const member = await signup('b');
    const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    expect(
      (
        await call(member, 'POST', '/invite/accept', {
          code: body.invite.code,
          homeserver: anchors.a.homeserver,
        })
      ).status
    ).toBe(200);

    const ownerRt = await connect(owner);
    const memberRt = await connect(member); // B tells A the member came online
    const online = await ownerRt.waitFor(
      'user.status.changed',
      (e) => e.data.status === 'ONLINE',
      15_000
    );
    expect(online.data.userId).toBeTruthy();
    ownerRt.close();
    memberRt.close();
  });
});

describe('POST /federation/users/status (a user went online or offline, for friends and guilds at once)', () => {
  test('updates the status, tells the guilds the user is in and skips the others', async () => {
    const { owner, guild, member } = await room();
    const strangerGuild = (await createGuild(await signup('a'), 'unrelated')).guild;
    const ownerRt = await connect(owner);

    const res = await fakeSend(1, 'a', '/federation/users/status', {
      user: member,
      status: 'ONLINE',
      guildIds: [guild.id, strangerGuild.id, 'nope'],
    });
    expect(res).toMatchObject({ status: 200, json: { ok: true } });
    const event = await ownerRt.waitFor(
      'user.status.changed',
      (e) => e.data.status === 'ONLINE',
      10_000
    );
    expect(event.data.userId).toBeTruthy();

    expect(
      (
        await fakeSend(1, 'a', '/federation/users/status', {
          user: member,
          status: 'OFFLINE',
          guildIds: [],
        })
      ).status
    ).toBe(200);
    ownerRt.close();
  });

  test('refuses what the two separate routes refuse', async () => {
    const { guild, member } = await room();
    expect(
      (
        await fakeSend(1, 'a', '/federation/users/status', {
          user: member,
          status: 'AWAY',
          guildIds: [],
        })
      ).status
    ).toBe(400);
    expect(
      (await fakeSend(1, 'a', '/federation/users/status', { user: member, status: 'ONLINE' }))
        .status
    ).toBe(400); // no guild list
    expect(
      (
        await fakeSend(1, 'a', '/federation/users/status', {
          user: member,
          status: 'ONLINE',
          guildIds: [guild.id, 5],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await fakeSend(1, 'a', '/federation/users/status', {
          user: fakeUser(uniqueName('ghost')),
          status: 'ONLINE',
          guildIds: [],
        })
      ).status
    ).toBe(404);
    // the user payload has to belong to the signer, like on every other route
    expect(
      (
        await fakeSend(1, 'a', '/federation/users/status', {
          user: { ...member, homeserver: anchors.b.homeserver },
          status: 'ONLINE',
          guildIds: [],
        })
      ).status
    ).toBe(401);
  });
});
