import Elysia from 'elysia';
import { version } from '../../utils/version';
import { getConfig } from '../../utils/config';
import { getKeys } from '../../utils/keys';
import { z } from 'zod';
import { federationFeatures } from '../../utils/federationFeatures';

export const wellKnown = new Elysia({ prefix: '/.well-known/anchor', tags: ['Well known'] }).get(
  '/info',
  async () => {
    const { homeserver, base_url: baseUrl } = getConfig().server;
    const { auth } = getConfig();
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
      maxGroupMembers: getConfig().dms.max_group_members,
      homeserver,
      baseUrl,
      version,
      features: [...federationFeatures],
      auth: {
        passwordSignup: auth.password_signup,
        inviteOnly: auth.invite_only,
        providers: Object.entries(auth.providers).map(([id, { name }]) => ({ id, name })),
      },
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
        maxGroupMembers: z.number(),
        homeserver: z.string(),
        baseUrl: z.url(),
        version: z.string(),
        features: z.array(z.string()),
        auth: z.object({
          passwordSignup: z.boolean(),
          inviteOnly: z.boolean(),
          providers: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      }),
    },
  }
);
