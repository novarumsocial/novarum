import Elysia from 'elysia';
import { version } from '../../utils/version';

export const wellKnown = new Elysia({ prefix: '/.well-known/anchor' }).get('/info', async () => {
  return {
    app: {
      name: 'novarum-anchor',
      description: 'Anchor is a homeserver for Novarum, a decentralized chat app.',
    },
    version,
  };
});
