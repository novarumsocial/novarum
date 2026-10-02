# L6: database migrations

Run: `bun run test:migrations` (needs `bun run test:infra`; about 40s). Docker is only needed by the rollback test, which
skips itself when `docker exec anchor-test-postgres-1 pg_dump` does not work (override the name with `ANCHOR_TEST_PG_CONTAINER`).

| file | plan | what |
| --- | --- | --- |
| `static.test.ts` | 6.1 | no drift (`drizzle-kit generate` into a temp copy), `drizzle-kit check`, snapshot chain, old migrations unchanged vs `origin/main` or `main` (skipped without git or such a ref), dangerous-SQL lint |
| `fresh.test.ts` | 6.2 | empty DB boot records every folder in `drizzle/`, schema equals `drizzle-kit push` on another DB, second boot is a no-op |
| `upgrade.test.ts` | 6.3 | for each migration N: apply 1..N-1, load `seeds/<N>.sql`, apply N, row counts preserved plus per-migration invariants |
| `prodlike.ts` / `prodlike.test.ts` | 6.4 | large synthetic upgrade with lock sampling; the test is a tiny smoke run |
| `fixpush.test.ts` | 6.5 | `src/db/fix-push.ts` after `db:push` |
| `failure.test.ts` | 6.6 | broken migration and unreachable DB |
| `rollback.test.ts` | 6.7 | backup, upgrade, restore |

## Adding a migration

1. `bun run db:generate`, review the SQL. If the lint flags it (`DROP COLUMN`, `DROP TABLE`, column type change,
   `SET NOT NULL` without an `UPDATE` backfill, `ADD CONSTRAINT ... UNIQUE`), add a `-- reviewed: <reason>` comment line.
   The lint only applies to migrations that are neither on main nor listed in `reviewed.json` (the 15 existing ones are
   grandfathered there).
2. Add `seeds/<new-migration-folder>.sql`: realistic rows valid for the schema **before** the new migration (copy the
   previous seed and adapt it to the columns that exist). Seeds are frozen once the migration is merged.
3. Add an entry to `specs` in `upgrade.test.ts` with the invariants (and `deletes` if the migration removes rows on purpose).
4. Never edit a migration that is on main; add a new one.

## Production-like run

`bun test/migrations/prodlike.ts` (env: `PRODLIKE_MESSAGES=100000 PRODLIKE_USERS=5000 PRODLIKE_GUILDS=500
MIGRATION_MAX_LOCK_SECONDS=5`) seeds the schema before the newest migration, boots anchor and prints duration and the
longest `ACCESS EXCLUSIVE` hold (sampled from `pg_locks` every 10ms, so locks shorter than that can be missed; all
migrations share one transaction, so this is the migration run's lock time). Exits 1 over the limit. Intended for nightly CI.

## Rollback policy

Drizzle has no down migrations. **Rolling back means restoring the backup taken before the upgrade and running the
previous image.** Procedure:

1. Before deploying a release that contains migrations: `pg_dump` the database (plain or custom format).
2. Deploy. If it must be reverted: stop anchor, drop and recreate the database, restore the dump, start the previous image.
3. Do not try to revert by editing `drizzle.__drizzle_migrations` or by hand-writing reverse SQL; data written after the
   backup is lost by design.
4. Anchor refuses to run a failed migration (exit 1, nothing applied, see `failure.test.ts`), so a failed upgrade needs
   no restore, just the previous image.

`rollback.test.ts` verifies this: backup, upgrade by boot, restore into a clean database, data and schema equal the
pre-upgrade state, the previous version's migrator is a no-op on it, and the current version can upgrade it again.

## Known gaps found by these tests

- `fix-push.ts` does nothing on a database made only by `db:push` (no `drizzle` schema): the SELECT throws and
  `.finally(() => process.exit(0))` hides it (exit 0, no output). It works once `drizzle.__drizzle_migrations` exists.
- An unreachable database logs only `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"`, not the connection error.
