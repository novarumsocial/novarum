import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, setDefaultTimeout } from 'bun:test';
import { configDir, resetHarness } from '../harness/federation';
import { ready, ensurePingUser, pingBody, pingPath, restartAnchor, sendFrom, withDb } from '../harness/fedVerify';

setDefaultTimeout(120_000); // hooks restart anchors and wait on canaries; a multi-file run resets bun's timeout

// TESTING_PLAN 5.2 "Nonce table cleanup": with nonce_max_age_seconds = 2, expired nonces are only deleted lazily
// (at most once a minute, from the next verification). anchor-c's config is bind-mounted from test/federation/.run, so
// the test rewrites that file, restarts anchor-c and restores both at the end.
const configFile = path.join(configDir, 'c/config.toml');
const original = readFileSync(configFile, 'utf8');
const nonceRows = (nonce: string) => withDb('c', (sql) => sql`select 1 from federation_nonce where nonce = ${nonce}`);
const ping = (nonce: string) => sendFrom(1, 'c', pingPath, pingBody('172.30.0.66'), { nonce });

beforeAll(async () => {
  await ready();
  await resetHarness();
  expect(original).toContain('nonce_max_age_seconds = 300');
  writeFileSync(configFile, original.replace('nonce_max_age_seconds = 300', 'nonce_max_age_seconds = 2'));
  await restartAnchor('c');
  await ensurePingUser('c', 1);
});
afterAll(async () => {
  writeFileSync(configFile, original);
  await restartAnchor('c');
});

test('expired nonces are deleted lazily by the next request, not on a timer', async () => {
  const [old, next] = [crypto.randomUUID(), crypto.randomUUID()];
  expect((await ping(old)).status).toBe(200);
  expect(await nonceRows(old)).toHaveLength(1);

  await Bun.sleep(63_000); // > 2s max age and > the 60s cleanup interval
  expect(await nonceRows(old)).toHaveLength(1); // nothing happened without a request

  expect((await ping(next)).status).toBe(200);
  expect(await nonceRows(old)).toHaveLength(0);
  expect(await nonceRows(next)).toHaveLength(1);
}, 120_000);
