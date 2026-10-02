import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase, dropDatabase } from '../harness/db';
import { spawnAnchor } from '../harness/anchor';
import {
  drizzleKit,
  migrateFolder,
  migrationNames,
  query,
  recordedMigrations,
  run,
} from './helpers';

let db: { database: string; url: string };
beforeEach(async () => {
  db = await createDatabase('fixpush');
});
afterEach(() => dropDatabase(db.database));

const fixPush = () => run(['bun', 'run', 'src/db/fix-push.ts'], { env: { DATABASE_URL: db.url } });

/** a database created by `db:push`, with an empty drizzle.__drizzle_migrations table (what a bare migrator run creates) */
async function pushedDatabase() {
  const empty = mkdtempSync(path.join(tmpdir(), 'anchor-empty-'));
  try {
    await migrateFolder(db.url, empty);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  expect((await drizzleKit(['push', '--force'], { DATABASE_URL: db.url })).code).toBe(0);
  expect(await recordedMigrations(db.url)).toHaveLength(0);
}

describe('db:push recovery (fix-push.ts)', () => {
  test('records every migration, then boot re-applies nothing', async () => {
    await pushedDatabase();
    const res = await fixPush();
    expect(res.code).toBe(0);
    const rows = await recordedMigrations(db.url);
    expect(rows).toHaveLength(migrationNames.length);
    expect(rows.map((r) => r.name)).toEqual(migrationNames);

    const anchor = await spawnAnchor({ name: 'fixpush', db: db.url });
    try {
      expect(anchor.logs()).toContain('[DB] Migrations complete!');
      expect(anchor.logs()).not.toContain('Error when migrating');
      expect(await recordedMigrations(db.url)).toEqual(rows);
    } finally {
      await anchor.destroy();
    }
  });

  test('a partially recorded table gets the missing hashes exactly once', async () => {
    await pushedDatabase();
    await fixPush();
    const full = await recordedMigrations(db.url);
    const k = 6;
    await query(db.url, `DELETE FROM drizzle.__drizzle_migrations WHERE id > ${full[k - 1]!.id}`);
    expect(await recordedMigrations(db.url)).toHaveLength(k);

    await fixPush();
    const after = await recordedMigrations(db.url);
    expect(after).toHaveLength(migrationNames.length);
    expect(new Set(after.map((r) => r.hash)).size).toBe(migrationNames.length);
    expect(after.slice(0, k)).toEqual(full.slice(0, k));
  });

  test('running it twice inserts nothing the second time', async () => {
    await pushedDatabase();
    await fixPush();
    const once = await recordedMigrations(db.url);
    const second = await fixPush();
    expect(second.output).not.toContain('Adding migration');
    expect(await recordedMigrations(db.url)).toEqual(once);
  });

  // Gap: on a database made purely by `db:push` there is no drizzle schema, so fix-push's SELECT throws and
  // `main().finally(() => process.exit(0))` swallows it: exit 0, nothing recorded, no message.
  test.failing('recovers a push-only database that has no migrations table yet', async () => {
    expect((await drizzleKit(['push', '--force'], { DATABASE_URL: db.url })).code).toBe(0);
    const res = await fixPush();
    expect(res.code).toBe(0);
    expect(await recordedMigrations(db.url)).toHaveLength(migrationNames.length);
  });
});
