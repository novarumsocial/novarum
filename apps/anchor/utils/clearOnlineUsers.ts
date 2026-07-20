import { db } from '../prisma/db';

export async function clearOnlineUsers(users?: string[]) {
  const onlineUsers = db.orm.public.User.where({ status: 'ONLINE' });

  await (users ? onlineUsers.where((user) => user.id.in(users)) : onlineUsers).update({
    status: 'OFFLINE',
  });
}

export async function getOnlineUsers() {
  return await db.orm.public.User.where({ status: 'ONLINE' }).all();
}
