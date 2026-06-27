import Elysia, { t } from 'elysia';
import { discoverRemoteAnchor } from '../../utils/discovery';
import { isNonceUsed, storeNonce, verifyMessage } from '../../utils/keys';
import { getConfig } from '../../utils/config';
import crypto from 'node:crypto';
import { db } from '../../prisma/db';
import { randomString } from '../../utils/randomString';

async function verifyFederationRequest(
  request: Request,
  body: string
): Promise<
  | { ok: true; origin: Awaited<ReturnType<typeof discoverRemoteAnchor>> }
  | { ok: false; status: 400 | 401 | 404; error: string }
> {
  const homeserver = request.headers.get('X-Novarum-Homeserver');
  if (!homeserver) {
    return { ok: false, status: 400, error: 'Missing X-Novarum-Homeserver header' };
  }

  const discovered = await discoverRemoteAnchor(homeserver);
  if (!discovered) {
    return { ok: false, status: 404, error: 'Could not discover remote anchor' };
  }

  const keyId = request.headers.get('X-Novarum-Key-Id');
  const date = request.headers.get('X-Novarum-Date');
  const nonce = request.headers.get('X-Novarum-Nonce');
  const signature = request.headers.get('X-Novarum-Signature');
  const bodyHash = request.headers.get('X-Novarum-Body-SHA256');
  if (!keyId || !date || !nonce || !signature || !bodyHash) {
    return { ok: false, status: 400, error: 'Missing required federation headers' };
  }
  if (discovered.publicKey.id !== keyId) {
    return { ok: false, status: 401, error: 'Unknown federation key' };
  }
  if (isStaleFederationDate(date)) {
    return { ok: false, status: 401, error: 'Stale federation request' };
  }
  if (await isNonceUsed(nonce)) {
    return { ok: false, status: 401, error: 'Federation nonce already used' };
  }
  if (bodySha256(body) !== bodyHash) {
    return { ok: false, status: 401, error: 'Invalid federation body hash' };
  }

  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;

  const signingString = [
    'v1',
    request.method.toUpperCase(),
    path,
    url.host,
    homeserver,
    date,
    nonce,
    bodyHash,
  ].join('\n');
  const correct = verifyMessage(signingString, signature, discovered.publicKey.key);
  if (!correct) {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
  const stored = await storeNonce(nonce, homeserver);
  if (!stored) {
    return { ok: false, status: 401, error: 'Federation nonce already used' };
  }

  return { ok: true, origin: discovered };
}

export const federation = new Elysia({ prefix: '/federation' })
  .get('/users/:username', async ({ params, status }) => {
    const { username } = params;
    if (!username) {
      return status(400, { error: 'Missing username' });
    }

    const user = await db.orm.public.User.where({
      username,
      homeserver: getConfig().server.homeserver,
    }).first();
    if (!user) {
      return status(404, { error: 'User not found' });
    }

    return {
      user: {
        username: user.username,
        homeserver: user.homeserver,
        handle: `@${user.username}:${user.homeserver}`,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isBot: user.isBot,
      },
    };
  })
  .get('/invites/:code', async ({ params, status }) => {
    const invite = await db.orm.public.GuildInvite.where({ code: params.code }).first();
    if (!invite || isExpired(invite.expiresAt)) {
      return status(404, { error: 'Invite not found' });
    }

    const guild = await db.orm.public.Guild.where({ id: invite.guildId }).first();
    if (!guild) {
      return status(404, { error: 'Guild not found' });
    }

    const members = await db.orm.public.GuildMember.where({ guildId: guild.id }).all();

    return {
      invite: {
        code: invite.code,
        expiresAt: invite.expiresAt,
      },
      guild: {
        id: guild.id,
        homeserver: getConfig().server.homeserver,
        name: guild.name,
        description: guild.description,
        avatarUrl: guild.avatarUrl,
        memberCount: members.length,
      },
    };
  })
  .post(
    '/invites/:code/accept',
    async ({ params, body, request, status }) => {
      const verification = await verifyFederationRequest(request, JSON.stringify(body));
      if (!verification.ok) {
        return status(verification.status, { error: verification.error });
      }

      const { origin } = verification;
      if (body.user.homeserver !== origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }
      if (body.user.homeserver === getConfig().server.homeserver) {
        return status(400, { error: 'Use local invite accept for local users' });
      }

      const invite = await db.orm.public.GuildInvite.where({ code: params.code }).first();
      if (!invite || isExpired(invite.expiresAt)) {
        return status(404, { error: 'Invite not found' });
      }

      const guild = await db.orm.public.Guild.where({ id: invite.guildId }).first();
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }

      const now = new Date();
      let user = await db.orm.public.User.where({
        username: body.user.username,
        homeserver: body.user.homeserver,
      }).first();

      if (user) {
        await db.orm.public.User.where({ id: user.id }).update({
          displayName: body.user.displayName,
          avatarUrl: body.user.avatarUrl,
          isBot: body.user.isBot,
          updatedAt: now,
        });
      } else {
        user = await db.orm.public.User.create({
          id: randomString(),
          username: body.user.username,
          homeserver: body.user.homeserver,
          displayName: body.user.displayName,
          avatarUrl: body.user.avatarUrl,
          isBot: body.user.isBot,
          createdAt: now,
          updatedAt: now,
        });
      }

      const membership = await db.orm.public.GuildMember.where({
        guildId: guild.id,
        userId: user.id,
      }).first();

      if (!membership) {
        await db.orm.public.GuildMember.create({
          guildId: guild.id,
          userId: user.id,
          role: 'MEMBER',
        });
      }

      const channels = await db.orm.public.Channel.where({ guildId: guild.id })
        .orderBy((channel) => channel.position.asc())
        .all();

      return {
        guild: {
          id: guild.id,
          homeserver: getConfig().server.homeserver,
          name: guild.name,
          description: guild.description,
          avatarUrl: guild.avatarUrl,
        },
        channels: channels.map((channel) => ({
          id: channel.id,
          guildId: channel.guildId,
          name: channel.name,
          position: channel.position,
          type: channel.type as 'TEXT' | 'VOICE',
        })),
      };
    },
    {
      body: t.Object({
        user: t.Object({
          username: t.String({ minLength: 2, maxLength: 32, pattern: '^[a-zA-Z0-9._]+$' }),
          homeserver: t.String({ minLength: 1, maxLength: 255 }),
          displayName: t.Nullable(t.String({ maxLength: 64 })),
          avatarUrl: t.Nullable(t.String()),
          isBot: t.Boolean(),
        }),
      }),
    }
  );

function isStaleFederationDate(date: string) {
  const timestamp = new Date(date).getTime();
  if (Number.isNaN(timestamp)) return true;

  const maxAgeMs = getConfig().federation.nonce_max_age_seconds * 1000;
  return Math.abs(Date.now() - timestamp) > maxAgeMs;
}

function bodySha256(body: string) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('base64');
}

function isExpired(expiresAt: Date | string | null | undefined) {
  return expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
}
