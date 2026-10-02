// Catch-all listener that records every hit; admin on :9999. Run inside docker as `canary`, `canary-p`, `canary-a`.
// CANARY_LISTEN: comma-separated `host:port=label[:tcp]` (http unless `:tcp`), default 80/443/6379/8080 on 0.0.0.0.
// CANARY_SETUP: newline-separated shell commands run first (add IPs on lo, iptables REDIRECT rules, ...).
import { json, runSetup } from './net';

type Hit = { ts: number; listener: string; port: number; source: string; method?: string; path?: string; host?: string; headers?: Record<string, string>; firstBytes?: string };
let hits: Hit[] = [];

if (import.meta.main) {
  runSetup(process.env.CANARY_SETUP);
  const spec =
    process.env.CANARY_LISTEN ?? '0.0.0.0:80=http80,0.0.0.0:443=tcp443:tcp,0.0.0.0:6379=tcp6379:tcp,0.0.0.0:8080=http8080';
  for (const item of spec.split(',')) {
    const [addr, rest = ''] = item.split('=');
    const [hostname = '0.0.0.0', portText] = addr!.split(':');
    const port = Number(portText);
    const [label = addr!, mode] = rest.split(':');
    if (mode === 'tcp') {
      Bun.listen({
        hostname,
        port,
        socket: {
          open(s) {
            hits.push({ ts: Date.now(), listener: label, port, source: s.remoteAddress });
          },
          data(s, chunk) {
            const hit = hits.findLast((h) => h.listener === label && h.source === s.remoteAddress && !h.firstBytes);
            if (hit) hit.firstBytes = Buffer.from(chunk.subarray(0, 256)).toString('base64');
            s.end();
          },
        },
      });
    } else {
      Bun.serve({
        hostname,
        port,
        fetch(req, server) {
          const url = new URL(req.url);
          hits.push({
            ts: Date.now(),
            listener: label,
            port,
            source: server.requestIP(req)?.address ?? '',
            method: req.method,
            path: url.pathname + url.search,
            host: req.headers.get('host') ?? '',
            headers: Object.fromEntries(req.headers),
          });
          return json({ canary: true });
        },
      });
    }
  }
  Bun.serve({
    hostname: '0.0.0.0',
    port: Number(process.env.CANARY_ADMIN_PORT ?? 9999),
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return json({ ok: true });
      if (url.pathname === '/hits') {
        if (req.method === 'DELETE') return (hits = []), json({ ok: true });
        const listener = url.searchParams.get('listener');
        return json(hits.filter((h) => !listener || h.listener === listener));
      }
      return json({ error: 'not found' }, 404);
    },
  });
  console.log('[canary] up');
}
