import { treaty } from '@elysia/eden';
import type { createApp } from '../../src/app';

// random start: a long-lived stack (FED_KEEP) must not see the same addresses again in the next run
let ipCounter = Math.floor(Math.random() * 2 ** 24);
/** every call gets a fresh client address so the in-memory auth rate limits don't interfere */
export const freshIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

export type TestApp = ReturnType<typeof createApp>;
export const cookieName = 'session_token';

export const parseSetCookie = (res: Response, name = cookieName) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export const clientFor = (url: string, cookie?: string, headers: Record<string, string> = {}) =>
  treaty<TestApp>(url, {
    headers: { ...(cookie ? { cookie: `${cookieName}=${cookie}` } : {}), ...headers },
  });

let userCounter = 0;
export const uniqueName = (prefix = 'user') =>
  `${prefix}${Date.now().toString(36)}${(userCounter++).toString(36)}`.slice(0, 30);

export type TestUser = Awaited<ReturnType<typeof signup>>;

/** POST /auth/signup with a unique user; returns the user, the session cookie and a typed client */
export async function signup(
  url: string,
  overrides: { username?: string; email?: string; password?: string; displayName?: string } = {}
) {
  const username = overrides.username ?? uniqueName();
  const body = {
    username,
    email: overrides.email ?? `${username}@example.test`,
    password: overrides.password ?? 'correct-horse-battery',
    displayName: overrides.displayName,
  };
  const res = await fetch(`${url}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { user: { id: string; username: string; handle: string; homeserver: string } };
  const cookie = parseSetCookie(res)!;
  return {
    user: json.user,
    cookie,
    email: body.email,
    password: body.password,
    api: clientFor(url, cookie),
    url,
    /** raw fetch with this user's cookie */
    fetch: (path: string, init: RequestInit = {}) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: {
          cookie: `${cookieName}=${cookie}`,
          ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      }),
  };
}

