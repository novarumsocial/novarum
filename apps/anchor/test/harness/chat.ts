import type { TestUser } from './users';

type Actor = Pick<TestUser, 'fetch'>;

/** an actor with no session cookie */
export const anonymous = (url: string): Actor => ({
  fetch: (path, init = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers },
    }),
});

/** one JSON request as `user`; returns the status and parsed body */
export async function call(
  user: Actor,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const res = await user.fetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json };
}

const ok = <T>(r: { status: number; body: T }, what: string) => {
  if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

export async function createGuild(owner: TestUser, name = 'guild') {
  const { guild } = ok(await call(owner, 'POST', '/guilds/create', { name }), 'guild create');
  const { guilds } = ok(await call(owner, 'GET', '/guilds/list'), 'guild list');
  const channel = guilds.find((g: any) => g.id === guild.id).channels[0];
  return { guild: guild as { id: string; name: string }, channel: channel as { id: string } };
}

/** owner creates an invite, `user` accepts it; returns the invite code */
export async function join(owner: TestUser, guildId: string, user: TestUser) {
  const { invite } = ok(await call(owner, 'POST', `/guilds/${guildId}/invites`, {}), 'invite create');
  ok(await call(user, 'POST', '/invite/accept', { code: invite.code }), 'invite accept');
  return invite.code as string;
}

let nonceCounter = 0;
export const nonce = () => `n${Date.now().toString(36)}${nonceCounter++}`;

export async function send(user: TestUser, channelId: string, content: string | null, extra: object = {}) {
  return call(user, 'POST', '/message/send', { channelId, content, nonce: nonce(), ...extra });
}

export async function list(user: TestUser, channelId: string, cursor = 0, amount = 50) {
  return call(user, 'GET', `/message/list?channelId=${channelId}&cursor=${cursor}&amount=${amount}`);
}
