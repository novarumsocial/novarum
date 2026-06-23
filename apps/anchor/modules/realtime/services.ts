import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { sessionCookieName, validateSessionToken } from '../auth/provider';

export const realtime = new Elysia({ prefix: '/realtime' }).ws('/', {
  cookie: t.Cookie({
    [sessionCookieName]: t.Optional(t.String()),
  }),
  async open(ws) {
    const token = ws.data.cookie[sessionCookieName]?.value as string | undefined;
    const session = await validateSessionToken(token);
    if (!session) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    const memberships = await db.orm.public.GuildMember.where({ userId: session.userId }).all();

    ws.subscribe(`userEvents:${session.userId}`);
    for (const membership of memberships) {
      console.log(`Subscribing ${session.user.username} to guildEvents:${membership.guildId}`);
      ws.subscribe(`guildEvents:${membership.guildId}`);
    }
  },
});
