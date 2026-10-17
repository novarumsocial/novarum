import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resetHarness, stackIsUp } from '../harness/federation';
import { call, send } from '../harness/chat';
import { connect } from '../harness/realtime';
import { closePg, joinedRoom, pg } from '../harness/fedflows';

// a B member's profile for a guild hosted on A: B hands it to A, and A serves it to everyone
beforeAll(async () => {
  await stackIsUp();
  await resetHarness();
});
afterAll(closePg);

const userNamed = (users: { username: string }[], username: string) =>
  users.find((user) => user.username === username) as Record<string, unknown> | undefined;

describe('server profiles in a remote guild', () => {
  test('the host takes it, serves it to its members and bridges it back', async () => {
    const { owner, channel, member, shadowGuild, shadowChannel, rt } = await joinedRoom();
    const ownerRt = await connect(owner);

    const res = await call(member, 'PATCH', `/guilds/${shadowGuild}/profile`, {
      displayName: 'Remote Nick',
    });
    expect(res.status).toBe(200);
    expect(res.body.profile.displayName).toBe('Remote Nick');

    // A's members hear about it directly, the B member through the bridge
    await ownerRt.waitFor('member.updated', (e) => e.data.user.displayName === 'Remote Nick');
    const bridged = await rt.waitFor(
      'member.updated',
      (e) => e.data.user.displayName === 'Remote Nick'
    );
    expect(bridged.data.guildId).toBe(shadowGuild);

    const users = (await call(owner, 'GET', `/channel/${channel.id}/users`)).body.users;
    expect(userNamed(users, member.user.username)?.displayName).toBe('Remote Nick');
    const sent = await send(member, shadowChannel, 'hi');
    expect(sent.body.message.author.displayName).toBe('Remote Nick');

    // A has the profile, B keeps its copy for editing
    const [row] = await pg('a')`
      SELECT gm."displayName" FROM guild_member gm JOIN "user" u ON u.id = gm."userId"
      WHERE u.username = ${member.user.username}`;
    expect(row!.displayName).toBe('Remote Nick');
    const own = await call(member, 'GET', `/guilds/${shadowGuild}/profile`);
    expect(own.body.profile.displayName).toBe('Remote Nick');
    ownerRt.close();
    rt.close();
  });

  test('a change to the own profile reaches the host with the guild profile still on top', async () => {
    const { owner, member, shadowGuild, rt } = await joinedRoom();
    await call(member, 'PATCH', `/guilds/${shadowGuild}/profile`, { displayName: 'Kept' });
    const ownerRt = await connect(owner);

    await call(member, 'POST', '/user/about', { about: 'new about' });
    const updated = await ownerRt.waitFor(
      'member.updated',
      (e) => e.data.user.about === 'new about'
    );
    expect(updated.data.user.displayName).toBe('Kept');
    ownerRt.close();
    rt.close();
  });
});
