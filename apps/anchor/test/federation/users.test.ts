import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { api, anchors, resetHarness, signup, stackIsUp } from '../harness/federation';
import { closePg, pg, requestFriend } from '../harness/fedflows';
import { uniqueName } from '../harness/users';

// TESTING_PLAN §5.3 flow 1: user lookup
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const lookup = (server: 'a' | 'b' | 'c', name: string) => fetch(`${api(server)}/federation/users/${name}`);

describe('GET /federation/users/:username', () => {
  test('serves the local profile without internal ids', async () => {
    const alice = await signup('b', { displayName: 'Alice B' });
    const res = await lookup('b', alice.user.username);
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as any;
    expect(user).toMatchObject({
      username: alice.user.username,
      homeserver: anchors.b.homeserver,
      displayName: 'Alice B',
      handle: `@${alice.user.username}:${anchors.b.homeserver}`,
      isBot: false,
    });
    expect(user).not.toHaveProperty('userId');
  });

  test('unknown user is 404', async () => {
    const res = await lookup('b', uniqueName('nobody'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'User not found' });
  });

  test('is served without a signature (public profile)', async () => {
    const u = await signup('c');
    expect((await lookup('c', u.user.username)).status).toBe(200);
  });

  test('a remote shadow user is not served as local', async () => {
    const onB = await signup('b');
    const onA = await signup('a');
    // A learns about the B user through a friend request, which stores a shadow row for them
    expect((await requestFriend(onA, onB)).status).toBe(200);
    const [shadow] = await pg('a')`SELECT "homeserverName" AS hs FROM "user" WHERE username = ${onB.user.username}`;
    expect(shadow!.hs).toBe(anchors.b.homeserver);
    // ... but A does not serve it, while B (the owner) does
    expect((await lookup('a', onB.user.username)).status).toBe(404);
    expect((await lookup('b', onB.user.username)).status).toBe(200);
  });

  test('the same username on two homeservers resolves independently', async () => {
    const username = uniqueName('twin');
    const a = await signup('a', { username, displayName: 'on A' });
    const b = await signup('b', { username, displayName: 'on B' });
    expect(((await (await lookup('a', username)).json()) as any).user).toMatchObject({ displayName: 'on A', homeserver: anchors.a.homeserver });
    expect(((await (await lookup('b', username)).json()) as any).user).toMatchObject({ displayName: 'on B', homeserver: anchors.b.homeserver });
    // a friend request across servers resolves the remote user on the right homeserver
    expect((await requestFriend(a, b)).status).toBe(200);
  });

  test('friend request to an unknown remote user is 404, to an unreachable homeserver 502', async () => {
    const a = await signup('a');
    const missing = await a.fetch('/friends/request', { method: 'POST', body: JSON.stringify({ username: uniqueName('ghost'), homeserver: anchors.b.homeserver }) });
    expect(missing.status).toBe(404);
    const unreachable = await a.fetch('/friends/request', { method: 'POST', body: JSON.stringify({ username: 'someone', homeserver: 'does-not-exist.test' }) });
    expect(unreachable.status).toBe(502);
  });
});
