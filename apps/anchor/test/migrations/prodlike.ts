/**
 * Production-like upgrade check (plan 6.4): seeds a large database at the previous schema version, boots anchor against
 * it so the newest migration runs on real volumes, and reports the duration and the longest ACCESS EXCLUSIVE lock held.
 *
 *   bun test/migrations/prodlike.ts
 *
 * env: PRODLIKE_MESSAGES (100000), PRODLIKE_USERS (5000), PRODLIKE_GUILDS (500),
 *      MIGRATION_MAX_LOCK_SECONDS (5; exit 1 when a table stays ACCESS EXCLUSIVE locked longer)
 *
 * Locks are measured by sampling pg_locks while anchor boots (`log_lock_waits` needs superuser/ALTER SYSTEM and a log
 * reader, sampling needs neither). All migrations run in one transaction, so the lock time is the transaction's.
 */
import { spawnAnchor } from '../harness/anchor';
import { connect, createDatabase, dropDatabase } from '../harness/db';
import { applyMigrations, migrationNames, recordedMigrations } from './helpers';

export type Sizes = { messages: number; users: number; guilds: number };
export type LockStats = {
  maxExclusiveSeconds: number;
  table: string | null;
  waitersSeen: number;
  samples: number;
};
export type Report = Sizes &
  LockStats & {
    migration: string;
    bootSeconds: number;
    seedSeconds: number;
    maxLockSeconds: number;
  };

const num = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback);

export const sizesFromEnv = (): Sizes => ({
  messages: num(process.env.PRODLIKE_MESSAGES, 100_000),
  users: num(process.env.PRODLIKE_USERS, 5_000),
  guilds: num(process.env.PRODLIKE_GUILDS, 500),
});

/** bulk seed valid for the schema just before the newest migration (all columns of the previous version) */
export async function seedLarge(url: string, { messages, users, guilds }: Sizes) {
  const sql = connect(url);
  try {
    await sql.unsafe(`
      INSERT INTO "user" (id, username, "homeserverName", "displayName", "isBot", "createdAt", "updatedAt")
        SELECT 'u' || i, 'user' || i, 'localhost', 'User ' || i, false, now(), now() FROM generate_series(1, ${users}) i;
      INSERT INTO local_credential ("userId", email, "passwordHash")
        SELECT 'u' || i, 'user' || i || '@example.test', 'hash' FROM generate_series(1, ${users}) i;
      INSERT INTO session (id, "userId", "secretHash", "createdAt", "expiresAt")
        SELECT 's' || i, 'u' || i, '\\xdeadbeef', now(), now() + interval '1 year' FROM generate_series(1, ${users}) i;
      INSERT INTO guild (id, name, "ownerId")
        SELECT 'g' || i, 'Guild ' || i, 'u' || ((i - 1) % ${users} + 1) FROM generate_series(1, ${guilds}) i;
      INSERT INTO guild_member ("guildId", "userId", role, position)
        SELECT 'g' || ((i + k * 7) % ${guilds} + 1), 'u' || i, 'MEMBER', k
          FROM generate_series(1, ${users}) i, generate_series(0, 2) k ON CONFLICT DO NOTHING;
      INSERT INTO channel (id, "guildId", name, position, "createdAt", "updatedAt")
        SELECT 'c' || g || '_' || k, 'g' || g, 'channel' || k, k, now(), now()
          FROM generate_series(1, ${guilds}) g, generate_series(0, 1) k;
      INSERT INTO message (id, "channelId", "authorId", content, nonce, "createdAt", "updatedAt")
        SELECT 'm' || i, 'c' || ((i - 1) % ${guilds} + 1) || '_' || (i % 2), 'u' || ((i - 1) % ${users} + 1),
               md5(i::text), 'n' || i, now() - make_interval(secs => i), now()
          FROM generate_series(1, ${messages}) i;
      INSERT INTO message_ping ("messageId", "userId")
        SELECT 'm' || i, 'u' || (i % ${users} + 1) FROM generate_series(1, ${messages}, 10) i ON CONFLICT DO NOTHING;
      ANALYZE;
    `);
  } finally {
    await sql.close();
  }
}

/** polls pg_locks and tracks how long each public table stays ACCESS EXCLUSIVE locked by another backend */
export function sampleLocks(url: string, intervalMs = 10) {
  const sql = connect(url);
  const held = new Map<string, { first: number; last: number }>();
  const longest = { seconds: 0, table: null as string | null };
  let waiters = 0;
  let samples = 0;
  let running = true;

  const loop = (async () => {
    while (running) {
      const now = performance.now();
      const rows = (await sql
        .unsafe(
          `
        SELECT c.relname AS "table", l.mode, l.granted FROM pg_locks l
          JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE l.pid <> pg_backend_pid() AND n.nspname = 'public' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND (l.mode = 'AccessExclusiveLock' OR NOT l.granted)
      `
        )
        .catch(() => [])) as { table: string; mode: string; granted: boolean }[];
      samples++;
      waiters += rows.filter((r) => !r.granted).length;
      const now_held = new Set(
        rows.filter((r) => r.granted && r.mode === 'AccessExclusiveLock').map((r) => r.table)
      );
      for (const table of now_held) {
        const entry = held.get(table) ?? { first: now, last: now };
        entry.last = now;
        held.set(table, entry);
        if ((entry.last - entry.first) / 1000 > longest.seconds) {
          longest.seconds = (entry.last - entry.first) / 1000;
          longest.table = table;
        }
      }
      for (const table of [...held.keys()]) if (!now_held.has(table)) held.delete(table);
      await Bun.sleep(intervalMs);
    }
  })();

  return {
    async stop(): Promise<LockStats> {
      running = false;
      await loop;
      await sql.close();
      return {
        maxExclusiveSeconds: longest.seconds,
        table: longest.table,
        waitersSeen: waiters,
        samples,
      };
    },
  };
}

/** returns the failure message when the lock budget is exceeded */
export const lockViolation = (
  report: Pick<Report, 'maxExclusiveSeconds' | 'table' | 'maxLockSeconds'>
) =>
  report.maxExclusiveSeconds > report.maxLockSeconds
    ? `"${report.table}" held ACCESS EXCLUSIVE for ${report.maxExclusiveSeconds.toFixed(2)}s (limit ${report.maxLockSeconds}s)`
    : null;

export async function runProdlike(
  sizes = sizesFromEnv(),
  maxLockSeconds = num(process.env.MIGRATION_MAX_LOCK_SECONDS, 5)
) {
  const { database, url } = await createDatabase('prodlike');
  try {
    await applyMigrations(url, migrationNames.length - 1);
    let t = performance.now();
    await seedLarge(url, sizes);
    const seedSeconds = (performance.now() - t) / 1000;

    const sampler = sampleLocks(url);
    t = performance.now();
    const anchor = await spawnAnchor({ name: 'prodlike', db: url });
    const bootSeconds = (performance.now() - t) / 1000;
    const locks = await sampler.stop();
    await anchor.destroy();

    const applied = await recordedMigrations(url);
    if (applied.length !== migrationNames.length)
      throw new Error(`expected ${migrationNames.length} migrations, found ${applied.length}`);
    return {
      ...sizes,
      ...locks,
      migration: migrationNames.at(-1)!,
      bootSeconds,
      seedSeconds,
      maxLockSeconds,
    } satisfies Report;
  } finally {
    await dropDatabase(database);
  }
}

if (import.meta.main) {
  const report = await runProdlike();
  console.log(JSON.stringify(report, null, 2));
  const violation = lockViolation(report);
  if (violation) {
    console.error(`FAIL: ${violation}`);
    process.exit(1);
  }
}
