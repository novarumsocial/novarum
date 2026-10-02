import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { z } from 'zod';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect, createGuild, joinGuild, befriend, post } from '../harness/realtime';
import { connect as dbConnect } from '../harness/db';
import { signup } from '../harness/users';
import { publicUserSchema } from '../../utils/publicUser';
import { dmResponseSchema, channelResponseSchema } from '../../src/db/zod';

/*
 * One test per RealtimeEvent type in utils/types.ts. Every event is triggerable locally (REST or WS), so
 * none are federation-only; their federated variants (remote channel events, bridged voice presence,
 * remote friend status) are covered in test/federation. voice.state.changed from LiveKit webhooks is
 * covered in voice.test.ts (@livekit). Client request replies (emoji.*.results) are tested here too.
 */

const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  type: z.enum(['TEXT', 'VOICE']),
  guildId: z.string(),
});
const voicePresenceSchema = z.object({
  guildId: z.string().nullable(),
  channelId: z.string(),
  userId: z.string(),
  name: z.string().nullable(),
});
const messageEventSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  guildId: z.string().nullable(),
  content: z.string().nullable(),
  nonce: z.string(),
  replyTo: z.string().nullable(),
  pingedHandles: z.array(z.string()),
  attachments: z.array(z.unknown()),
  createdAt: z.iso.datetime(),
  author: publicUserSchema,
});
const emojiSchema = z.object({ name: z.string(), unicode: z.string(), url: z.string() });

const emojis = [
  { name: 'grinning face', unicode: '1F600', url: 'https://example.test/1f600.png' },
  { name: 'rocket', unicode: '1F680', url: 'https://example.test/1f680.png' },
];

setDefaultTimeout(30_000);

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'rtevents' });
  const sql = dbConnect(anchor.databaseUrl);
  for (const e of emojis) await sql`INSERT INTO emojis (name, unicode, url) VALUES (${e.name}, ${e.unicode}, ${e.url})`;
  await sql.close();
});
afterAll(() => anchor.destroy());

async function pair() {
  const [a, b] = [await signup(anchor.url), await signup(anchor.url)];
  return { a, b, ra: await connect(a), rb: await connect(b) };
}

describe('realtime events', () => {
  test('voice.states.snapshot on connect lists the user guilds and dms', async () => {
    const a = await signup(anchor.url);
    const { guildId } = await createGuild(a);
    const rt = await connect(a);
    const snap = await rt.waitFor('voice.states.snapshot');
    const data = z
      .object({ guildIds: z.array(z.string()), dmIds: z.array(z.string()), states: z.array(voicePresenceSchema) })
      .parse(snap.data);
    expect(data.guildIds).toEqual([guildId]);
    expect(data.dmIds).toEqual([]);
    rt.close();
  });

  test('guild.created reaches the creator', async () => {
    const a = await signup(anchor.url);
    const rt = await connect(a);
    const { guildId } = await createGuild(a, 'evguild');
    const ev = await rt.waitFor('guild.created', (e) => e.data.id === guildId);
    const data = z
      .object({
        id: z.string(),
        name: z.literal('evguild'),
        ownerId: z.literal(a.user.id),
        avatarUrl: z.string().nullable(),
        description: z.string().nullable(),
        channels: z.array(channelSchema).length(1),
      })
      .parse(ev.data);
    expect(data.channels[0]!.name).toBe('general');
    rt.close();
  });

  test('channel.created, guild.channels.reordered, channel.typing reach guild members', async () => {
    const { a, b, ra, rb } = await pair();
    const { guildId, channelId } = await createGuild(a);
    await joinGuild(a, b, guildId);
    rb.send({ type: 'subscribe.guild', guildId });
    await rb.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);
    ra.send({ type: 'subscribe.guild', guildId });
    await ra.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);

    const created = await post(a, '/channel/create', { name: 'second chan', guildId, type: 'VOICE' });
    for (const rt of [ra, rb]) {
      const ev = await rt.waitFor('channel.created', (e) => e.data.id === created.id);
      expect(channelSchema.parse(ev.data)).toMatchObject({ name: 'second-chan', type: 'VOICE', guildId });
    }

    await post(a, '/channel/order', { guildId, channelIds: [channelId, created.id] }, 'PATCH');
    const reorder = await rb.waitFor('guild.channels.reordered');
    expect(z.object({ guildId: z.string(), channelIds: z.array(z.string()) }).parse(reorder.data)).toEqual({
      guildId,
      channelIds: [channelId, created.id],
    });

    await post(a, `/channel/${channelId}/typing`);
    const typing = await rb.waitFor('channel.typing');
    expect(
      z
        .object({
          channelId: z.literal(channelId),
          userId: z.literal(a.user.id),
          username: z.literal(a.user.username),
          displayName: z.string().nullable(),
          homeserver: z.string(),
          time: z.iso.datetime(),
        })
        .parse(typing.data).userId
    ).toBe(a.user.id);
    ra.close();
    rb.close();
  });

  test('message.created / updated / deleted', async () => {
    const { a, b, ra, rb } = await pair();
    const { guildId, channelId } = await createGuild(a);
    await joinGuild(a, b, guildId);
    rb.send({ type: 'subscribe.guild', guildId });
    ra.send({ type: 'subscribe.guild', guildId });
    await rb.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);
    await ra.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);

    const { message: sent } = await post(a, '/message/send', { channelId, content: 'hello', nonce: 'n1' });
    const created = await rb.waitFor('message.created', (e) => e.data.id === sent.id);
    expect(messageEventSchema.parse(created.data)).toMatchObject({
      content: 'hello',
      nonce: 'n1',
      guildId,
      channelId,
      author: { userId: a.user.id },
    });

    await post(a, '/message/edit', { channelId, messageId: sent.id, content: 'edited' });
    const updated = await rb.waitFor('message.updated', (e) => e.data.id === sent.id);
    expect(messageEventSchema.parse(updated.data).content).toBe('edited');

    await post(a, '/message/delete', { channelId, messageId: sent.id });
    const deleted = await rb.waitFor('message.deleted', (e) => e.data.id === sent.id);
    expect(
      z.object({ id: z.string(), channelId: z.string(), guildId: z.string().nullable() }).parse(deleted.data)
    ).toEqual({ id: sent.id, channelId, guildId });
    ra.close();
    rb.close();
  });

  test('member.joined and the joiner guild.created', async () => {
    const { a, b, ra, rb } = await pair();
    const { guildId } = await createGuild(a);
    ra.send({ type: 'subscribe.guild', guildId });
    await ra.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);
    await joinGuild(a, b, guildId);

    const joined = await ra.waitFor('member.joined');
    const data = z
      .object({ guildId: z.literal(guildId), user: publicUserSchema.extend({ status: z.enum(['ONLINE', 'OFFLINE']) }) })
      .parse(joined.data);
    expect(data.user.userId).toBe(b.user.id);
    const created = await rb.waitFor('guild.created', (e) => e.data.id === guildId);
    expect(created.data.channels).toHaveLength(1);
    ra.close();
    rb.close();
  });

  test('friends.changed to both users, dm.created to the other participant', async () => {
    const { a, b, ra, rb } = await pair();
    await post(a, '/friends/request', { username: b.user.username, homeserver: b.user.homeserver });
    await rb.waitFor('friends.changed');
    await post(b, `/friends/requests/${a.user.id}/accept`);
    expect(z.object({}).strict().parse((await ra.waitFor('friends.changed', () => true)).data)).toEqual({});
    await eventuallyCount(ra.events, 'friends.changed', 1);

    const dm = await post(a, '/dm', { userId: b.user.id });
    const ev = await rb.waitFor('dm.created', (e) => e.data.id === dm.id);
    expect(dmResponseSchema.parse(ev.data)).toMatchObject({ id: dm.id, type: 'DM' });
    expect(ev.data.participants.map((p: any) => p.userId)).toEqual([a.user.id]);
    ra.close();
    rb.close();
  });

  test('user.updated reaches the user and their guild', async () => {
    const { a, b, ra, rb } = await pair();
    const { guildId } = await createGuild(a);
    await joinGuild(a, b, guildId);
    rb.send({ type: 'subscribe.guild', guildId });
    await rb.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);

    await post(a, '/user/about', { about: 'new about' });
    for (const rt of [ra, rb]) {
      const ev = await rt.waitFor('user.updated', (e) => e.data.user.userId === a.user.id);
      expect(z.object({ user: publicUserSchema }).parse(ev.data).user.userId).toBe(a.user.id);
    }
    ra.close();
    rb.close();
  });

  test('user.status.changed to friends and guild members on connect/disconnect', async () => {
    const a = await signup(anchor.url);
    const b = await signup(anchor.url);
    const { guildId } = await createGuild(a);
    await joinGuild(a, b, guildId);
    await befriend(a, b);
    const rb = await connect(b);
    rb.send({ type: 'subscribe.guild', guildId });
    await rb.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);

    const ra = await connect(a);
    const online = await rb.waitFor('user.status.changed', (e) => e.data.userId === a.user.id);
    expect(z.object({ userId: z.string(), status: z.literal('ONLINE') }).parse(online.data).userId).toBe(a.user.id);
    ra.close();
    const offline = await rb.waitFor('user.status.changed', (e) => e.data.status === 'OFFLINE', 8000);
    expect(offline.data.userId).toBe(a.user.id);
    rb.close();
  });

  test('voice.join -> voice.state.changed(connected) and snapshot for new sockets; voice.leave -> disconnected', async () => {
    const { a, b, ra, rb } = await pair();
    const { guildId, channelId: textId } = await createGuild(a);
    await joinGuild(a, b, guildId);
    const voice = await post(a, '/channel/create', { name: 'vc', guildId, type: 'VOICE' });
    rb.send({ type: 'subscribe.guild', guildId });
    await rb.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);

    ra.send({ type: 'voice.join', channelId: voice.id });
    const joined = await rb.waitFor('voice.state.changed', (e) => e.data.connected);
    expect(voicePresenceSchema.extend({ connected: z.literal(true) }).parse(joined.data)).toMatchObject({
      channelId: voice.id,
      userId: a.user.id,
      guildId,
    });
    await ra.waitFor('voice.state.changed');

    // a fresh socket sees the live state in its snapshot
    const rb2 = await connect(b);
    const snap = await rb2.waitFor('voice.states.snapshot');
    expect(snap.data.states.map((s: any) => s.userId)).toEqual([a.user.id]);

    // joining a text channel is ignored
    ra.send({ type: 'voice.join', channelId: textId });

    ra.send({ type: 'voice.leave' });
    const left = await rb.waitFor('voice.state.changed', (e) => !e.data.connected);
    expect(left.data.userId).toBe(a.user.id);
    ra.close();
    rb.close();
    rb2.close();
  });

  test('call.ring goes to DM participants and ignores non-DM channels', async () => {
    const { a, b, ra, rb } = await pair();
    await befriend(a, b);
    const dm = await post(a, '/dm', { userId: b.user.id });
    const { channelId: guildChannel } = await createGuild(a);

    ra.send({ type: 'call.ring', channelId: guildChannel, ringing: true });
    ra.send({ type: 'call.ring', channelId: dm.id, ringing: true });
    const ev = await rb.waitFor('call.ringing');
    expect(
      z.object({ channelId: z.string(), user: publicUserSchema, ringing: z.boolean() }).parse(ev.data)
    ).toMatchObject({ channelId: dm.id, ringing: true, user: { userId: a.user.id } });
    expect(rb.events.filter((e) => e.type === 'call.ringing')).toHaveLength(1);
    ra.close();
    rb.close();
  });

  test('emoji.search / emoji.query reply with the seeded emojis', async () => {
    const a = await signup(anchor.url);
    const rt = await connect(a);
    rt.send({ type: 'emoji.search', query: 'rocket' });
    const search = await rt.waitFor('emoji.search.results');
    expect(z.object({ query: z.string(), emojis: z.array(emojiSchema) }).parse(search.data)).toEqual({
      query: 'rocket',
      emojis: [emojis[1]!],
    });

    rt.send({ type: 'emoji.query', unicodes: ['1f600', '1F680', '1F680', 'ABCDE'] });
    const query = await rt.waitFor('emoji.query.results');
    const data = z.object({ unicodes: z.array(z.string()), emojis: z.array(emojiSchema) }).parse(query.data);
    expect(data.unicodes).toEqual(['1F600', '1F680', 'ABCDE']);
    expect(data.emojis).toEqual(emojis);
    rt.close();
  });

  test('invalid bodies are rejected without crashing the server or the socket', async () => {
    const a = await signup(anchor.url);
    const rt = await connect(a);
    rt.send({ type: 'emoji.query', unicodes: [] });
    rt.send({ type: 'emoji.query', unicodes: ['not hex!'] });
    rt.send({ type: 'nope' });
    rt.ws.send('not json at all');
    rt.send({ type: 'emoji.search' });
    rt.send({ type: 'emoji.search', query: 'rocket' });
    await rt.waitFor('emoji.search.results');
    expect(rt.events.filter((e) => e.type.startsWith('emoji.query'))).toHaveLength(0);
    expect((await fetch(`${anchor.url}/`)).ok).toBe(true);
    rt.close();
  });
});

const eventuallyCount = async (events: { type: string }[], type: string, n: number) => {
  const { eventually } = await import('../harness/wait');
  await eventually(() => events.filter((e) => e.type === type).length >= n);
};
