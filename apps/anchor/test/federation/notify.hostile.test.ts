import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, resetHarness, signup } from '../harness/federation';
import { call, createGuild } from '../harness/chat';
import { fedChannelId, fedGuildId } from '../harness/fedflows';
import { ready, sendSigned, signed, withDb } from '../harness/fedVerify';
import { startPushSink } from '../harness/push';
import { eventually } from '../harness/wait';

// hostile callers of POST /federation/push: forged, replayed, stale and flooding homeservers, and
// subscription endpoints that point somewhere a push must never go. The fake anchor (identity 1,
// 172.30.0.66) plays the evil homeserver; it hosts a guild that anchor-b's user really is a member of.
const sink = startPushSink({ endpointHost: '172.30.0.1' });
const evil = '172.30.0.66';
const path = '/federation/push';

let member: Awaited<ReturnType<typeof signup>>;
let device: { label: string };
const push = (over: object = {}) => ({
  guildId: 'g1',
  channelId: 'c1',
  messageId: 'm1',
  author: { username: 'mallory', displayName: null, homeserver: evil, avatarUrl: null },
  snippet: 'hi',
  handles: [member.user.handle],
  ...over,
});

beforeAll(async () => {
  await ready();
  await resetHarness();
  member = await signup('b');
  device = await sink.subscribe(member);
  const [guild, channel] = [fedGuildId(evil, 'g1'), fedChannelId(evil, 'c1')];
  await withDb('b', async (sql) => {
    // a leftover from an earlier run on a kept stack
    await sql`DELETE FROM guild WHERE id = ${guild}`;
    await sql`INSERT INTO guild (id, name, "ownerId") VALUES (${guild}, 'evil guild', ${member.user.id})`;
    await sql`INSERT INTO guild_member ("guildId", "userId", position) VALUES (${guild}, ${member.user.id}, 0)`;
    await sql`INSERT INTO channel (id, "guildId", name) VALUES (${channel}, ${guild}, 'general')`;
  });
});
afterAll(() => sink.stop());

const received = () => sink.for(device.label).length;

describe('control', () => {
  test('a correctly signed push from a homeserver that really hosts the guild is delivered', async () => {
    const before = received();
    expect((await sendSigned(await signed(1, 'b', path, push()))).status).toBe(200);
    await eventually(() => received() === before + 1, { message: 'push delivered' });
  });
});

describe('forged and mismatched senders', () => {
  test('claiming to be another homeserver while signing with the evil key is 401, and nothing is pushed', async () => {
    const before = received();
    const res = await sendSigned(await signed(1, 'b', path, push(), { homeserver: anchors.a.homeserver }));
    expect(res.status).toBe(401);
    await sink.settle();
    expect(received()).toBe(before);
  });

  test('a tampered body fails the body hash, and a tampered signature fails verification', async () => {
    const s = await signed(1, 'b', path, push());
    const tamperedBody = { ...s, text: JSON.stringify(push({ snippet: 'changed' })) };
    expect((await sendSigned(tamperedBody)).status).toBe(401);
    const badSignature = await sendSigned(await signed(1, 'b', path, push()), (headers) => {
      headers['X-Novarum-Signature'] = Buffer.alloc(64, 1).toString('base64');
    });
    expect(badSignature.status).toBe(401);
  });

  test('the evil homeserver cannot push for a guild hosted by another one, even by naming its raw id', async () => {
    // a real guild on A that the member joined: the evil server names A's guild id, which it rebuilds as its own
    const owner = await signup('a');
    const { guild } = await createGuild(owner, 'real');
    const { body } = await call(owner, 'POST', `/guilds/${guild.id}/invites`, {});
    expect((await call(member, 'POST', '/invite/accept', { code: body.invite.code, homeserver: anchors.a.homeserver })).status).toBe(200);
    const before = received();
    const res = await sendSigned(await signed(1, 'b', path, push({ guildId: guild.id, channelId: 'whatever' })));
    expect(res.status).toBe(200);
    await sink.settle();
    expect(received()).toBe(before);
  });
});

describe('replay and staleness', () => {
  test('replaying a signed push is 401 and does not notify twice', async () => {
    const before = received();
    const s = await signed(1, 'b', path, push({ messageId: 'replay' }));
    expect((await sendSigned(s)).status).toBe(200);
    const replay = await sendSigned(s);
    expect(replay.status).toBe(401);
    expect(replay.json?.error).toContain('nonce');
    await eventually(() => received() === before + 1, { message: 'one push' });
    await sink.settle();
    expect(received()).toBe(before + 1);
  });

  test('20 parallel copies of one signed push deliver exactly once', async () => {
    const before = received();
    const s = await signed(1, 'b', path, push({ messageId: 'parallel' }));
    const statuses = (await Promise.all(Array.from({ length: 20 }, () => sendSigned(s)))).map((r) => r.status);
    expect(statuses.filter((code) => code === 200)).toHaveLength(1);
    expect(statuses.filter((code) => code === 401)).toHaveLength(19);
    await sink.settle();
    expect(received()).toBe(before + 1);
  });

  test('a push signed with an old date is 401', async () => {
    const before = received();
    const res = await sendSigned(await signed(1, 'b', path, push({ messageId: 'old' }), { date: new Date(Date.now() - 3_600_000).toISOString() }));
    expect(res.status).toBe(401);
    await sink.settle();
    expect(received()).toBe(before);
  });
});

describe('flooding', () => {
  test('one homeserver is limited to 600 pushes a minute, with a 429 after that', async () => {
    const statuses: number[] = [];
    for (let batch = 0; batch < 35; batch++) {
      const results = await Promise.all(
        Array.from({ length: 20 }, async () => (await sendSigned(await signed(1, 'b', path, push({ guildId: 'nope', handles: ['@nobody:' + anchors.b.homeserver] })))).status)
      );
      statuses.push(...results);
    }
    expect(statuses.filter((code) => code === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((code) => code === 200).length).toBeLessThanOrEqual(600);
    expect(statuses.every((code) => code === 200 || code === 429)).toBe(true);
  });
});

describe('subscription endpoints', () => {
  // anchor-p is a public-mode anchor (https://p.test), so unlike the others it refuses private targets
  test('a public anchor refuses endpoints that point at loopback, link-local or private addresses', async () => {
    const user = await signup('p');
    const keys = { p256dh: 'k', auth: 'a' };
    for (const endpoint of ['https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://172.30.0.99/x', 'https://localhost/x', 'http://p.test/x']) {
      const res = await call(user, 'POST', '/notifications/subscriptions', { kind: 'WEBPUSH', endpoint, keys });
      expect(res.status, endpoint).toBe(400);
    }
    const stored = await withDb('p', (sql) => sql`SELECT 1 FROM push_subscription WHERE "userId" = ${user.user.id}`);
    expect(stored).toHaveLength(0);
  });
});
