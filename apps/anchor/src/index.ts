import { getConfig } from '../utils/config';
import { startPresenceCleanup } from '../modules/realtime/services';
import { configureStorageCors } from '../utils/services/storage';
import { writeEmojis } from '../utils/emojiWriter';
import { clearOnlineUsers } from '../utils/clearOnlineUsers';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { db, channels } from './db';
import { and, isNull, like } from 'drizzle-orm';
import { ensureFederatedDmRealtimeBridge } from '../utils/federationRealtime';
import { exit, argv } from 'process';
import { startFriendSyncRetry } from '../modules/friends/services.ts';
import { createApp } from './app';

if (argv[2] === 'cli') {
  await import('./cli/index.ts');
}

console.log('[DB] Running migrations...');
await migrate(db, {
  migrationsFolder: './drizzle',
}).catch((e) => {
  console.log(`[DB] Error when migrating:\n${e}`);
  exit(1);
});
console.log('[DB] Migrations complete!');

if (!getConfig().files.s3_disable_cors) {
  await configureStorageCors();
}
if (!getConfig().misc.skip_emoji_download) await writeEmojis();
await clearOnlineUsers();
startPresenceCleanup();
startFriendSyncRetry();

const app = createApp().listen(getConfig().server.listen_port);

// federated DM bridges otherwise only start from /dm, so after a restart new messages
// in a closed DM would never reach us to reopen it.
const federatedDms = await db
  .select({ id: channels.id })
  .from(channels)
  .where(and(isNull(channels.guildId), like(channels.id, 'fed:channel:%')));
for (const { id } of federatedDms) {
  void ensureFederatedDmRealtimeBridge(app.server!, id).catch(() => null);
}

export type App = ReturnType<typeof createApp>;
export type { RealtimeEvent } from '../utils/types';

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
