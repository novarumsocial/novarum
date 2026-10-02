import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnAnchor } from '../harness/anchor';
import { adminDatabaseUrl } from '../harness/env';
import { createDatabase, dropDatabase } from '../harness/db';
import {
  applyMigrations,
  copyMigrations,
  countTables,
  dumpSchema,
  migrateFolder,
  migrationNames,
  query,
  recordedMigrations,
} from './helpers';

const container = process.env.ANCHOR_TEST_PG_CONTAINER ?? 'anchor-test-postgres-1';

async function docker(args: string[], stdin?: string) {
  const p = Bun.spawn(['docker', 'exec', '-i', container, ...args], {
    stdin: stdin ? new TextEncoder().encode(stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

const available = await docker(['pg_dump', '--version']).then(
  (r) => r.code === 0,
  () => false
);
if (!available)
  console.warn(`[migrations] docker exec ${container} unavailable: skipping rollback test`);

describe('rollback policy: restore from backup', () => {
  test.skipIf(!available)(
    'pg_dump before upgrade, upgrade, restore, the previous version boots',
    async () => {
      const last = migrationNames.at(-1)!;
      const previous = migrationNames.length - 1;
      const { database, url } = await createDatabase('mig_rollback');
      try {
        await applyMigrations(url, previous);
        await query(url, readFileSync(path.join(import.meta.dir, 'seeds', `${last}.sql`), 'utf8'));
        const rowsBefore = await countTables(url);
        const schemaBefore = await dumpSchema(url);

        // 1. backup
        const dump = await docker(['pg_dump', '-U', 'novarum', '-d', database]);
        expect(dump.code).toBe(0);

        // 2. upgrade by booting the current version
        const anchor = await spawnAnchor({ name: 'rollback', db: url });
        await anchor.stop();
        expect(await recordedMigrations(url)).toHaveLength(migrationNames.length);

        // 3. restore into a clean database
        await dropDatabase(database);
        await query(adminDatabaseUrl, `CREATE DATABASE "${database}"`);
        const restore = await docker(
          ['psql', '-U', 'novarum', '-d', database, '-v', 'ON_ERROR_STOP=1', '-q'],
          dump.stdout
        );
        expect(restore.code, restore.stderr).toBe(0);

        // 4. data and schema are exactly as before the upgrade
        expect(await recordedMigrations(url)).toHaveLength(previous);
        expect(await countTables(url)).toEqual(rowsBefore);
        expect(await dumpSchema(url)).toEqual(schemaBefore);

        // 5. the previous version's migrator (its drizzle/ folder) has nothing to do and does not fail
        const prev = copyMigrations(previous);
        try {
          await migrateFolder(url, prev.dir);
        } finally {
          prev.cleanup();
        }
        expect(await recordedMigrations(url)).toHaveLength(previous);

        // 6. and the current version can upgrade the restored database again
        const again = await spawnAnchor({ name: 'rollback2', db: url });
        await again.destroy();
        expect(await recordedMigrations(url)).toHaveLength(migrationNames.length);
      } finally {
        await dropDatabase(database);
      }
    },
    60_000
  );
});
