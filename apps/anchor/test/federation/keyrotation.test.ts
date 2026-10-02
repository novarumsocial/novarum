import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { anchors, api, exec, logs, resetHarness, restart, signup, stackIsUp } from '../harness/federation';
import { closePg, friendList, listHas, pg, requestFriend, signerFor, userPayload } from '../harness/fedflows';
import { eventually } from '../harness/wait';

// TESTING_PLAN §5.3 flow 7: key rotation on A, observed by B. The test leaves A with a fresh key (every peer re-discovers on
// demand). The container layout: workdir /app/apps/anchor, ANCHOR_CONFIG=/app/config.toml, keys in ./keys -> /app/keys.
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const info = async () => (await (await fetch(`${api('a')}/.well-known/anchor/info`)).json()) as { publicKey: { id: string; key: string } };
const status = (signer: Awaited<ReturnType<typeof signerFor>>, user: { username: string; homeserver: string }, keyOverride?: object) =>
  // /friends/status is verified like every signed route; an unknown user is a 404 AFTER the signature was accepted
  signer.send('b', 'POST', '/federation/friends/status', { user: userPayload(user), status: 'ONLINE' }, keyOverride);

test('rotate-keys on A: new key published, B refreshes on an unknown id, the old key then stops working', async () => {
  const [a1, a2, b1] = [await signup('a'), await signup('a'), await signup('b')];
  const before = await info();
  const oldSigner = await signerFor('a');
  expect(oldSigner.keyId).toBe(before.publicKey.id);

  // B has A's discovery document cached (it verifies a request from A right now)
  expect((await status(oldSigner, a1.user)).status).toBe(404); // signature accepted, user unknown on B

  const rotate = await exec('a', 'bun run src/index.ts cli rotate-keys');
  expect({ code: rotate.code, err: rotate.stderr.slice(0, 300) }).toEqual({ code: 0, err: expect.any(String) });

  // A publishes the new key; the database has exactly one active key
  const after = await info();
  expect(after.publicKey.id).not.toBe(before.publicKey.id);
  expect(after.publicKey.key).not.toBe(before.publicKey.key);
  const active = await pg('a')`SELECT id FROM homeserver_keys WHERE active`;
  expect(active.map((r: any) => r.id)).toEqual([after.publicKey.id]);

  // pinned: until B refreshes (its discovery cache lasts 5 minutes), the OLD key is still accepted by B
  expect((await status(oldSigner, a1.user)).status).toBe(404);

  // the next real A -> B request carries the new key id; B sees an unknown id, re-discovers and accepts
  expect((await requestFriend(a2, b1)).status).toBe(200);
  await eventually(async () => listHas((await friendList(b1)).incoming, a2), { message: 'B accepted the request signed with the new key' });
  expect(oldSigner.keyId).not.toBe((await signerFor('a')).keyId);

  // once B has refreshed, a signature with the old key id is refused
  const stale = await status(oldSigner, a1.user);
  expect(stale).toMatchObject({ status: 401, json: { error: 'Unknown federation key' } });
  // a request signed with the new key works for sure
  expect((await status(await signerFor('a'), a1.user)).status).toBe(404);
});

test('deleting the active key file and restarting A logs a warning and publishes a replacement', async () => {
  const before = await info();
  const [row] = await pg('a')`SELECT "privateKeyFilename" AS file FROM homeserver_keys WHERE active`;
  const warned = async () => (await logs('a')).split('Active homeserver key file is missing').length - 1;
  const warnedBefore = await warned();

  expect((await exec('a', `rm keys/${row!.file}`)).code).toBe(0);
  await restart('a');
  // the key is loaded lazily, on first use
  const after = await info();
  expect(after.publicKey.id).not.toBe(before.publicKey.id);
  expect(await warned()).toBe(warnedBefore + 1);
  expect((await exec('a', `ls keys`)).stdout).toContain(((await pg('a')`SELECT "privateKeyFilename" AS file FROM homeserver_keys WHERE active`)[0] as any).file);

  // federation with the replacement key works end to end
  const [a, b] = [await signup('a'), await signup('b')];
  expect((await requestFriend(a, b)).status).toBe(200);
  await eventually(async () => listHas((await friendList(b)).incoming, a), { message: 'B accepts the replacement key' });
});

describe('the container layout the plan assumes', () => {
  test('the cli runs from the workdir and the keys directory is the volume-less /app/keys', async () => {
    expect((await exec('a', 'pwd')).stdout.trim()).toBe('/app/apps/anchor');
    expect((await exec('a', 'readlink keys')).stdout.trim()).toBe('/app/keys');
    expect(anchors.a.homeserver).toBe('172.30.0.11');
  });
});
