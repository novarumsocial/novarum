import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { anchorRoot } from '../harness/env';
import { connect, createDatabase, dropDatabase } from '../harness/db';

export const drizzleDir = path.join(anchorRoot, 'drizzle');
export const migrationNames = readdirSync(drizzleDir)
  .filter((f) => /^\d{14}_/.test(f))
  .sort();

/** copies the first `count` migration folders into a temp dir (all when omitted) */
export function copyMigrations(count = migrationNames.length) {
  const dir = mkdtempSync(path.join(tmpdir(), 'anchor-migrations-'));
  for (const name of migrationNames.slice(0, count)) {
    cpSync(path.join(drizzleDir, name), path.join(dir, name), { recursive: true });
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** applies a migrations folder with drizzle's own migrator */
export async function migrateFolder(url: string, folder: string) {
  const sql = connect(url);
  try {
    await migrate(drizzle({ client: sql }), { migrationsFolder: folder });
  } finally {
    await sql.close();
  }
}

/** applies the first `count` migrations of the repo's drizzle/ folder */
export async function applyMigrations(url: string, count: number) {
  const { dir, cleanup } = copyMigrations(count);
  try {
    await migrateFolder(url, dir);
  } finally {
    cleanup();
  }
}

/** runs a query against a database and always closes the connection */
export async function query<T = Record<string, unknown>>(url: string, text: string) {
  const sql = connect(url);
  try {
    return (await sql.unsafe(text)) as T[];
  } finally {
    await sql.close();
  }
}

export async function withDatabase<T>(name: string, fn: (url: string) => Promise<T>) {
  const { database, url } = await createDatabase(name);
  try {
    return await fn(url);
  } finally {
    await dropDatabase(database);
  }
}

export async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {}
) {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd ?? anchorRoot,
    env: { ...process.env, ANCHOR_CONFIG: path.join(anchorRoot, 'test/config.toml'), ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  return { code: await p.exited, stdout, stderr, output: stdout + stderr };
}

export const drizzleKit = (args: string[], env: Record<string, string> = {}) =>
  run(['bunx', '--bun', 'drizzle-kit', ...args], { env });

/** rows of drizzle.__drizzle_migrations (empty when the table does not exist) */
export async function recordedMigrations(url: string) {
  const exists = await query<{ t: string | null }>(
    url,
    `SELECT to_regclass('drizzle.__drizzle_migrations') AS t`
  );
  if (!exists[0]!.t) return [];
  return query<{ id: number; hash: string; created_at: string; name: string | null }>(
    url,
    `SELECT id, hash, created_at, name FROM drizzle.__drizzle_migrations ORDER BY id`
  );
}

/** normalized description of the public schema, for comparing two databases */
export async function dumpSchema(url: string) {
  const [columns, constraints, indexes, enums] = await Promise.all([
    query(
      url,
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
              character_maximum_length, numeric_precision, datetime_precision
         FROM information_schema.columns WHERE table_schema = 'public'
        ORDER BY table_name, column_name`
    ),
    query(
      url,
      `SELECT c.relname AS table_name, con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
        ORDER BY c.relname, con.conname`
    ),
    query(
      url,
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`
    ),
    query(
      url,
      `SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        ORDER BY t.typname, e.enumsortorder`
    ),
  ]);
  return { columns, constraints, indexes, enums };
}

export const countTables = async (url: string) =>
  Object.fromEntries(
    await Promise.all(
      (
        await query<{ table_name: string }>(
          url,
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        )
      ).map(async ({ table_name }) => [
        table_name,
        Number(
          (await query<{ n: string }>(url, `SELECT count(*) AS n FROM "${table_name}"`))[0]!.n
        ),
      ])
    )
  ) as Record<string, number>;
