import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, createGuild, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, fakeSend, fakeUser, joinedRoom } from '../harness/fedflows';
import { uniqueName } from '../harness/users';

// Reactions in a guild hosted on A: B proxies its user's reactions to A, A stores them and fans the
// events out, and B's bridge passes them on to its clients with mapped ids.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const react = (channelId: string, messageId: string, emoji: string, add = true) => ({
  channelId,
  messageId,
  emoji,
  add,
});
const listed = async (user: Parameters<typeof call>[0], channelId: string, messageId: string) =>
  (
    await call(
      user,
      'GET',
      `/message/list?channelId=${encodeURIComponent(channelId)}&cursor=0&amount=50`
    )
  ).body.messages.find((m: any) => m.id === messageId).reactions;

describe('reacting in a remote guild through the user API', () => {
  test('the host stores the reaction, both sides list it and both get the events', async () => {
    const { owner, member, channel, shadowChannel, rt } = await joinedRoom();
    const ownerRt = await connect(owner);
    try {
      const msg = (await send(owner, channel.id, 'react here')).body.message;

      const added = await call(
        member,
        'POST',
        '/message/react',
        react(shadowChannel, msg.id, '👍')
      );
      expect(added.status).toBe(200);
      expect(added.body.reactions).toMatchObject([
        { emoji: '👍', count: 1, me: true, users: [{ username: member.user.username }] },
      ]);
      // idempotent through the proxy too
      expect(
        (await call(member, 'POST', '/message/react', react(shadowChannel, msg.id, '👍'))).body
          .reactions
      ).toMatchObject([{ count: 1 }]);

      expect(await listed(owner, channel.id, msg.id)).toMatchObject([
        { emoji: '👍', count: 1, me: false },
      ]);
      expect(await listed(member, shadowChannel, msg.id)).toMatchObject([
        { emoji: '👍', count: 1, me: true },
      ]);

      await ownerRt.waitFor('message.reaction.added', (e) => e.data.messageId === msg.id);
      const bridged = await rt.waitFor(
        'message.reaction.added',
        (e) => e.data.messageId === msg.id
      );
      expect(bridged.data).toMatchObject({
        channelId: shadowChannel,
        emoji: '👍',
        count: 1,
        user: { username: member.user.username },
      });

      await call(owner, 'POST', '/message/react', react(channel.id, msg.id, '👍', false));
      await call(member, 'POST', '/message/react', react(shadowChannel, msg.id, '👍', false));
      await rt.waitFor(
        'message.reaction.removed',
        (e) => e.data.messageId === msg.id && e.data.count === 0
      );
      expect(await listed(owner, channel.id, msg.id)).toEqual([]);
    } finally {
      ownerRt.close();
      rt.close();
    }
  });

  test('errors from the host come back as they are', async () => {
    const { member, shadowChannel, rt } = await joinedRoom();
    rt.close();
    const reacted = (messageId: string, emoji: string) =>
      call(member, 'POST', '/message/react', react(shadowChannel, messageId, emoji));
    expect((await reacted('nope', '👍')).status).toBe(404);
    expect((await reacted('nope', 'not an emoji')).status).toBe(422);
  });
});

describe('the host route (/federation/channels/:id/messages/react)', () => {
  async function room() {
    const owner = await signup('a');
    const { guild, channel } = await createGuild(owner, 'wire');
    const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    const member = fakeUser(uniqueName('fk'));
    await fakeSend(1, 'a', `/federation/invites/${body.invite.code}/accept`, { user: member });
    const msg = (await send(owner, channel.id, 'wire')).body.message;
    const ch = (extra: object, user: object = member) =>
      fakeSend(1, 'a', `/federation/channels/${channel.id}/messages/react`, { user, ...extra });
    return { owner, channel, msg, ch };
  }

  test('members react; bad input is 400, unknown messages 404, outsiders 403', async () => {
    const { owner, channel, msg, ch } = await room();
    const ok = await ch({ messageId: msg.id, emoji: '🎉', add: true });
    expect(ok.status).toBe(200);
    expect(ok.json.reactions).toMatchObject([{ emoji: '🎉', count: 1, me: true }]);
    expect(await listed(owner, channel.id, msg.id)).toMatchObject([{ emoji: '🎉', count: 1 }]);

    expect((await ch({ messageId: msg.id, emoji: 'hi', add: true })).status).toBe(400);
    expect((await ch({ messageId: msg.id, emoji: '🎉' })).status).toBe(400);
    expect((await ch({ messageId: 5, emoji: '🎉', add: true })).status).toBe(400);
    expect((await ch({ messageId: 'nope', emoji: '🎉', add: true })).status).toBe(404);
    const outsider = fakeUser(uniqueName('fk'));
    expect((await ch({ messageId: msg.id, emoji: '🎉', add: true }, outsider)).status).toBe(403);
  });
});
