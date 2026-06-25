import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import { wellKnown } from '../modules/well-known/services';
import { auth } from '../modules/auth/services';
import { guilds } from '../modules/guilds/services';
import { realtime } from '../modules/realtime/services';
import { channel } from '../modules/channel/services';
import { message } from '../modules/message/services';
import { invite } from '../modules/invite/services';

const app = new Elysia()
  .use(cors({ credentials: true }))
  .use(wellKnown)
  .use(auth)
  .use(guilds)
  .use(realtime)
  .use(channel)
  .use(message)
  .use(invite)
  .get('/', () => 'this is anchor')
  .listen(5049);

export type App = typeof app;
export type { RealtimeEvent } from '../utils/types';

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
