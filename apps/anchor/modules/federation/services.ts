import Elysia from 'elysia';
import { discoverRemoteAnchor } from '../../utils/discovery';
import { isNonceUsed, storeNonce, verifyMessage } from '../../utils/keys';
import { getConfig } from '../../utils/config';
import crypto from 'node:crypto';
import { randomString } from '../../utils/randomString';
import { publishRealtime, publishToChannel } from '../../utils/publishRealtime';
import { canAccessChannel } from '../../utils/channelAccess';
import { makeFederatedChannelId, makeFederatedGuildId } from '../../utils/federationIds';
import { dmResponse, latestMessages, openLocalDm, upsertDmShadow } from '../dm/services';
import { ensureFederatedDmRealtimeBridge } from '../../utils/federationRealtime';
import { AccessToken } from 'livekit-server-sdk';
import {
  removeVoicePresence,
  setVoicePresence,
  voicePresenceForChannels,
  voicePresenceForGuilds,
} from '../../utils/services/livekit';
import {
  attachmentPayload,
  attachmentPresignSchema,
  isAllowedAttachmentType,
  maxAttachmentCount,
  presignedUploadSchema,
} from '../../utils/attachments';
import { dmRecipients, maxSnippetLength, notifyInBackground, notifyLocal } from '../../utils/notify';
import { createPendingAttachment } from '../upload/services';
import { getPingRecipients, messageEdited, verifyPendingAttachments } from '../message/services';
import { storage } from '../../utils/services/storage';
import { z } from 'zod';
import { isMessageAfter } from '../../utils/messageCursor';
import {
  db,
  guildMembers,
  channels as dbChannels,
  channelMembers,
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
  findFriendship,
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
  dmLatestResponseSchema,
  dmOpenResponseSchema,
  federatedGuildResponseSchema,
  guildInviteResponseSchema,
  messageResponseBaseSchema,
  userStatusSchema,
} from '../../src/db/zod';

const federatedMessagePageSize = 50;
const maxFederatedMessagePageSize = 100;
const okResponseSchema = z.object({ ok: z.boolean() });
const successResponseSchema = z.object({ success: z.boolean() });
const federatedMessageSchema = messageResponseBaseSchema.extend({
  guildId: z.string().nullable(),
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

// text only: the receiving end shows it as plain text, never as html
const federationPushSchema = z.object({
  guildId: z.string().min(1).nullable(),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  author: z.object({
    username: z.string().min(1).max(64),
    displayName: z.string().max(64).nullable(),
    homeserver: z.string().min(1).max(255),
    avatarUrl: z.url().nullable(),
  }),
  snippet: z
    .string()
    .nullable()
    .transform((snippet) => snippet?.slice(0, maxSnippetLength) ?? null),
  handles: z.array(z.string().max(300)).min(1).max(1000),
});
const maxPushesPerMinute = 600;
const pushWindows = new Map<string, { start: number; count: number }>();

// a fixed window per sending homeserver, so one noisy server can't flood push services
function allowFederatedPush(homeserver: string) {
  const now = Date.now();
  const window = pushWindows.get(homeserver);
  if (!window || now - window.start > 60_000) {
    pushWindows.set(homeserver, { start: now, count: 1 });
    return true;
  }
  return ++window.count <= maxPushesPerMinute;
}

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
          homeserver: userPayload.homeserver.toLowerCase(),
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
        channels.some((channel) => !channel.guildId || !guildIds.has(channel.guildId))
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
    '/push',
    async ({ request, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const origin = parsed.origin.homeserver;
      if (!allowFederatedPush(origin)) return status(429, { error: 'Too many pushes' });

      const input = federationPushSchema.safeParse(parsed.body);
      if (!input.success) return status(400, { error: 'Invalid push' });

      // the ids are rebuilt from the sender's homeserver, so a server can only ever push
      // for its own guilds and DMs
      const guildId = input.data.guildId && makeFederatedGuildId(origin, input.data.guildId);
      const channelId = makeFederatedChannelId(origin, input.data.channelId);

      const localHomeserver = getConfig().server.homeserver.toLowerCase();
      const wanted = input.data.handles.flatMap((handle) => {
        const [, username, homeserver] = handle.match(/^@([^:]+):(.+)$/) ?? [];
        return username && homeserver?.toLowerCase() === localHomeserver ? [username] : [];
      });
      const [members, users] = await Promise.all([
        guildId
          ? db.query.guildMembers.findMany({ where: { guildId } })
          : db.query.channelMembers.findMany({ where: { channelId } }),
        wanted.length
          ? db.query.users.findMany({ where: { username: { in: wanted }, homeserver: getConfig().server.homeserver } })
          : [],
      ]);
      // anything that is not a local member of that guild or DM is silently dropped
      const memberIds = new Set(members.map((member) => member.userId));
      const userIds = users.filter((user) => memberIds.has(user.id)).map((user) => user.id);

      await notifyLocal(userIds, {
        guildId,
        channelId,
        messageId: input.data.messageId,
        author: input.data.author,
        snippet: input.data.snippet,
      });

      return { ok: true };
    },
    {
      response: {
        200: okResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
        429: genericResponseErrorSchema,
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
          guildId: channel.guildId!,
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

      const access = await getFederatedChannelAccess(params.id, userPayload, true);
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

        // a new message reopens the DM for everyone who had closed it.
        if (!access.channel.guildId) {
          await tx
            .update(channelMembers)
            .set({ closed: false })
            .where(eq(channelMembers.channelId, params.id));
        }

        return {
          ...created,
          attachments: attachments.value,
          pingedHandles: pingRecipients.map((recipient) => recipient.handle),
        };
      });

      const responseMessage = federatedMessageResponse(message, access.channel, access.user);
      if (server) {
        await publishToChannel(server, access.channel, {
          type: 'message.created',
          data: responseMessage,
        });
      }
      notifyInBackground(
        { ...message, author: access.user },
        access.channel,
        access.channel.guildId ? pingRecipients : dmRecipients(access.channel.id)
      );

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

      // anyone already pinged by the original message was already notified
      const alreadyPinged = new Set(
        (await db.query.messagePings.findMany({ where: { messageId: existing.id } })).map(
          (ping) => ping.userId
        )
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
        await publishToChannel(server, access.channel, {
          type: 'message.updated',
          data: responseMessage,
        });
      }
      notifyInBackground(
        { ...message!, author: access.user },
        access.channel,
        pingRecipients.filter((recipient) => !alreadyPinged.has(recipient.userId))
      );

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
        await publishToChannel(server, access.channel, {
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

      const access = await getFederatedChannelAccess(params.id, userPayload, true);
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
      // this route only lists guild rosters; DMs have no roster to speak of.
      if (!access.channel.guildId) return { users: [] };

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

      const access = await getFederatedChannelAccess(params.id, userPayload, true);
      if (!access.ok) return status(access.status, { error: access.error });

      if (server) {
        await publishToChannel(server, access.channel, {
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

      const access = await getFederatedChannelAccess(params.id, userPayload, true);
      if (!access.ok) return status(access.status, { error: access.error });
      if (access.channel.type !== 'VOICE' && access.channel.type !== 'DM') {
        return status(404, { error: 'Channel not right' });
      }

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
      if (access.channel.type !== 'VOICE' && access.channel.type !== 'DM') {
        return status(404, { error: 'Channel not right' });
      }

      const state = {
        guildId: access.channel.guildId,
        channelId: access.channel.id,
        userId: access.user.id,
        name: access.user.displayName || access.user.username,
      };

      if (connected) setVoicePresence(state);
      else removeVoicePresence(state.userId);

      if (server) {
        await publishToChannel(server, access.channel, {
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
            guildId: z.string().nullable(),
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
    '/friends/status',
    async ({ request, server, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
      if (!userPayload) return status(400, { error: 'Invalid federation user' });
      if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }

      const statusResult = userStatusSchema.safeParse(getObjectProperty(parsed.body, 'status'));
      if (!statusResult.success) return status(400, { error: 'Invalid federation user status' });
      const nextStatus = statusResult.data;

      const [remote] = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.username, userPayload.username),
            sql`lower(${users.homeserver}) = ${parsed.origin.homeserver}`
          )
        )
        .limit(1);
      if (!remote) return status(404, { error: 'Unknown user' });

      await db.update(users).set({ status: nextStatus }).where(eq(users.id, remote.id));

      const friendships = await db.query.friendRelationships.findMany({
        where: {
          status: 'ACCEPTED',
          OR: [{ userOneId: remote.id }, { userTwoId: remote.id }],
        },
      });
      for (const { userOneId, userTwoId } of friendships) {
        if (server)
          publishRealtime(server, `userEvents:${userOneId === remote.id ? userTwoId : userOneId}`, {
            type: 'user.status.changed',
            data: { userId: remote.id, status: nextStatus },
          });
      }

      return { ok: true };
    },
    {
      response: {
        200: okResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
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

      const statusResult = userStatusSchema.safeParse(getObjectProperty(parsed.body, 'status'));
      if (!statusResult.success) return status(400, { error: 'Invalid federation user status' });
      const nextStatus = statusResult.data;

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
  .post(
    '/dms/open',
    async ({ request, server, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
      if (!userPayload) return status(400, { error: 'Invalid federation user' });
      if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }
      if (userPayload.isBot) return status(403, { error: 'Bots cannot open DMs' });

      const peerResult = z.string().safeParse(getObjectProperty(parsed.body, 'peerUsername'));
      if (!peerResult.success) return status(400, { error: 'Invalid peer username' });
      const peerUsername = peerResult.data;

      const localHomeserver = getConfig().server.homeserver;
      if (
        friendAuthority(localHomeserver, userPayload.homeserver) !== localHomeserver.toLowerCase()
      ) {
        return status(400, { error: 'This homeserver is not authoritative for this DM' });
      }

      const target = await db.query.users.findFirst({
        where: { username: peerUsername, homeserver: localHomeserver },
      });
      if (!target || target.isBot) return status(404, { error: 'User not found' });

      const actor = await upsertFederatedUser(userPayload);
      const friendship = await findFriendship(actor.id, target.id);
      if (friendship?.status !== 'ACCEPTED') return status(403, { error: 'Users are not friends' });

      const dm = await openLocalDm(actor.id, target.id);
      if (dm.created && server) {
        publishRealtime(server, `userEvents:${target.id}`, {
          type: 'dm.created',
          data: dmResponse(dm.channel, dm.joinedAt, [actor]),
        });
      }

      return {
        id: dm.channel.id,
        type: dm.channel.type as 'DM' | 'GROUP_DM',
        participants: [publicUser(target), publicUser(actor)],
      };
    },
    {
      response: {
        200: dmOpenResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/dms/notify',
    async ({ request, server, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const channelResult = z.string().safeParse(getObjectProperty(parsed.body, 'channelId'));
      if (!channelResult.success) return status(400, { error: 'Invalid channel ID' });
      const channelId = channelResult.data;

      const participants = z
        .array(federationUserSchema)
        .safeParse(getObjectProperty(parsed.body, 'participants'));
      if (!participants.success) return status(400, { error: 'Invalid participants' });

      const localHomeserver = getConfig().server.homeserver.toLowerCase();
      const local = participants.data.find((p) => p.homeserver.toLowerCase() === localHomeserver);
      if (!local) return status(400, { error: 'No local participant in this DM' });
      const remotes = participants.data.filter((p) => p !== local);
      if (
        participants.data.length !== 2 ||
        remotes.some((p) => p.homeserver.toLowerCase() !== parsed.origin.homeserver)
      ) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }

      if (
        friendAuthority(parsed.origin.homeserver, getConfig().server.homeserver) !==
        parsed.origin.homeserver.toLowerCase()
      ) {
        return status(403, { error: 'This homeserver is not authoritative for this DM' });
      }

      const localUser = await db.query.users.findFirst({
        where: { username: local.username, homeserver: getConfig().server.homeserver },
      });
      if (!localUser) return status(404, { error: 'User not found' });

      const others = await Promise.all(remotes.map(upsertFederatedUser));
      const actor = others[0]!;

      const friendship = await findFriendship(localUser.id, actor.id);
      if (friendship?.status !== 'ACCEPTED') {
        return status(403, { error: 'Users are not friends' });
      }

      const shadowId = makeFederatedChannelId(parsed.origin.homeserver, channelId);
      const membership = await upsertDmShadow(shadowId, localUser.id, [
        localUser.id,
        ...others.map((user) => user.id),
      ]);

      if (server) {
        publishRealtime(server, `userEvents:${localUser.id}`, {
          type: 'dm.created',
          data: dmResponse({ id: shadowId, type: 'DM' }, membership.joinedAt, others),
        });
        void ensureFederatedDmRealtimeBridge(server, shadowId).catch(() => null);
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
    '/dms/latest',
    async ({ request, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
      if (!userPayload) return status(400, { error: 'Invalid federation user' });
      if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }

      const channelIds = z
        .array(z.string())
        .max(500)
        .safeParse(getObjectProperty(parsed.body, 'channelIds'));
      if (!channelIds.success) return status(400, { error: 'Invalid channel IDs' });

      const user = await db.query.users.findFirst({
        where: { username: userPayload.username, homeserver: userPayload.homeserver.toLowerCase() },
      });
      if (!user || !channelIds.data.length) return { channels: [] };

      const memberships = await db.query.channelMembers.findMany({
        where: { userId: user.id, channelId: { in: channelIds.data } },
      });
      const latest = await latestMessages(memberships.map((m) => m.channelId));

      return {
        channels: latest.map((message) => ({
          channelId: message.channelId,
          id: message.id,
          createdAt: message.createdAt.toISOString(),
          own: message.authorId === user.id,
        })),
      };
    },
    {
      response: {
        200: dmLatestResponseSchema,
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .post(
    '/channels/:id/ring',
    async ({ params, request, server, status }) => {
      const parsed = await verifiedFederationJsonBody(request);
      if (!parsed.ok) return status(parsed.status, { error: parsed.error });

      const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
      if (!userPayload) return status(400, { error: 'Invalid federation user' });
      if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
        return status(401, { error: 'Federation user homeserver mismatch' });
      }

      const ringResult = z.boolean().safeParse(getObjectProperty(parsed.body, 'ringing'));
      if (!ringResult.success) return status(400, { error: 'Invalid ring state' });
      const ringing = ringResult.data;

      const access = await getFederatedChannelAccess(params.id, userPayload, true);
      if (!access.ok) return status(access.status, { error: access.error });
      if (access.channel.type !== 'DM') return status(404, { error: 'Channel not right' });

      if (server) {
        await publishToChannel(server, access.channel, {
          type: 'call.ringing',
          data: { channelId: access.channel.id, user: publicUser(access.user), ringing },
        });
      }

      return { ok: true };
    },
    {
      response: {
        200: z.object({ ok: z.boolean() }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
        403: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  )
  .ws('/realtime/dms/:id', {
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
      const signedPath = `/federation/realtime/dms/${encodeURIComponent(ws.data.params.id)}`;
      const verification = await verifyFederationRequest(request, '', signedPath);
      if (!verification.ok) {
        ws.close(1008, verification.error);
        return;
      }

      const members = await db.query.channelMembers.findMany({
        where: { channelId: ws.data.params.id },
        with: { user: true },
      });
      const hasAccess = members.some(
        (member) => member.user.homeserver === verification.origin.homeserver
      );
      if (!hasAccess) {
        ws.close(1008, 'Forbidden');
        return;
      }

      ws.subscribe(`dmEvents:${ws.data.params.id}`);
      ws.send(
        JSON.stringify({
          type: 'voice.states.snapshot',
          data: { guildIds: [], states: voicePresenceForChannels([ws.data.params.id]) },
        })
      );
    },
    message() {
      // server-to-server realtime is publish-only for now.
    },
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
async function getFederatedChannelAccess(
  channelId: string,
  userPayload: FederationUserPayload,
  write = false
) {
  const channel = await db.query.channels.findFirst({
    where: { id: channelId },
  });
  if (!channel) return { ok: false as const, status: 404 as const, error: 'Channel not found' };

  const user = await db.query.users.findFirst({
    where: {
      username: userPayload.username,
      homeserver: userPayload.homeserver.toLowerCase(),
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

  if (!(await canAccessChannel(channel, user.id, write))) {
    return { ok: false as const, status: 403 as const, error: 'Forbidden' };
  }

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
      homeserver: userPayload.homeserver.toLowerCase(),
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

function federatedMessageResponse(message: any, channel: { guildId: string | null }, author: any) {
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
