import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { signup, type TestUser } from '../harness/users';
import { openRealtime } from '../harness/ws';
import { befriend } from '../harness/friends';
import { anonymous, call, createGuild, join, list, send } from '../harness/chat';

let anchor: RunningAnchor;
let sql: ReturnType<typeof connect>;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'reactions' });
  sql = connect(anchor.databaseUrl);
});
afterAll(async () => {
  await sql.close();
  await anchor.destroy();
});

async function world() {
  const [owner, member, stranger] = await Promise.all([
    signup(anchor.url),
    signup(anchor.url),
    signup(anchor.url),
  ]);
  const { guild, channel } = await createGuild(owner);
  await join(owner, guild.id, member);
  const message = (await send(owner, channel.id, 'react to me')).body.message;
  return { owner, member, stranger, guild, channel, message };
}

const react = (
  user: Pick<TestUser, 'fetch'>,
  channelId: string,
  messageId: string,
  emoji: string,
  add = true
) => call(user, 'POST', '/message/react', { channelId, messageId, emoji, add });

const listed = async (user: TestUser, channelId: string, messageId: string) =>
  (await list(user, channelId)).body.messages.find((m: any) => m.id === messageId).reactions;

describe('react', () => {
  test('adding and removing returns the aggregated reactions as the caller sees them', async () => {
    const { owner, member, channel, message } = await world();
    const first = await react(member, channel.id, message.id, '👍');
    expect(first.status).toBe(200);
    expect(first.body.reactions).toEqual([
      {
        emoji: '👍',
        count: 1,
        me: true,
        users: [expect.objectContaining({ userId: member.user.id })],
      },
    ]);

    const second = await react(owner, channel.id, message.id, '👍');
    expect(second.body.reactions).toMatchObject([{ emoji: '👍', count: 2, me: true }]);
    expect(second.body.reactions[0].users.map((u: any) => u.userId)).toEqual([
      member.user.id,
      owner.user.id,
    ]);

    await react(owner, channel.id, message.id, '🎉');
    expect(await listed(member, channel.id, message.id)).toMatchObject([
      { emoji: '👍', count: 2, me: true },
      { emoji: '🎉', count: 1, me: false },
    ]);

    const removed = await react(member, channel.id, message.id, '👍', false);
    expect(removed.body.reactions).toMatchObject([
      { emoji: '👍', count: 1, me: false },
      { emoji: '🎉', count: 1, me: false },
    ]);
  });

  test('toggling is idempotent: adding twice or removing what is not there changes nothing', async () => {
    const { member, channel, message } = await world();
    await react(member, channel.id, message.id, '👍');
    const again = await react(member, channel.id, message.id, '👍');
    expect(again.status).toBe(200);
    expect(again.body.reactions).toMatchObject([{ emoji: '👍', count: 1 }]);
    expect(
      await sql`SELECT 1 FROM message_reaction WHERE "messageId" = ${message.id}`
    ).toHaveLength(1);

    const gone = await react(member, channel.id, message.id, '🎉', false);
    expect(gone.status).toBe(200);
    expect(gone.body.reactions).toMatchObject([{ emoji: '👍', count: 1 }]);
  });

  test('skin tones, ZWJ sequences, flags and keycaps are single emojis', async () => {
    const { member, channel, message } = await world();
    for (const emoji of ['👍🏽', '👩‍💻', '🇫🇷', '1️⃣', '❤️']) {
      expect((await react(member, channel.id, message.id, emoji)).status, emoji).toBe(200);
    }
  });

  test('anything but one emoji is rejected', async () => {
    const { member, channel, message } = await world();
    for (const emoji of [
      '',
      'a',
      'hi',
      '👍👍',
      '👍 ',
      ':thumbsup:',
      '1',
      '#',
      '<b>',
      '👍'.repeat(40),
    ]) {
      expect((await react(member, channel.id, message.id, emoji)).status, emoji).toBe(422);
    }
    const missingAdd = await call(member, 'POST', '/message/react', {
      channelId: channel.id,
      messageId: message.id,
      emoji: '👍',
    });
    expect(missingAdd.status).toBe(422);
    expect(await listed(member, channel.id, message.id)).toEqual([]);
  });

  test('a message takes at most 20 different emojis, but more people can use one of them', async () => {
    const { owner, member, channel, message } = await world();
    const emojis = [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗'];
    expect(emojis).toHaveLength(20);
    await Promise.all(emojis.map((emoji) => react(owner, channel.id, message.id, emoji)));

    const over = await react(member, channel.id, message.id, '🤔');
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('Too many reactions');
    expect((await react(member, channel.id, message.id, '😀')).status).toBe(200);

    // removing one makes room again
    await react(owner, channel.id, message.id, '🤗', false);
    expect((await react(member, channel.id, message.id, '🤔')).status).toBe(200);
  });

  test('racing adds of new emojis never go over the cap', async () => {
    const { owner, channel, message } = await world();
    const emojis = [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗🤔🤨😐😑😶'];
    await Promise.all(emojis.map((emoji) => react(owner, channel.id, message.id, emoji)));
    const [row] =
      await sql`SELECT count(DISTINCT emoji)::int AS n FROM message_reaction WHERE "messageId" = ${message.id}`;
    expect(row.n).toBe(20);
  });

  test('non-members 403, unknown channel 404, unknown message or one from another channel 404, anonymous 401', async () => {
    const { owner, member, stranger, guild, channel, message } = await world();
    expect((await react(stranger, channel.id, message.id, '👍')).status).toBe(403);
    expect((await react(member, 'nope', message.id, '👍')).status).toBe(404);
    expect((await react(member, channel.id, 'nope', '👍')).status).toBe(404);
    expect((await react(anonymous(anchor.url), channel.id, message.id, '👍')).status).toBe(401);

    const other = (
      await call(owner, 'POST', '/channel/create', {
        guildId: guild.id,
        name: 'other',
        type: 'TEXT',
      })
    ).body;
    expect((await react(member, other.id, message.id, '👍')).status).toBe(404);

    // a message of a guild the stranger is in can't be reached through it either
    const { channel: theirs } = await createGuild(stranger);
    expect((await react(stranger, theirs.id, message.id, '👍')).status).toBe(404);
    expect(
      await sql`SELECT 1 FROM message_reaction WHERE "messageId" = ${message.id}`
    ).toHaveLength(0);
  });

  test('reactions go away with their message', async () => {
    const { owner, member, channel, message } = await world();
    await react(member, channel.id, message.id, '👍');
    await call(owner, 'POST', '/message/delete', { channelId: channel.id, messageId: message.id });
    expect(
      await sql`SELECT 1 FROM message_reaction WHERE "messageId" = ${message.id}`
    ).toHaveLength(0);
  });

  test('edit answers with the reactions the message has', async () => {
    const { owner, member, channel, message } = await world();
    await react(member, channel.id, message.id, '👍');
    const edited = await call(owner, 'POST', '/message/edit', {
      channelId: channel.id,
      messageId: message.id,
      content: 'edited',
    });
    expect(edited.body.message.reactions).toMatchObject([{ emoji: '👍', count: 1, me: false }]);
    expect((await send(owner, channel.id, 'new')).body.message.reactions).toEqual([]);
  });

  test('a reaction names its first 10 people; count has them all', async () => {
    const { owner, guild, channel, message } = await world();
    const people = await Promise.all(Array.from({ length: 12 }, () => signup(anchor.url)));
    for (const person of people) {
      await join(owner, guild.id, person);
      await react(person, channel.id, message.id, '👍');
    }
    const [reaction] = await listed(owner, channel.id, message.id);
    expect(reaction).toMatchObject({ count: 12, me: false });
    expect(reaction.users.map((u: any) => u.userId)).toEqual(
      people.slice(0, 10).map((p) => p.user.id)
    );
  });

  test('list loads reactions for a whole page at once', async () => {
    const { owner, member, channel } = await world();
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push((await send(owner, channel.id, `m${i}`)).body.message);
    await react(member, channel.id, sent[1].id, '👍');
    await react(member, channel.id, sent[3].id, '🎉');
    const messages = (await list(owner, channel.id)).body.messages;
    const byId = new Map(messages.map((m: any) => [m.id, m.reactions]));
    expect(byId.get(sent[0].id)).toEqual([]);
    expect(byId.get(sent[1].id)).toMatchObject([{ emoji: '👍', count: 1, me: false }]);
    expect(byId.get(sent[3].id)).toMatchObject([{ emoji: '🎉', count: 1, me: false }]);
  });
});

describe('realtime', () => {
  test('guild members see reactions added and removed; nothing is sent when nothing changed', async () => {
    const { owner, member, channel, message } = await world();
    const ws = await openRealtime(anchor.url, owner.cookie);
    try {
      await Bun.sleep(200);
      await react(member, channel.id, message.id, '👍');
      const added = await ws.waitFor('message.reaction.added');
      expect(added.data).toMatchObject({
        messageId: message.id,
        channelId: channel.id,
        emoji: '👍',
        count: 1,
        user: { userId: member.user.id },
      });

      await react(member, channel.id, message.id, '👍');
      await react(member, channel.id, message.id, '👍', false);
      const removed = await ws.waitFor('message.reaction.removed');
      expect(removed.data).toMatchObject({ messageId: message.id, emoji: '👍', count: 0 });
      await Bun.sleep(200);
      expect(ws.events.filter((e) => e.type.startsWith('message.reaction.'))).toHaveLength(2);
    } finally {
      ws.close();
    }
  });

  test('a stranger hears nothing', async () => {
    const { member, stranger, channel, message } = await world();
    const ws = await openRealtime(anchor.url, stranger.cookie);
    try {
      await Bun.sleep(200);
      await react(member, channel.id, message.id, '👍');
      await Bun.sleep(300);
      expect(ws.events.some((e) => e.type.startsWith('message.reaction.'))).toBe(false);
    } finally {
      ws.close();
    }
  });
});

describe('DMs', () => {
  test('participants react and the other one sees it; outsiders get 403', async () => {
    const [a, b, outsider] = await Promise.all([
      signup(anchor.url),
      signup(anchor.url),
      signup(anchor.url),
    ]);
    await befriend(a, b);
    const dm = (await call(a, 'POST', '/dm', { userId: b.user.id })).body;
    const message = (await send(a, dm.id, 'hi')).body.message;
    const ws = await openRealtime(anchor.url, a.cookie);
    try {
      await Bun.sleep(200);
      expect((await react(b, dm.id, message.id, '❤️')).status).toBe(200);
      await ws.waitFor('message.reaction.added', (e) => e.data.messageId === message.id);
    } finally {
      ws.close();
    }
    expect((await react(outsider, dm.id, message.id, '❤️')).status).toBe(403);
    expect(await listed(a, dm.id, message.id)).toMatchObject([{ emoji: '❤️', count: 1 }]);
  });
});
