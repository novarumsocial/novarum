import Elysia from 'elysia';
import { discoverRemoteAnchor } from '../../utils/discovery';
import { isNonceUsed, storeNonce, verifyMessage } from '../../utils/keys';
import { getConfig } from '../../utils/config';
import crypto from 'node:crypto';
import { db } from '../../prisma/db';
import { randomString } from '../../utils/randomString';
import { publishRealtime } from '../../utils/publishRealtime';
import { AccessToken } from 'livekit-server-sdk';
import {
  removeVoicePresence,
  setVoicePresence,
  voicePresenceForGuilds,
} from '../../utils/services/livekit';
import {
  attachmentPayload,
  attachmentPresignSchema,
  isAllowedAttachmentType,
  maxAttachmentCount,
} from '../../utils/attachments';
import { createPendingAttachment } from '../upload/services';
import { getPingRecipients, verifyPendingAttachments } from '../message/services';
import { storage } from '../../utils/services/storage';

const usernamePattern = /^[a-zA-Z0-9._]+$/;
const federatedMessagePageSize = 50;
const maxFederatedMessagePageSize = 100;

type FederationUserPayload = {
  username: string;
  homeserver: string;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
};

async function verifyFederationRequest(
  request: Request,
  body: string,
  signedPath?: string
): Promise<
  | { ok: true; origin: Awaited<ReturnType<typeof discoverRemoteAnchor>> }
  | { ok: false; status: 400 | 401 | 404; error: string }
> {
  const homeserver = request.headers.get('X-Novarum-Homeserver');
  if (!homeserver) {
    return { ok: false, status: 400, error: 'Missing X-Novarum-Homeserver header' };
  }

  const keyId = request.headers.get('X-Novarum-Key-Id');
  const date = request.headers.get('X-Novarum-Date');
  const nonce = request.headers.get('X-Novarum-Nonce');
  const signature = request.headers.get('X-Novarum-Signature');
  const bodyHash = request.headers.get('X-Novarum-Body-SHA256');
  if (!keyId || !date || !nonce || !signature || !bodyHash) {
    return { ok: false, status: 400, error: 'Missing required federation headers' };
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

  let discovered: Awaited<ReturnType<typeof discoverRemoteAnchor>>;
  try {
    discovered = await discoverRemoteAnchor(homeserver);
  } catch {
    return { ok: false, status: 400, error: 'Could not discover remote anchor' };
  }

  if (discovered.publicKey.id !== keyId) {
    try {
      discovered = await discoverRemoteAnchor(homeserver, { refresh: true });
    } catch {
      return { ok: false, status: 400, error: 'Could not discover remote anchor' };
    }

    if (discovered.publicKey.id !== keyId) {
      return { ok: false, status: 401, error: 'Unknown federation key' };
    }
  }

  const url = new URL(request.url);
  const path = signedPath ?? `${url.pathname}${url.search}`;

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
  .post('/invites/:code/accept', async ({ params, request, server, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });

    const { origin } = parsed;
    if (userPayload.homeserver.toLowerCase() !== origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }
    if (userPayload.homeserver.toLowerCase() === getConfig().server.homeserver.toLowerCase()) {
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

    const user = await upsertFederatedUser(userPayload);

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

      if (server) {
        publishRealtime(server, `guildEvents:${guild.id}`, {
          type: 'member.joined',
          data: {
            guildId: guild.id,
            user: {
              userId: user.id,
              username: user.username,
              displayName: user.displayName ?? user.username,
              avatarUrl: user.avatarUrl,
              homeserver: user.homeserver,
              isBot: user.isBot,
              status: user.status as 'ONLINE' | 'OFFLINE',
            },
          },
        });
      }
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
  })
  .post('/channels/:id/messages/send', async ({ params, request, server, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const content = getObjectProperty(parsed.body, 'content');
    const nonce = getObjectProperty(parsed.body, 'nonce');
    const replyTo = getObjectProperty(parsed.body, 'replyTo');
    const attachmentIdsResult = federationAttachmentIds(parsed.body);
    if (
      typeof content !== 'string' ||
      typeof nonce !== 'string' ||
      (replyTo != null && typeof replyTo !== 'string')
    ) {
      return status(400, { error: 'Invalid federation message' });
    }
    if (!attachmentIdsResult.ok) return status(400, { error: attachmentIdsResult.error });

    const access = await getFederatedChannelAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });

    const replyTarget = replyTo
      ? await db.orm.public.Message.where({ id: replyTo, channelId: params.id }).first()
      : null;
    if (replyTo && !replyTarget) {
      return status(400, { error: 'Invalid reply target' });
    }

    const priorMsg = await db.orm.public.Message.where({
      authorId: access.user.id,
      nonce,
    })
      .include('attachments')
      .first();
    if (priorMsg) {
      if (
        priorMsg.channelId !== params.id ||
        priorMsg.content !== content ||
        priorMsg.replyTo !== (replyTo ?? null)
      ) {
        return status(409, { error: 'Nonce already used for a different message' });
      }

      return { message: federatedMessageResponse(priorMsg, access.channel, access.user) };
    }

    const attachments = await verifyPendingAttachments(
      attachmentIdsResult.value,
      access.user.id,
      params.id
    );
    if (!attachments.ok) return status(400, { error: attachments.error });
    const pingRecipients = await getPingRecipients(
      access.channel.guildId,
      content,
      replyTarget?.authorId,
      access.user.id
    );

    const message = await db.transaction(async (tx) => {
      const created = await tx.orm.public.Message.create({
        id: randomString(),
        channelId: params.id,
        authorId: access.user.id,
        content,
        replyTo: replyTo ?? null,
        nonce,
      });

      for (const attachment of attachments.value) {
        const updated = await tx.orm.public.Attachment.where({
          id: attachment.id,
          status: 'PENDING',
        }).update({ messageId: created.id, status: 'ATTACHED' });
        if (!updated) throw new Error('Attachment was already claimed');
      }

      for (const recipient of pingRecipients) {
        await tx.orm.public.MessagePing.create({
          messageId: created.id,
          userId: recipient.userId,
        });
      }

      return {
        ...created,
        attachments: attachments.value,
        pingedHandles: pingRecipients.map((recipient) => recipient.handle),
      };
    });

    const responseMessage = federatedMessageResponse(message, access.channel, access.user);
    if (server) {
      publishRealtime(server, `guildEvents:${access.channel.guildId}`, {
        type: 'message.created',
        data: responseMessage,
      });
    }

    return { message: responseMessage };
  })
  .post('/channels/:id/messages/delete', async ({ params, request, server, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const messageId = getObjectProperty(parsed.body, 'messageId');
    if (typeof messageId !== 'string') return status(400, { error: 'Invalid message ID' });

    const access = await getFederatedChannelAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });

    const existing = await db.orm.public.Message.where({ id: messageId, channelId: params.id })
      .include('attachments')
      .first();
    if (!existing) return status(404, { error: 'Message not found' });
    if (existing.authorId !== access.user.id) return status(403, { error: 'Forbidden' });

    await db.orm.public.Message.where({ id: messageId }).delete();
    await Promise.all(
      existing.attachments.map((attachment) =>
        storage
          .file(String(attachment.objectKey))
          .delete()
          .catch(() => {})
      )
    );

    if (server) {
      publishRealtime(server, `guildEvents:${access.channel.guildId}`, {
        type: 'message.deleted',
        data: {
          id: messageId,
          channelId: access.channel.id,
          guildId: access.channel.guildId,
        },
      });
    }

    return { success: true };
  })
  .post('/channels/:id/attachments/presign', async ({ params, request, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const uploadInput = attachmentPresignSchema.safeParse(parsed.body);
    if (!uploadInput.success) return status(400, { error: 'Invalid attachment metadata' });
    if (!isAllowedAttachmentType(uploadInput.data.contentType)) {
      return status(415, { error: 'Unsupported file type' });
    }

    const access = await getFederatedChannelAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });

    return createPendingAttachment({
      channelId: access.channel.id,
      guildId: access.channel.guildId,
      uploaderId: access.user.id,
      ...uploadInput.data,
    });
  })
  .post('/channels/:id/messages', async ({ params, request, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const access = await getFederatedChannelAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });

    const pagination = parseFederatedMessagePagination(parsed.body);
    if (!pagination.ok) return status(400, { error: pagination.error });

    const messages = await fetchFederatedMessagePage(
      params.id,
      pagination.limit,
      pagination.cursor
    );
    const visibleMessages = messages.slice(0, pagination.limit);
    const lastMessage = visibleMessages[visibleMessages.length - 1];

    return {
      messages: visibleMessages.map((message) =>
        federatedMessageResponse(message, access.channel, message.author)
      ),
      nextCursor:
        messages.length > pagination.limit && lastMessage
          ? encodeFederatedMessageCursor(lastMessage)
          : null,
    };
  })
  .post('/channels/:id/users', async ({ params, request, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const access = await getFederatedChannelAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });

    const members = await db.orm.public.GuildMember.where({ guildId: access.channel.guildId })
      .include('user')
      .all();

    return {
      users: members.map((member) => ({
        userId: member.user.id as string,
        username: member.user.username as string,
        displayName: (member.user.displayName as string | null) ?? (member.user.username as string),
        homeserver: member.user.homeserver as string,
        avatarUrl: (member.user.avatarUrl as string | null) ?? undefined,
        isBot: member.user.isBot as boolean,
        status: member.user.status as 'ONLINE' | 'OFFLINE',
        role: member.role as 'OWNER' | 'ADMIN' | 'MEMBER',
        joinedAt: member.joinedAt as Date,
      })),
    };
  })
  .post('/channels/:id/typing', async ({ params, request, server, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const access = await getFederatedChannelAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });

    if (server) {
      publishRealtime(server, `guildEvents:${access.channel.guildId}`, {
        type: 'channel.typing',
        data: {
          channelId: access.channel.id,
          userId: access.user.id,
          username: access.user.username,
          displayName: access.user.displayName,
          homeserver: access.user.homeserver,
          time: new Date().toISOString(),
        },
      });
    }

    return { ok: true };
  })
  .post('/channels/:id/call/token', async ({ params, request, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const access = await getFederatedChannelAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });
    if (access.channel.type !== 'VOICE') return status(404, { error: 'Channel not right' });

    const voiceConfig = getConfig().voice;
    const token = new AccessToken(voiceConfig.livekit_key, voiceConfig.livekit_secret, {
      identity: access.user.id,
      name: access.user.displayName || access.user.username,
      ttl: '5m',
      metadata: JSON.stringify({
        channelId: access.channel.id,
        guildId: access.channel.guildId,
        userId: access.user.id,
      }),
    });

    token.addGrant({
      roomJoin: true,
      room: `voice:${access.channel.id}`,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return {
      serverUrl: voiceConfig.livekit_url,
      token: await token.toJwt(),
    };
  })
  .post('/channels/:id/voice-state', async ({ params, request, server, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const connected = getObjectProperty(parsed.body, 'connected');
    if (typeof connected !== 'boolean') return status(400, { error: 'Invalid voice state' });

    const access = await getFederatedChannelAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });
    if (access.channel.type !== 'VOICE') return status(404, { error: 'Channel not right' });

    const state = {
      guildId: access.channel.guildId,
      channelId: access.channel.id,
      userId: access.user.id,
      name: access.user.displayName || access.user.username,
    };

    if (connected) setVoicePresence(state);
    else removeVoicePresence(state.userId);

    if (server) {
      publishRealtime(server, `guildEvents:${state.guildId}`, {
        type: 'voice.state.changed',
        data: { ...state, connected },
      });
    }

    return { state };
  })
  .post('/guilds/:id/users/status', async ({ params, request, server, status }) => {
    const parsed = await verifiedFederationJsonBody(request);
    if (!parsed.ok) return status(parsed.status, { error: parsed.error });

    const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
    if (!userPayload) return status(400, { error: 'Invalid federation user' });
    if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
      return status(401, { error: 'Federation user homeserver mismatch' });
    }

    const nextStatus = getObjectProperty(parsed.body, 'status');
    if (nextStatus !== 'ONLINE' && nextStatus !== 'OFFLINE') {
      return status(400, { error: 'Invalid federation user status' });
    }

    const access = await getFederatedGuildAccess(params.id, userPayload);
    if (!access.ok) return status(access.status, { error: access.error });

    await db.orm.public.User.where({ id: access.user.id }).update({
      displayName: userPayload.displayName,
      avatarUrl: userPayload.avatarUrl,
      isBot: userPayload.isBot,
      status: nextStatus,
      updatedAt: new Date(),
    });

    if (server) {
      publishRealtime(server, `guildEvents:${params.id}`, {
        type: 'user.status.changed',
        data: {
          userId: access.user.id,
          status: nextStatus,
        },
      });
    }

    return { ok: true };
  })
  .ws('/realtime/guilds/:id', {
    async open(ws) {
      const headers = new Headers();
      const query = ws.data.query as Record<string, string | undefined>;
      for (const key of [
        'X-Novarum-Homeserver',
        'X-Novarum-Key-Id',
        'X-Novarum-Date',
        'X-Novarum-Nonce',
        'X-Novarum-Body-SHA256',
        'X-Novarum-Signature',
      ]) {
        const value = query[key];
        if (value) headers.set(key, value);
      }

      const request = new Request(ws.data.request.url, {
        method: 'GET',
        headers,
      });
      const signedPath = `/federation/realtime/guilds/${encodeURIComponent(ws.data.params.id)}`;
      const verification = await verifyFederationRequest(request, '', signedPath);
      if (!verification.ok) {
        ws.close(1008, verification.error);
        return;
      }

      const members = await db.orm.public.GuildMember.where({ guildId: ws.data.params.id })
        .include('user')
        .all();
      const hasAccess = members.some(
        (member) => member.user.homeserver === verification.origin.homeserver
      );
      if (!hasAccess) {
        ws.close(1008, 'Forbidden');
        return;
      }

      ws.subscribe(`guildEvents:${ws.data.params.id}`);
      ws.send(
        JSON.stringify({
          type: 'voice.states.snapshot',
          data: {
            guildIds: [ws.data.params.id],
            states: voicePresenceForGuilds([ws.data.params.id]),
          },
        })
      );
    },
    message() {
      // Server-to-server realtime is publish-only for now.
    },
  });

async function verifiedFederationJsonBody(
  request: Request
): Promise<
  | { ok: true; origin: Awaited<ReturnType<typeof discoverRemoteAnchor>>; body: unknown }
  | { ok: false; status: 400 | 401 | 404; error: string }
> {
  const rawBody = await request.text();
  const verification = await verifyFederationRequest(request, rawBody);
  if (!verification.ok) return verification;

  try {
    return { ok: true, origin: verification.origin, body: JSON.parse(rawBody) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'Invalid federation JSON body' };
  }
}

function parseFederationUserPayload(value: unknown): FederationUserPayload | null {
  if (!value || typeof value !== 'object') return null;

  const username = getObjectProperty(value, 'username');
  const homeserver = getObjectProperty(value, 'homeserver');
  const displayName = getObjectProperty(value, 'displayName');
  const avatarUrl = getObjectProperty(value, 'avatarUrl');
  const isBot = getObjectProperty(value, 'isBot');

  if (
    typeof username !== 'string' ||
    username.length < 2 ||
    username.length > 32 ||
    !usernamePattern.test(username) ||
    typeof homeserver !== 'string' ||
    homeserver.length < 1 ||
    homeserver.length > 255 ||
    (displayName !== null && (typeof displayName !== 'string' || displayName.length > 64)) ||
    (avatarUrl !== null && typeof avatarUrl !== 'string') ||
    typeof isBot !== 'boolean'
  ) {
    return null;
  }

  return { username, homeserver, displayName, avatarUrl, isBot };
}

function getObjectProperty(value: unknown, key: string) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function parseFederatedMessagePagination(
  body: unknown
):
  | { ok: true; limit: number; cursor: { createdAt: Date; id: string } | null }
  | { ok: false; error: string } {
  const rawLimit = getObjectProperty(body, 'limit');
  const rawCursor = getObjectProperty(body, 'cursor');

  const limit =
    rawLimit === undefined
      ? federatedMessagePageSize
      : typeof rawLimit === 'number' && Number.isInteger(rawLimit)
        ? rawLimit
        : null;
  if (limit === null || limit < 1 || limit > maxFederatedMessagePageSize) {
    return { ok: false, error: 'Invalid message page limit' };
  }

  if (rawCursor === undefined || rawCursor === null) {
    return { ok: true, limit, cursor: null };
  }
  if (typeof rawCursor !== 'string') {
    return { ok: false, error: 'Invalid message cursor' };
  }

  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as unknown;
    const createdAt = getObjectProperty(decoded, 'createdAt');
    const id = getObjectProperty(decoded, 'id');
    if (typeof createdAt !== 'string' || typeof id !== 'string') {
      return { ok: false, error: 'Invalid message cursor' };
    }

    const createdAtDate = new Date(createdAt);
    if (Number.isNaN(createdAtDate.getTime())) {
      return { ok: false, error: 'Invalid message cursor' };
    }

    return { ok: true, limit, cursor: { createdAt: createdAtDate, id } };
  } catch {
    return { ok: false, error: 'Invalid message cursor' };
  }
}

function encodeFederatedMessageCursor(message: { createdAt: Date | string; id: string }) {
  const createdAt =
    message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt;

  return Buffer.from(JSON.stringify({ createdAt, id: message.id }), 'utf8').toString('base64url');
}

async function fetchFederatedMessagePage(
  channelId: string,
  limit: number,
  cursor: { createdAt: Date; id: string } | null
) {
  const query = db.orm.public.Message.where({ channelId })
    .include('author')
    .include('attachments')
    .orderBy([(message) => message.createdAt.asc(), (message) => message.id.asc()])
    .take(limit + 1);

  if (!cursor) return await query.all();

  return await query.cursor(cursor).all();
}

async function upsertFederatedUser(input: FederationUserPayload) {
  const now = new Date();
  const existingUser = await db.orm.public.User.where({
    username: input.username,
    homeserver: input.homeserver,
  }).first();

  if (!existingUser) {
    return await db.orm.public.User.create({
      id: randomString(),
      username: input.username,
      homeserver: input.homeserver,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      isBot: input.isBot,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.orm.public.User.where({ id: existingUser.id }).update({
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    isBot: input.isBot,
    updatedAt: now,
  });

  return {
    ...existingUser,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    isBot: input.isBot,
    updatedAt: now,
  };
}

async function getFederatedChannelAccess(channelId: string, userPayload: FederationUserPayload) {
  const channel = await db.orm.public.Channel.where({ id: channelId }).first();
  if (!channel) return { ok: false as const, status: 404 as const, error: 'Channel not found' };

  const user = await db.orm.public.User.where({
    username: userPayload.username,
    homeserver: userPayload.homeserver,
  }).first();
  if (!user) return { ok: false as const, status: 403 as const, error: 'Forbidden' };

  await db.orm.public.User.where({ id: user.id }).update({
    displayName: userPayload.displayName,
    avatarUrl: userPayload.avatarUrl,
    isBot: userPayload.isBot,
    updatedAt: new Date(),
  });

  const membership = await db.orm.public.GuildMember.where({
    guildId: channel.guildId,
    userId: user.id,
  }).first();
  if (!membership) return { ok: false as const, status: 403 as const, error: 'Forbidden' };

  return {
    ok: true as const,
    channel,
    user: {
      ...user,
      displayName: userPayload.displayName,
      avatarUrl: userPayload.avatarUrl,
      isBot: userPayload.isBot,
    },
  };
}

async function getFederatedGuildAccess(guildId: string, userPayload: FederationUserPayload) {
  const guild = await db.orm.public.Guild.where({ id: guildId }).first();
  if (!guild) return { ok: false as const, status: 404 as const, error: 'Guild not found' };

  const user = await db.orm.public.User.where({
    username: userPayload.username,
    homeserver: userPayload.homeserver,
  }).first();
  if (!user) return { ok: false as const, status: 403 as const, error: 'Forbidden' };

  const membership = await db.orm.public.GuildMember.where({
    guildId,
    userId: user.id,
  }).first();
  if (!membership) return { ok: false as const, status: 403 as const, error: 'Forbidden' };

  return {
    ok: true as const,
    guild,
    user,
  };
}

function federatedMessageResponse(message: any, channel: { guildId: string }, author: any) {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: channel.guildId,
    content: message.content,
    nonce: message.nonce,
    replyTo: message.replyTo ?? null,
    pingedHandles: Array.isArray(message.pingedHandles) ? message.pingedHandles : [],
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map(attachmentPayload)
      : [],
    createdAt:
      message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
    author: {
      id: author.id,
      username: author.displayName || author.username,
      avatar: author.avatarUrl ?? null,
    },
  };
}

function federationAttachmentIds(body: unknown) {
  const attachmentIds = getObjectProperty(body, 'attachmentIds');
  if (attachmentIds === undefined) return { ok: true as const, value: [] as string[] };
  if (
    !Array.isArray(attachmentIds) ||
    attachmentIds.length > maxAttachmentCount ||
    attachmentIds.some((id) => typeof id !== 'string') ||
    new Set(attachmentIds).size !== attachmentIds.length
  ) {
    return { ok: false as const, error: 'Invalid attachment IDs' };
  }

  return { ok: true as const, value: attachmentIds as string[] };
}

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
