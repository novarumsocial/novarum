import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect as dbConnect } from '../harness/db';
import { connect, createGuild, joinGuild, post } from '../harness/realtime';
import { signup } from '../harness/users';
import { eventually } from '../harness/wait';
import { openRealtime } from '../harness/ws';

setDefaultTimeout(30_000);

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'realtime' });
});
afterAll(() => anchor.destroy());

async function statusOf(userId: string) {
  const sql = dbConnect(anchor.databaseUrl);
  try {
    const [row] = await sql`SELECT status FROM "user" WHERE id = ${userId}`;
    return row.status as string;
  } finally {
    await sql.close();
  }
}

describe('connection', () => {
  test('no cookie closes with 1008', async () => {
    const rt = await openRealtime(anchor.url);
    expect(await rt.waitClosed()).toMatchObject({ code: 1008, reason: 'Unauthorized' });
  });

  test('invalid or tampered cookie closes with 1008', async () => {
    const u = await signup(anchor.url);
    for (const cookie of ['garbage', `${u.cookie}x`, u.cookie.split('.')[0]! + '.wrongsecret']) {
      const rt = await openRealtime(anchor.url, cookie);
      expect((await rt.waitClosed()).code).toBe(1008);
    }
  });

  test('a logged-out session cookie is refused', async () => {
    const u = await signup(anchor.url);
    await u.fetch('/auth/logout', { method: 'POST' });
    const rt = await openRealtime(anchor.url, u.cookie);
    expect((await rt.waitClosed()).code).toBe(1008);
  });

  test('messages sent right after open are handled once the session is validated', async () => {
    const u = await signup(anchor.url);
    const rt = await openRealtime(anchor.url, u.cookie);
    rt.send({ type: 'emoji.search', query: 'nothing' });
    const res = await rt.waitFor('emoji.search.results');
    expect(res.data).toEqual({ query: 'nothing', emojis: [] });
    rt.close();
  });

  test('messages from an unauthorized socket are ignored and do not crash the server', async () => {
    const rt = await openRealtime(anchor.url);
    rt.send({ type: 'emoji.search', query: 'x' });
    await rt.waitClosed();
    expect(rt.events).toEqual([]);
    expect((await fetch(`${anchor.url}/`)).ok).toBe(true);
  });
});

describe('subscriptions', () => {
  test('guild events only reach member guilds; subscribe.guild for a non-member guild is ignored', async () => {
    const owner = await signup(anchor.url);
    const outsider = await signup(anchor.url);
    const { guildId, channelId } = await createGuild(owner);
    const ro = await connect(owner);
    ro.send({ type: 'subscribe.guild', guildId });
    await ro.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);

    const rx = await connect(outsider);
    rx.send({ type: 'subscribe.guild', guildId });

    const { message } = await post(owner, '/message/send', { channelId, content: 'secret', nonce: 'n' });
    await ro.waitFor('message.created', (e) => e.data.id === message.id);
    // the outsider got neither a snapshot for that guild nor the event (they share the same server, so give it a beat)
    await Bun.sleep(300);
    expect(rx.events.filter((e) => e.type === 'message.created')).toHaveLength(0);
    expect(rx.events.filter((e) => e.type === 'voice.states.snapshot')).toHaveLength(1);
    ro.close();
    rx.close();
  });

  test('guilds joined before connecting are subscribed automatically', async () => {
    const owner = await signup(anchor.url);
    const guest = await signup(anchor.url);
    const { guildId, channelId } = await createGuild(owner);
    await joinGuild(owner, guest, guildId);
    const rg = await connect(guest);
    const { message } = await post(owner, '/message/send', { channelId, content: 'hi', nonce: 'n' });
    await rg.waitFor('message.created', (e) => e.data.id === message.id);
    rg.close();
  });
});

describe('presence', () => {
  test('online on connect; offline about 3s after the last socket closes (two tabs)', async () => {
    const u = await signup(anchor.url);
    expect(await statusOf(u.user.id)).toBe('OFFLINE');
    const tab1 = await connect(u);
    await eventually(async () => (await statusOf(u.user.id)) === 'ONLINE');
    const tab2 = await connect(u);

    tab1.close();
    await tab1.waitClosed();
    // the cleanup sweep runs every 3s; wait past two sweeps and the user must still be online
    await Bun.sleep(6500);
    expect(await statusOf(u.user.id)).toBe('ONLINE');

    tab2.close();
    await eventually(async () => (await statusOf(u.user.id)) === 'OFFLINE', { timeout: 8000 });

    // reconnecting flips it back
    const tab3 = await connect(u);
    await eventually(async () => (await statusOf(u.user.id)) === 'ONLINE');
    tab3.close();
  });
});
