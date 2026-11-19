import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call, send } from '../harness/chat';
import {
  closePg,
  fedChannelId,
  idOf,
  makeFriends,
  pg,
  signerFor,
  userPayload,
} from '../harness/fedflows';
import { eventually } from '../harness/wait';
import type { TestUser } from '../harness/users';

// Group DMs across homeservers: the creator's homeserver (A) hosts the group and pushes its state
// to B and C, which keep shadow copies for their users.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const hostA = anchors.a.homeserver;
const groupsFrom = async (u: TestUser) =>
  ((await call(u, 'GET', `/dm/homeserver/${hostA}`)).body.dms ?? []) as any[];
const groupOf = async (u: TestUser, id: string) => (await groupsFrom(u)).find((d) => d.id === id);
// GET /dm leaves out DMs hosted elsewhere, so they are read from the host's list
const members = async (u: TestUser, groupId: string) =>
  (await groupOf(u, groupId))?.participants.map((p: any) => `${p.username}@${p.homeserver}`).sort();
const handle = (u: TestUser) => `${u.user.username}@${u.user.homeserver}`;

async function group() {
  const [a, b, c] = [await signup('a'), await signup('b'), await signup('c')];
  await makeFriends(a, b);
  await makeFriends(a, c);
  const res = await call(a, 'POST', '/dm/group', {
    userIds: [await idOf(a, b), await idOf(a, c)],
    name: 'Across',
  });
  expect(res.status).toBe(200);
  const shadowId = fedChannelId(hostA, res.body.id);
  await eventually(async () => (await groupOf(b, shadowId)) && (await groupOf(c, shadowId)), {
    message: 'shadow groups on b and c',
  });
  return { a, b, c, hostId: res.body.id as string, shadowId };
}

describe('group DMs across homeservers', () => {
  test('members on other homeservers see the group, with every member, and can chat in it', async () => {
    const { a, b, c, hostId, shadowId } = await group();
    expect(await groupOf(b, shadowId)).toMatchObject({ type: 'GROUP_DM', name: 'Across' });
    expect(await members(b, shadowId)).toEqual([handle(a), handle(c)].sort());

    expect((await send(b, shadowId, 'hello from b')).status).toBe(200);
    await eventually(
      async () =>
        (
          await call(a, 'GET', `/message/list?channelId=${hostId}&cursor=0&amount=50`)
        ).body.messages.some((m: any) => m.content === 'hello from b'),
      { message: 'b message on the host' }
    );
  });

  test('a remote member adds their own friend, and a rename reaches every homeserver', async () => {
    const { a, b, c, hostId, shadowId } = await group();
    const d = await signup('b');
    await makeFriends(b, d);
    const added = await call(b, 'POST', `/dm/${encodeURIComponent(shadowId)}/members`, {
      userIds: [await idOf(b, d)],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    await eventually(async () => !!(await groupOf(d, shadowId)), { message: 'd sees the group' });
    expect(await members(c, shadowId)).toContain(handle(d));

    // only the owner may rename, also when asked through another homeserver
    expect(
      (await call(b, 'PATCH', `/dm/${encodeURIComponent(shadowId)}`, { name: 'x' })).status
    ).toBe(403);
    expect((await call(a, 'PATCH', `/dm/${hostId}`, { name: 'New' })).status).toBe(200);
    await eventually(async () => (await groupOf(c, shadowId))?.name === 'New', {
      message: 'rename on c',
    });
  });

  test('a kicked remote member loses the group and can no longer write to it', async () => {
    const { a, b, c, hostId, shadowId } = await group();
    const bId = (await call(a, 'GET', '/dm')).body.dms
      .find((d: any) => d.id === hostId)
      .participants.find((p: any) => p.username === b.user.username).userId;
    expect((await call(a, 'DELETE', `/dm/${hostId}/members/${bId}`)).status).toBe(200);
    await eventually(async () => !(await groupOf(b, shadowId)), { message: 'shadow gone on b' });
    expect((await send(b, shadowId, 'still here?')).status).not.toBe(200);
    expect(await members(c, shadowId)).toEqual([handle(a)]);
  });

  test('a homeserver cannot push a group that puts our users in it without a friend adding them', async () => {
    const a = await signup('a');
    const b = await signup('b');
    const signer = await signerFor('b');
    const res = await signer.send('a', 'POST', '/federation/dms/sync', {
      channelId: 'forced',
      name: 'spam',
      iconUrl: null,
      owner: userPayload(b.user),
      participants: [userPayload(b.user), userPayload(a.user)],
      added: [{ user: { username: a.user.username, homeserver: hostA }, by: userPayload(b.user) }],
    });
    expect(res.status).toBe(403);
    const [row] = await pg(
      'a'
    )`SELECT 1 FROM channel WHERE id = ${fedChannelId(anchors.b.homeserver, 'forced')}`;
    expect(row).toBeUndefined();
  });

  test('a homeserver cannot say that one of our users added someone to a group they are not in', async () => {
    const [a, a2] = [await signup('a'), await signup('a')];
    await makeFriends(a, a2);
    const b = await signup('b');
    const signer = await signerFor('b');
    const ref = (u: TestUser) => ({ username: u.user.username, homeserver: hostA });
    const res = await signer.send('a', 'POST', '/federation/dms/sync', {
      channelId: 'forged-adder',
      name: 'spam',
      iconUrl: null,
      owner: userPayload(b.user),
      participants: [userPayload(b.user), userPayload(a.user), userPayload(a2.user)],
      added: [
        { user: ref(a), by: userPayload(a2.user) },
        { user: ref(a2), by: userPayload(a.user) },
      ],
    });
    expect(res.status).toBe(403);
    const [row] = await pg(
      'a'
    )`SELECT 1 FROM channel WHERE id = ${fedChannelId(anchors.b.homeserver, 'forged-adder')}`;
    expect(row).toBeUndefined();
  });

  test('a remote user who is not in the group cannot make the host look up the people they add', async () => {
    const b = await signup('b');
    const stranger = await signup('c');
    const signer = await signerFor('b');
    const res = await signer.send('a', 'POST', '/federation/dms/nope/members', {
      user: userPayload(b.user),
      users: [{ username: stranger.user.username, homeserver: anchors.c.homeserver }],
    });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Channel not found');
    const [row] = await pg('a')`SELECT 1 FROM "user" WHERE username = ${stranger.user.username}`;
    expect(row).toBeUndefined();
  });
});
