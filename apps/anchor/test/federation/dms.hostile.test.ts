import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fake, resetHarness, restart, signup, stackIsUp } from '../harness/federation';
import { call } from '../harness/chat';
import { closePg, fakeSend, pg, userPayload } from '../harness/fedflows';
import { uniqueName } from '../harness/users';

// A hostile DM host (the fake anchor as evil.test, which sorts before p.test and so hosts the pair's DMs) trying to open
// endless DMs, and with them endless bridges, for one local user on anchor-p.
const evil = 'evil.test';
const asEvil = { homeserver: evil };

beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
  await fake.respond(1, '/.well-known/anchor/info', {
    discovery: { homeserver: evil, baseUrl: `https://${evil}` },
  });
  await restart('p');
});
// the shadow DM would keep a bridge to evil.test reconnecting (and re-discovering) for every later suite
afterAll(async () => {
  await pg('p')`DELETE FROM channel WHERE id LIKE ${`fed:channel:${evil}:%`}`;
  await restart('p');
  await fake.reset();
  await closePg();
});

/** a p user and a friend on evil.test, with the friendship seeded so evil.test can notify DMs */
async function friendOnEvil() {
  const local = await signup('p');
  const friend = userPayload({ username: uniqueName('dm'), homeserver: evil });
  const notify = (channelId: string) =>
    fakeSend(
      1,
      'p',
      '/federation/dms/notify',
      { channelId, participants: [friend, userPayload(local.user)] },
      asEvil
    );
  // not friends yet: refused, but the remote user is stored, so the friendship can be seeded
  expect((await notify('first')).status).toBe(403);
  const [remote] = await pg('p')`SELECT id FROM "user" WHERE username = ${friend.username}`;
  const [one, two] = [local.user.id, remote.id as string].sort();
  await pg('p')`
    INSERT INTO friend_relationship ("userOneId", "userTwoId", "requestedById", status, "acceptedAt")
    VALUES (${one}, ${two}, ${local.user.id}, 'ACCEPTED', now())`;
  return { local, remoteId: remote.id as string, notify };
}

test('a host gets one DM per pair of friends, and a bounded channel id', async () => {
  const { local, notify } = await friendOnEvil();
  expect((await notify('first')).status).toBe(200);
  expect((await notify('first')).status).toBe(200);
  expect((await notify('second')).status).toBe(409);
  expect((await notify('x'.repeat(65))).status).toBe(400);

  const dms = await pg('p')`
    SELECT c.id FROM channel c JOIN channel_member m ON m."channelId" = c.id
    WHERE m."userId" = ${local.user.id} AND c."guildId" IS NULL`;
  expect(dms.map((row: any) => row.id)).toEqual([`fed:channel:${evil}:first`]);
});

describe('/dms/latest from a host that predates previews', () => {
  const dmsOnP = async (user: Awaited<ReturnType<typeof signup>>) =>
    (await call(user, 'GET', `/dm/homeserver/${evil}`)).body.dms as any[];
  const latest = (channelId: string, extra: object) =>
    fake.respond(1, 'POST /federation/dms/latest', {
      json: {
        channels: [
          { channelId, id: 'm1', createdAt: '2026-01-01T00:00:00.000Z', own: false, ...extra },
        ],
      },
    });

  test('without content/attachmentCount the DM still lists, with lastMessageAt but no preview', async () => {
    const { local, notify } = await friendOnEvil();
    expect((await notify('old')).status).toBe(200);
    await latest('old', {});
    const [dm] = await dmsOnP(local);
    expect(dm).toMatchObject({
      id: `fed:channel:${evil}:old`,
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      lastMessage: null,
      unread: true,
    });
  });

  test('a newer host gets its preview re-cut locally and the author mapped to our copy of them', async () => {
    const { local, remoteId, notify } = await friendOnEvil();
    expect((await notify('new')).status).toBe(200);
    await latest('new', { content: `hi\n${'y'.repeat(500)}`, attachmentCount: 3 });
    const [dm] = await dmsOnP(local);
    expect(dm.lastMessage).toEqual({
      id: 'm1',
      authorId: remoteId,
      content: `hi ${'y'.repeat(136)}…`,
      attachmentCount: 3,
      system: null,
      // an older host doesn't name the author
      author: null,
    });
  });
});
