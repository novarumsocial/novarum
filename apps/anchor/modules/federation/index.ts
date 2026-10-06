import Elysia from 'elysia';
import { channels } from './routes/channels';
import { dms } from './routes/dms';
import { friends } from './routes/friends';
import { guilds } from './routes/guilds';
import { invites } from './routes/invites';
import { messageRoutes } from './routes/messages';
import { push } from './routes/push';
import { realtime } from './routes/realtime';
import { userStatus } from './routes/status';
import { users } from './routes/users';

// The routes other homeservers call. Everything except looking up a user is signed and verified,
// see ./verify.ts and ./plugin.ts.
export const federation = new Elysia({ prefix: '/federation', tags: ['Federation'] })
  .use(users)
  .use(friends)
  .use(invites)
  .use(messageRoutes)
  .use(channels)
  .use(guilds)
  .use(userStatus)
  .use(dms)
  .use(push)
  .use(realtime);
