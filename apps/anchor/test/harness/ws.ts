import { cookieName } from './users';
import { eventually } from './wait';

export type RealtimeMessage = { type: string; data?: any; [key: string]: any };

/** opens /realtime with a session cookie; events are recorded so waitFor sees past ones too */
export async function openRealtime(url: string, cookie?: string) {
  const events: RealtimeMessage[] = [];
  const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/realtime`, {
    headers: cookie ? { cookie: `${cookieName}=${cookie}` } : {},
  } as any);
  let closed: { code: number; reason: string } | null = null;
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)));
  ws.onclose = (e) => (closed = { code: e.code, reason: e.reason });
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
    const onclose = ws.onclose;
    ws.onclose = (e) => {
      (onclose as any)?.(e);
      resolve();
    };
  });
  return {
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
}
