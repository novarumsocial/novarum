import Elysia, { t } from 'elysia';
import { db } from '../../prisma/db';
import { sessionCookieName, validateSessionToken, type SessionWithUser } from '../auth/provider';
import { publishRealtime } from '../../utils/publishRealtime';

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
    
    // @ts-ignore fuh ts
    ws.data.session = session;

    const memberships = await db.orm.public.GuildMember.where({ userId: session.userId }).all();

    ws.subscribe(`userEvents:${session.userId}`);
    for (const membership of memberships) {
      console.log(`Subscribing ${session.user.username} to guildEvents:${membership.guildId}`);
      ws.subscribe(`guildEvents:${membership.guildId}`);
    }

    await db.orm.public.User.where({ id: session.userId }).update({ status: 'ONLINE' });

    if (ws.data.server) {
      for (const membership of memberships) {
        publishRealtime(ws.data.server, `guildEvents:${membership.guildId}`, {
          type: 'user.status.changed',
          data: {
            userId: session.userId,
            status: 'ONLINE',
          },
        });
      }
    }
  },
  async close(ws) {
    // @ts-ignore using it here
    const session = ws.data.session as SessionWithUser;
    if (!session) return;

    await db.orm.public.User.where({ id: session.userId }).update({ status: 'OFFLINE' });

    const memberships = await db.orm.public.GuildMember.where({ userId: session.userId }).all();
    if (ws.data.server) {
      for (const membership of memberships) {
        publishRealtime(ws.data.server, `guildEvents:${membership.guildId}`, {
          type: 'user.status.changed',
          data: {
            userId: session.userId,
            status: 'OFFLINE',
          },
        });
      }
    }
  }
});
