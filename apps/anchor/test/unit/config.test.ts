import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TOML } from 'bun';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringifyToml } from '../harness/config';
import { getConfig } from '../../utils/config';

type Table = Record<string, any>;
const original = process.env.ANCHOR_CONFIG;
const dir = mkdtempSync(path.join(tmpdir(), 'anchor-config-'));
const base = () =>
  TOML.parse(readFileSync(original ?? 'test/config.toml', 'utf8').toString()) as Record<
    string,
    Table
  >;
let n = 0;

// writes a config derived from test/config.toml, applies `edit`, points ANCHOR_CONFIG at it and loads it
function load(edit: (c: Record<string, Table>) => void = () => {}) {
  const c = base();
  edit(c);
  const file = path.join(dir, `c${n++}.toml`);
  writeFileSync(file, stringifyToml(c));
  process.env.ANCHOR_CONFIG = file;
  return getConfig();
}

afterAll(() => {
  if (original) process.env.ANCHOR_CONFIG = original;
});

describe('getConfig', () => {
  test('the committed test config is valid', () => {
    expect(load().server.homeserver).toBe('localhost');
  });

  test('ANCHOR_CONFIG selects the file, and it is re-read on every call', () => {
    load((c) => (c.server!.homeserver = 'one.test'));
    expect(getConfig().server.homeserver).toBe('one.test');
    load((c) => (c.server!.homeserver = 'two.test'));
    expect(getConfig().server.homeserver).toBe('two.test');
  });

  test('a missing file throws', () => {
    process.env.ANCHOR_CONFIG = path.join(dir, 'nope.toml');
    expect(() => getConfig()).toThrow();
  });

  test('defaults', () => {
    const c = load((c) => {
      delete c.server!.listen_port;
      delete c.federation!.nonce_max_age_seconds;
      delete c.federation!.key_dir;
      delete c.files!.max_file_size;
      delete c.files!.max_avatar_size;
      delete c.misc!.skip_emoji_download;
      delete c.files!.s3_disable_cors;
    });
    expect(c.server.listen_port).toBe(5049);
    expect(c.federation.nonce_max_age_seconds).toBe(300);
    expect(c.federation.key_dir).toBe('./keys');
    expect(c.files.max_file_size).toBe(10);
    expect(c.files.max_avatar_size).toBe(2);
    expect(c.misc.skip_emoji_download).toBe(false);
    expect(c.files.s3_disable_cors).toBe(false);
    expect(c.network).toEqual({});
    expect(c.dms.max_group_members).toBe(30);
  });

  test('the group DM size can be changed, but a group needs room for three', () => {
    expect(load((c) => (c.dms = { max_group_members: 50 })).dms.max_group_members).toBe(50);
    expect(() => load((c) => (c.dms = { max_group_members: 2 }))).toThrow();
  });

  test('CORS: default is "*", and base_url is appended', () => {
    const c = load((c) => delete c.files!.s3_cors_origins);
    expect(c.files.s3_cors_origins).toEqual(['*', c.server.base_url]);
  });

  test('CORS: "*" anywhere collapses the rest', () => {
    const c = load((c) => (c.files!.s3_cors_origins = ['https://a.test', '*']));
    expect(c.files.s3_cors_origins).toEqual(['*', c.server.base_url]);
  });

  test('CORS: explicit origins gain the app origins and base_url, de-duplication aside', () => {
    const c = load((c) => (c.files!.s3_cors_origins = ['https://a.test']));
    expect(c.files.s3_cors_origins).toEqual([
      'https://a.test',
      'app://novarum',
      'https://localhost',
      'http://localhost:5173',
      c.server.base_url,
    ]);
  });

  test('auth: password signups on, no invites, no providers by default', () => {
    const c = load((c) => delete c.auth);
    expect(c.auth.password_signup).toBe(true);
    expect(c.auth.invite_only).toBe(false);
    expect(c.auth.providers).toEqual({});
    expect(c.auth.client_origins).toContain('https://app.novarum.me');
  });

  const oidc = {
    name: 'Pocket ID',
    issuer: 'https://id.example.test',
    client_id: 'a',
    client_secret: 'b',
  };
  const oauth2 = {
    name: 'GitHub',
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token',
    userinfo_endpoint: 'https://api.github.com/user',
    client_id: 'a',
    client_secret: 'b',
  };

  test('auth: OpenID Connect and plain OAuth 2 providers, with their defaults', () => {
    const { providers } = load(
      (c) => (c.auth = { providers: { pocketid: oidc, github: oauth2 } })
    ).auth;
    expect(providers.pocketid).toMatchObject({ scopes: ['openid', 'profile', 'email'] });
    expect(providers.pocketid).toMatchObject({ trust_email: false });
    expect(providers.github).toMatchObject({
      trust_email: false,
      subject_field: 'id',
      username_field: 'login',
      scopes: [],
    });
  });

  test('auth: providers need https (except on localhost), credentials and a safe id', () => {
    const withProvider = (id: string, provider: object) => () =>
      load((c) => (c.auth = { providers: { [id]: provider } }));
    expect(withProvider('local', { ...oidc, issuer: 'http://localhost:9000' })).not.toThrow();
    expect(withProvider('plain', { ...oidc, issuer: 'http://id.example.test' })).toThrow();
    expect(withProvider('half', { ...oauth2, token_endpoint: undefined })).toThrow();
    expect(withProvider('nosecret', { ...oidc, client_secret: '' })).toThrow();
    expect(withProvider('Bad Id', oidc)).toThrow();
  });

  test('CORS: an explicit empty list or a non-url is rejected', () => {
    expect(() => load((c) => (c.files!.s3_cors_origins = []))).toThrow();
    expect(() => load((c) => (c.files!.s3_cors_origins = ['not a url']))).toThrow();
  });

  test.each(['mysql://x', 'postgres://x', 'x', '', 'http://x'])('rejects database_url %p', (v) => {
    expect(() => load((c) => (c.server!.database_url = v))).toThrow();
  });

  test.each([
    'localhost:5049',
    'ftp://a.test',
    'https://a.test/path',
    'https://a b.test',
    '',
    'https://a.test/',
  ])('rejects base_url %p', (v) => expect(() => load((c) => (c.server!.base_url = v))).toThrow());

  test.each(['http://localhost:5049', 'https://a.test', 'http://10.0.0.5', 'https://a.test:8443'])(
    'accepts base_url %p',
    (v) => expect(load((c) => (c.server!.base_url = v)).server.base_url).toBe(v)
  );

  test.each(['http://127.0.0.1:7880', 'https://lk.test', '', 'lk.test'])(
    'rejects livekit_url %p',
    (v) => {
      expect(() => load((c) => (c.voice!.livekit_url = v))).toThrow();
    }
  );

  test.each(['ws://127.0.0.1:7880', 'wss://lk.test'])('accepts livekit_url %p', (v) => {
    expect(load((c) => (c.voice!.livekit_url = v)).voice.livekit_url).toBe(v);
  });

  test('empty livekit key/secret and s3 keys are rejected', () => {
    expect(() => load((c) => (c.voice!.livekit_key = ''))).toThrow();
    expect(() => load((c) => (c.voice!.livekit_secret = ''))).toThrow();
    expect(() => load((c) => (c.files!.s3_secret_key = ''))).toThrow();
  });

  test('required sections and fields are enforced', () => {
    expect(() => load((c) => delete c.server)).toThrow();
    expect(() => load((c) => delete c.misc!.otp_pepper)).toThrow();
    expect(() => load((c) => delete c.server!.homeserver)).toThrow();
  });

  test('non-positive limits are rejected', () => {
    expect(() => load((c) => (c.server!.listen_port = 0))).toThrow();
    expect(() => load((c) => (c.federation!.nonce_max_age_seconds = 0))).toThrow();
    expect(() => load((c) => (c.files!.max_file_size = -1))).toThrow();
  });
});
