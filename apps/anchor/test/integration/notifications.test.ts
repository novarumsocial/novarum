import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { signup } from '../harness/users';
import { befriend } from '../harness/friends';
import { anonymous, call, createGuild, join, send } from '../harness/chat';
import { openRealtime } from '../harness/ws';
import { startPushSink } from '../harness/push';
import { eventually } from '../harness/wait';

let anchor: RunningAnchor;
let sql: ReturnType<typeof connect>;
const sink = startPushSink();
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'notifications' });
  sql = connect(anchor.databaseUrl);
});
afterAll(async () => {
  sink.stop();
  await sql.close();
  await anchor.destroy();
});

const user = () => signup(anchor.url);
type Actor = Awaited<ReturnType<typeof signup>>;
const setting = (u: Actor, targetId: string, body: object) =>
  call(u, 'PUT', `/notifications/settings/${encodeURIComponent(targetId)}`, body);

// a guild owner with a member `b` who has a subscribed device
async function guildWithSubscriber() {
  const [owner, b] = await Promise.all([user(), user()]);
  const { guild, channel } = await createGuild(owner);
  await join(owner, guild.id, b);
  const { label } = await sink.subscribe(b);
  return { owner, b, guild, channel, label };
}

describe('settings', () => {
  test('GET returns the defaults, and every route needs a session', async () => {
    const u = await user();
    expect((await call(u, 'GET', '/notifications/settings')).body).toEqual({
      preferences: { push: true, messagePreview: true },
      settings: [],
    });
    const subscription = { kind: 'WEBPUSH', endpoint: 'https://push.example/x', keys: { p256dh: 'k', auth: 'a' } };
    for (const [method, path, body] of [
      ['GET', '/notifications/settings', undefined],
      ['PUT', '/notifications/settings/x', { level: 'ALL' }],
      ['DELETE', '/notifications/settings/x', undefined],
      ['POST', '/notifications/subscriptions', subscription],
    ] as const) {
      expect((await call(anonymous(anchor.url), method, path, body)).status).toBe(401);
    }
  });

  test('PUT and DELETE change one entry, for guilds and channels', async () => {
    const u = await user();
    const { guild, channel } = await createGuild(u);
    expect((await setting(u, guild.id, { level: 'MENTIONS' })).body).toMatchObject({ targetId: guild.id, level: 'MENTIONS', mutedUntil: null });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await setting(u, channel.id, { level: 'NONE', mutedUntil: until })).body).toMatchObject({ level: 'NONE', mutedUntil: until });
    expect((await setting(u, channel.id, { level: 'ALL' })).body.mutedUntil).toBeNull();
    expect((await call(u, 'GET', '/notifications/settings')).body.settings).toHaveLength(2);

    expect((await call(u, 'DELETE', `/notifications/settings/${encodeURIComponent(channel.id)}`)).status).toBe(200);
    expect((await call(u, 'GET', '/notifications/settings')).body.settings.map((s: any) => s.targetId)).toEqual([guild.id]);
  });

  test('a bad level is 422, and targets the user is not in are 403', async () => {
    const [u, other] = await Promise.all([user(), user()]);
    const { guild, channel } = await createGuild(other);
    expect((await setting(u, guild.id, { level: 'LOUD' })).status).toBe(422);
    expect((await setting(u, guild.id, { level: 'NONE' })).status).toBe(403);
    expect((await setting(u, channel.id, { level: 'NONE' })).status).toBe(403);
    expect((await setting(u, 'nonexistent', { level: 'NONE' })).status).toBe(403);
    expect(await sql`SELECT 1 FROM notification_setting WHERE "userId" = ${u.user.id}`).toHaveLength(0);
  });

  test('DM targets need membership, and fed: ids survive URL encoding', async () => {
    const [a, b, c] = await Promise.all([user(), user(), user()]);
    await befriend(a, b);
    const dm = (await call(a, 'POST', '/dm', { userId: b.user.id })).body.id as string;
    expect((await setting(a, dm, { level: 'NONE' })).status).toBe(200);
    expect((await setting(c, dm, { level: 'NONE' })).status).toBe(403);

    const fedGuild = 'fed:guild:remote.example:g1';
    await sql`INSERT INTO guild (id, name, "ownerId") VALUES (${fedGuild}, 'remote', ${a.user.id})`;
    await sql`INSERT INTO guild_member ("guildId", "userId", position) VALUES (${fedGuild}, ${a.user.id}, 0)`;
    expect((await setting(a, fedGuild, { level: 'MENTIONS' })).body.targetId).toBe(fedGuild);
    expect((await setting(b, fedGuild, { level: 'MENTIONS' })).status).toBe(403);
  });

  test('preferences are stored per user', async () => {
    const u = await user();
    expect((await call(u, 'PUT', '/notifications/preferences', { messagePreview: false })).body).toEqual({ push: true, messagePreview: false });
    expect((await call(u, 'GET', '/notifications/settings')).body.preferences).toEqual({ push: true, messagePreview: false });
  });
});

describe('subscriptions', () => {
  test('the VAPID public key is public and stable', async () => {
    const first = await call(anonymous(anchor.url), 'GET', '/notifications/vapid-key');
    expect(first.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect((await call(anonymous(anchor.url), 'GET', '/notifications/vapid-key')).body).toEqual(first.body);
  });

  test('created, moved to the newest session when re-subscribed, and removed on logout', async () => {
    const u = await user();
    const { id } = await sink.subscribe(u, 'laptop');
    const [row] = await sql`SELECT * FROM push_subscription WHERE id = ${id}`;
    expect(row).toMatchObject({ userId: u.user.id, kind: 'WEBPUSH' });

    const second = await sink.subscribe(u, 'laptop');
    expect(second.id).toBe(id);
    expect(await sql`SELECT 1 FROM push_subscription WHERE "userId" = ${u.user.id}`).toHaveLength(1);

    const res = await u.fetch('/auth/logout', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(await sql`SELECT 1 FROM push_subscription WHERE "userId" = ${u.user.id}`).toHaveLength(0);
  });

  test('unsafe endpoints are rejected, and only the owner can delete', async () => {
    const [u, other] = await Promise.all([user(), user()]);
    const keys = { p256dh: 'k', auth: 'a' };
    for (const endpoint of ['ftp://push.example/x', 'not a url']) {
      const res = await call(u, 'POST', '/notifications/subscriptions', { kind: 'WEBPUSH', endpoint, keys });
      expect([400, 422]).toContain(res.status);
    }
    expect((await call(u, 'POST', '/notifications/subscriptions', { kind: 'FCM', endpoint: 'https://push.example/x', keys })).status).toBe(422);

    const { id } = await sink.subscribe(u);
    expect((await call(other, 'DELETE', `/notifications/subscriptions/${id}`)).status).toBe(404);
    expect((await call(u, 'DELETE', `/notifications/subscriptions/${id}`)).status).toBe(200);
    expect((await call(u, 'DELETE', `/notifications/subscriptions/${id}`)).status).toBe(404);
  });

  test('another account cannot take over a device\'s endpoint while the owner\'s session is alive', async () => {
    const [owner, thief] = await Promise.all([user(), user()]);
    const { id, label } = await sink.subscribe(owner);
    const endpoint = (await sql`SELECT endpoint FROM push_subscription WHERE id = ${id}`)[0]!.endpoint;
    const body = { kind: 'WEBPUSH', endpoint, keys: { p256dh: 'k', auth: 'a' } };
    expect((await call(thief, 'POST', '/notifications/subscriptions', body)).status).toBe(409);
    expect((await sql`SELECT "userId" FROM push_subscription WHERE id = ${id}`)[0]!.userId).toBe(owner.user.id);

    // the same phone moving to another account, after the first one's session ran out
    await sql`UPDATE session SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = ${owner.user.id}`;
    expect((await call(thief, 'POST', '/notifications/subscriptions', body)).status).toBe(200);
    expect((await sql`SELECT "userId" FROM push_subscription WHERE id = ${id}`)[0]!.userId).toBe(thief.user.id);
    expect(label).toBeDefined();
  });

  test('a user keeps at most 10 devices: a new one replaces the oldest', async () => {
    const u = await user();
    for (let i = 0; i < 10; i++) await sink.subscribe(u, `cap-${u.user.id}-${i}`);
    await sink.subscribe(u, `cap-${u.user.id}-new`);
    const rows = await sql`SELECT endpoint FROM push_subscription WHERE "userId" = ${u.user.id}`;
    expect(rows).toHaveLength(10);
    expect(rows.some((row: any) => row.endpoint.endsWith(`cap-${u.user.id}-0`))).toBe(false);
    expect(rows.some((row: any) => row.endpoint.endsWith(`cap-${u.user.id}-new`))).toBe(true);
    await sink.subscribe(u, `cap-${u.user.id}-5`);
    expect(await sql`SELECT 1 FROM push_subscription WHERE "userId" = ${u.user.id}`).toHaveLength(10);
  });

  test('UnifiedPush endpoints are stored like web push ones', async () => {
    const u = await user();
    const { id } = await sink.subscribe(u, undefined, 'UNIFIEDPUSH');
    expect((await sql`SELECT kind FROM push_subscription WHERE id = ${id}`)[0]!.kind).toBe('UNIFIEDPUSH');
  });

  test('a device the push service reports gone (410) is forgotten', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    sink.forget(label);
    await send(owner, channel.id, `psst ${b.user.handle}`);
    await eventually(async () => (await sql`SELECT 1 FROM push_subscription WHERE "userId" = ${b.user.id}`).length === 0, { message: 'subscription removed' });
  });
});

describe('what gets pushed', () => {
  test('a mention pushes to the mentioned member only, with a titled, tagged, deep-linked notification', async () => {
    const { owner, b, guild, channel, label } = await guildWithSubscriber();
    const bystander = await user();
    await join(owner, guild.id, bystander);
    const bystanderDevice = await sink.subscribe(bystander);

    const sent = await send(owner, channel.id, `hello ${b.user.handle}`);
    const [push] = await eventually(() => (sink.for(label).length ? sink.for(label) : null), { message: 'mention push' });
    expect(push).toMatchObject({
      body: `hello ${b.user.handle}`,
      tag: channel.id,
      channelId: channel.id,
      url: `/guilds/${guild.id}/${channel.id}/${sent.body.message.id}`,
    });
    expect(push.title).toContain(`#general`);
    await sink.settle();
    expect(sink.for(bystanderDevice.label)).toHaveLength(0);
    expect(sink.for(label)).toHaveLength(1);
  });

  test('a message with no mention pushes nothing', async () => {
    const { owner, channel, label } = await guildWithSubscriber();
    await send(owner, channel.id, 'just chatting');
    await sink.settle();
    expect(sink.for(label)).toHaveLength(0);
  });

  test('a reply to your message pushes to you', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    const first = await send(b, channel.id, 'anyone there?');
    await send(owner, channel.id, 'yes', { replyTo: first.body.message.id });
    await eventually(() => sink.for(label).length === 1, { message: 'reply push' });
  });

  test('a DM pushes to the other participant, and never to its author', async () => {
    const [a, b] = await Promise.all([user(), user()]);
    await befriend(a, b);
    const [deviceA, deviceB] = [await sink.subscribe(a), await sink.subscribe(b)];
    const dm = (await call(a, 'POST', '/dm', { userId: b.user.id })).body.id as string;

    await send(a, dm, 'psst');
    const [push] = await eventually(() => (sink.for(deviceB.label).length ? sink.for(deviceB.label) : null), { message: 'dm push' });
    expect(push).toMatchObject({ body: 'psst', url: `/guilds/dms/${encodeURIComponent(dm)}`, tag: dm });
    expect(push.title).toBe(a.user.username);
    await sink.settle();
    expect(sink.for(deviceA.label)).toHaveLength(0);
  });

  test('an edit that adds a mention pushes once; editing again does not repeat it', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    const sent = await send(owner, channel.id, 'hello');
    const edit = (content: string) =>
      call(owner, 'POST', '/message/edit', { channelId: channel.id, messageId: sent.body.message.id, content });

    expect((await edit(`hello ${b.user.handle}`)).status).toBe(200);
    await eventually(() => sink.for(label).length === 1, { message: 'edit push' });
    expect((await edit(`hello again ${b.user.handle}`)).status).toBe(200);
    await sink.settle();
    expect(sink.for(label)).toHaveLength(1);
  });

  test('a message that already mentioned you does not push again when edited', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    const sent = await send(owner, channel.id, `hi ${b.user.handle}`);
    await eventually(() => sink.for(label).length === 1, { message: 'first push' });
    await call(owner, 'POST', '/message/edit', { channelId: channel.id, messageId: sent.body.message.id, content: `hi ${b.user.handle}!` });
    await sink.settle();
    expect(sink.for(label)).toHaveLength(1);
  });
});

describe('who is skipped', () => {
  test('muting the channel or the guild stops pushes; a channel setting beats the guild one', async () => {
    const { owner, b, guild, channel, label } = await guildWithSubscriber();
    const mention = () => send(owner, channel.id, `ping ${b.user.handle}`);

    await setting(b, channel.id, { level: 'NONE' });
    await mention();
    await sink.settle();
    expect(sink.for(label)).toHaveLength(0);

    // the channel says MENTIONS even though the guild is muted
    await setting(b, guild.id, { level: 'NONE' });
    await setting(b, channel.id, { level: 'MENTIONS' });
    await mention();
    await eventually(() => sink.for(label).length === 1, { message: 'channel overrides guild' });

    // a timed mute counts until it expires
    await setting(b, channel.id, { level: 'ALL', mutedUntil: new Date(Date.now() + 60_000).toISOString() });
    await mention();
    await sink.settle();
    expect(sink.for(label)).toHaveLength(1);
  });

  test('a muted DM pushes nothing', async () => {
    const [a, b] = await Promise.all([user(), user()]);
    await befriend(a, b);
    const device = await sink.subscribe(b);
    const dm = (await call(a, 'POST', '/dm', { userId: b.user.id })).body.id as string;
    await setting(b, dm, { level: 'NONE' });
    await send(a, dm, 'hello?');
    await sink.settle();
    expect(sink.for(device.label)).toHaveLength(0);
  });

  test('push turned off in the preferences', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    await call(b, 'PUT', '/notifications/preferences', { push: false });
    await send(owner, channel.id, `hey ${b.user.handle}`);
    await sink.settle();
    expect(sink.for(label)).toHaveLength(0);
  });

  test('an active connection blocks push, and a backgrounded one does not', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    const rt = await openRealtime(anchor.url, b.cookie);
    await send(owner, channel.id, `look ${b.user.handle}`);
    await sink.settle();
    expect(sink.for(label)).toHaveLength(0);

    // a phone app keeps its socket open while backgrounded and tells the server so
    rt.send({ type: 'client.state', active: false });
    await Bun.sleep(300);
    await send(owner, channel.id, `look again ${b.user.handle}`);
    await eventually(() => sink.for(label).length === 1, { message: 'push once inactive' });

    rt.send({ type: 'client.state', active: true });
    await Bun.sleep(300);
    await send(owner, channel.id, `third ${b.user.handle}`);
    await sink.settle();
    expect(sink.for(label)).toHaveLength(1);
    rt.close();
  });

  test('one person gets at most 60 pushes a minute, however many people mention them', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    for (let i = 0; i < 70; i++) await send(owner, channel.id, `spam ${i} ${b.user.handle}`);
    await eventually(() => sink.for(label).length >= 60, { timeout: 15_000, message: 'pushes arrive' });
    await sink.settle();
    expect(sink.for(label)).toHaveLength(60);
  });

  test('a local author\'s avatar is the notification icon', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    await sql`UPDATE "user" SET "avatarUrl" = 'https://example.com/a.png' WHERE id = ${owner.user.id}`;
    await send(owner, channel.id, `look ${b.user.handle}`);
    const [push] = await eventually(() => (sink.for(label).length ? sink.for(label) : null), { message: 'push' });
    expect(push.icon).toBe('https://example.com/a.png');
  });

  test('without message preview the content stays out of the push', async () => {
    const { owner, b, channel, label } = await guildWithSubscriber();
    await call(b, 'PUT', '/notifications/preferences', { messagePreview: false });
    await send(owner, channel.id, `top secret ${b.user.handle}`);
    const [push] = await eventually(() => (sink.for(label).length ? sink.for(label) : null), { message: 'push' });
    expect(push.body).toBe('Mentioned you');
    expect(JSON.stringify(push)).not.toContain('top secret');
  });
});
