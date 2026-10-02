import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { anchorRoot } from '../harness/env';

const repoRoot = path.resolve(anchorRoot, '../..');
const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repoRoot });
const allowed = ['apps/anchor/test/config.toml', 'apps/anchor/test/compose.yml', 'apps/anchor/test/livekit.yaml', 'dev/compose.yml', 'dev/livekit.yaml', 'apps/anchor/test/federation/compose.yml'];
// a quoted/assigned value of 8+ chars next to a secret-looking key name
const secretLike = /(secret|access_key|api_key|livekit_key|pepper|password|pass|token)[\w"']*\s*[=:]\s*['"]?[A-Za-z0-9+/_-]{8,}/i;

// only config-style files are scanned (source files assign test fixtures all over the place; gitleaks covers those in CI)
// tracked or not-yet-committed (but not ignored) files, so a new file is checked before its first commit
const files = git('ls-files', '-co', '--exclude-standard', '--', 'apps/anchor', 'dev').stdout.toString().split('\n').filter((f) => f && !f.endsWith('bun.lock'));

describe('secrets', () => {
  test('config.toml (real config) is gitignored, test/config.toml is not', () => {
    expect(git('check-ignore', '-q', 'apps/anchor/config.toml').exitCode).toBe(0);
    expect(git('check-ignore', '-q', 'apps/anchor/test/config.toml').exitCode).toBe(1);
    expect(files.filter((f) => f.endsWith('config.toml'))).toEqual(['apps/anchor/test/config.toml']);
  });

  test('key directories are gitignored and no key material is committed', () => {
    expect(git('check-ignore', '-q', 'apps/anchor/keys/x').exitCode).toBe(0);
    expect(git('check-ignore', '-q', 'apps/anchor/test/.keys/x').exitCode).toBe(0);
    expect(files.filter((f) => /\.(pem|key)$/.test(f) || /(^|\/)keys\//.test(f))).toEqual([]);
  });

  test('test/config.toml only has placeholder values', async () => {
    const cfg = Bun.TOML.parse(await Bun.file(path.join(repoRoot, allowed[0]!)).text()) as Record<string, Record<string, unknown>>;
    const sensitive = [cfg.voice!.livekit_secret, cfg.files!.s3_secret_key, cfg.files!.s3_access_key, cfg.misc!.otp_pepper, cfg.email!.smtp_pass].map(String);
    for (const v of sensitive) expect(v).toMatch(/test|dev|not-real/i);
    expect(JSON.stringify(cfg)).not.toMatch(/AKIA|-----BEGIN|sk_live|ghp_/);
    expect(cfg.server!.database_url).toMatch(/@(127\.0\.0\.1|localhost)[:/]/);
  });

  const scan = async () => {
    const hits: string[] = [];
    for (const f of files) {
      if (!/\.(toml|ya?ml|env|conf)$/.test(f) || f.endsWith('.gitleaks.toml')) continue;
      const text = await Bun.file(path.join(repoRoot, f)).text();
      if (secretLike.test(text) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) hits.push(f);
    }
    return hits;
  };

  test('only allow-listed files contain secret-looking assignments', async () => {
    expect((await scan()).filter((f) => !allowed.includes(f))).toEqual([]);
  });

  test('.gitleaks.toml allow-lists every file with placeholder keys', async () => {
    const toml = await Bun.file(path.join(anchorRoot, '.gitleaks.toml')).text();
    const patterns = [...toml.matchAll(/'''(.+?)'''/g)].map((m) => new RegExp(m[1]!));
    expect((await scan()).filter((f) => !patterns.some((r) => r.test(f)))).toEqual([]);
  });
});
