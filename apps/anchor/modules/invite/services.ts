import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { sessionCookieName, validateSessionToken } from '../auth/provider';

export const invite = new Elysia({ prefix: '/invite' })
  .get('/:code', async ({ params, status }) => {
    const { code } = params;

    const invite = await db.orm.public.GuildInvite.where({ code }).include('creator').first();
    if (!invite || isExpired(invite.expiresAt)) {
      return status(404, { error: 'Invite not found' });
    }

    const guild = await db.orm.public.Guild.where({ id: invite.guildId }).first();
    if (!guild) {
      return status(404, { error: 'Guild not found' });
    }

    const members = await db.orm.public.GuildMember.where({ guildId: guild.id }).all();

    return {
      invite,
      guild: {
        id: guild.id,
        name: guild.name,
        description: guild.description,
        avatarUrl: guild.avatarUrl,
        memberCount: members.length,
      },
    };
  })
  .post(
    '/accept',
    async ({ body, cookie, status }) => {
      const token = cookie[sessionCookieName]?.value as string | undefined;
      const session = await validateSessionToken(token);
      if (!session) {
        return status(401, { error: 'Unauthorized' });
      }

      const invite = await db.orm.public.GuildInvite.where({ code: body.code }).first();
      if (!invite || isExpired(invite.expiresAt)) {
        return status(404, { error: 'Invite not found' });
      }

      const guild = await db.orm.public.Guild.where({ id: invite.guildId }).first();
      if (!guild) {
        return status(404, { error: 'Guild not found' });
      }

      const membership = await db.orm.public.GuildMember.where({
        guildId: invite.guildId,
        userId: session.userId,
      }).first();
      if (!membership) {
        await db.orm.public.GuildMember.create({
          guildId: invite.guildId,
          userId: session.userId,
          role: 'MEMBER',
        });
      }

      return { guildId: invite.guildId };
    },
    {
      body: t.Object({
        code: t.String({ minLength: 1 }),
      }),
    }
  );

function isExpired(expiresAt: Date | string | null | undefined) {
  return expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
}
