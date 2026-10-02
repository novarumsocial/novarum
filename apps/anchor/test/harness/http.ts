import { cookieName, freshIp } from './users';

/** JSON POST with a fresh client IP (so the per-IP auth rate limits don't interfere); pass `headers` to override */
export const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...headers },
    body: JSON.stringify(body),
  });

export const withCookie = (cookie: string, headers: Record<string, string> = {}) => ({
  cookie: `${cookieName}=${cookie}`,
  ...headers,
});

export const meStatus = async (url: string, cookie: string) =>
  (await fetch(`${url}/auth/me`, { headers: withCookie(cookie) })).status;
