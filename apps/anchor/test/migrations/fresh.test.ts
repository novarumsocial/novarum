import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDatabase, dropDatabase } from '../harness/db';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { dumpSchema, drizzleKit, migrationNames, recordedMigrations } from './helpers';

describe('fresh install', () => {
  let anchor: RunningAnchor;
  let pushed: { database: string; url: string };

  beforeAll(async () => {
    anchor = await spawnAnchor({ name: 'fresh' });
    pushed = await createDatabase('fresh_push');
  });
  afterAll(async () => {
    await anchor?.destroy();
    if (pushed) await dropDatabase(pushed.database);
  });

  test('boot on an empty database records every migration', async () => {
    const rows = await recordedMigrations(anchor.databaseUrl);
    expect(rows).toHaveLength(migrationNames.length);
    expect(rows.map((r) => r.name)).toEqual(migrationNames);
    expect(anchor.logs()).toContain('[DB] Migrations complete!');
  });

  test('migrate and drizzle-kit push produce the same schema', async () => {
    const res = await drizzleKit(['push', '--force'], { DATABASE_URL: pushed.url });
    expect(res.code).toBe(0);
    const [migrated, push] = await Promise.all([
      dumpSchema(anchor.databaseUrl),
      dumpSchema(pushed.url),
    ]);
    expect(migrated.columns.length).toBeGreaterThan(50);
    expect(migrated.columns).toEqual(push.columns);
    expect(migrated.constraints).toEqual(push.constraints);
    expect(migrated.indexes).toEqual(push.indexes);
    expect(migrated.enums).toEqual(push.enums);
  });

  test('a second boot is a no-op', async () => {
    const before = await recordedMigrations(anchor.databaseUrl);
    const schema = await dumpSchema(anchor.databaseUrl);
    await anchor.restart();
    expect(await recordedMigrations(anchor.databaseUrl)).toEqual(before);
    expect(await dumpSchema(anchor.databaseUrl)).toEqual(schema);
    const res = await fetch(`${anchor.url}/`);
    expect(await res.text()).toBe('this is anchor');
  });
});
