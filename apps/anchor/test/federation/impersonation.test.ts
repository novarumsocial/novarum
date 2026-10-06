import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { anchorRoot } from '../harness/env';
import { fake, resetHarness } from '../harness/federation';
import { fakeUser, ready, restartAnchor, sendSigned, signed } from '../harness/fedVerify';

setDefaultTimeout(120_000); // hooks restart anchors and wait on canaries; a multi-file run resets bun's timeout

// TESTING_PLAN 5.2 impersonation matrix: `fake` signs a valid request whose user payload names another homeserver (anchor-b).
// The route list is read from the route files in modules/federation/routes, so a new POST route is covered automatically.
const routesDir = path.join(anchorRoot, 'modules/federation/routes');
const source = readdirSync(routesDir)
  .map((file) => readFileSync(path.join(routesDir, file), 'utf8'))
  .join('\n');
const postRoutes = [...source.matchAll(/\.post\(\s*'([^']+)'/g)].map((m) => m[1]!);

type Family = 'user' | 'friends' | 'participants';
// friends/command and /sync -> 403; everything else with a `user` payload (guild, channel, message, invite, DM, voice, status) -> 401
const familyOf = (route: string): Family => (route.startsWith('/friends/') && /\/(command|sync)$/.test(route) ? 'friends' : route === '/dms/notify' ? 'participants' : 'user');
const expectedStatus = { user: 401, friends: 403, participants: 401 } as const;

const concrete = (route: string) => `/federation${route.replace(/:[a-zA-Z]+/g, 'x')}`;

/** body of a request in which the payload claims `victim` while `local` is the receiving homeserver */
function bodyFor(family: Family, victim: string, local: string) {
  const user = fakeUser(victim);
  if (family === 'user') return { user };
  if (family === 'participants') return { channelId: 'x', participants: [fakeUser(local), user] };
  return { commandId: 'c1', actor: user, peerUsername: 'someone', action: 'REQUEST', expectedVersion: 0 };
}
const syncBody = (victim: string) => ({
  commandId: null,
  remoteUser: fakeUser(victim),
  localUsername: 'someone',
  requestedBy: { username: 'someone', homeserver: victim },
  status: 'PENDING',
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  acceptedAt: null,
});

test('the route table was parsed (guards the matrix against a silent regex miss)', () => {
  expect(postRoutes.length).toBeGreaterThanOrEqual(19);
  expect(postRoutes).toContain('/friends/command');
  expect(postRoutes).toContain('/dms/notify');
});

describe('on anchor-a (private IP homeservers)', () => {
  beforeAll(async () => {
    await ready();
    await restartAnchor('a');
    await resetHarness();
  });
  afterAll(resetHarness);

  const claim = (route: string, victim: string) => {
    const family = familyOf(route);
    return route.endsWith('/friends/sync') ? syncBody(victim) : bodyFor(family, victim, '172.30.0.11');
  };

  for (const route of postRoutes) {
    test(`POST ${route} claiming a user of anchor-b -> ${expectedStatus[familyOf(route)]}`, async () => {
      const s = await signed(1, 'a', concrete(route), claim(route, '172.30.0.12'));
      const res = await sendSigned(s);
      expect(res.status).toBe(expectedStatus[familyOf(route)]);
      if (familyOf(route) !== 'friends') expect(res.json?.error).toBe('Federation user homeserver mismatch');
    });
  }

  test('control: the same payload naming the signer itself gets past the homeserver check', async () => {
    const res = await sendSigned(await signed(1, 'a', '/federation/unread-mentions', { user: fakeUser('172.30.0.66'), channels: [] }));
    expect(res.status).toBe(403); // verified, user unknown: not the 401 mismatch
  });
});

// mixed case needs real names, which only the public anchor can resolve: evil.test (fake) is discovered over https from p
describe('on anchor-p (mixed-case host names)', () => {
  const infoPath = '/.well-known/anchor/info';
  const signer = 'evil.test';
  const send = async (route: string, body: unknown) => sendSigned(await signed(1, 'p', concrete(route), body, { host: 'p.test', homeserver: signer }), undefined, { host: 'p.test' });

  beforeAll(async () => {
    await ready();
    await restartAnchor('p');
    await resetHarness();
    await fake.respond(1, infoPath, { discovery: { homeserver: signer, baseUrl: 'https://evil.test' } });
  });
  afterAll(async () => {
    await resetHarness();
    await restartAnchor('p');
  });

  for (const route of postRoutes) {
    test(`POST ${route} claiming "B.TEST"/"Anchor-B.Test" while signed as evil.test -> ${expectedStatus[familyOf(route)]}`, async () => {
      const family = familyOf(route);
      const body = route.endsWith('/friends/sync') ? syncBody('B.TEST') : bodyFor(family, 'B.TEST', 'P.Test');
      const res = await send(route, body);
      expect(res.status).toBe(expectedStatus[family]);
    });
  }

  test('control: user.homeserver differing from the signer only in case is accepted (normalised)', async () => {
    expect((await send('/unread-mentions', { user: fakeUser('EVIL.Test'), channels: [] })).status).toBe(403); // not the 401 mismatch
  });

  test('a mixed-case spelling of the signer cannot be used to claim a different user: friends/command with actor "Evil.TEST" is not rejected as foreign', async () => {
    // passes the actor check (403); p is not authoritative for evil.test so it stops at 400
    const res = await send('/friends/command', bodyFor('friends', 'Evil.TEST', 'p.test'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });
});
