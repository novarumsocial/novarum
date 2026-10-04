import Elysia from 'elysia';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { sessionCookieName, validateSessionToken } from '../auth/provider';
import {
  db,
  notificationPreferences,
  notificationSettings,
  pushSubscriptions,
} from '../../src/db';
import { canAccessChannel } from '../../utils/channelAccess';
import { assertSafeFederationUrl } from '../../utils/discovery';
import { genericResponseErrorSchema } from '../../utils/genericResponseError';
import { randomString } from '../../utils/randomString';
import { getVapidKeys } from '../../utils/vapid';

const levelSchema = z.enum(['ALL', 'MENTIONS', 'NONE']);
const settingSchema = z.object({
  targetId: z.string(),
  level: levelSchema,
  mutedUntil: z.iso.datetime().nullable(),
});
const preferencesSchema = z.object({ push: z.boolean(), messagePreview: z.boolean() });
const subscriptionBodySchema = z.object({
  kind: z.enum(['WEBPUSH', 'UNIFIEDPUSH']),
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
});

const toSetting = (row: typeof notificationSettings.$inferSelect) => ({
  targetId: row.targetId,
  level: row.level,
  mutedUntil: row.mutedUntil?.toISOString() ?? null,
});

export const notifications = new Elysia({ prefix: '/notifications', tags: ['Notifications'] })
  // the public key is what browsers need to subscribe, so it needs no session
  .get('/vapid-key', async () => ({ publicKey: (await getVapidKeys()).publicKey }), {
    response: { 200: z.object({ publicKey: z.string() }) },
  })
  .resolve(async ({ cookie, status }) => {
    const token = cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) return status(401, { error: 'Unauthorized' });
    return { session };
  })
  .get(
    '/settings',
    async ({ session }) => {
      const [preferences, settings] = await Promise.all([
        db.query.notificationPreferences.findFirst({ where: { userId: session.userId } }),
        db.query.notificationSettings.findMany({ where: { userId: session.userId } }),
      ]);
      return {
        preferences: {
          push: preferences?.push ?? true,
          messagePreview: preferences?.messagePreview ?? true,
        },
        settings: settings.map(toSetting),
      };
    },
    {
      response: {
        200: z.object({ preferences: preferencesSchema, settings: z.array(settingSchema) }),
        401: genericResponseErrorSchema,
      },
    }
  )
  .put(
    '/preferences',
    async ({ body, session }) => {
      const [row] = await db
        .insert(notificationPreferences)
        .values({ userId: session.userId, ...body })
        .onConflictDoUpdate({ target: notificationPreferences.userId, set: body })
        .returning();
      return { push: row!.push, messagePreview: row!.messagePreview };
    },
    {
      body: preferencesSchema.partial(),
      response: { 200: preferencesSchema, 401: genericResponseErrorSchema },
    }
  )
  .put(
    '/settings/:targetId',
    async ({ params, body, session, status }) => {
      // fed: ids contain colons, so clients URL-encode them and elysia decodes them back
      const { targetId } = params;
      if (!(await canTarget(targetId, session.userId))) return status(403, { error: 'Forbidden' });

      const values = {
        userId: session.userId,
        targetId,
        level: body.level,
        mutedUntil: body.mutedUntil ? new Date(body.mutedUntil) : null,
      };
      const [row] = await db
        .insert(notificationSettings)
        .values(values)
        .onConflictDoUpdate({
          target: [notificationSettings.userId, notificationSettings.targetId],
          set: values,
        })
        .returning();
      return toSetting(row!);
    },
    {
      body: z.object({ level: levelSchema, mutedUntil: z.iso.datetime().nullable().optional() }),
      response: { 200: settingSchema, 401: genericResponseErrorSchema, 403: genericResponseErrorSchema },
    }
  )
  .delete(
    '/settings/:targetId',
    async ({ params, session }) => {
      await db
        .delete(notificationSettings)
        .where(
          and(
            eq(notificationSettings.userId, session.userId),
            eq(notificationSettings.targetId, params.targetId)
          )
        );
      return { success: true };
    },
    {
      response: { 200: z.object({ success: z.boolean() }), 401: genericResponseErrorSchema },
    }
  )
  .post(
    '/subscriptions',
    async ({ body, session, status }) => {
      // we will POST to this url, so it gets the same checks as a federation target
      const safe = await assertSafeFederationUrl(new URL(body.endpoint)).then(
        () => true,
        () => false
      );
      if (!safe) return status(400, { error: 'Invalid push endpoint' });

      const values = {
        userId: session.userId,
        sessionId: session.id,
        kind: body.kind,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      };
      // an endpoint belongs to one device, so a re-subscribe moves it to the current session
      const [row] = await db
        .insert(pushSubscriptions)
        .values({ id: randomString(), ...values })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
        .returning();
      return { id: row!.id };
    },
    {
      body: subscriptionBodySchema,
      response: {
        200: z.object({ id: z.string() }),
        400: genericResponseErrorSchema,
        401: genericResponseErrorSchema,
      },
    }
  )
  .delete(
    '/subscriptions/:id',
    async ({ params, session, status }) => {
      const deleted = await db
        .delete(pushSubscriptions)
        .where(
          and(eq(pushSubscriptions.id, params.id), eq(pushSubscriptions.userId, session.userId))
        )
        .returning();
      if (!deleted.length) return status(404, { error: 'Subscription not found' });
      return { success: true };
    },
    {
      response: {
        200: z.object({ success: z.boolean() }),
        401: genericResponseErrorSchema,
        404: genericResponseErrorSchema,
      },
    }
  );

// a target is a guild or a channel (DMs included) the user belongs to
async function canTarget(targetId: string, userId: string) {
  if (await db.query.guildMembers.findFirst({ where: { guildId: targetId, userId } })) return true;

  const channel = await db.query.channels.findFirst({ where: { id: targetId } });
  return !!channel && (await canAccessChannel(channel, userId));
}
