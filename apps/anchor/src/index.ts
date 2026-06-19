import { Elysia } from 'elysia';
import { wellKnown } from '../modules/well-known/services';

const app = new Elysia()
  .use(wellKnown)
  .get('/', () => 'this is anchor')
  .listen(3000);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
