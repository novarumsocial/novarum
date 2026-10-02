// bun benchmarks/presence-load.ts
// Measures the database load of the 3s presence loop (realtime/services.ts) with N connected users.
// Needs the test Postgres (test/compose.yml). Env: PRESENCE_USERS (1000), PRESENCE_SECONDS (30),
// PRESENCE_MAX_TX_PER_SECOND (fails above it, default 50).
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/bun-sql';
import { spawnAnchor } from '../test/harness/anchor';
import { connect } from '../test/harness/db';
import { hashSecret } from '../modules/auth/provider';
import * as schema from '../src/db/schema';
import { relations } from '../src/db/relations';

const env = z
  .object({
    PRESENCE_USERS: z.coerce.number().int().positive().default(1000),
    PRESENCE_SECONDS: z.coerce.number().positive().default(30),
    PRESENCE_MAX_TX_PER_SECOND: z.coerce.number().positive().default(50),
  })
  .parse(process.env);

const anchor = await spawnAnchor({ name: 'presence' });
const db = drizzle({ connection: anchor.databaseUrl, relations });
const sql = connect(anchor.databaseUrl);

try {
  const now = new Date();
  const secret = 'bench-secret';
  const secretHash = await hashSecret(secret);
  const rows = Array.from({ length: env.PRESENCE_USERS }, (_, i) => ({
    id: `presence-user-${i}`,
    username: `presence${i}`,
    isBot: false,
    homeserver: anchor.homeserver,
    createdAt: now,
    updatedAt: now,
  }));
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await db.insert(schema.users).values(chunk);
    await db.insert(schema.sessions).values(
      chunk.map(({ id }) => ({
        id: `s-${id}`,
        userId: id,
        secretHash,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      }))
    );
  }

  const stats = async () => {
    const [row] = await sql`
      SELECT xact_commit + xact_rollback AS tx, tup_returned + tup_fetched AS tuples
      FROM pg_stat_database WHERE datname = current_database()`;
    return { tx: Number(row.tx), tuples: Number(row.tuples) };
  };
  const measure = async (label: string) => {
    const a = await stats();
    await Bun.sleep(env.PRESENCE_SECONDS * 1000);
    const b = await stats();
    // the stats connection itself adds two transactions
    const tx = (b.tx - a.tx - 2) / env.PRESENCE_SECONDS;
    const tuples = (b.tuples - a.tuples) / env.PRESENCE_SECONDS;
    console.log(`${label}: ${tx.toFixed(1)} transactions/s, ${tuples.toFixed(0)} tuples/s`);
    return tx;
  };

  const idle = await measure('0 connected users');

  const sockets = await Promise.all(
    rows.map(
      ({ id }) =>
        new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(`${anchor.url.replace(/^http/, 'ws')}/realtime`, {
            headers: { cookie: `session_token=s-${id}.${secret}` },
          } as any);
          ws.onopen = () => resolve(ws);
          ws.onerror = () => reject(new Error(`ws ${id} failed`));
        })
    )
  );
  await Bun.sleep(10_000); // let the connect storm settle
  const loaded = await measure(`${sockets.length} connected users`);
  for (const ws of sockets) ws.close();

  if (loaded > env.PRESENCE_MAX_TX_PER_SECOND) {
    throw new Error(`presence loop load ${loaded.toFixed(1)} tx/s > ${env.PRESENCE_MAX_TX_PER_SECOND}`);
  }
  console.log(`idle baseline ${idle.toFixed(1)} tx/s; loaded ${loaded.toFixed(1)} tx/s`);
} finally {
  await sql.close();
  await anchor.destroy();
}
