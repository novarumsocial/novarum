import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { openRealtime } from '../harness/ws';
import { signup } from '../harness/users';
import { eventually } from '../harness/wait';

// local (same-homeserver) friendships only; federated ones live in test/federation
let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'friends' });
});
afterAll(() => anchor?.destroy());

type User = Awaited<ReturnType<typeof signup>>;
const pair = async () => [await signup(anchor.url), await signup(anchor.url)] as const;

const request = (from: User, to: User, homeserver = 'localhost') =>
  from.fetch('/friends/request', { method: 'POST', body: JSON.stringify({ username: to.user.username, homeserver }) });
const accept = (by: User, requester: User) => by.fetch(`/friends/requests/${requester.user.id}/accept`, { method: 'POST' });
const decline = (by: User, requester: User) => by.fetch(`/friends/requests/${requester.user.id}/decline`, { method: 'POST' });
const del = (by: User, other: User) => by.fetch(`/friends/${other.user.id}`, { method: 'DELETE' });
const list = async (u: User) =>
  (await (await u.fetch('/friends')).json()) as Record<'accepted' | 'incoming' | 'outgoing', { user: { userId: string } }[]>;
const ids = (entries: { user: { userId: string } }[]) => entries.map((e) => e.user.userId);

describe('request / accept / remove', () => {
  test('a request is outgoing for the sender and incoming for the recipient', async () => {
    const [a, b] = await pair();
    const res = await request(a, b);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'PENDING', requestedById: a.user.id, version: 1, acceptedAt: null });
    expect(ids((await list(a)).outgoing)).toEqual([b.user.id]);
    expect(ids((await list(b)).incoming)).toEqual([a.user.id]);
    expect((await list(a)).incoming).toEqual([]);
    expect((await list(b)).outgoing).toEqual([]);
  });

  test('accepting makes both sides friends', async () => {
    const [a, b] = await pair();
    await request(a, b);
    const res = await accept(b, a);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ACCEPTED', version: 2 });
    for (const [me, other] of [[a, b], [b, a]] as const) {
      const l = await list(me);
      expect(ids(l.accepted)).toEqual([other.user.id]);
      expect(l.incoming).toEqual([]);
      expect(l.outgoing).toEqual([]);
    }
  });

  test('the requester cannot accept their own request', async () => {
    const [a, b] = await pair();
    await request(a, b);
    expect((await accept(a, b)).status).toBe(400);
    expect(ids((await list(b)).incoming)).toEqual([a.user.id]);
  });

  test('a mutual request is an accept', async () => {
    const [a, b] = await pair();
    await request(a, b);
    const res = await request(b, a);
    expect(await res.json()).toMatchObject({ status: 'ACCEPTED' });
    expect(ids((await list(a)).accepted)).toEqual([b.user.id]);
  });

  test('requesting twice is idempotent', async () => {
    const [a, b] = await pair();
    const first = (await (await request(a, b)).json()) as any;
    const again = await request(a, b);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect((await list(b)).incoming).toHaveLength(1);
  });

  test('requesting an existing friend changes nothing', async () => {
    const [a, b] = await pair();
    await request(a, b);
    await accept(b, a);
    const res = await request(a, b);
    expect(await res.json()).toMatchObject({ status: 'ACCEPTED', version: 2 });
  });

  test('either side can remove a friend, and then they can request again', async () => {
    const [a, b] = await pair();
    await request(a, b);
    await accept(b, a);
    const removed = await del(a, b);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ status: 'NONE' });
    for (const u of [a, b]) expect(ids((await list(u)).accepted)).toEqual([]);

    await request(b, a);
    await accept(a, b);
    expect((await del(b, a)).status).toBe(200);
  });

  test('the homeserver part is case-insensitive', async () => {
    const [a, b] = await pair();
    expect((await request(a, b, 'LocalHost')).status).toBe(200);
  });
});

describe('decline / cancel', () => {
  test('the recipient declines: the request disappears for both', async () => {
    const [a, b] = await pair();
    await request(a, b);
    const res = await decline(b, a);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'NONE' });
    for (const u of [a, b]) {
      const l = await list(u);
      expect([l.accepted, l.incoming, l.outgoing].flat()).toEqual([]);
    }
  });

  test('the requester cannot decline their own request', async () => {
    const [a, b] = await pair();
    await request(a, b);
    expect((await decline(a, b)).status).toBe(400);
  });

  test('the requester cancels with DELETE', async () => {
    const [a, b] = await pair();
    await request(a, b);
    const res = await del(a, b);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'NONE' });
    expect((await list(b)).incoming).toEqual([]);
  });

  test('the recipient cannot cancel with DELETE (they decline instead)', async () => {
    const [a, b] = await pair();
    await request(a, b);
    expect((await del(b, a)).status).toBe(400);
    expect(ids((await list(b)).incoming)).toEqual([a.user.id]);
  });

  test('a declined request can be sent again', async () => {
    const [a, b] = await pair();
    await request(a, b);
    await decline(b, a);
    const again = await request(a, b);
    expect(await again.json()).toMatchObject({ status: 'PENDING' });
    expect(ids((await list(b)).incoming)).toEqual([a.user.id]);
  });

  test('removing someone who is not a friend is a no-op, not an error', async () => {
    const [a, b] = await pair();
    const res = await del(a, b);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'NONE' });
    expect([(await list(a)).accepted, (await list(b)).accepted].flat()).toEqual([]);
  });

  test('accepting or declining a request that does not exist changes nothing', async () => {
    const [a, b] = await pair();
    expect(await (await accept(b, a)).json()).toMatchObject({ status: 'NONE' });
    expect(await (await decline(b, a)).json()).toMatchObject({ status: 'NONE' });
    for (const u of [a, b]) expect((await list(u)).accepted).toEqual([]);
  });
});

describe('validation', () => {
  test('self-request is 400', async () => {
    const a = await signup(anchor.url);
    expect((await request(a, a)).status).toBe(400);
    expect((await list(a)).outgoing).toEqual([]);
  });

  test('an unknown username is 404', async () => {
    const a = await signup(anchor.url);
    const res = await a.fetch('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ username: 'nobody.here', homeserver: 'localhost' }),
    });
    expect(res.status).toBe(404);
  });

  test('a bot target is 404', async () => {
    const [a, bot] = await pair();
    const sql = connect(anchor.databaseUrl);
    try {
      await sql`UPDATE "user" SET "isBot" = true WHERE id = ${bot.user.id}`;
    } finally {
      await sql.close();
    }
    expect((await request(a, bot)).status).toBe(404);
  });

  test('unknown user ids are 404 on accept, decline and delete', async () => {
    const a = await signup(anchor.url);
    for (const [method, path] of [
      ['POST', '/friends/requests/nobody/accept'],
      ['POST', '/friends/requests/nobody/decline'],
      ['DELETE', '/friends/nobody'],
    ] as const) {
      expect((await a.fetch(path, { method })).status).toBe(404);
    }
  });

  test('username and homeserver bounds are enforced', async () => {
    const a = await signup(anchor.url);
    const post = (body: object) => a.fetch('/friends/request', { method: 'POST', body: JSON.stringify(body) });
    expect((await post({ username: 'a', homeserver: 'localhost' })).status).toBe(422);
    expect((await post({ username: 'ab', homeserver: '' })).status).toBe(422);
    expect((await post({ username: 'ab' })).status).toBe(422);
  });

  test('one user cannot see or change a friendship between two others', async () => {
    const [a, b] = await pair();
    const c = await signup(anchor.url);
    await request(a, b);
    expect((await list(c)).incoming).toEqual([]);
    // c has no relationship with a, so these are no-ops, not edits of a<->b
    await accept(c, a);
    await del(c, a);
    expect(ids((await list(b)).incoming)).toEqual([a.user.id]);
  });
});

describe('realtime', () => {
  test('friends.changed is delivered to both users on every change', async () => {
    const [a, b] = await pair();
    const [wa, wb] = await Promise.all([openRealtime(anchor.url, a.cookie), openRealtime(anchor.url, b.cookie)]);
    const count = (ws: typeof wa) => ws.events.filter((e) => e.type === 'friends.changed').length;
    const expectCounts = async (n: number) => {
      await eventually(() => count(wa) === n && count(wb) === n, { message: `friends.changed x${n}` });
    };
    try {
      await request(a, b);
      await expectCounts(1);
      await accept(b, a);
      await expectCounts(2);
      await del(a, b);
      await expectCounts(3);
      // a no-op change does not notify
      await del(a, b);
      await Bun.sleep(300);
      expect(count(wa)).toBe(3);
    } finally {
      wa.close();
      wb.close();
    }
  });
});
