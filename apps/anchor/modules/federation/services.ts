import Elysia from 'elysia';
import { discoverRemoteAnchor } from '../../utils/discovery';
import { isNonceUsed, storeNonce, verifyMessage } from '../../utils/keys';
import { getConfig } from '../../utils/config';
import crypto from 'node:crypto';
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
  presignedUploadSchema,
} from '../../utils/attachments';
import { createPendingAttachment } from '../upload/services';
import { getPingRecipients, messageEdited, verifyPendingAttachments } from '../message/services';
import { storage } from '../../utils/services/storage';
import { z } from 'zod';
import { isMessageAfter } from '../../utils/messageCursor';
import {
  db,
  guildMembers,
  messages,
  attachments as dbAttachments,
  messagePings,
  users,
} from '../../src/db';
import { and, eq, sql } from 'drizzle-orm';
import { publicUser, publicUserSchema, userProfile } from '../../utils/publicUser';
import {
  federationUserSchema,
  type FederationUserPayload,
  upsertFederatedUser,
} from '../../utils/federationPayload';
import {
  applyFriendSnapshot,
  friendAuthority,
  friendCommandSchema,
  friendSnapshotSchema,
  snapshotFor,
  syncFriendship,
  transitionFriendship,
} from '../friends/model';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import {
  attachmentResponseSchema,
  channelResponseSchema,
  channelUsersResponseSchema,
  federatedGuildResponseSchema,
  guildInviteResponseSchema,
  messageResponseBaseSchema,
} from '../../src/db/zod';

const federatedMessagePageSize = 50;
const maxFederatedMessagePageSize = 100;
const okResponseSchema = z.object({ ok: z.boolean() });
const successResponseSchema = z.object({ success: z.boolean() });
const federatedMessageSchema = messageResponseBaseSchema.extend({
  guildId: z.string(),
  pingedHandles: z.array(z.string()),
  attachments: z.array(attachmentResponseSchema),
  author: publicUserSchema,
});
const friendCommandErrorSchema = z.object({
  error: z.string(),
  snapshot: friendSnapshotSchema.optional(),
});
const unreadMentionChannelsSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      cursor: z
        .object({
          createdAt: z.iso.datetime(),
          id: z.string().min(1),
        })
        .nullable(),
    })
  )
  .max(1000);

type PingMessage = { id: string; channelId: string; createdAt: Date | string };

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
  if (await isNonceUsed(nonce, homeserver)) {
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

export const federation = new Elysia({ prefix: '/federation', tags: ['Federation'] })
  .get(
    '/users/:username',
    async ({ params, status }) => {
      const { username } = params;
      if (!username) {
        return status(400, { error: 'Missing username' });
      }

      const user = await db.query.users.findFirst({
        where: {
          username,
          homeserver: getConfig().server.homeserver,
        },
      });
      if (!user) {
        return status(404, { error: 'User not found' });
      }

      const { userId: _, ...profile } = publicUser(user);
      return { user: { ...profile, handle: `@${user.username}:${user.homeserver}` } };
    },
    {
      response: {
        200: z.object({ user: federationUserSchema.extend({ handle: z.string() }) }),
        400: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/friends/command',
    async ({ request, server, status }) => {
      const verified = await verifiedFederationJsonBody(request);
      if (!verified.ok) return status(verified.status, { error: verified.error });

      const parsed = friendCommandSchema.safeParse(verified.body);
      if (!parsed.success) return status(400, { error: 'Invalid friendship command.' });

      const command = parsed.data;
      const origin = verified.origin.homeserver;
      const localHomeserver = getConfig().server.homeserver;
      if (command.actor.homeserver.toLowerCase() !== origin.toLowerCase() || command.actor.isBot) {
        return status(403, { error: 'Friend actor does not belong to the sending homeserver.' });
      }
      if (friendAuthority(origin, localHomeserver) !== localHomeserver.toLowerCase()) {
        return status(400, { error: 'This homeserver is not authoritative for this friendship.' });
      }

      const peer = await db.query.users.findFirst({
        where: { username: command.peerUsername, homeserver: localHomeserver },
      });
      if (!peer || peer.isBot) return status(404, { error: 'User not found.' });

      const actor = await upsertFederatedUser(command.actor);
      const result = await transitionFriendship(
        actor,
        peer,
        actor.id,
        command.action,
        command.expectedVersion,
        true,
        command.commandId
      );

      if (!result.ok) {
        if (!result.relationship) return status(result.status, { error: result.error });

        const requestedBy = await db.query.users.findFirst({
          where: { id: result.relationship.requestedById },
        });
        if (!requestedBy) return status(500, { error: 'Friendship requester not found.' });
        return status(result.status, {
          error: result.error,
          snapshot: snapshotFor(result.relationship, peer, actor, requestedBy),
        });
      }

      const requestedBy = await db.query.users.findFirst({
        where: { id: result.relationship.requestedById },
      });
      if (!requestedBy) return status(500, { error: 'Friendship requester not found.' });

      if (result.changed && server) {
        publishRealtime(server, `userEvents:${peer.id}`, { type: 'friends.changed', data: {} });
      }
      await syncFriendship(result.relationship);

      return { snapshot: snapshotFor(result.relationship, peer, actor, requestedBy) };
    },
    {
      response: {
        200: z.object({ snapshot: friendSnapshotSchema }),
        400: friendCommandErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: friendCommandErrorSchema,
        500: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/friends/sync',
    async ({ request, server, status }) => {
      const verified = await verifiedFederationJsonBody(request);
      if (!verified.ok) return status(verified.status, { error: verified.error });

      const parsed = friendSnapshotSchema.safeParse(verified.body);
      if (!parsed.success) return status(400, { error: 'Invalid friendship snapshot.' });

      const snapshot = parsed.data;
      const origin = verified.origin.homeserver;
      const localHomeserver = getConfig().server.homeserver;
      if (
        snapshot.remoteUser.homeserver.toLowerCase() !== origin.toLowerCase() ||
        friendAuthority(origin, localHomeserver) !== origin.toLowerCase()
      ) {
        return status(403, { error: 'Invalid friendship authority.' });
      }

      const localUser = await db.query.users.findFirst({
        where: { username: snapshot.localUsername, homeserver: localHomeserver },
      });
      if (!localUser || localUser.isBot) return status(404, { error: 'User not found.' });

      const result = await applyFriendSnapshot(localUser, snapshot);
      if (!result.ok) return status(result.status, { error: result.error });

      if (result.changed && server) {
        publishRealtime(server, `userEvents:${localUser.id}`, {
          type: 'friends.changed',
          data: {},
        });
      }
      return { version: result.relationship.version };
    },
    {
      response: {
        200: z.object({ version: friendSnapshotSchema.shape.version }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
      },
    }
  )
  .get(
    '/invites/:code',
    async ({ params, status }) => {
      const invite = await db.query.guildInvites.findFirst({
        where: {
          code: params.code,
        },
      });
      if (!invite || isExpired(invite.expiresAt)) {
        return status(404, { error: 'Invite not found' });
      }

      const guild = await db.query.guilds.findFirst({
        where: { id: invite.guildId },
      });

      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }

      const members = await db.query.guildMembers.findMany({
        where: { guildId: guild.id },
      });

      return {
        invite: {
          code: invite.code,
          expiresAt: invite.expiresAt?.toISOString() ?? null,
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
    },
    {
      response: {
        200: z.object({
          invite: guildInviteResponseSchema.pick({ code: true, expiresAt: true }),
          guild: federatedGuildResponseSchema.extend({
            memberCount: z.number().int().nonnegative(),
          }),
        }),
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/unread-mentions',
    async ({ request, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
      if (!userPayload) return status(400, { error: 'Invalid federation user' });
      if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }

      const input = unreadMentionChannelsSchema.safeParse(
        getObjectProperty(parsed.body, 'channels')
      );
      if (!input.success) return status(400, { error: 'Invalid channels' });

      const user = await db.query.users.findFirst({
        where: {
          username: userPayload.username,
          homeserver: userPayload.homeserver,
        },
      });
      if (!user) return status(403, { error: 'Forbidden' });

      const channelIds = [...new Set(input.data.map((channel) => channel.id))];
      // TODO: holy moly i really have to refactor this code
      const [memberships, channels, pings] = await Promise.all([
        db.query.guildMembers.findMany({ where: { userId: user.id } }),
        channelIds.length
          ? await db.query.channels.findMany({
              where: {
                id: {
                  in: channelIds,
                },
              },
            })
          : [],
        db.query.messagePings.findMany({ where: { userId: user.id }, with: { message: true } }),
      ]);
      const guildIds = new Set(memberships.map((membership) => membership.guildId));
      if (
        channels.length !== channelIds.length ||
        channels.some((channel) => !guildIds.has(channel.guildId))
      ) {
        return status(403, { error: 'Forbidden' });
      }

      const cursorByChannel = new Map(input.data.map((channel) => [channel.id, channel.cursor]));
      const counts = new Map(channelIds.map((channelId) => [channelId, 0]));
      for (const ping of pings) {
        const message = ping.message as PingMessage;
        if (
          counts.has(message.channelId) &&
          isMessageAfter(message, cursorByChannel.get(message.channelId) ?? undefined)
        ) {
          counts.set(message.channelId, counts.get(message.channelId)! + 1);
        }
      }

      return {
        channels: channelIds.map((id) => ({ id, mention: counts.get(id)! })),
      };
    },
    {
      response: {
        200: z.object({
          channels: z.array(z.object({ id: z.string(), mention: z.number().int().nonnegative() })),
        }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/invites/:code/accept',
    async ({ params, request, server, status }) => {
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

      const invite = await db.query.guildInvites.findFirst({
        where: { code: params.code },
      });
      if (!invite || isExpired(invite.expiresAt)) {
        return status(404, { error: 'Invite not found' });
      }

      const guild = await db.query.guilds.findFirst({
        where: { id: invite.guildId },
      });
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }

      const user = await upsertFederatedUser(userPayload);
      if (!user) {
        return status(500, { error: 'Failed to upsert user' });
      }

      const membership = await db.query.guildMembers.findFirst({
        where: { guildId: guild.id, userId: user.id },
      });

      if (!membership) {
        await db.transaction(async (tx) => {
          // increase by one so we can put the guild at position 0
          await tx
            .update(guildMembers)
            .set({ position: sql`${guildMembers.position} + 1` })
            .where(and(eq(guildMembers.userId, user.id)));

          await tx.insert(guildMembers).values({
            guildId: invite.guildId,
            userId: user.id,
            role: 'MEMBER',
            position: 0,
          });
        });

        if (server) {
          publishRealtime(server, `guildEvents:${guild.id}`, {
            type: 'member.joined',
            data: {
              guildId: guild.id,
              user: {
                ...publicUser(user),
                status: user.status as 'ONLINE' | 'OFFLINE',
              },
            },
          });
        }
      }

      const channels = await db.query.channels.findMany({
        where: { guildId: guild.id },
        orderBy: { position: 'asc' },
      });

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
      response: {
        200: z.object({
          guild: federatedGuildResponseSchema,
          channels: z.array(channelResponseSchema),
        }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        500: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/messages/send',
    async ({ params, request, server, status }) => {
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
        (content !== null && typeof content !== 'string') ||
        typeof nonce !== 'string' ||
        (replyTo != null && typeof replyTo !== 'string')
      ) {
        return status(400, { error: 'Invalid federation message' });
      }
      if (!attachmentIdsResult.ok) return status(400, { error: attachmentIdsResult.error });
      if (content === null && attachmentIdsResult.value.length === 0) {
        return status(400, { error: 'Message content or an attachment is required' });
      }

      const access = await getFederatedChannelAccess(params.id, userPayload);
      if (!access.ok) return status(access.status, { error: access.error });

      const replyTarget = replyTo
        ? await db.query.messages.findFirst({
            where: { id: replyTo, channelId: params.id },
          })
        : null;
      if (replyTo && !replyTarget) {
        return status(400, { error: 'Invalid reply target' });
      }

      const priorMsg = await db.query.messages.findFirst({
        where: {
          authorId: access.user.id,
          nonce,
        },
        with: { attachments: true },
      });
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
        const [created] = await tx
          .insert(messages)
          .values({
            id: randomString(),
            channelId: params.id,
            authorId: access.user.id,
            content,
            replyTo: replyTo ?? null,
            nonce,
          })
          .returning();
        if (!created) throw new Error('Failed to create message');

        for (const attachment of attachments.value) {
          const updated = await tx
            .update(dbAttachments)
            .set({
              messageId: created.id,
              status: 'ATTACHED',
            })
            .where(and(eq(dbAttachments.id, attachment.id), eq(dbAttachments.status, 'PENDING')))
            .returning();
          if (updated.length === 0) throw new Error('Attachment was already claimed');
        }

        for (const recipient of pingRecipients) {
          await tx.insert(messagePings).values({
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
    },
    {
      response: {
        200: z.object({ message: federatedMessageSchema }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        409: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/messages/edit',
    async ({ params, request, server, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
      if (!userPayload) return status(400, { error: 'Invalid federation user' });
      if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }

      const messageId = getObjectProperty(parsed.body, 'messageId');
      const content = getObjectProperty(parsed.body, 'content');
      if (typeof messageId !== 'string') return status(400, { error: 'Invalid message ID' });
      if (content !== null && typeof content !== 'string') {
        return status(400, { error: 'Invalid federation message' });
      }

      const access = await getFederatedChannelAccess(params.id, userPayload);
      if (!access.ok) return status(access.status, { error: access.error });

      const existing = await db.query.messages.findFirst({
        where: { id: messageId, channelId: params.id },
        with: { attachments: true },
      });
      if (!existing) return status(404, { error: 'Message not found' });
      if (existing.authorId !== access.user.id) return status(403, { error: 'Forbidden' });
      if (content === null && existing.attachments.length === 0) {
        return status(400, { error: 'Message content or an attachment is required' });
      }

      const replyTarget = existing.replyTo
        ? await db.query.messages.findFirst({
            where: { id: existing.replyTo, channelId: params.id },
          })
        : null;
      const pingRecipients = await getPingRecipients(
        access.channel.guildId,
        content,
        replyTarget?.authorId,
        access.user.id
      );

      const message = await db.transaction(async (tx) => {
        await tx.delete(messagePings).where(eq(messagePings.messageId, existing.id));
        for (const recipient of pingRecipients) {
          await tx.insert(messagePings).values({
            messageId: existing.id,
            userId: recipient.userId,
          });
        }
        return (
          await tx.update(messages).set({ content }).where(eq(messages.id, existing.id)).returning()
        )[0];
      });

      const responseMessage = federatedMessageResponse(
        {
          ...message,
          attachments: existing.attachments,
          pingedHandles: pingRecipients.map((recipient) => recipient.handle),
        },
        access.channel,
        access.user
      );
      if (server) {
        publishRealtime(server, `guildEvents:${access.channel.guildId}`, {
          type: 'message.updated',
          data: responseMessage,
        });
      }

      return { message: responseMessage };
    },
    {
      response: {
        200: z.object({ message: federatedMessageSchema }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/messages/delete',
    async ({ params, request, server, status }) => {
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

      const existing = await db.query.messages.findFirst({
        where: { id: messageId, channelId: params.id },
        with: { attachments: true },
      });
      if (!existing) return status(404, { error: 'Message not found' });
      if (existing.authorId !== access.user.id) return status(403, { error: 'Forbidden' });

      await db.delete(messages).where(eq(messages.id, messageId));
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
    },
    {
      response: {
        200: successResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/attachments/presign',
    async ({ params, request, status }) => {
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
    },
    {
      response: {
        200: presignedUploadSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        415: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/messages',
    async ({ params, request, status }) => {
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
    },
    {
      response: {
        200: z.object({
          messages: z.array(federatedMessageSchema),
          nextCursor: z.string().nullable(),
        }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/users',
    async ({ params, request, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
      if (!userPayload) return status(400, { error: 'Invalid federation user' });
      if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }

      const access = await getFederatedChannelAccess(params.id, userPayload);
      if (!access.ok) return status(access.status, { error: access.error });

      const members = await db.query.guildMembers.findMany({
        where: { guildId: access.channel.guildId },
        with: { user: true },
      });

      return {
        // TODO: cba removing typings now that we have moved to drizzle
        // ...except for those enums, of course.
        users: members.map((member) => ({
          ...publicUser(member.user),
          status: member.user.status as 'ONLINE' | 'OFFLINE',
          role: member.role as 'OWNER' | 'ADMIN' | 'MEMBER',
          joinedAt: member.joinedAt.toISOString(),
        })),
      };
    },
    {
      response: {
        200: channelUsersResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/typing',
    async ({ params, request, server, status }) => {
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
    },
    {
      response: {
        200: okResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/call/token',
    async ({ params, request, status }) => {
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
    },
    {
      response: {
        200: z.object({ serverUrl: z.string(), token: z.string() }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/voice-state',
    async ({ params, request, server, status }) => {
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
    },
    {
      response: {
        200: z.object({
          state: z.object({
            guildId: z.string(),
            channelId: z.string(),
            userId: z.string(),
            name: z.string(),
          }),
        }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/guilds/:id/users/status',
    async ({ params, request, server, status }) => {
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

      await db
        .update(users)
        .set({
          ...userProfile(userPayload),
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(users.id, access.user.id));

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
    },
    {
      response: {
        200: okResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
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

      const members = await db.query.guildMembers.findMany({
        where: { guildId: ws.data.params.id },
        with: { user: true },
      });
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
      // server-to-server realtime is publish-only for now.
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
  const result = federationUserSchema.safeParse(value);
  return result.success ? result.data : null;
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

// this function was made quite a bit more long and complicated after moving to drizzle,
// but oh well... i like drizzle more now :)
async function fetchFederatedMessagePage(
  channelId: string,
  limit: number,
  cursor: { createdAt: Date; id: string } | null
) {
  return db.query.messages.findMany({
    where: cursor
      ? {
          channelId,
          OR: [
            { createdAt: { gt: cursor.createdAt } },
            { createdAt: { eq: cursor.createdAt }, id: { gt: cursor.id } },
          ],
        }
      : { channelId },
    with: {
      author: true,
      attachments: true,
    },
    orderBy: {
      createdAt: 'asc',
      id: 'asc',
    },
    limit: limit + 1,
  });
}
async function getFederatedChannelAccess(channelId: string, userPayload: FederationUserPayload) {
  const channel = await db.query.channels.findFirst({
    where: { id: channelId },
  });
  if (!channel) return { ok: false as const, status: 404 as const, error: 'Channel not found' };

  const user = await db.query.users.findFirst({
    where: {
      username: userPayload.username,
      homeserver: userPayload.homeserver,
    },
  });
  if (!user) return { ok: false as const, status: 403 as const, error: 'Forbidden' };

  await db
    .update(users)
    .set({
      ...userProfile(userPayload),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  const membership = await db.query.guildMembers.findFirst({
    where: {
      guildId: channel.guildId,
      userId: user.id,
    },
  });
  if (!membership) return { ok: false as const, status: 403 as const, error: 'Forbidden' };

  return {
    ok: true as const,
    channel,
    user: {
      ...user,
      ...userProfile(userPayload),
    },
  };
}

async function getFederatedGuildAccess(guildId: string, userPayload: FederationUserPayload) {
  const guild = await db.query.guilds.findFirst({
    where: { id: guildId },
  });
  if (!guild) return { ok: false as const, status: 404 as const, error: 'Guild not found' };

  const user = await db.query.users.findFirst({
    where: {
      username: userPayload.username,
      homeserver: userPayload.homeserver,
    },
  });
  if (!user) return { ok: false as const, status: 403 as const, error: 'Forbidden' };

  const membership = await db.query.guildMembers.findFirst({
    where: {
      guildId,
      userId: user.id,
    },
  });
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
    edited: messageEdited(message),
    editedTime: messageEdited(message) ? new Date(message.updatedAt).toISOString() : undefined,
    pingedHandles: Array.isArray(message.pingedHandles) ? message.pingedHandles : [],
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map(attachmentPayload)
      : [],
    createdAt:
      message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
    author: publicUser(author),
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
