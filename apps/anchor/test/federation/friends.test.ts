import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fake, resetHarness, signup, stackIsUp } from '../harness/federation';
import { connect } from '../harness/realtime';
import {
  closePg,
  fakeSend,
  fakeUser,
  friendList,
  idOf,
  listHas,
  makeFriends,
  relationOn,
  requestFriend,
  signerFor,
  pg,
  userPayload,
} from '../harness/fedflows';
import { call } from '../harness/chat';
import { eventually } from '../harness/wait';
import { uniqueName } from '../harness/users';
import { anchors } from '../harness/federation';

// TESTING_PLAN §5.3 flow 2: friends. Authority for a pair is the lexicographically smaller homeserver:
// A (172.30.0.11) for A<->B and A<->C, B (172.30.0.12) for B<->C.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

/** both homeservers agree on the row (same status, version, requester) and nothing is pending a sync */
const agreed = async (s1: 'a' | 'b' | 'c', s2: 'a' | 'b' | 'c', x: string, y: string) => {
  const [r1, r2] = await Promise.all([relationOn(s1, x, y), relationOn(s2, x, y)]);
  if (!r1 || !r2) return null;
  const same = r1.status === r2.status && r1.version === r2.version && r1.requestedBy === r2.requestedBy;
  return same ? r1 : null;
};

describe('request / accept across servers', () => {
  test('authority side requests, non-authority accepts: both ACCEPTED with matching versions', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    expect((await requestFriend(a, b)).status).toBe(200);
    // B sees an incoming request and A an outgoing one
    await eventually(async () => listHas((await friendList(b)).incoming, a), { message: 'b sees incoming' });
    expect(listHas((await friendList(a)).outgoing, b)).toBe(true);
    expect(await agreed('a', 'b', a.user.username, b.user.username)).toMatchObject({ status: 'PENDING', version: 1, requestedBy: a.user.username });

    // B is not the authority, so its accept goes through POST A /federation/friends/command, then A syncs back
    const accept = await call(b, 'POST', `/friends/requests/${await idOf(b, a)}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ status: 'ACCEPTED', version: 2 });
    await eventually(async () => listHas((await friendList(a)).accepted, b), { message: 'a sees accepted' });
    expect(listHas((await friendList(b)).accepted, a)).toBe(true);
    expect(await agreed('a', 'b', a.user.username, b.user.username)).toMatchObject({ status: 'ACCEPTED', version: 2, syncPending: false });
  });

  test('non-authority side requests: command on A, sync back to B, then A accepts', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    const req = await requestFriend(b, a);
    expect(req.status).toBe(200);
    expect(req.body).toMatchObject({ status: 'PENDING', version: 1 });
    // A (authority) now has the PENDING row requested by b, and B got the snapshot back
    const onA = await eventually(() => relationOn('a', a.user.username, b.user.username), { message: 'row on a' });
    expect(onA).toMatchObject({ status: 'PENDING', requestedBy: b.user.username, version: 1 });
    expect(await relationOn('b', a.user.username, b.user.username)).toMatchObject({ status: 'PENDING', requestedBy: b.user.username, version: 1, syncPending: false });
    await eventually(async () => listHas((await friendList(a)).incoming, b), { message: 'a incoming' });

    // authority accepts locally and syncs the new snapshot to B
    expect((await call(a, 'POST', `/friends/requests/${await idOf(a, b)}/accept`)).status).toBe(200);
    expect(await eventually(() => agreed('a', 'b', a.user.username, b.user.username).then((r) => r?.status === 'ACCEPTED' && r), { message: 'accepted on both' })).toMatchObject({ version: 2 });
    expect(listHas((await friendList(b)).accepted, a)).toBe(true);
  });

  test('requesting the user who already requested you accepts (REQUEST on a pending request)', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    await requestFriend(a, b);
    await eventually(() => relationOn('b', a.user.username, b.user.username), { message: 'row on b' });
    expect((await requestFriend(b, a)).body).toMatchObject({ status: 'ACCEPTED' });
    await eventually(() => agreed('a', 'b', a.user.username, b.user.username).then((r) => r?.status === 'ACCEPTED' && r), { message: 'accepted on both' });
  });

  test('works for the pair B<->C where B is the authority', async () => {
    const [b, c] = [await signup('b'), await signup('c')];
    expect((await requestFriend(c, b)).status).toBe(200); // C is the non-authority here
    await eventually(async () => listHas((await friendList(b)).incoming, c), { message: 'b incoming' });
    expect((await call(b, 'POST', `/friends/requests/${await idOf(b, c)}/accept`)).status).toBe(200);
    await eventually(() => agreed('b', 'c', b.user.username, c.user.username).then((r) => r?.status === 'ACCEPTED' && r), { message: 'accepted on both' });
  });

  test('decline, cancel and remove propagate from either side', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    const settled = (status: string) => eventually(() => agreed('a', 'b', a.user.username, b.user.username).then((r) => r?.status === status && r), { message: `both ${status}` });

    await requestFriend(a, b);
    await eventually(async () => listHas((await friendList(b)).incoming, a), { message: 'b incoming' });
    expect((await call(b, 'POST', `/friends/requests/${await idOf(b, a)}/decline`)).body).toMatchObject({ status: 'NONE' });
    await settled('NONE');

    await requestFriend(b, a); // non-authority requests again, then cancels
    await eventually(async () => listHas((await friendList(a)).incoming, b), { message: 'a incoming' });
    expect((await call(b, 'DELETE', `/friends/${await idOf(b, a)}`)).body).toMatchObject({ status: 'NONE' });
    await settled('NONE');
    expect((await friendList(a)).incoming).toHaveLength(0);

    await makeFriends(a, b);
    // the non-authority removes the friend (REMOVE through the authority)
    expect((await call(b, 'DELETE', `/friends/${await idOf(b, a)}`)).status).toBe(200);
    await settled('NONE');
    expect((await friendList(a)).accepted).toHaveLength(0);
    expect((await friendList(b)).accepted).toHaveLength(0);
  });

  test('a friend request notifies the recipient over realtime', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    const rt = await connect(b);
    await requestFriend(a, b);
    await rt.waitFor('friends.changed');
    rt.close();
  });
});

describe('versions, command ids and authority rules', () => {
  test('stale expectedVersion: 409 with a snapshot, and the client retry succeeds', async () => {
    const [a, b] = [await signup('a'), await signup('b')];
    await requestFriend(a, b);
    await eventually(async () => listHas((await friendList(b)).incoming, a), { message: 'b incoming' });
    // make B's copy stale: its local version is behind A's
    await pg('b')`UPDATE friend_relationship SET version = 0 WHERE status = 'PENDING' AND "userOneId" IN (SELECT id FROM "user" WHERE username = ${a.user.username})
      OR "userTwoId" IN (SELECT id FROM "user" WHERE username = ${a.user.username})`;
    const acceptPath = `/friends/requests/${await idOf(b, a)}/accept`;
    const stale = await call(b, 'POST', acceptPath);
    expect(stale.status).toBe(409);
    // the 409 carried A's snapshot, which B applied: B is back at version 1
    expect(await relationOn('b', a.user.username, b.user.username)).toMatchObject({ status: 'PENDING', version: 1 });
    const retry = await call(b, 'POST', acceptPath);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: 'ACCEPTED', version: 2 });
    await eventually(() => agreed('a', 'b', a.user.username, b.user.username).then((r) => r?.status === 'ACCEPTED' && r), { message: 'accepted on both' });
  });

  describe('/federation/friends/command as a remote homeserver (fake anchor)', () => {
    const command = (actor: string, peer: string, action: string, expectedVersion: number, commandId = crypto.randomUUID()) =>
      fakeSend(1, 'a', '/federation/friends/command', { commandId, actor: fakeUser(actor), peerUsername: peer, action, expectedVersion });

    beforeAll(async () => {
      await fake.respond(1, 'POST /federation/friends/sync', { json: { version: 1 } });
    });

    test('stale expectedVersion gives 409 + snapshot; retrying with the snapshot version works', async () => {
      const local = await signup('a');
      const actor = uniqueName('fk');
      const first = await command(actor, local.user.username, 'REQUEST', 0);
      expect(first.status).toBe(200);
      expect(first.json.snapshot).toMatchObject({ status: 'PENDING', version: 1, localUsername: actor });

      const stale = await command(actor, local.user.username, 'CANCEL', 0);
      expect(stale.status).toBe(409);
      expect(stale.json.snapshot).toMatchObject({ status: 'PENDING', version: 1 });

      const retry = await command(actor, local.user.username, 'CANCEL', stale.json.snapshot.version);
      expect(retry.status).toBe(200);
      expect(retry.json.snapshot).toMatchObject({ status: 'NONE', version: 2 });
    });

    test('re-sending the same commandId is idempotent (version unchanged, no second event)', async () => {
      const local = await signup('a');
      const rt = await connect(local);
      const actor = uniqueName('fk');
      const commandId = crypto.randomUUID();
      const first = await command(actor, local.user.username, 'REQUEST', 0, commandId);
      const second = await command(actor, local.user.username, 'REQUEST', 0, commandId);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.json.snapshot.version).toBe(first.json.snapshot.version);
      await rt.waitFor('friends.changed');
      await Bun.sleep(400);
      expect(rt.events.filter((e) => e.type === 'friends.changed')).toHaveLength(1);
      // a different commandId with the same expectedVersion is a real conflict
      expect((await command(actor, local.user.username, 'REQUEST', 0)).status).toBe(409);
      rt.close();
    });

    test('actions that make no sense are 400 and do not change the version', async () => {
      const local = await signup('a');
      const actor = uniqueName('fk');
      await command(actor, local.user.username, 'REQUEST', 0);
      // the requester cannot accept their own request
      const res = await command(actor, local.user.username, 'ACCEPT', 1);
      expect(res.status).toBe(400);
      expect(await relationOn('a', local.user.username, actor)).toMatchObject({ version: 1, status: 'PENDING' });
    });

    test('actor from another homeserver than the sender is 403; unknown peer is 404; bad body is 400', async () => {
      const local = await signup('a');
      const mismatch = await fakeSend(1, 'a', '/federation/friends/command', {
        commandId: 'x',
        actor: userPayload({ username: uniqueName('fk'), homeserver: anchors.b.homeserver }),
        peerUsername: local.user.username,
        action: 'REQUEST',
        expectedVersion: 0,
      });
      expect(mismatch.status).toBe(403);
      expect((await command(uniqueName('fk'), uniqueName('nobody'), 'REQUEST', 0)).status).toBe(404);
      expect((await fakeSend(1, 'a', '/federation/friends/command', { nope: true })).status).toBe(400);
    });
  });

  describe('as real anchors (signed with their own keys)', () => {
    test('a command sent to the non-authority is refused (400)', async () => {
      // A is the authority for A<->B, so B must not accept commands for such a pair
      const [a, b] = [await signup('a'), await signup('b')];
      const fromA = await signerFor('a');
      const res = await fromA.send('b', 'POST', '/federation/friends/command', {
        commandId: 'c1',
        actor: userPayload(a.user),
        peerUsername: b.user.username,
        action: 'REQUEST',
        expectedVersion: 0,
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/not authoritative/);
    });

    test('/friends/sync from the non-authority is 403', async () => {
      const [a, b] = [await signup('a'), await signup('b')];
      const fromB = await signerFor('b');
      const now = new Date().toISOString();
      const res = await fromB.send('a', 'POST', '/federation/friends/sync', {
        commandId: 'c2',
        remoteUser: userPayload(b.user),
        localUsername: a.user.username,
        requestedBy: { username: b.user.username, homeserver: b.user.homeserver },
        status: 'PENDING',
        version: 1,
        createdAt: now,
        updatedAt: now,
        acceptedAt: null,
      });
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/authority/);
      expect(await relationOn('a', a.user.username, b.user.username)).toBeUndefined();
      // the same from fake (never the authority for any of A, B or C)
      const now2 = new Date().toISOString();
      const viaFake = await fakeSend(1, 'a', '/federation/friends/sync', {
        commandId: 'c3',
        remoteUser: fakeUser(uniqueName('fk')),
        localUsername: a.user.username,
        requestedBy: { username: a.user.username, homeserver: a.user.homeserver },
        status: 'PENDING',
        version: 1,
        createdAt: now2,
        updatedAt: now2,
        acceptedAt: null,
      });
      expect(viaFake.status).toBe(403);
    });

    test('a snapshot about an unknown local user is 404, a malformed one 400', async () => {
      const b = await signup('b');
      const fromA = await signerFor('a');
      const now = new Date().toISOString();
      const remote = userPayload({ username: uniqueName('ra'), homeserver: anchors.a.homeserver });
      const snapshot = {
        commandId: 'c4',
        remoteUser: remote,
        localUsername: uniqueName('ghost'),
        requestedBy: { username: remote.username, homeserver: remote.homeserver },
        status: 'PENDING',
        version: 1,
        createdAt: now,
        updatedAt: now,
        acceptedAt: null,
      };
      const res = await fromA.send('b', 'POST', '/federation/friends/sync', snapshot);
      expect(res.status).toBe(404);
      expect((await fromA.send('b', 'POST', '/federation/friends/sync', { ...snapshot, version: 0, localUsername: b.user.username })).status).toBe(400);
    });

    test('a remote cannot accept a request for a local user it never asked for', async () => {
      // an ACCEPTED snapshot for a pair with no prior request from the local side must not create a friendship
      const b = await signup('b');
      const fromA = await signerFor('a');
      const now = new Date().toISOString();
      const remote = userPayload({ username: uniqueName('ra'), homeserver: anchors.a.homeserver });
      const res = await fromA.send('b', 'POST', '/federation/friends/sync', {
        commandId: 'c5',
        remoteUser: remote,
        localUsername: b.user.username,
        requestedBy: { username: b.user.username, homeserver: b.user.homeserver },
        status: 'ACCEPTED',
        version: 2,
        createdAt: now,
        updatedAt: now,
        acceptedAt: now,
      });
      expect(res.status).toBe(403);
      expect((await friendList(b)).accepted).toHaveLength(0);
    });
  });
});

describe('friend chains across three servers', () => {
  test('A<->B, B<->C and A<->C are consistent on every side', async () => {
    const [a, b, c] = [await signup('a'), await signup('b'), await signup('c')];
    await makeFriends(a, b); // authority A
    await makeFriends(b, c); // authority B
    await makeFriends(a, c); // authority A
    for (const [x, y] of [[a, b], [b, c], [a, c]] as const) {
      expect(listHas((await friendList(x)).accepted, y)).toBe(true);
      expect(listHas((await friendList(y)).accepted, x)).toBe(true);
    }
    expect((await friendList(a)).accepted).toHaveLength(2);
    expect((await friendList(b)).accepted).toHaveLength(2);
    expect((await friendList(c)).accepted).toHaveLength(2);
    expect(await agreed('b', 'c', b.user.username, c.user.username)).toMatchObject({ status: 'ACCEPTED' });
    expect(await agreed('a', 'c', a.user.username, c.user.username)).toMatchObject({ status: 'ACCEPTED' });
  });

  test('removing one edge leaves the others', async () => {
    const [a, b, c] = [await signup('a'), await signup('b'), await signup('c')];
    await makeFriends(a, b);
    await makeFriends(b, c);
    expect((await call(c, 'DELETE', `/friends/${await idOf(c, b)}`)).status).toBe(200); // C removes B, authority is B
    await eventually(async () => !listHas((await friendList(b)).accepted, c), { message: 'b dropped c' });
    expect(listHas((await friendList(b)).accepted, a)).toBe(true);
    expect(listHas((await friendList(a)).accepted, b)).toBe(true);
  });
});
