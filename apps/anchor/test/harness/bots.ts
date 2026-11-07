import { call } from './chat';
import { eventually } from './wait';
import { uniqueName, type TestUser } from './users';
import type { RealtimeMessage } from './ws';

export type TestBot = Awaited<ReturnType<typeof createBot>>;

/** an actor that authenticates with `Authorization: Bot <token>` */
export const botActor = (url: string, token: string) => ({
  url,
  token,
  fetch: (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${token}`,
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    }),
});

/** `owner` creates a bot in the developer panel; returns the bot and an actor using its token */
export async function createBot(
  owner: TestUser,
  overrides: { username?: string; public?: boolean } = {}
) {
  const res = await call(owner, 'POST', '/developers/bots', {
    username: overrides.username ?? uniqueName('bot'),
  });
  if (res.status !== 200)
    throw new Error(`bot create failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (overrides.public === false) {
    await call(owner, 'PATCH', `/developers/bots/${res.body.bot.userId}`, { public: false });
  }
  return {
    bot: res.body.bot as { userId: string; username: string; homeserver: string; handle: string },
    ...botActor(owner.url, res.body.token as string),
  };
}

/** `adder` adds `bot` to a guild through the client route */
export const addBot = (
  adder: Pick<TestUser, 'fetch'>,
  guildId: string,
  bot: { username: string; homeserver: string },
  role: 'MEMBER' | 'ADMIN' = 'MEMBER'
) =>
  call(adder, 'POST', `/guilds/${guildId}/bots`, {
    username: bot.username,
    homeserver: bot.homeserver,
    role,
  });

/** opens /realtime as a bot and waits for the connect snapshot */
export async function connectBot(url: string, token: string) {
  const events: RealtimeMessage[] = [];
  const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/realtime`, {
    headers: { authorization: `Bot ${token}` },
  } as any);
  let closed: { code: number; reason: string } | null = null;
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)));
  ws.onclose = (e) => (closed = { code: e.code, reason: e.reason });
  const rt = {
    ws,
    events,
    get closed() {
      return closed;
    },
    send: (message: object) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
    waitClosed: (timeout = 5000) => eventually(() => closed, { timeout, message: 'ws close' }),
    waitFor: (type: string, pred: (e: RealtimeMessage) => boolean = () => true, timeout = 5000) =>
      eventually(() => events.find((e) => e.type === type && pred(e)), {
        timeout,
        message: `ws event ${type}`,
      }),
  };
  await eventually(() => events.some((e) => e.type === 'voice.states.snapshot') || closed, {
    timeout: 5000,
    message: 'bot realtime connect',
  });
  return rt;
}
