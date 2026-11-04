import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fake, resetHarness, restart, signup, stackIsUp } from '../harness/federation';
import { closePg, fakeSend, pg, userPayload } from '../harness/fedflows';
import { uniqueName } from '../harness/users';

// A hostile DM host (the fake anchor as evil.test, which sorts before p.test and so hosts the pair's DMs) trying to open
// endless DMs, and with them endless bridges, for one local user on anchor-p.
const pHost = '172.30.0.20';
const evil = 'evil.test';
const asEvil = { host: pHost, homeserver: evil };

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

test('a host gets one DM per pair of friends, and a bounded channel id', async () => {
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

  expect((await notify('first')).status).toBe(200);
  expect((await notify('first')).status).toBe(200);
  expect((await notify('second')).status).toBe(409);
  expect((await notify('x'.repeat(65))).status).toBe(400);

  const dms = await pg('p')`
    SELECT c.id FROM channel c JOIN channel_member m ON m."channelId" = c.id
    WHERE m."userId" = ${local.user.id} AND c."guildId" IS NULL`;
  expect(dms.map((row: any) => row.id)).toEqual([`fed:channel:${evil}:first`]);
});
