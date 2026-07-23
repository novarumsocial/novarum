import { and, eq, inArray } from 'drizzle-orm';
import { db, users } from '../src/db';

export async function clearOnlineUsers(userIds?: string[]) {
  if (userIds?.length === 0) return;

  await db
    .update(users)
    .set({ status: 'OFFLINE' })
    .where(
      userIds
        ? and(eq(users.status, 'ONLINE'), inArray(users.id, userIds))
        : eq(users.status, 'ONLINE')
    );
}

export async function getOnlineUsers() {
  return await db.query.users.findMany({
    where: { status: 'ONLINE' },
  });
}
