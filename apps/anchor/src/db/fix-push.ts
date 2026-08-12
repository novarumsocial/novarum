// slightly modified for bun sql.
// original: https://github.com/drizzle-team/drizzle-orm/discussions/1604#discussioncomment-10205580
import { SQL } from "bun";
import original_config from "../../drizzle.config";
import { type MigrationConfig, readMigrationFiles } from "drizzle-orm/migrator";
import { getConfig } from "../../utils/config";

const config = {
  ...original_config,
  migrationsFolder: original_config.out,
  migrationsTable: original_config.migrations?.table ?? "__drizzle_migrations",
  migrationsSchema: original_config.migrations?.schema ?? "drizzle",
} as MigrationConfig;

const migrations = readMigrationFiles(config);

const sql = new SQL(process.env.DATABASE_URL || getConfig().server.database_url);

const table_name = `${config.migrationsSchema}.${config.migrationsTable}`;

const get_db_migrations = sql`SELECT id, hash, created_at FROM ${sql(
  table_name
)}`;

async function main() {
  const db_migrations_hashs = (await get_db_migrations.execute()).map((m: any) => {
    return m.hash as string;
  });

  for (const migration of migrations) {
    if (!db_migrations_hashs.includes(migration.hash)) {
      console.log(
        `######## Adding migration to ${table_name}:\n\n${migration.sql}\n\n`
      );
      const new_db_migration = {
        hash: migration.hash,
        created_at: migration.folderMillis,
        name: migration.name,
      };
      await sql`INSERT INTO ${sql(table_name)} ${sql(
        new_db_migration,
        "hash",
        "created_at",
        "name",
      )}`.execute();
    }
  }
}

main().finally(() => process.exit(0));