import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import sharp from 'sharp';
import { z } from 'zod';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { call, createGuild, join, list, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { signup, type TestUser } from '../harness/users';
import { publicUserSchema } from '../../utils/publicUser';

setDefaultTimeout(30_000);

let anchor: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'guildprofiles', s3: true });
});
afterAll(() => anchor?.destroy());

const empty = { displayName: null, avatarUrl: null, bannerUrl: null, about: null };
const ownName = 'Own Name';

// an owner and a member sharing a guild
async function room() {
  const owner = await signup(anchor.url);
  const member = await signup(anchor.url, { displayName: ownName });
  const { guild, channel } = await createGuild(owner);
  await join(owner, guild.id, member);
  return { owner, member, guildId: guild.id, channelId: channel.id };
}

const memberOf = async (viewer: TestUser, channelId: string, user: TestUser) =>
  (await call(viewer, 'GET', `/channel/${channelId}/users`)).body.users.find(
    (u: { userId: string }) => u.userId === user.user.id
  );

const uploadPicture = async (user: TestUser, guildId: string, kind: 'avatar' | 'banner') => {
  const form = new FormData();
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  form.set('picture', new File([png], 'picture.png', { type: 'image/png' }));
  return user.fetch(`/guilds/${guildId}/profile/${kind}`, { method: 'POST', body: form });
};

describe('guild profiles', () => {
  test('start empty, so members look like themselves', async () => {
    const { owner, member, guildId, channelId } = await room();
    const res = await call(member, 'GET', `/guilds/${guildId}/profile`);
    expect(res).toEqual({ status: 200, body: { profile: empty } });
    expect((await memberOf(owner, channelId, member)).displayName).toBe(ownName);
  });

  test('a display name and about show up in that guild only', async () => {
    const { owner, member, guildId, channelId } = await room();
    const other = await createGuild(owner);
    await join(owner, other.guild.id, member);

    const res = await call(member, 'PATCH', `/guilds/${guildId}/profile`, {
      displayName: 'Guild Name',
      about: 'only here',
    });
    expect(res.status).toBe(200);
    expect(res.body.profile).toEqual({ ...empty, displayName: 'Guild Name', about: 'only here' });
    expect(publicUserSchema.parse(res.body.user)).toMatchObject({
      userId: member.user.id,
      displayName: 'Guild Name',
      about: 'only here',
    });

    expect(await memberOf(owner, channelId, member)).toMatchObject({
      displayName: 'Guild Name',
      about: 'only here',
    });
    expect((await memberOf(owner, other.channel.id, member)).displayName).toBe(ownName);

    // messages carry it too, old and new
    const sent = await send(member, channelId, 'hi');
    expect(sent.body.message.author.displayName).toBe('Guild Name');
    const [listed] = (await list(owner, channelId)).body.messages;
    expect(listed.author.displayName).toBe('Guild Name');
    expect((await send(member, other.channel.id, 'hi')).body.message.author.displayName).toBe(
      ownName
    );
  });

  test('null or empty falls back to the own profile', async () => {
    const { owner, member, guildId, channelId } = await room();
    await call(member, 'PATCH', `/guilds/${guildId}/profile`, { displayName: 'Temp' });
    await call(member, 'PATCH', `/guilds/${guildId}/profile`, { displayName: null });
    expect((await memberOf(owner, channelId, member)).displayName).toBe(ownName);

    await call(member, 'PATCH', `/guilds/${guildId}/profile`, { about: '' });
    expect((await memberOf(owner, channelId, member)).about).toBeNull();
  });

  test('a patch leaves the fields it does not mention alone', async () => {
    const { member, guildId } = await room();
    await call(member, 'PATCH', `/guilds/${guildId}/profile`, { displayName: 'Kept' });
    const res = await call(member, 'PATCH', `/guilds/${guildId}/profile`, { about: 'added' });
    expect(res.body.profile).toEqual({ ...empty, displayName: 'Kept', about: 'added' });
  });

  test('only members have one', async () => {
    const { guildId } = await room();
    const stranger = await signup(anchor.url);
    expect((await call(stranger, 'GET', `/guilds/${guildId}/profile`)).status).toBe(404);
    expect(
      (await call(stranger, 'PATCH', `/guilds/${guildId}/profile`, { displayName: 'x' })).status
    ).toBe(404);
    expect((await uploadPicture(stranger, guildId, 'avatar')).status).toBe(404);
  });

  test.each([
    ['a display name over 64 chars', { displayName: 'x'.repeat(65) }],
    ['an about over 512 chars', { about: 'x'.repeat(513) }],
    ['setting a picture url directly', { avatarUrl: 'https://evil.example/a.png' }],
  ])('rejects %s', async (_, body) => {
    const { member, guildId } = await room();
    expect((await call(member, 'PATCH', `/guilds/${guildId}/profile`, body)).status).toBe(422);
  });

  test('pictures are uploaded, served and removed', async () => {
    const { owner, member, guildId, channelId } = await room();
    for (const kind of ['avatar', 'banner'] as const) {
      const res = await uploadPicture(member, guildId, kind);
      expect(res.status).toBe(200);
      const { profile } = (await res.json()) as { profile: Record<string, string> };
      const path = `/guilds/${guildId}/members/${member.user.id}/${kind}`;
      expect(profile[`${kind}Url`]).toContain(`${path}?v=`);
      expect((await memberOf(owner, channelId, member))[`${kind}Url`]).toBe(profile[`${kind}Url`]);
      expect((await fetch(`${anchor.url}${path}`, { redirect: 'manual' })).status).toBe(302);

      await call(member, 'PATCH', `/guilds/${guildId}/profile`, { [`${kind}Url`]: null });
      expect((await fetch(`${anchor.url}${path}`, { redirect: 'manual' })).status).toBe(404);
    }
  });

  test('member.updated tells the guild, also when the own profile changes', async () => {
    const { owner, member, guildId } = await room();
    const rt = await connect(owner);
    rt.send({ type: 'subscribe.guild', guildId });
    await rt.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);
    const eventSchema = z.object({ guildId: z.literal(guildId), user: publicUserSchema });

    await call(member, 'PATCH', `/guilds/${guildId}/profile`, { displayName: 'Live' });
    const renamed = await rt.waitFor('member.updated', (e) => e.data.user.displayName === 'Live');
    expect(eventSchema.parse(renamed.data).user.userId).toBe(member.user.id);

    // the guild keeps seeing the guild name on top of the new about
    await call(member, 'POST', '/user/about', { about: 'fresh' });
    const updated = await rt.waitFor('member.updated', (e) => e.data.user.about === 'fresh');
    expect(eventSchema.parse(updated.data).user.displayName).toBe('Live');
    rt.close();
  });
});
