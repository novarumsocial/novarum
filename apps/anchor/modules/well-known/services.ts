import Elysia from 'elysia';
import { version } from '../../utils/version';
import { getConfig } from '../../utils/config';
import { getKeys } from '../../utils/keys';
import { z } from 'zod';

export const wellKnown = new Elysia({ prefix: '/.well-known/anchor', tags: ['Well known'] }).get(
  '/info',
  async () => {
    const { homeserver, base_url: baseUrl } = getConfig().server;
    const { publicKey, id } = await getKeys();

    return {
      app: {
        name: 'novarum-anchor',
        description: 'Anchor is a homeserver for Novarum, a decentralized chat app.',
      },
      publicKey: {
        id,
        algorithm: 'ed25519' as const,
        key: publicKey,
      },
      maxFileSize: getConfig().files.max_file_size,
      homeserver,
      baseUrl,
      version,
    };
  },
  {
    response: {
      200: z.object({
        app: z.object({
          name: z.string(),
          description: z.string(),
        }),
        publicKey: z.object({
          id: z.string(),
          algorithm: z.literal('ed25519'),
          key: z.string(),
        }),
        maxFileSize: z.number(),
        homeserver: z.string(),
        baseUrl: z.url(),
        version: z.string(),
      }),
    },
  }
);
