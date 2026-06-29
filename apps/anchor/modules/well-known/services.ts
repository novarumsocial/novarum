import Elysia from 'elysia';
import { version } from '../../utils/version';
import { getConfig } from '../../utils/config';
import { getKeys } from '../../utils/keys';

export const wellKnown = new Elysia({ prefix: '/.well-known/anchor' }).get(
  '/info',
  async ({ request }) => {
    const { homeserver, baseUrl } = getConfig().server;
    const { publicKey, id } = await getKeys();

    return {
      app: {
        name: 'novarum-anchor',
        description: 'Anchor is a homeserver for Novarum, a decentralized chat app.',
      },
      publicKey: {
        id,
        algorithm: 'ed25519',
        key: publicKey,
      },
      homeserver,
      baseUrl,
      version,
    };
  }
);
