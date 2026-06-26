import Elysia from 'elysia';
import { version } from '../../utils/version';
import { getConfig } from '../../utils/config';

export const wellKnown = new Elysia({ prefix: '/.well-known/anchor' }).get(
  '/info',
  async ({ request }) => {
    const { homeserver, baseUrl } = getConfig().server;

    return {
      app: {
        name: 'novarum-anchor',
        description: 'Anchor is a homeserver for Novarum, a decentralized chat app.',
      },
      homeserver,
      baseUrl,
      version,
    };
  }
);
