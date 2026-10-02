import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootExpectingExit } from '../harness/anchor';
import { createDatabase, dropDatabase, databaseUrl } from '../harness/db';
import {
  dumpSchema,
  drizzleDir,
  migrationNames,
  applyMigrations,
  recordedMigrations,
} from './helpers';

describe('failure behaviour', () => {
  let db: { database: string; url: string };
  let cwd: string;

  beforeAll(async () => {
    db = await createDatabase('mig_fail');
    // a cwd whose ./drizzle has one extra migration: it creates a table, then fails
    cwd = mkdtempSync(path.join(tmpdir(), 'anchor-broken-'));
    cpSync(drizzleDir, path.join(cwd, 'drizzle'), { recursive: true });
    const broken = path.join(cwd, 'drizzle', '20990101000000_broken');
    mkdirSync(broken);
    writeFileSync(
      path.join(broken, 'migration.sql'),
      'CREATE TABLE "half_applied" ("id" text PRIMARY KEY);--> statement-breakpoint\nSELECT * FROM "table_that_does_not_exist";'
    );
    await applyMigrations(db.url, migrationNames.length);
  });
  afterAll(async () => {
    rmSync(cwd, { recursive: true, force: true });
    await dropDatabase(db.database);
  });

  test('a failing migration exits 1 before listening and leaves the previous version', async () => {
    const before = await dumpSchema(db.url);
    const res = await bootExpectingExit({ db: db.url, env: { CWD: cwd } });
    expect(res.code).toBe(1);
    expect(res.output).toContain('[DB] Error when migrating');
    expect(res.output).toContain('table_that_does_not_exist');
    expect(res.output).not.toContain('Migrations complete');
    expect(res.output).not.toContain('Elysia is running');

    expect(await recordedMigrations(db.url)).toHaveLength(migrationNames.length);
    expect(await dumpSchema(db.url)).toEqual(before);
  });

  test('a failing migration on a fresh database leaves no partial schema', async () => {
    const fresh = await createDatabase('mig_fail_fresh');
    try {
      const res = await bootExpectingExit({ db: fresh.url, env: { CWD: cwd } });
      expect(res.code).toBe(1);
      expect(res.output).toContain('[DB] Error when migrating');
      const schema = await dumpSchema(fresh.url);
      expect(schema.columns).toEqual([]);
      expect(await recordedMigrations(fresh.url)).toHaveLength(0);
    } finally {
      await dropDatabase(fresh.database);
    }
  });

  test('an unreachable database exits non-zero with a clear message', async () => {
    const res = await bootExpectingExit({
      db: 'postgresql://novarum:novarum@127.0.0.1:1/anchor_nope',
    });
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/Error when migrating/);
    expect(res.output).not.toContain('Elysia is running');
  });

  // Gap: the log only says "Failed query: CREATE SCHEMA ...", the connection error cause is not printed.
  test.failing('the unreachable-database message names the connection problem', async () => {
    const res = await bootExpectingExit({
      db: 'postgresql://novarum:novarum@127.0.0.1:1/anchor_nope',
    });
    expect(res.output).toMatch(/ECONNREFUSED|connection refused|Unable to connect/i);
  });

  test('a missing database exits non-zero with a clear message', async () => {
    const res = await bootExpectingExit({ db: databaseUrl('anchor_does_not_exist_xyz') });
    expect(res.code).not.toBe(0);
    expect(res.output).toMatch(/does not exist|Error when migrating/i);
  });
});
