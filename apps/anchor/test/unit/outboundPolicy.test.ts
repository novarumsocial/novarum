import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// TESTING_PLAN §7 "outbound fetch policy": a grep-level check over utils/, modules/ and src/.
// Every fetch( / new WebSocket( must either be allow-listed (it only talks to our own storage or
// is the emoji CDN fetch) or: be preceded, in its function, by assertSafeFederationUrl, and (for
// fetch) pass redirect: 'error'. The behavioural side lives in the federation tests.
const root = path.resolve(import.meta.dir, '../..');

type Site = { file: string; line: number; kind: 'fetch' | 'WebSocket'; text: string };

const allowList = [
  {
    file: 'utils/emojiWriter.ts',
    includes: 'cdn.jsdelivr.net',
    reason: 'emoji dataset CDN, fixed URL',
  },
  {
    file: 'utils/services/storage.ts',
    includes: 'client.fetch(',
    reason: 'signed request to our own S3 (CORS setup)',
  },
  {
    file: 'modules/upload/services.ts',
    includes: 'fetch(url)',
    reason: 'GET of a presigned URL to our own S3',
  },
  {
    file: 'src/cli/index.ts',
    includes: 'fetch(',
    reason: 'operator CLI fetching avatars stored on our own storage',
  },
];

// today's code violates the policy here (TESTING_PLAN §0). each is a test.failing that goes red
// once the gap is fixed: then delete the entry and the code is held to the policy like the rest.
const knownOffenders = [
  {
    file: 'utils/federationPayload.ts',
    kind: 'fetch',
    gap: 'fetchFederatedUser reuses the cached baseUrl without assertSafeFederationUrl (§5.4 E)',
  },
  {
    file: 'utils/federationRealtime.ts',
    kind: 'WebSocket',
    gap: 'bridge reuses the cached baseUrl without assertSafeFederationUrl (§5.4 E/F)',
  },
] as const;

function findSites(file: string, source: string): Site[] {
  return source.split('\n').flatMap((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return [];
    const kind = /\bnew WebSocket\(/.test(text)
      ? 'WebSocket'
      : /\bfetch\(/.test(text)
        ? 'fetch'
        : null;
    return kind ? [{ file, line: i + 1, kind, text: text.trim() }] : [];
  });
}

/** returns the policy violations for the call at `site` (empty when it conforms) */
function violations(site: Site, source: string) {
  const lines = source.split('\n');
  let start = site.line - 1;
  while (
    start > 0 &&
    !/^(export )?(async )?function\b|^(export )?const \w+ = (async )?\(/.test(lines[start]!)
  )
    start--;
  const before = lines.slice(start, site.line).join('\n');
  const call = lines.slice(site.line - 1, site.line + 12).join('\n');

  const found: string[] = [];
  if (!before.includes('assertSafeFederationUrl('))
    found.push('no assertSafeFederationUrl before the call');
  if (site.kind === 'fetch' && !/redirect:\s*'error'/.test(call))
    found.push("no redirect: 'error'");
  return found;
}

const allowed = (site: Site) =>
  allowList.some((a) => a.file === site.file && site.text.includes(a.includes));
const offender = (site: Site) =>
  knownOffenders.find((o) => o.file === site.file && o.kind === site.kind);

const sources = new Map<string, string>();
for (const dir of ['utils', 'modules', 'src']) {
  for (const file of new Glob(`${dir}/**/*.{ts,tsx}`).scanSync({ cwd: root })) {
    if (file.includes('node_modules')) continue;
    sources.set(file, readFileSync(path.join(root, file), 'utf8'));
  }
}
const sites = [...sources].flatMap(([file, source]) => findSites(file, source));
const policed = sites.filter((s) => !allowed(s));

describe('outbound fetch policy', () => {
  test('the scan finds the known call sites', () => {
    const files = new Set(sites.map((s) => `${s.file}:${s.kind}`));
    for (const f of [
      'utils/discovery.ts:fetch',
      'utils/federationPayload.ts:fetch',
      'utils/federationRealtime.ts:WebSocket',
      'utils/emojiWriter.ts:fetch',
    ])
      expect(files).toContain(f);
  });

  test('allow-list entries are not stale', () => {
    for (const a of allowList)
      expect(sites.some((s) => allowed(s) && s.file === a.file)).toBe(true);
  });

  test('known offenders are not stale (still a call site in that file)', () => {
    for (const o of knownOffenders)
      expect(policed.some((s) => s.file === o.file && s.kind === o.kind)).toBe(true);
  });

  test('the checker itself: catches a missing guard and a missing redirect, accepts a good call', () => {
    const good =
      "async function f(u: URL) {\n  await assertSafeFederationUrl(u);\n  await fetch(u, {\n    redirect: 'error',\n  });\n}";
    const noGuard =
      "async function f(u: URL) {\n  await fetch(u, {\n    redirect: 'error',\n  });\n}";
    const noRedirect =
      'async function f(u: URL) {\n  await assertSafeFederationUrl(u);\n  await fetch(u, {});\n}';
    const wsGuarded =
      'async function f(u: URL) {\n  await assertSafeFederationUrl(u);\n  new WebSocket(u);\n}';
    const check = (src: string) => violations(findSites('x.ts', src)[0]!, src);
    expect(check(good)).toEqual([]);
    expect(check(noGuard)).toEqual(['no assertSafeFederationUrl before the call']);
    expect(check(noRedirect)).toEqual(["no redirect: 'error'"]);
    expect(check(wsGuarded)).toEqual([]);
  });

  for (const site of policed) {
    const name = `${site.file}:${site.line} ${site.kind}`;
    const check = () => expect(violations(site, sources.get(site.file)!)).toEqual([]);
    const known = offender(site);
    if (known) test.failing(`known gap, ${name}: ${known.gap}`, check);
    else test(name, check);
  }
});
