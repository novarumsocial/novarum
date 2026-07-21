import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { getConfig } from '../utils/config';
import { wellKnown } from '../modules/well-known/services';
import { auth } from '../modules/auth/services';
import { guilds } from '../modules/guilds/services';
import { realtime } from '../modules/realtime/services';
import { channel } from '../modules/channel/services';
import { message } from '../modules/message/services';
import { invite } from '../modules/invite/services';
import { federation } from '../modules/federation/services';
import { upload } from '../modules/upload/services';
import { user } from '../modules/user/services';
import { configureStorageCors } from '../utils/services/storage';
import { writeEmojis } from '../utils/emojiWriter';
import { clearOnlineUsers } from '../utils/clearOnlineUsers';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { db } from './db';
import { exit } from 'process';

await configureStorageCors();
await writeEmojis();
await clearOnlineUsers();

console.log('[DB] Running migrations...');
await migrate(db, {
  migrationsFolder: './drizzle',
}).catch((e) => {
  console.log(`[DB] Error when migrating:\n${e}`);
  exit(1);
});
console.log('[DB] Migrations complete!');

const app = new Elysia()
  .use(cors({ credentials: true }))
  .use(wellKnown)
  .use(auth)
  .use(guilds)
  .use(realtime)
  .use(channel)
  .use(message)
  .use(invite)
  .use(federation)
  .use(upload)
  .use(user)
  .get('/', () => 'this is anchor')
  .listen(getConfig().server.listen_port);

export type App = typeof app;
export type { RealtimeEvent } from '../utils/types';

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
