import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mockDb, restoreDb } from '../harness/mockDb';
import { generateKeyPairB64, signFederationRequestWith, verifies } from '../harness/signer';

// fixed key: seed 0x01..0x20 wrapped in a pkcs8 ed25519 header
const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const privateKeyB64 = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  seed,
]).toString('base64');
const publicKeyB64 = 'MCowBQYDK2VwAyEAebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=';

const original = process.env.ANCHOR_CONFIG;
let signMessage: typeof import('../../utils/keys').signMessage;
let verifyMessage: typeof import('../../utils/keys').verifyMessage;
let signFederationRequest: typeof import('../../utils/discovery').signFederationRequest;

beforeAll(async () => {
  // keys.ts reads the private key from federation.key_dir and the row from the db: stub both
  const dir = mkdtempSync(path.join(tmpdir(), 'anchor-keys-'));
  writeFileSync(path.join(dir, 'k.b64'), privateKeyB64);
  const toml = readFileSync(original ?? 'test/config.toml', 'utf8').replace(
    /key_dir = .*/,
    `key_dir = ${JSON.stringify(dir)}`
  );
  writeFileSync(path.join(dir, 'config.toml'), toml);
  process.env.ANCHOR_CONFIG = path.join(dir, 'config.toml');

  mockDb({
    query: {
      homeserverKeys: {
        findFirst: async () => ({
          publicKey: publicKeyB64,
          privateKeyFilename: 'k.b64',
          id: 'key-1',
        }),
      },
    },
  });
  ({ signMessage, verifyMessage } = await import('../../utils/keys'));
  ({ signFederationRequest } = await import('../../utils/discovery'));
});

afterAll(() => {
  restoreDb();
  if (original) process.env.ANCHOR_CONFIG = original;
});

describe('signMessage / verifyMessage', () => {
  test('sign then verify', async () => {
    const sig = await signMessage('hello');
    expect(verifyMessage('hello', sig, publicKeyB64)).toBe(true);
  });

  test('ed25519 is deterministic', async () => {
    expect(await signMessage('hello')).toBe(await signMessage('hello'));
  });

  test('unicode messages', async () => {
    const sig = await signMessage('héllo 日本 😀');
    expect(verifyMessage('héllo 日本 😀', sig, publicKeyB64)).toBe(true);
  });

  test('tampered message fails', async () => {
    const sig = await signMessage('hello');
    expect(verifyMessage('hellp', sig, publicKeyB64)).toBe(false);
    expect(verifyMessage('', sig, publicKeyB64)).toBe(false);
  });

  test('tampered or truncated signature returns false', async () => {
    const sig = Buffer.from(await signMessage('hello'), 'base64');
    const flipped = Buffer.from(sig);
    flipped[0]! ^= 1;
    expect(verifyMessage('hello', flipped.toString('base64'), publicKeyB64)).toBe(false);
    expect(verifyMessage('hello', sig.subarray(0, 32).toString('base64'), publicKeyB64)).toBe(
      false
    );
    expect(verifyMessage('hello', '', publicKeyB64)).toBe(false);
  });

  test('a different valid ed25519 key fails', async () => {
    const sig = await signMessage('hello');
    expect(verifyMessage('hello', sig, generateKeyPairB64().publicKeyB64)).toBe(false);
  });

  // pinned: garbage / wrong-algorithm public keys THROW (callers must catch), they don't return false
  test('malformed public key throws', async () => {
    const sig = await signMessage('hello');
    expect(() => verifyMessage('hello', sig, 'not-a-key')).toThrow();
    expect(() => verifyMessage('hello', sig, '')).toThrow();
  });

  test('wrong key type: x25519 and rsa public keys never verify', async () => {
    const sig = await signMessage('hello');
    const der = (k: crypto.KeyObject) =>
      k.export({ format: 'der', type: 'spki' }).toString('base64');
    for (const key of [
      der(crypto.generateKeyPairSync('x25519').publicKey),
      der(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey),
    ]) {
      let result: boolean | 'threw';
      try {
        result = verifyMessage('hello', sig, key);
      } catch {
        result = 'threw';
      }
      expect(result === false || result === 'threw').toBe(true);
    }
  });
});

describe('federation signing string (protocol golden)', () => {
  const input = {
    privateKeyB64,
    keyId: 'key-1',
    method: 'post',
    path: '/federation/invites/abc/accept?x=1',
    host: 'b.test',
    homeserver: 'a.test',
    body: '{"hello":"wörld"}',
    date: '2026-01-02T03:04:05.678Z',
    nonce: 'nonce123',
  };
  // written out by hand, independent of the implementation: any protocol change breaks this
  const expectedString =
    'v1\nPOST\n/federation/invites/abc/accept?x=1\nb.test\na.test\n2026-01-02T03:04:05.678Z\nnonce123\n' +
    crypto.createHash('sha256').update('{"hello":"wörld"}', 'utf8').digest('base64');
  const expectedSignature =
    'AouXDT66EItfAWPWsKC+PysHPnE0kdj62hepd3ZEAoBPa5FHooT5sgE1Z+jNeUec4DmQn8f/HRBtHwLjDaaODA==';

  test('signing string, body hash and signature are pinned', () => {
    const { signingString, headers } = signFederationRequestWith(input);
    expect(signingString).toBe(expectedString);
    expect(headers['X-Novarum-Body-SHA256']).toBe('Ff6TbVpcSlZMjckAIoAAkmPAzAvQ8o4WZSUpqfg7LSM=');
    expect(headers['X-Novarum-Signature']).toBe(expectedSignature);
    expect(headers['X-Novarum-Homeserver']).toBe('a.test');
    expect(headers['X-Novarum-Key-Id']).toBe('key-1');
    expect(headers['X-Novarum-Date']).toBe(input.date);
    expect(headers['X-Novarum-Nonce']).toBe('nonce123');
    expect(verifies(expectedString, expectedSignature, publicKeyB64)).toBe(true);
  });

  test('every field is covered by the signature', () => {
    const base = signFederationRequestWith(input).headers['X-Novarum-Signature'];
    const variants = [
      { method: 'GET' },
      { path: '/federation/invites/abc/accept?x=2' },
      { host: 'c.test' },
      { homeserver: 'z.test' },
      { body: '{}' },
      { date: '2026-01-02T03:04:05.679Z' },
      { nonce: 'nonce124' },
    ];
    for (const v of variants) {
      const { signingString, headers } = signFederationRequestWith({ ...input, ...v });
      expect(headers['X-Novarum-Signature']).not.toBe(base);
      expect(verifies(signingString, base, publicKeyB64)).toBe(false);
    }
  });

  test('method is upper-cased', () => {
    expect(signFederationRequestWith({ ...input, method: 'post' }).signingString).toBe(
      signFederationRequestWith({ ...input, method: 'POST' }).signingString
    );
  });

  test('the real signFederationRequest produces what the standalone signer produces', async () => {
    const real = await signFederationRequest({
      method: 'post',
      path: input.path,
      host: input.host,
      homeserver: input.homeserver,
      body: input.body,
    });
    const mine = signFederationRequestWith({
      ...input,
      date: real.headers['X-Novarum-Date'],
      nonce: real.headers['X-Novarum-Nonce'],
    });
    expect(real.signingString).toBe(mine.signingString);
    expect(real.headers).toEqual(mine.headers);
    expect(real.headers['X-Novarum-Key-Id']).toBe('key-1');
    expect(Number.isNaN(Date.parse(real.headers['X-Novarum-Date']))).toBe(false);
  });
});
