import type { TestUser } from './users';

/** a requests b, b accepts, through the real /friends API */
export async function befriend(a: TestUser, b: TestUser) {
  const request = await a.fetch('/friends/request', {
    method: 'POST',
    body: JSON.stringify({ username: b.user.username, homeserver: b.user.homeserver }),
  });
  if (!request.ok) throw new Error(`friend request failed: ${request.status} ${await request.text()}`);
  const accept = await b.fetch(`/friends/requests/${a.user.id}/accept`, { method: 'POST' });
  if (!accept.ok) throw new Error(`friend accept failed: ${accept.status} ${await accept.text()}`);
}

/** a removes b from their friends */
export async function unfriend(a: TestUser, b: TestUser) {
  const res = await a.fetch(`/friends/${b.user.id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`unfriend failed: ${res.status} ${await res.text()}`);
}
