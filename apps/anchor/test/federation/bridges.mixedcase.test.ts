import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fake, resetHarness, restart, signup, stackIsUp } from '../harness/federation';
import { call, createGuild } from '../harness/chat';
import { closePg, fakeSend, openBridge, pg, userPayload } from '../harness/fedflows';
import { uniqueName } from '../harness/users';
import { randomString } from '../../utils/randomString';

// TESTING_PLAN §5.3 flow 5, "mixed-case member row". The bridge access check compares `member.user.homeserver ===
// origin.homeserver` case-sensitively, and origin.homeserver is always lower-case. IP homeservers (A, B, C) have no letters, so
// the check runs on anchor-p with the fake anchor as a letters-bearing homeserver (evil.test, https, discovered by p over
// the public network): its member rows are inserted straight into p's database, as the plan prescribes for the Caddy
// variant (A cannot reach 203.0.113.x, so b.test cannot be discovered from A at all).
const pHost = '172.30.0.20'; // the host p sees on requests made to its fed address
const evil = 'evil.test';

beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
  await fake.respond(1, '/.well-known/anchor/info', { discovery: { homeserver: evil, baseUrl: `https://${evil}` } });
  await restart('p'); // clean discovery cache
});
afterAll(async () => {
  await fake.reset();
  await closePg();
});

const signer = async (_t: unknown, path: string) => (await fake.sign({ identity: 1, method: 'GET', path, host: pHost, homeserver: evil, body: '' })).headers;

/** inserts a remote user row with exactly this homeserver spelling */
async function remoteRow(homeserver: string) {
  const id = randomString();
  await pg('p')`INSERT INTO "user" (id, username, "homeserverName", "isBot", "createdAt", "updatedAt") VALUES (${id}, ${uniqueName('rm')}, ${homeserver}, false, now(), now())`;
  return id;
}

async function guildWithMember(homeserver: string) {
  const owner = await signup('p');
  const { guild } = await createGuild(owner, 'mixed');
  const userId = await remoteRow(homeserver);
  await pg('p')`INSERT INTO guild_member ("guildId", "userId", role, position) VALUES (${guild.id}, ${userId}, 'MEMBER', 0)`;
  return guild.id;
}

async function dmWithMember(homeserver: string) {
  const channelId = randomString();
  const localId = (await pg('p')`SELECT id FROM "user" WHERE "homeserverName" = 'p.test' LIMIT 1`)[0]!.id as string;
  const userId = await remoteRow(homeserver);
  await pg('p')`INSERT INTO channel (id, "guildId", name, type) VALUES (${channelId}, NULL, ${channelId}, 'DM')`;
  await pg('p')`INSERT INTO channel_member ("channelId", "userId") VALUES (${channelId}, ${userId}), (${channelId}, ${localId})`;
  return channelId;
}

describe('bridge access with a letters-bearing homeserver', () => {
  test('control: a lower-case member row is accepted (guild and DM)', async () => {
    const guild = await guildWithMember(evil);
    const bridge = await openBridge('p', 'guilds', guild, signer);
    await bridge.waitFor('voice.states.snapshot');
    expect(bridge.closed).toBeNull();
    bridge.close();

    const dm = await dmWithMember(evil);
    const dmBridge = await openBridge('p', 'dms', dm, signer);
    await dmBridge.waitFor('voice.states.snapshot');
    dmBridge.close();
  });

  // Known gap: verification.origin.homeserver is lower-cased but member.user.homeserver is compared as stored
  test.failing('a member row stored as "Evil.Test" is accepted for the guild bridge', async () => {
    const guild = await guildWithMember('Evil.Test');
    const bridge = await openBridge('p', 'guilds', guild, signer);
    expect(await Promise.race([bridge.waitFor('voice.states.snapshot', 2000).then(() => 'open'), bridge.waitClosed(2000).then(() => 'closed')])).toBe('open');
    bridge.close();
  });

  test.failing('a member row stored as "Evil.Test" is accepted for the DM bridge', async () => {
    const dm = await dmWithMember('Evil.Test');
    const bridge = await openBridge('p', 'dms', dm, signer);
    expect(await Promise.race([bridge.waitFor('voice.states.snapshot', 2000).then(() => 'open'), bridge.waitClosed(2000).then(() => 'closed')])).toBe('open');
    bridge.close();
  });
});

describe('every federated-user write path lower-cases the homeserver', () => {
  const asEvil = { host: pHost, homeserver: evil };
  const mixed = (username: string) => userPayload({ username, homeserver: 'Evil.Test' });
  const storedSpellings = async (username: string) => (await pg('p')`SELECT "homeserverName" AS hs FROM "user" WHERE username = ${username}`).map((r: any) => r.hs as string);

  test('invite accept, friend sync and dm notify store the user as evil.test', async () => {
    // invite accept
    const owner = await signup('p');
    const { guild } = await createGuild(owner, 'case');
    const code = (await call(owner, 'POST', `/guilds/${guild.id}/invites`, {})).body.invite.code as string;
    const joiner = uniqueName('rj');
    expect((await fakeSend(1, 'p', `/federation/invites/${code}/accept`, { user: mixed(joiner) }, asEvil)).status).toBe(200);
    expect(await storedSpellings(joiner)).toEqual([evil]);

    // friend sync (evil.test sorts before p.test, so it is the authority for the pair)
    const local = await signup('p');
    const syncer = uniqueName('rs');
    const now = new Date().toISOString();
    const sync = await fakeSend(1, 'p', '/federation/friends/sync', {
      commandId: 'c1',
      remoteUser: mixed(syncer),
      localUsername: local.user.username,
      requestedBy: { username: syncer, homeserver: 'Evil.Test' },
      status: 'PENDING',
      version: 1,
      createdAt: now,
      updatedAt: now,
      acceptedAt: null,
    }, asEvil);
    expect(sync.status).toBe(200);
    expect(await storedSpellings(syncer)).toEqual([evil]);

    // dm notify: refused (not friends), but the user row is written first
    const notifier = uniqueName('rn');
    const notify = await fakeSend(1, 'p', '/federation/dms/notify', { channelId: 'ch1', participants: [mixed(notifier), userPayload(local.user)] }, asEvil);
    expect(notify.status).toBe(403);
    expect(await storedSpellings(notifier)).toEqual([evil]);

    // nothing in the table keeps a mixed-case spelling
    const odd = await pg('p')`SELECT "homeserverName" AS hs FROM "user" WHERE "homeserverName" <> lower("homeserverName") AND "homeserverName" <> 'Evil.Test'`;
    expect(odd).toEqual([]);
  });

  test('a user that already exists is matched case-insensitively instead of duplicated', async () => {
    const owner = await signup('p');
    const { guild } = await createGuild(owner, 'case2');
    const code = (await call(owner, 'POST', `/guilds/${guild.id}/invites`, {})).body.invite.code as string;
    const name = uniqueName('rd');
    for (const spelling of ['evil.test', 'EVIL.test', 'Evil.Test']) {
      expect((await fakeSend(1, 'p', `/federation/invites/${code}/accept`, { user: userPayload({ username: name, homeserver: spelling }) }, asEvil)).status).toBe(200);
    }
    expect(await pg('p')`SELECT id FROM "user" WHERE username = ${name}`).toHaveLength(1);
  });
});
