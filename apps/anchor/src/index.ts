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
import { dm } from '../modules/dm/services';
import { configureStorageCors } from '../utils/services/storage';
import { writeEmojis } from '../utils/emojiWriter';
import { clearOnlineUsers } from '../utils/clearOnlineUsers';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { db, channels } from './db';
import { and, isNull, like } from 'drizzle-orm';
import { ensureFederatedDmRealtimeBridge } from '../utils/federationRealtime';
import { exit, argv } from 'process';
import { friends } from '../modules/friends/services.ts';
import openapi from '@elysia/openapi';
import { ip } from 'elysia-ip';

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
await writeEmojis();
await clearOnlineUsers();

const app = new Elysia()
  .use(cors({ credentials: true, origin: getConfig().files.s3_cors_origins }))
  .use(ip({ headersFirst: true }))
  .use(
    openapi({
      documentation: {
        tags: [
          { name: 'Well known', description: 'the .well-known/ routes' },
          { name: 'Auth', description: 'the auth/ routes' },
          { name: 'Guilds', description: 'the guilds/ routes' },
          { name: 'Realtime', description: 'the realtime/ routes' },
          { name: 'Channel', description: 'the channel/ routes' },
          { name: 'Message', description: 'the message/ routes' },
          { name: 'Invite', description: 'the invite/ routes' },
          { name: 'Federation', description: 'the federation/ routes' },
          { name: 'Upload', description: 'the upload/ routes' },
          { name: 'User', description: 'the user/ routes' },
          { name: 'Friends', description: 'the friends/ routes' },
          { name: 'DM', description: 'the dm/ routes' },
        ],
      },
    })
  )
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
  .use(friends)
  .use(dm)
  .get('/', () => 'this is anchor')
  .listen(getConfig().server.listen_port);

// federated DM bridges otherwise only start from /dm, so after a restart new messages
// in a closed DM would never reach us to reopen it.
const federatedDms = await db
  .select({ id: channels.id })
  .from(channels)
  .where(and(isNull(channels.guildId), like(channels.id, 'fed:channel:%')));
for (const { id } of federatedDms) {
  void ensureFederatedDmRealtimeBridge(app.server!, id).catch(() => null);
}

export type App = typeof app;
export type { RealtimeEvent } from '../utils/types';

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
