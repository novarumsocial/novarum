import { parseArgs } from 'node:util';
import { db, guilds, users } from '../db';
import { and, eq } from 'drizzle-orm';
import { getConfig } from '../../utils/config';
import { getAverageColor } from 'fast-average-color-node';
import { processImage } from '../../utils/optimizeWebp';
import { storage } from '../../utils/services/storage';

const { positionals } = parseArgs({
  args: Bun.argv.slice(3),
  allowPositionals: true,
});
const homeserver = getConfig().server.homeserver;

const [command, arg1] = positionals;

// TODO: refactor the cli (but no extra deps!)
if (command === 'promote-admin' && arg1) {
  if (!(await db.query.users.findFirst({ where: { username: arg1, homeserver } }))) {
    console.error(`User ${arg1} does not exist on this homeserver.`);
    process.exit(1);
  }
  await db
    .update(users)
    .set({ isHomeserverAdmin: true })
    .where(and(eq(users.username, arg1), eq(users.homeserver, homeserver)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
  console.log(`${arg1} has been elevated to homeserver admin.`);
  process.exit(0);
}

if (command === 'demote-admin' && arg1) {
  if (!(await db.query.users.findFirst({ where: { username: arg1, homeserver } }))) {
    console.error(`User ${arg1} does not exist on this homeserver.`);
    process.exit(1);
  }
  await db
    .update(users)
    .set({ isHomeserverAdmin: false })
    .where(and(eq(users.username, arg1), eq(users.homeserver, homeserver)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
  console.log(`${arg1} has been demoted from homeserver admin.`);
  process.exit(0);
}

if (command === 'compute-avatar-color') {
  const allUsers = await db.query.users.findMany({
    where: {
      homeserver,
      AND: [{ avatarUrl: { isNotNull: true } }, { avatarColor: { isNull: true } }],
    },
  });

  console.log(`computing avatar colors for ${allUsers.length} users...`);

  for (const user of allUsers) {
    try {
      const response = await fetch(user.avatarUrl!);
      if (!response.ok) {
        console.error(`failed to fetch avatar for user ${user.username}: ${response.statusText}`);
        console.error('ensure the server is up so the avatar can be fetched.');
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const color = await getAverageColor(buffer);

      await db
        .update(users)
        .set({ avatarColor: color.hex.toUpperCase() })
        .where(eq(users.id, user.id));

      console.log(`${user.username} complete (${color.hex.toUpperCase()})`);
    } catch (error) {
      console.error(`error computing for ${user.username}:`, error);
    }
  }

  process.exit(0);
}

if (command === 'reprocess-webp') {
  // migrate user pfps
  const allUsers = await db.query.users.findMany({
    where: {
      homeserver,
      AND: [{ avatarUrl: { isNotNull: true } }, { avatarUrl: { like: '%?format=%' } }],
    },
  });
  for (const user of allUsers) {
    const img = await fetch(user.avatarUrl!);
    if (!img.ok) {
      console.error(`failed to fetch avatar for user ${user.username}: ${img.statusText}`);
      continue;
    }
    const buffer = await img.arrayBuffer();

    const image = await processImage(buffer);
    await storage.write(`avatars/${user.id}.webp`, image.data, {
      type: 'image/webp',
    });

    const avatarUrl = new URL(
      `/user/avatar/${encodeURIComponent(user.id)}?v=${Date.now()}${image.animated ? '&animated=1' : ''}`,
      getConfig().server.baseUrl
    ).toString();
    await db
      .update(users)
      .set({
        avatarUrl,
      })
      .where(eq(users.id, user.id));
    console.log(`migrated avatar for ${user.username}`);
  }

  // migrate banners
  const allBanners = await db.query.users.findMany({
    where: {
      homeserver,
      AND: [{ bannerUrl: { isNotNull: true } }, { bannerUrl: { like: '%?format=%' } }],
    },
  });
  for (const user of allBanners) {
    const img = await fetch(user.bannerUrl!);
    if (!img.ok) {
      console.error(`failed to fetch banner for user ${user.username}: ${img.statusText}`);
      continue;
    }
    const buffer = await img.arrayBuffer();

    const image = await processImage(buffer);
    await storage.write(`banners/${user.id}.webp`, image.data, {
      type: 'image/webp',
    });

    const bannerUrl = new URL(
      `/user/banner/${encodeURIComponent(user.id)}?v=${Date.now()}${image.animated ? '&animated=1' : ''}`,
      getConfig().server.baseUrl
    ).toString();
    await db
      .update(users)
      .set({
        bannerUrl,
      })
      .where(eq(users.id, user.id));
    console.log(`migrated banner for ${user.username}`);
  }

  // migrate guild icons
  const allGuilds = await db.query.guilds.findMany({
    where: {
      AND: [
        { avatarUrl: { isNotNull: true } },
        { avatarUrl: { like: '%?format=%' } },
        { id: { notLike: 'fed:%' } },
      ],
    },
  });
  for (const guild of allGuilds) {
    const img = await fetch(guild.avatarUrl!);
    if (!img.ok) {
      console.error(`failed to fetch avatar for guild ${guild.name}: ${img.statusText}`);
      continue;
    }
    const buffer = await img.arrayBuffer();

    const image = await processImage(buffer);
    await storage.write(`guild-avatars/${guild.id}.webp`, image.data, {
      type: 'image/webp',
    });

    const avatarUrl = new URL(
      `/guilds/avatar/${encodeURIComponent(guild.id)}?v=${Date.now()}${image.animated ? '&animated=1' : ''}`,
      getConfig().server.baseUrl
    ).toString();
    await db
      .update(guilds)
      .set({
        avatarUrl,
      })
      .where(eq(guilds.id, guild.id));
    console.log(`migrated avatar for guild ${guild.name}`);
  }

  console.log(
    'migration complete! note that you may need to refresh the frontend to get the migrated images'
  );

  process.exit(0);
}

console.log('no valid command, check docs');
process.exit(0);
