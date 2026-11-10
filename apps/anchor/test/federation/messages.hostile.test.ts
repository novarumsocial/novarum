import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fake, resetHarness, signup, stackIsUp } from '../harness/federation';
import { call } from '../harness/chat';
import { closePg, fedChannelId, fedGuildId, pg } from '../harness/fedflows';

// A hostile guild host (fake identity 1) that answers every page of a channel's history with a new cursor.
// Listing that channel on anchor-a must give up after a bounded number of pages instead of paging forever.
const host = fake.identityInfo(1).homeserver;
const guildId = fedGuildId(host, 'endless');
const channelId = fedChannelId(host, 'endless');
// maxRemoteMessagePages in modules/message/services.ts
const maxRemoteMessagePages = 100;
const pagesPath = 'POST /federation/channels/endless/messages';

beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(async () => {
  await pg('a')`DELETE FROM guild WHERE id = ${guildId}`;
  await fake.reset();
  await closePg();
});

test('a host that never stops paging is cut off after maxRemoteMessagePages', async () => {
  const user = await signup('a');
  await pg('a')`INSERT INTO guild (id, name, "ownerId", "extAnchorDown")
    VALUES (${guildId}, 'endless', ${user.user.id}, false)`;
  await pg(
    'a'
  )`INSERT INTO guild_member ("guildId", "userId", position) VALUES (${guildId}, ${user.user.id}, 0)`;
  await pg(
    'a'
  )`INSERT INTO channel (id, "guildId", name) VALUES (${channelId}, ${guildId}, 'endless')`;

  // later rules win and each is used once, so every page hands out a cursor never seen before
  for (let page = 0; page < maxRemoteMessagePages + 5; page++) {
    await fake.respond(1, pagesPath, {
      json: { messages: [], nextCursor: `cursor-${page}` },
      times: 1,
    });
  }

  const res = await call(
    user,
    'GET',
    `/message/list?channelId=${encodeURIComponent(channelId)}&cursor=0&amount=50`
  );
  expect([res.status, res.body.error]).toEqual([502, 'Remote channel history is too long']);
  const asked = await fake.requests(1, { path: '/federation/channels/endless/messages' });
  expect(asked).toHaveLength(maxRemoteMessagePages);
});

test('a page with more messages than asked for is refused', async () => {
  const user = await signup('a');
  await pg(
    'a'
  )`INSERT INTO guild_member ("guildId", "userId", position) VALUES (${guildId}, ${user.user.id}, 0)`;
  const message = (i: number) => ({
    id: `m${i}`,
    channelId: 'endless',
    guildId: 'endless',
    content: 'x',
    nonce: `n${i}`,
    replyTo: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    author: {
      userId: 'u',
      username: 'evil',
      homeserver: host,
      displayName: null,
      avatarUrl: null,
      avatarColor: null,
      speakingRingColor: null,
      isBot: false,
    },
  });
  await fake.respond(1, pagesPath, {
    json: { messages: Array.from({ length: 101 }, (_, i) => message(i)), nextCursor: null },
  });

  const res = await call(
    user,
    'GET',
    `/message/list?channelId=${encodeURIComponent(channelId)}&cursor=0&amount=50`
  );
  expect(res.status).toBe(502);
});
