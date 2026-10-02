import { cpus } from 'node:os';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { eq, like } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../src/db/schema';
import { relations } from '../src/db/relations';

const options = z
  .object({
    DATABASE_URL: z.url().startsWith('postgresql://'),
    BENCH_WARMUP: z.coerce.number().int().nonnegative().default(20),
    BENCH_SAMPLES: z.coerce.number().int().positive().default(200),
    BENCH_THROUGHPUT_OPS: z.coerce.number().int().positive().default(500),
    BENCH_CONCURRENCY: z.coerce.number().int().positive().default(10),
    BENCH_OUTPUT: z.string().default('benchmarks/results.json'),
    BENCH_CHANNEL_MESSAGES: z.coerce.number().int().positive().default(10_000),
    BENCH_NONCES: z.coerce.number().int().positive().default(100_000),
    BENCH_ONLINE_USERS: z.coerce.number().int().positive().default(5_000),
  })
  .parse(process.env);

const { users, guilds, guildMembers, channels, messages } = schema;
const { channelReadStates, messagePings, federationNonces } = schema;
const db = drizzle({ connection: options.DATABASE_URL, relations });
const guildCount = 50;
const deepOffset = 5000;

type Fixture = Awaited<ReturnType<typeof setup>>;

const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
const prefix = `bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// one throwaway homeserver for everything the suite writes, so cleanup is a single delete per table
const homeserver = `${prefix}.invalid`;

const chunks = <T>(rows: T[], size = 2000) =>
  Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

async function insertAll<T>(insert: (rows: T[]) => PromiseLike<unknown>, rows: T[]) {
  for (const chunk of chunks(rows)) await insert(chunk);
}

async function setup() {
  const now = new Date();
  const userRow = (id: string, i: number, status: 'ONLINE' | 'OFFLINE' = 'OFFLINE') => ({
    id,
    username: `${prefix}-${i}`,
    homeserver,
    displayName: `Benchmark user ${i}`,
    avatarUrl: null,
    isBot: false,
    status,
    createdAt: now,
    updatedAt: now,
  });
  const userId = `${prefix}-user-0`;
  const guildId = `${prefix}-guild`;
  const channelId = `${prefix}-channel`;

  await insertAll(
    (rows) => db.insert(users).values(rows),
    [
      ...Array.from({ length: 10 }, (_, i) => userRow(`${prefix}-user-${i}`, i)),
      ...Array.from({ length: options.BENCH_ONLINE_USERS }, (_, i) =>
        userRow(`${prefix}-online-${i}`, 1000 + i, 'ONLINE')
      ),
    ]
  );
  await db.insert(guilds).values({ id: guildId, name: 'Benchmark', ownerId: userId });
  await db
    .insert(guildMembers)
    .values(Array.from({ length: 10 }, (_, i) => ({ guildId, userId: `${prefix}-user-${i}`, position: 0 })));
  await db.insert(channels).values({ id: channelId, guildId, name: 'benchmark', position: 0 });

  // distinct timestamps so ordering is stable, spread over the last day
  await insertAll(
    (rows) => db.insert(messages).values(rows),
    Array.from({ length: options.BENCH_CHANNEL_MESSAGES }, (_, i) => ({
      id: `${prefix}-seed-message-${i}`,
      channelId,
      authorId: `${prefix}-user-${i % 10}`,
      content: `Benchmark message ${i}`,
      nonce: `${prefix}-seed-nonce-${i}`,
      createdAt: new Date(now.getTime() - (options.BENCH_CHANNEL_MESSAGES - i) * 1000),
    }))
  );

  // a user in 50 guilds, each with a channel, a read state and a few pings (GET /guilds/list)
  const guildIds = Array.from({ length: guildCount }, (_, i) => `${prefix}-member-guild-${i}`);
  await db
    .insert(guilds)
    .values(guildIds.map((id, i) => ({ id, name: `Benchmark ${i}`, ownerId: userId })));
  await db
    .insert(guildMembers)
    .values(guildIds.map((id, i) => ({ guildId: id, userId: `${prefix}-user-1`, position: i })));
  const guildChannelIds = guildIds.map((_, i) => `${prefix}-member-channel-${i}`);
  await db
    .insert(channels)
    .values(guildIds.map((id, i) => ({ id: guildChannelIds[i]!, guildId: id, name: 'general', position: 0 })));
  const guildMessages = guildChannelIds.map((id, i) => ({
    id: `${prefix}-member-message-${i}`,
    channelId: id,
    authorId: userId,
    content: '@ping',
    nonce: `${prefix}-member-nonce-${i}`,
  }));
  await db.insert(messages).values(guildMessages);
  await db.insert(channelReadStates).values(
    guildChannelIds.map((id, i) => ({
      userId: `${prefix}-user-1`,
      channelId: id,
      lastReadCreatedAt: new Date(now.getTime() - 60_000),
      lastReadMessageId: `${prefix}-member-message-${i}`,
    }))
  );
  await db
    .insert(messagePings)
    .values(guildMessages.map(({ id }) => ({ messageId: id, userId: `${prefix}-user-1` })));

  await insertAll(
    (rows) => db.insert(federationNonces).values(rows),
    Array.from({ length: options.BENCH_NONCES }, (_, i) => ({
      id: `${prefix}-nonce-row-${i}`,
      nonce: `prefill-${i}`,
      homeserver,
    }))
  );
  await db.execute('ANALYZE');

  return { userId, memberUserId: `${prefix}-user-1`, guildId, channelId };
}

const scenarios: [string, (f: Fixture, n: number) => Promise<unknown>][] = [
  ['User by primary key', ({ userId }) => db.query.users.findFirst({ where: { id: userId } })],
  [
    'Membership by compound key',
    ({ userId, guildId }) => db.query.guildMembers.findFirst({ where: { userId, guildId } }),
  ],
  [
    'Message page (latest 50 + author + attachments)',
    ({ channelId }) =>
      db.query.messages.findMany({
        where: { channelId },
        orderBy: { createdAt: 'desc' },
        with: { author: true, attachments: true },
        limit: 50,
      }),
  ],
  [
    `Message page (offset ${deepOffset})`,
    ({ channelId }) =>
      db.query.messages.findMany({
        where: { channelId },
        orderBy: { createdAt: 'desc' },
        with: { author: true, attachments: true },
        limit: 50,
        offset: deepOffset,
      }),
  ],
  [
    'Guild list (50 guilds + read states + pings)',
    ({ memberUserId }) =>
      Promise.all([
        db.query.guildMembers.findMany({
          where: { userId: memberUserId },
          with: { guild: true },
          orderBy: { position: 'asc' },
        }),
        db.query.channelReadStates.findMany({ where: { userId: memberUserId } }),
        db.query.messagePings.findMany({ where: { userId: memberUserId }, with: { message: true } }),
      ]),
  ],
  [
    'Federation nonce lookup + insert (100k rows)',
    async (_, n) => {
      const nonce = `measured-${n}`;
      await db.query.federationNonces.findFirst({ where: { nonce, homeserver } });
      await db
        .insert(federationNonces)
        .values({ id: `${prefix}-measured-nonce-${n}`, nonce, homeserver })
        .onConflictDoNothing();
    },
  ],
  [
    'Online-user scan (5k users)',
    () => db.query.users.findMany({ where: { status: 'ONLINE', homeserver } }),
  ],
  [
    'Insert message',
    ({ channelId, userId }, n) =>
      db.insert(messages).values({
        id: `${prefix}-measured-message-${n}`,
        channelId,
        authorId: userId,
        content: 'Measured insert',
        nonce: `${prefix}-measured-nonce-${n}`,
      }),
  ],
  [
    'Update user',
    ({ userId }, n) =>
      db
        .update(users)
        .set({ status: n % 2 ? 'ONLINE' : 'IDLE' })
        .where(eq(users.id, userId)),
  ],
];

async function cleanup() {
  // guild deletes cascade to channels, messages, members, pings and read states
  await db.delete(guilds).where(like(guilds.id, `${prefix}-%`));
  await db.delete(federationNonces).where(eq(federationNonces.homeserver, homeserver));
  await db.delete(users).where(eq(users.homeserver, homeserver));
}

function percentile(sorted: number[], value: number) {
  return sorted[Math.min(Math.ceil(sorted.length * value) - 1, sorted.length - 1)]!;
}

function command(...args: string[]) {
  const result = Bun.spawnSync(args);
  return result.success ? result.stdout.toString().trim() : 'unknown';
}

try {
  const fixture = await setup();
  const results = [];
  for (const [name, operation] of scenarios) {
    process.stdout.write(`${name}... `);
    for (let i = 0; i < options.BENCH_WARMUP; i++) await operation(fixture, -i - 1);

    const durations = [];
    for (let i = 0; i < options.BENCH_SAMPLES; i++) {
      const start = Bun.nanoseconds();
      await operation(fixture, i);
      durations.push((Bun.nanoseconds() - start) / 1e6);
    }

    const throughputStart = Bun.nanoseconds();
    for (let i = 0; i < options.BENCH_THROUGHPUT_OPS; i += options.BENCH_CONCURRENCY) {
      await Promise.all(
        Array.from(
          { length: Math.min(options.BENCH_CONCURRENCY, options.BENCH_THROUGHPUT_OPS - i) },
          (_, offset) => operation(fixture, 1_000_000 + i + offset)
        )
      );
    }
    const throughputSeconds = (Bun.nanoseconds() - throughputStart) / 1e9;
    durations.sort((a, b) => a - b);
    const result = {
      name,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
      opsPerSecond: options.BENCH_THROUGHPUT_OPS / throughputSeconds,
    };
    results.push(result);
    console.log(`${result.p50Ms.toFixed(2)} ms p50, ${result.opsPerSecond.toFixed(1)} ops/s`);
  }

  const output = {
    schemaVersion: 2,
    commit: command('git', 'rev-parse', '--short=12', 'HEAD'),
    timestamp: new Date().toISOString(),
    runtime: `Bun ${Bun.version}`,
    machine: `${cpus()[0]?.model ?? 'unknown CPU'} (${cpus().length} logical cores)`,
    database: new URL(options.DATABASE_URL).host,
    drizzle: packageJson.dependencies['drizzle-orm'],
    config: {
      warmup: options.BENCH_WARMUP,
      samples: options.BENCH_SAMPLES,
      throughputOps: options.BENCH_THROUGHPUT_OPS,
      concurrency: options.BENCH_CONCURRENCY,
      channelMessages: options.BENCH_CHANNEL_MESSAGES,
      nonces: options.BENCH_NONCES,
      onlineUsers: options.BENCH_ONLINE_USERS,
    },
    results,
  };
  await Bun.write(options.BENCH_OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${options.BENCH_OUTPUT}`);
} finally {
  await cleanup();
  await db.$client.close();
}
