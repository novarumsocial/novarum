import { openRealtime } from './ws';
import type { TestUser } from './users';

/** opens /realtime and waits for the connect snapshot, i.e. until the server finished subscribing */
export async function connect(user: TestUser) {
  const rt = await openRealtime(user.url, user.cookie);
  await rt.waitFor('voice.states.snapshot');
  return rt;
}

/** POST json with the user's cookie, returns the parsed body (throws on non-2xx) */
export async function post<T = any>(user: TestUser, path: string, body?: object, method = 'POST') {
  const res = await user.fetch(path, { method, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function createGuild(owner: TestUser, name = 'testguild') {
  const { guild } = await post<{ guild: { id: string } }>(owner, '/guilds/create', { name });
  const guildId = guild.id;
  const list = await post<{ guilds: { id: string; channels: { id: string }[] }[] }>(owner, '/guilds/list', undefined, 'GET');
  const channelId = list.guilds.find((g) => g.id === guildId)!.channels[0]!.id;
  return { guildId, channelId };
}

export async function joinGuild(owner: TestUser, guestUser: TestUser, guildId: string) {
  const { invite } = await post<{ invite: { code: string } }>(owner, `/guilds/${guildId}/invites`, {});
  await post(guestUser, '/invite/accept', { code: invite.code });
}

export async function befriend(a: TestUser, b: TestUser) {
  await post(a, '/friends/request', { username: b.user.username, homeserver: b.user.homeserver });
  await post(b, `/friends/requests/${a.user.id}/accept`);
}
