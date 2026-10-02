// Authoritative resolver for *.test with runtime-editable records, run inside docker as service `dns`.
// DNS on :53 (UDP + TCP), admin HTTP on :9053. Hand-rolled wire format, no dependencies.
import net from 'node:net';
import { z } from 'zod';
import { json, runSetup } from './net';

const adminPort = Number(process.env.DNS_ADMIN_PORT ?? 9053);

const types = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28 } as const;
type Rtype = keyof typeof types;

const recordSchema = z.object({ type: z.enum(['A', 'AAAA', 'CNAME', 'TXT']).optional(), value: z.string() });
export const ruleSchema = z.object({
  /** answer records; `type` defaults to A/AAAA by the shape of `value` */
  records: z.array(recordSchema).optional(),
  /** respond with this rcode and no answers */
  rcode: z.enum(['NXDOMAIN', 'SERVFAIL', 'REFUSED', 'NOERROR']).optional(),
  /** never answer (UDP: silence; TCP: close) */
  drop: z.boolean().optional(),
  /** each A query pops the next record set (last one repeats): DNS rebinding */
  sequence: z.array(z.array(recordSchema)).optional(),
  ttl: z.number().int().min(0).default(60),
  /** delay every answer */
  delayMs: z.number().optional(),
});
type Rule = z.output<typeof ruleSchema>;
type Rec = z.infer<typeof recordSchema>;

const defaults: Record<string, z.input<typeof ruleSchema>> = {
  'b.test': { records: [{ value: '203.0.113.12' }] },
  'p.test': { records: [{ value: '203.0.113.10' }] },
  'q.test': { records: [{ value: '172.31.0.10' }] },
  'evil.test': { records: [{ value: '203.0.113.66' }] },
  'evil2.test': { records: [{ value: '203.0.113.67' }] },
  'wrongcert.test': { records: [{ value: '203.0.113.66' }] },
  'selfsigned.test': { records: [{ value: '203.0.113.66' }] },
  'expired.test': { records: [{ value: '203.0.113.66' }] },
};

let rules = new Map<string, Rule & { calls: number }>();
let queries: { ts: number; name: string; type: string; transport: 'udp' | 'tcp'; source: string; rcode: string; answers: string[] }[] = [];
const reset = () => {
  rules = new Map(Object.entries(defaults).map(([n, r]) => [n, { ...ruleSchema.parse(r), calls: 0 }]));
  queries = [];
};
reset();

const lookupRule = (name: string) => {
  const parts = name.split('.');
  for (let i = 0; i < parts.length; i++) {
    const rule = rules.get(i === 0 ? name : `*.${parts.slice(i).join('.')}`);
    if (rule) return rule;
  }
};

const recType = (r: Rec): Rtype => r.type ?? (net.isIPv6(r.value) ? 'AAAA' : 'A');

function encodeName(name: string) {
  const out: number[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    out.push(label.length, ...Buffer.from(label, 'ascii'));
  }
  out.push(0);
  return Buffer.from(out);
}

function encodeRdata(r: Rec) {
  switch (recType(r)) {
    case 'A':
      return Buffer.from(r.value.split('.').map(Number));
    case 'AAAA': {
      // expand `::` by hand
      const [head = '', tail = ''] = r.value.split('::');
      const h = head ? head.split(':') : [];
      const t = tail ? tail.split(':') : [];
      const groups = r.value.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
      const buf = Buffer.alloc(16);
      groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g, 16), i * 2));
      return buf;
    }
    case 'CNAME':
      return encodeName(r.value);
    default: {
      const text = Buffer.from(r.value);
      return Buffer.concat([Buffer.from([text.length]), text]);
    }
  }
}

function parseQuery(msg: Buffer) {
  if (msg.length < 12) return null;
  let off = 12;
  const labels: string[] = [];
  while (msg[off]) {
    const len = msg[off]!;
    labels.push(msg.subarray(off + 1, off + 1 + len).toString('ascii'));
    off += len + 1;
  }
  off++;
  return { id: msg.readUInt16BE(0), flags: msg.readUInt16BE(2), name: labels.join('.').toLowerCase(), qtype: msg.readUInt16BE(off), qclass: msg.readUInt16BE(off + 2), end: off + 4 };
}

type Answer = { rcode: number; records: { name: string; rec: Rec; ttl: number }[]; drop?: boolean; delayMs?: number };

function resolve(name: string, qtype: number): Answer {
  const records: Answer['records'] = [];
  let current = name;
  for (let hop = 0; hop < 8; hop++) {
    const rule = lookupRule(current);
    if (!rule) return { rcode: 3, records };
    if (rule.drop) return { rcode: 0, records: [], drop: true };
    if (rule.rcode && rule.rcode !== 'NOERROR') return { rcode: { NXDOMAIN: 3, SERVFAIL: 2, REFUSED: 5 }[rule.rcode]!, records: [], delayMs: rule.delayMs };
    let set = rule.records ?? [];
    if (rule.sequence) {
      // only A queries advance the sequence, so a parallel AAAA query does not skip a step
      const idx = qtype === types.A ? rule.calls++ : Math.max(rule.calls - 1, 0);
      set = rule.sequence[Math.min(idx, rule.sequence.length - 1)] ?? [];
    }
    const cname = set.find((r) => recType(r) === 'CNAME');
    if (cname) {
      records.push({ name: current, rec: cname, ttl: rule.ttl });
      current = cname.value.toLowerCase();
      continue;
    }
    for (const rec of set) if (types[recType(rec)] === qtype) records.push({ name: current, rec, ttl: rule.ttl });
    return { rcode: 0, records, delayMs: rule.delayMs };
  }
  return { rcode: 2, records };
}

function buildResponse(msg: Buffer, q: NonNullable<ReturnType<typeof parseQuery>>, a: Answer) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(0x8400 | (q.flags & 0x0100) | 0x0080 | a.rcode, 2); // QR AA, RD copied, RA
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(a.records.length, 6);
  const parts = [header, msg.subarray(12, q.end)];
  for (const { name, rec, ttl } of a.records) {
    const rdata = encodeRdata(rec);
    const tail = Buffer.alloc(10);
    tail.writeUInt16BE(types[recType(rec)], 0);
    tail.writeUInt16BE(1, 2);
    tail.writeUInt32BE(ttl, 4);
    tail.writeUInt16BE(rdata.length, 8);
    parts.push(encodeName(name), tail, rdata);
  }
  return Buffer.concat(parts);
}

async function answer(msg: Buffer, transport: 'udp' | 'tcp', source: string) {
  const q = parseQuery(msg);
  if (!q) return null;
  const typeName = Object.entries(types).find(([, v]) => v === q.qtype)?.[0] ?? String(q.qtype);
  const a = resolve(q.name, q.qtype);
  const log = (rcode: string, answers: string[]) => queries.push({ ts: Date.now(), name: q.name, type: typeName, transport, source, rcode, answers });
  if (a.drop) {
    log('DROP', []);
    return null;
  }
  log(['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'][a.rcode] ?? String(a.rcode), a.records.map((r) => r.rec.value));
  if (a.delayMs) await Bun.sleep(a.delayMs);
  return buildResponse(msg, q, a);
}

if (import.meta.main) {
  runSetup(process.env.DNS_SETUP);
  const udp = await Bun.udpSocket({
    port: 53,
    socket: {
      async data(sock, buf, port, addr) {
        const res = await answer(Buffer.from(buf), 'udp', addr);
        if (res) sock.send(res, port, addr);
      },
    },
  });
  Bun.listen({
    hostname: '0.0.0.0',
    port: 53,
    socket: {
      open(s) {
        (s as unknown as { buf: Buffer }).buf = Buffer.alloc(0);
      },
      async data(s, chunk) {
        const state = s as unknown as { buf: Buffer };
        state.buf = Buffer.concat([state.buf, chunk]);
        while (state.buf.length >= 2 && state.buf.length >= 2 + state.buf.readUInt16BE(0)) {
          const len = state.buf.readUInt16BE(0);
          const msg = state.buf.subarray(2, 2 + len);
          state.buf = state.buf.subarray(2 + len);
          const res = await answer(Buffer.from(msg), 'tcp', s.remoteAddress);
          if (!res) {
            s.end();
            return;
          }
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(res.length);
          void s.write(Buffer.concat([prefix, res]));
        }
      },
    },
  });

  const setSchema = ruleSchema.extend({ name: z.string() });
  Bun.serve({
    hostname: '0.0.0.0',
    port: adminPort,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/health') return json({ ok: true });
        if (url.pathname === '/reset' && req.method === 'POST') return reset(), json({ ok: true });
        if (url.pathname === '/records' && req.method === 'PUT') {
          const { name, ...rule } = setSchema.parse(await req.json());
          rules.set(name.toLowerCase(), { ...rule, calls: 0 });
          return json({ ok: true });
        }
        if (url.pathname === '/records' && req.method === 'DELETE') {
          rules.delete(z.string().parse(url.searchParams.get('name')).toLowerCase());
          return json({ ok: true });
        }
        if (url.pathname === '/records' && req.method === 'GET') return json(Object.fromEntries(rules));
        if (url.pathname === '/queries' && req.method === 'GET') {
          const name = url.searchParams.get('name')?.toLowerCase();
          return json(queries.filter((x) => !name || x.name === name));
        }
        if (url.pathname === '/queries' && req.method === 'DELETE') return (queries = []), json({ ok: true });
        return json({ error: 'not found' }, 404);
      } catch (error) {
        return json({ error: String(error) }, 400);
      }
    },
  });
  void udp;
  console.log(`[dns] up, admin on ${adminPort}`);
}
