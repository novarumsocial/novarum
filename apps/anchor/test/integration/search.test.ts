import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { signup } from '../harness/users';
import { befriend } from '../harness/friends';
import { anonymous, call, createGuild, join, list, send } from '../harness/chat';

let anchor: RunningAnchor;
let sql: ReturnType<typeof connect>;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'search' });
  sql = connect(anchor.databaseUrl);
});
afterAll(async () => {
  await sql.close();
  await anchor.destroy();
});

type Actor = Awaited<ReturnType<typeof signup>>;

async function world() {
  const [owner, member, stranger] = await Promise.all([
    signup(anchor.url),
    signup(anchor.url),
    signup(anchor.url),
  ]);
  const { guild, channel } = await createGuild(owner);
  await join(owner, guild.id, member);
  const other = (
    await call(owner, 'POST', '/channel/create', { guildId: guild.id, name: 'other', type: 'TEXT' })
  ).body;
  return { owner, member, stranger, guild, channel, other: other as { id: string } };
}

const search = (user: Pick<Actor, 'fetch'>, params: Record<string, string | number>) =>
  call(
    user,
    'GET',
    `/message/search?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, `${v}`]))}`
  );
const contents = (res: { body: any }) => res.body.messages.map((m: any) => m.content);

describe('matching', () => {
  test('every word has to prefix a word of the message, case-insensitively, newest first', async () => {
    const { owner, channel } = await world();
    for (const text of ['Hello World', 'hello there', 'world peace', 'helium balloon'])
      await send(owner, channel.id, text);

    expect(contents(await search(owner, { channelId: channel.id, q: 'hello' }))).toEqual([
      'hello there',
      'Hello World',
    ]);
    expect(contents(await search(owner, { channelId: channel.id, q: 'HEL' }))).toEqual([
      'helium balloon',
      'hello there',
      'Hello World',
    ]);
    expect(contents(await search(owner, { channelId: channel.id, q: 'hello wor' }))).toEqual([
      'Hello World',
    ]);
    expect(contents(await search(owner, { channelId: channel.id, q: 'nothing' }))).toEqual([]);
  });

  test('results carry the full message plus the channel name', async () => {
    const { owner, guild, channel } = await world();
    const sent = (await send(owner, channel.id, 'find me')).body.message;
    const res = await search(owner, { guildId: guild.id, q: 'find' });
    expect(res.status).toBe(200);
    expect(res.body.messages[0]).toMatchObject({
      id: sent.id,
      channelId: channel.id,
      guildId: guild.id,
      content: 'find me',
      channelName: expect.any(String),
      attachments: [],
      author: { userId: owner.user.id },
    });
    expect(res.body.nextCursor).toBeNull();
  });

  test('a guild search covers all its channels and no other guild', async () => {
    const { owner, guild, channel, other } = await world();
    const elsewhere = await createGuild(owner, 'elsewhere');
    await send(owner, channel.id, 'needle one');
    await send(owner, other.id, 'needle two');
    await send(owner, elsewhere.channel.id, 'needle three');
    const res = await search(owner, { guildId: guild.id, q: 'needle' });
    expect(contents(res)).toEqual(['needle two', 'needle one']);
    expect(res.body.messages.map((m: any) => m.channelName)).toEqual(['other', expect.any(String)]);
  });

  test('deleted messages are not found', async () => {
    const { owner, channel } = await world();
    const sent = (await send(owner, channel.id, 'ephemeral words')).body.message;
    await send(owner, channel.id, 'ephemeral kept');
    await call(owner, 'POST', '/message/delete', { channelId: channel.id, messageId: sent.id });
    // a soft-deleted row is skipped as well
    const soft = (await send(owner, channel.id, 'ephemeral soft')).body.message;
    await sql`UPDATE message SET "deletedAt" = now() WHERE id = ${soft.id}`;
    expect(contents(await search(owner, { channelId: channel.id, q: 'ephemeral' }))).toEqual([
      'ephemeral kept',
    ]);
  });
});

describe('filters', () => {
  test('from: by username or full handle, alone or with text', async () => {
    const { owner, member, channel } = await world();
    await send(owner, channel.id, 'owner says hi');
    await send(member, channel.id, 'member says hi');
    const handle = `@${member.user.username}:${member.user.homeserver}`;
    expect(
      contents(await search(owner, { channelId: channel.id, q: `from:${member.user.username}` }))
    ).toEqual(['member says hi']);
    expect(
      contents(await search(owner, { channelId: channel.id, q: `hi from:${handle.toUpperCase()}` }))
    ).toEqual(['member says hi']);
    expect(
      contents(await search(owner, { channelId: channel.id, q: 'from:nobody-at-all' }))
    ).toEqual([]);
    expect(
      contents(
        await search(owner, {
          channelId: channel.id,
          q: `from:${member.user.username}:elsewhere.example`,
        })
      )
    ).toEqual([]);
  });

  test('has:link, has:attachment and has:image', async () => {
    const { owner, channel } = await world();
    await send(owner, channel.id, 'plain words');
    await send(owner, channel.id, 'see https://example.com/page');
    const withFile = (await send(owner, channel.id, 'a file')).body.message;
    const withImage = (await send(owner, channel.id, 'a picture')).body.message;
    for (const [id, messageId, type] of [
      ['att-f', withFile.id, 'text/plain'],
      ['att-i', withImage.id, 'image/png'],
    ]) {
      await sql`INSERT INTO attachment (id, "channelId", "messageId", "uploaderId", filename, "contentType", size, "objectKey", status)
        VALUES (${`${id}-${channel.id}`}, ${channel.id}, ${messageId}, ${owner.user.id}, 'f', ${type}, 1, ${`k/${id}-${channel.id}`}, 'READY')`;
    }
    expect(contents(await search(owner, { channelId: channel.id, q: 'has:link' }))).toEqual([
      'see https://example.com/page',
    ]);
    expect(contents(await search(owner, { channelId: channel.id, q: 'has:attachment' }))).toEqual([
      'a picture',
      'a file',
    ]);
    expect(contents(await search(owner, { channelId: channel.id, q: 'has:image' }))).toEqual([
      'a picture',
    ]);
    expect((await search(owner, { channelId: channel.id, q: 'has:nonsense' })).status).toBe(400);
  });

  test('before: and after: are whole UTC days, both exclusive', async () => {
    const { owner, channel } = await world();
    const sent = [];
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      const message = (await send(owner, channel.id, `day ${day}`)).body.message;
      await sql`UPDATE message SET "createdAt" = ${new Date(`${day}T12:00:00Z`)} WHERE id = ${message.id}`;
      sent.push(message);
    }
    expect(
      contents(await search(owner, { channelId: channel.id, q: 'day before:2026-01-02' }))
    ).toEqual(['day 2026-01-01']);
    expect(
      contents(await search(owner, { channelId: channel.id, q: 'day after:2026-01-02' }))
    ).toEqual(['day 2026-01-03']);
    expect(
      contents(
        await search(owner, { channelId: channel.id, q: 'after:2026-01-01 before:2026-01-03' })
      )
    ).toEqual(['day 2026-01-02']);
    expect((await search(owner, { channelId: channel.id, q: 'before:yesterday' })).status).toBe(
      400
    );
    expect((await search(owner, { channelId: channel.id, q: 'before:2026-02-30' })).status).toBe(
      400
    );
  });
});

describe('pagination', () => {
  test('pages walk every match once, newest first, ties broken by id', async () => {
    const { owner, channel } = await world();
    const at = new Date('2025-05-05T05:05:05.005Z');
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = (await send(owner, channel.id, `paged ${i}`)).body.message.id;
      ids.push(id);
      // half of them share a timestamp, so the cursor has to break ties
      if (i % 2) await sql`UPDATE message SET "createdAt" = ${at} WHERE id = ${id}`;
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { body: any } = await search(owner, {
        channelId: channel.id,
        q: 'paged',
        limit: 5,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...res.body.messages.map((m: any) => m.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(12);
  });

  test('a malformed cursor is 400, a limit outside 1..50 fails validation', async () => {
    const { owner, channel } = await world();
    expect((await search(owner, { channelId: channel.id, q: 'x', cursor: 'nope' })).status).toBe(
      400
    );
    expect((await search(owner, { channelId: channel.id, q: 'x', limit: 0 })).status).toBe(422);
    expect((await search(owner, { channelId: channel.id, q: 'x', limit: 51 })).status).toBe(422);
  });
});

describe('access', () => {
  test('anonymous 401, non-members 403, unknown guild or channel 404', async () => {
    const { stranger, guild, channel } = await world();
    expect((await search(anonymous(anchor.url), { guildId: guild.id, q: 'x' })).status).toBe(401);
    expect((await search(stranger, { guildId: guild.id, q: 'x' })).status).toBe(403);
    expect((await search(stranger, { channelId: channel.id, q: 'x' })).status).toBe(403);
    expect((await search(stranger, { guildId: 'missing', q: 'x' })).status).toBe(404);
    expect((await search(stranger, { channelId: 'missing', q: 'x' })).status).toBe(404);
  });

  test('a guild search never returns another guild or DM messages, even with a guessed id', async () => {
    const { owner, member, stranger, guild, channel } = await world();
    const theirs = await createGuild(stranger, 'theirs');
    await send(stranger, theirs.channel.id, 'secret plans');
    await befriend(owner, stranger);
    const dmId = (await call(owner, 'POST', '/dm', { userId: stranger.user.id })).body.id;
    await send(stranger, dmId, 'secret dm');
    await send(owner, channel.id, 'secret public');
    expect(contents(await search(member, { guildId: guild.id, q: 'secret' }))).toEqual([
      'secret public',
    ]);
    expect((await search(member, { channelId: dmId, q: 'secret' })).status).toBe(403);
  });

  test('owner-only channels are readable, so members find their messages', async () => {
    const { owner, member, guild, channel } = await world();
    await call(owner, 'PATCH', `/channel/${channel.id}`, { ownerOnly: true });
    await send(owner, channel.id, 'announcement today');
    expect(contents(await search(member, { guildId: guild.id, q: 'announcement' }))).toEqual([
      'announcement today',
    ]);
  });

  test('DMs: participants search them, others get 403', async () => {
    const [a, b, c] = await Promise.all([
      signup(anchor.url),
      signup(anchor.url),
      signup(anchor.url),
    ]);
    await befriend(a, b);
    const dmId = (await call(a, 'POST', '/dm', { userId: b.user.id })).body.id;
    await send(b, dmId, 'just between us');
    expect(contents(await search(a, { channelId: dmId, q: 'between' }))).toEqual([
      'just between us',
    ]);
    expect((await search(c, { channelId: dmId, q: 'between' })).status).toBe(403);
  });
});

describe('input validation', () => {
  test('exactly one of guildId and channelId, a non-empty query, at most 200 characters (422)', async () => {
    const { owner, guild, channel } = await world();
    expect((await search(owner, { q: 'x' })).status).toBe(400);
    expect((await search(owner, { guildId: guild.id, channelId: channel.id, q: 'x' })).status).toBe(
      400
    );
    expect((await search(owner, { guildId: guild.id, q: '   ' })).status).toBe(400);
    expect((await search(owner, { guildId: guild.id, q: 'x'.repeat(201) })).status).toBe(422);
  });

  test('LIKE wildcards, tsquery syntax and SQL are matched as plain text', async () => {
    const { owner, channel } = await world();
    await send(owner, channel.id, "100% sure it's O'Reilly");
    await send(owner, channel.id, 'under_score and back\\slash');
    await send(owner, channel.id, 'unrelated');
    const hostile = [
      '%',
      '_',
      '\\',
      "'",
      "''",
      '!',
      '&',
      '|',
      '<->',
      ':*',
      'a:*b & | ! <-> ()',
      "x' OR '1'='1",
      "'); DROP TABLE message; --",
      'a\u0000b',
      '😀',
    ];
    for (const q of hostile) {
      const res = await search(owner, { channelId: channel.id, q });
      expect(res.status, q).toBe(200);
      expect(contents(res), q).not.toContain('unrelated');
    }
    expect(contents(await search(owner, { channelId: channel.id, q: "o'reilly" }))).toEqual([
      "100% sure it's O'Reilly",
    ]);
    expect(contents(await search(owner, { channelId: channel.id, q: 'back\\slash' }))).toEqual([
      'under_score and back\\slash',
    ]);
    expect((await list(owner, channel.id)).body.messages).toHaveLength(3);
  });
});

test('searching is rate limited per user', async () => {
  const { owner, channel } = await world();
  const statuses = [];
  for (let i = 0; i < 61; i++)
    statuses.push((await search(owner, { channelId: channel.id, q: 'x' })).status);
  expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
  expect(statuses.at(-1)).toBe(429);
});

describe('list until', () => {
  test('loads everything from the newest message down to an older one, plus some', async () => {
    const { owner, channel } = await world();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++)
      ids.push((await send(owner, channel.id, `m${i}`)).body.message.id);
    const res = await call(
      owner,
      'GET',
      `/message/list?channelId=${channel.id}&cursor=0&amount=50&until=${ids[10]}`
    );
    const got = res.body.messages.map((m: any) => m.id);
    expect(got).toContain(ids[10]);
    expect(got.at(-1)).toBe(ids[119]);
    expect(got).toHaveLength(120);
    // an id from another channel is ignored
    const other = await call(
      owner,
      'GET',
      `/message/list?channelId=${channel.id}&cursor=0&amount=50&until=missing`
    );
    expect(other.body.messages).toHaveLength(50);
  });
});
