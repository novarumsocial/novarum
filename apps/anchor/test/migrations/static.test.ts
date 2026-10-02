import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { anchorRoot } from '../harness/env';
import { dangerousSql, hasReview } from './lint';
import { drizzleDir, drizzleKit, migrationNames, run } from './helpers';

const read = (name: string, file: string) =>
  readFileSync(path.join(drizzleDir, name, file), 'utf8');

/** the base ref old migrations are compared against; null outside git or without a main ref */
async function baseRef() {
  const inGit = await run(['git', 'rev-parse', '--is-inside-work-tree']);
  if (inGit.code !== 0) return null;
  for (const ref of ['origin/main', 'main']) {
    if ((await run(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0)
      return ref;
  }
  return null;
}
const ref = await baseRef();

async function onBase(file: string) {
  const res = await run(['git', 'cat-file', '-e', `${ref}:./drizzle/${file}`]);
  return res.code === 0 ? (await run(['git', 'show', `${ref}:./drizzle/${file}`])).stdout : null;
}

describe('drift', () => {
  test('schema.ts produces no new migration', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'anchor-drift-'));
    try {
      cpSync(drizzleDir, tmp, { recursive: true });
      const res = await drizzleKit([
        'generate',
        '--dialect',
        'postgresql',
        '--schema',
        path.join(anchorRoot, 'src/db/schema.ts'),
        '--out',
        tmp,
      ]);
      expect(res.output).toContain('No schema changes');
      expect(readdirSync(tmp).sort()).toEqual(migrationNames);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('drizzle-kit check finds the snapshot chain consistent', async () => {
    const res = await drizzleKit(['check', '--dialect', 'postgresql', '--out', drizzleDir]);
    expect(res.code).toBe(0);
    expect(res.output).toContain("Everything's fine");
  });
});

describe('snapshot integrity', () => {
  test('there are migrations and nothing else in drizzle/', () => {
    expect(migrationNames.length).toBeGreaterThan(0);
    expect(readdirSync(drizzleDir).sort()).toEqual(migrationNames);
  });

  test('every folder has migration.sql and snapshot.json, in chronological unique order', () => {
    for (const name of migrationNames) {
      expect(existsSync(path.join(drizzleDir, name, 'migration.sql'))).toBe(true);
      expect(existsSync(path.join(drizzleDir, name, 'snapshot.json'))).toBe(true);
    }
    const stamps = migrationNames.map((n) => n.slice(0, 14));
    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test('snapshots form a single linear chain', () => {
    const snapshot = z.object({ id: z.string(), prevIds: z.array(z.string()).length(1) });
    let previous = '00000000-0000-0000-0000-000000000000';
    for (const name of migrationNames) {
      const snap = snapshot.parse(JSON.parse(read(name, 'snapshot.json')));
      expect(snap.prevIds[0]).toBe(previous);
      previous = snap.id;
    }
  });
});

describe('immutability', () => {
  test.skipIf(!ref)('migrations already on main are unchanged', async () => {
    const listed = await run(['git', 'ls-tree', '-r', '--name-only', ref!, 'drizzle/']);
    const files = listed.stdout
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace('drizzle/', ''));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const current = path.join(drizzleDir, file);
      expect(existsSync(current), `${file} was deleted or renamed`).toBe(true);
      expect(readFileSync(current, 'utf8'), `${file} was edited`).toBe((await onBase(file))!);
    }
  });
});

describe('dangerous SQL lint', () => {
  const reviewed = z
    .record(z.string(), z.string().min(1))
    .parse(JSON.parse(readFileSync(path.join(import.meta.dir, 'reviewed.json'), 'utf8')));

  test('detects each risky pattern', () => {
    const cases: [string, string][] = [
      ['ALTER TABLE "t" DROP COLUMN "c";', 'DROP COLUMN'],
      ['DROP TABLE "t";', 'DROP TABLE'],
      ['ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE bigint;', 'ALTER COLUMN TYPE'],
      ['ALTER TABLE "t" ADD CONSTRAINT "u" UNIQUE("c");', 'ADD CONSTRAINT UNIQUE'],
      ['ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;', 'SET NOT NULL'],
    ];
    for (const [sql, label] of cases) expect(dangerousSql(sql).join()).toContain(label);
  });

  test('ignores safe SQL, comments and backfilled NOT NULL', () => {
    expect(dangerousSql('ALTER TABLE "t" ADD COLUMN "c" text;')).toEqual([]);
    expect(dangerousSql('-- DROP TABLE "t";\nCREATE INDEX "i" ON "t" ("c");')).toEqual([]);
    const backfilled = 'UPDATE "t" SET "c" = 1;\nALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;';
    expect(dangerousSql(backfilled)).toEqual([]);
    expect(hasReview('-- reviewed: tiny table\nDROP TABLE "t";')).toBe(true);
    expect(hasReview('-- reviewed:\nDROP TABLE "t";')).toBe(false);
  });

  test('reviewed.json only lists existing migrations', () => {
    for (const name of Object.keys(reviewed)) expect(migrationNames).toContain(name);
  });

  test('every migration is grandfathered, already on main, or carries a "-- reviewed:" comment', async () => {
    for (const name of migrationNames) {
      const sql = read(name, 'migration.sql');
      const risky = dangerousSql(sql);
      if (!risky.length || name in reviewed || hasReview(sql)) continue;
      if (ref && (await onBase(`${name}/migration.sql`)) !== null) continue;
      expect.unreachable(
        `${name} has risky SQL (${risky.join(', ')}); add "-- reviewed: <reason>"`
      );
    }
  });
});
