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
import { federation } from '../modules/federation';
import { upload } from '../modules/upload/services';
import { user } from '../modules/user/services';
import { dm } from '../modules/dm/services';
import { friends } from '../modules/friends/services.ts';
import { notifications } from '../modules/notifications/services';
import openapi from '@elysia/openapi';
import { ip } from 'elysia-ip';

// no side effects: migrations, timers and listen() live in index.ts so tests can import this
export const createApp = () =>
  new Elysia()
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
          { name: 'Notifications', description: 'the notifications/ routes' },
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
  .use(notifications)
  .get('/', () => 'this is anchor');
