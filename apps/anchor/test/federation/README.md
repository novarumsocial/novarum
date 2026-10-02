# Federation test stack

Docker topology from `TESTING_PLAN.md` §5.1, plus a typed host-side client (`test/harness/federation.ts`).

```
bun test/federation/run.ts                 # build, up --wait, bun test test/federation, always down -v; exits with the TEST exit code
bun test/federation/run.ts up|down         # just bring the stack up / tear it down
FED_KEEP=1 bun test/federation/run.ts      # leave it running afterwards
FED_SKIP_UP=1 bun test/federation/run.ts   # reuse a running stack (combine with FED_KEEP=1 for fast iteration)
FED_SUITE=smoke|full|soak                  # smoke: no *.nightly.test.ts / *.soak.test.ts; full (default): no *.soak.test.ts; soak: only *.soak.test.ts
FED_BUILD_CACHE=gha                        # seed the anchor image from the GitHub Actions buildx cache first (best effort)
bun test/federation/run.ts -- -t "name"    # extra args after `--` go to `bun test`
```

Run from `apps/anchor` (`bun run test:fed`). Smoke mode still brings up the whole stack (including `anchor-q`, `proxy`, `dns`); it
is only ~15 s. On a failing run `test/federation/artifacts/` (gitignored) gets every service log and a `pg_dump` per database (Mailpit
messages are not saved). Tests do **not** call `startStack()`; `run.ts` does. A test file only needs `await stackIsUp()` (gives a clear
error when the stack is missing) and `resetHarness()` in `beforeAll`/`beforeEach`. Importing `harness/federation.ts` raises bun's test
timeout to 60 s (restarts, 10 s federation timeouts).

## Topology

| Service | Address | Notes |
| --- | --- | --- |
| `anchor-a` / `-b` / `-c` | 172.30.0.11 / .12 / .13 (fed) | `homeserver` = the IP, `base_url` `http://<ip>`, port 80. Anchor-a also has 169.254.169.11 on `meta` and is the only one with `s3_disable_cors = false` |
| `anchor-p` | 203.0.113.10 (pub) + 172.30.0.20 (fed) + 169.254.169.20 (meta) | `p.test`, `https://p.test`, public mode; trusts the CA (`NODE_EXTRA_CA_CERTS`); resolver `dns` |
| `anchor-q` | 172.31.0.10 (egress, `internal: true`) | `q.test`, public mode, all outbound through `proxy`; trusts the CA. **Not reachable from the host**: use `fetchIn('q', ...)` |
| `fake` | 172.30.0.66/.67 (http :80), 203.0.113.66/.67 (https :443), admin `172.30.0.66:9000` | identities 1 and 2 (see below) |
| `dns` | 172.30.0.53 / 203.0.113.53 / 172.31.0.53, admin `:9053` | authoritative `*.test`; UDP + TCP 53 |
| `proxy` | 203.0.113.80 / 172.31.0.80 / 172.30.0.80, port 3128 | **smokescreen** (Stripe), built from `proxy/Dockerfile`. `--allow-range 203.0.113.0/24` (TEST-NET-3 is otherwise denied), private/loopback/link-local denied. Denies are JSON log lines with `"allow":false` |
| `b-proxy` | 203.0.113.12 (+ 172.30.0.112) | Caddy 2, `https://b.test` -> `172.30.0.12:80`, cert from the test CA |
| `canary` | 172.30.0.99, admin `:9999` | listeners `http80`, `tcp443`, `tcp6379`, `http8080` |
| `canary-meta` | 169.254.169.254 (meta) + 172.30.0.98, admin `172.30.0.98:9999` | listeners `metadata` (:80), `metadata8080`; only anchor-a and anchor-p are on `meta` |
| `canary-p`, `canary-a` | inside anchor-p / anchor-a's netns (`network_mode: service:`), admin `<anchor ip>:9999` | listeners `loopback8080` (127.0.0.1:8080), `loopback443` (tcp). `restart('p')` also restarts `canary-p` (a netns owner restart orphans it) |
| `postgres` | 172.30.0.5 (+172.31.0.5), tmpfs | DBs `anchor_a/b/c/p/q`, user/password `novarum` |
| `garage`, `mailpit` | 172.30.0.6, 172.30.0.7 (+172.31.0.7) | Mailpit API: `mailpitUrl` = `http://172.30.0.7:8025` |

Default DNS records: `b.test` 203.0.113.12, `p.test` 203.0.113.10, `q.test` 172.31.0.10, `evil.test`/`wrongcert.test`/`selfsigned.test`/`expired.test`
203.0.113.66, `evil2.test` 203.0.113.67; everything else NXDOMAIN. `fake` serves https for `evil.test`, `evil2.test` (valid), `wrongcert.test`
(CA-signed but for another name), `selfsigned.test` (not signed by the CA) and `expired.test` (CA-signed, expired 2020) via SNI on both public IPs.

Why a `meta` network: anchors already listen on `0.0.0.0:80`, so a canary on `169.254.169.254:80` in the same namespace is impossible and an iptables
REDIRECT needs `nft_redir` (missing in our kernel). A separate container with that address on a shared network gives the same visibility.

### Fake anchor identities

Identity `1` = homeserver `172.30.0.66` (public name `evil.test`), identity `2` = `172.30.0.67` (`evil2.test`). Each has its own ed25519 key (rotatable).
Discovery on both sides returns `homeserver: <private ip>`, `baseUrl: http://<private ip>` by default; override with `discovery: {...}`.

## Client API (`test/harness/federation.ts`)

```ts
import { api, signup, fake, dns, canary, proxy, fetchIn, exec, logs, restart, stop, start, pause, unpause,
         resetHarness, stackIsUp, anchors, ips, mailpitUrl } from '../harness/federation';
```

- Addressing: `api('a'|'b'|'c'|'p')` -> base url; `anchors.a.{ip,homeserver,baseUrl,url,db,service}`; `ips.*`. `signup('b', overrides?)` is `users.ts signup(api('b'))`.
- Lifecycle: `startStack({config?, build?})`, `stopStack()`, `restart(s)`, `stop(s)`, `start(s)`, `pause(s)`, `unpause(s)` (`s`: `'a'..'q'`, `'fake'`, `'dns'`, `'canary'`, `'canary-a'`, `'canary-p'`,
  `'canary-meta'`, `'proxy'`, `'b-proxy'`, `'postgres'`, ...; anchors are awaited until they answer), `exec(s, 'sh cmd' | argv, {env})` -> `{code, stdout, stderr}`, `logs(s)` -> string.
  `startStack({config: {a: {federation: {nonce_max_age_seconds: 2}}}})` merges `ConfigOverrides` over the generated per-anchor configs (written to `test/federation/.run/config/<name>/config.toml`).
- `fetchIn(s, url, {method, headers, body, timeoutMs, env, inheritProxy})` runs a `fetch` (redirect manual) inside a container with its DNS, CA and network: `{ok:true,status,headers,body}` or `{ok:false,error,code}`.
  `env: {NODE_EXTRA_CA_CERTS: null}` unsets a variable for the probe; `HTTP(S)_PROXY` is unset unless `inheritProxy: true`.
- `fake.respond(identity, route, behaviour)`: route is `/path`, `METHOD /path` or a prefix `POST /federation/*`; later rules win. Behaviour: `status`, `headers`, `body`, `json`, `bodyBase64`,
  `redirect` (status default 302), `hangMs` (-1 = never answer), `drip {bytes, chunkBytes, intervalMs}`, `hugeBytes`, `gzipBombBytes`, `nonJson`, `invalidUtf8`, `deepJson`, `badKey` (discovery with a
  non-matching public key), `discovery {homeserver, baseUrl, version, publicKey{id,algorithm,key}, ...}` (merged into the document), `times: n` (first n matching requests only).
  Unmatched routes answer 404; `/.well-known/anchor/info` answers a valid document. `fake.clearRoutes(id)`, `fake.reset()` (rules + request logs of both identities; keys untouched).
- `fake.requests(identity, {path?: prefix, since?: id})` -> `[{id, ts, scheme, method, path, host, headers, body, sourceIp, localIp}]` over http and https; `fake.clearRequests(id)`.
- `fake.sign({identity, method, path, host, homeserver?, body?, date?, dateOffsetSeconds?, nonce?, bodyHash?, keyId?, key?: 'current'|'previous'|'random', tamper?})` -> `{headers, signingString}`
  (v1 signing string `v1\nMETHOD\npath\nhost\nhomeserver\ndate\nnonce\nbodyHash`, ed25519; `host` is the host the *recipient* sees; `bodyHash` overrides both header and signed value).
  `fake.send(identity, 'a', 'POST', path, body, signOverrides?)` signs and posts to a real anchor -> `{status, text, headers}`. `fake.rotateKey(id)`, `fake.info(id)`.
- `dns.set(name, 'ip' | {type:'CNAME',value} | [...], ttl=60)`, `dns.rebind(name, ['1.2.3.4', ['127.0.0.1']], ttl=0)` (each **A** query advances; the last set repeats), `dns.nxdomain/servfail/drop(name)`,
  `dns.slow(name, ms, ips)`, `dns.remove(name)`, `dns.queries(name?)`, `dns.reset()` (defaults back, log cleared). `*.suffix.test` wildcards work.
- `canary.hits(where = 'net' | 'meta' | 'p' | 'a', listener?)`, `canary.reset(where?)` (no arg: all), `canary.allHits()` (tagged by canary; assert `toEqual([])` after each SSRF case).
- `proxy.logs()`, `proxy.denies()` (smokescreen JSON deny lines).
- `resetHarness()` = `fake.reset()` + `dns.reset()` + `canary.reset()`.

Runner mode: everything above except `exec/logs/restart/stop/start/pause/unpause/fetchIn` is plain HTTP to fixed IPs, so a `runner` container on the `anchor-fed_fed` network (needed on macOS)
would work unchanged; the docker-based helpers need the docker socket there. Only host mode is implemented and tested; `FED_RUNNER=container` is not wired.

## Quirks found

- **Bun 1.3.9 ignores `HTTP(S)_PROXY` set in `process.env` after startup.** `utils/config.ts` exports `network.proxy_url` into `process.env` lazily, so an anchor configured only
  through `config.toml` still connects directly (reproduced in anchor-q: discovery of `evil.test` fails with "Unable to connect" when the container env has no proxy). `fetch(url, {proxy})` and the
  startup environment work. The compose file therefore sets `HTTP(S)_PROXY` in anchor-q's container env; `FED_Q_STARTUP_PROXY= bun test/federation/run.ts up` empties it to reproduce the gap.
- `NODE_EXTRA_CA_CERTS` is honoured by Bun 1.3.9 with the ECDSA P-256 CA (positive and negative controls in `boot.test.ts`).
- Discovery results are cached in anchor memory for 5 min (30 s for failures): `restart(name)` to start from a clean cache.
- Auth rate limits are per client IP; `users.ts freshIp()` now starts at a random address so a long-lived (`FED_KEEP`) stack does not see the same IPs twice.
- `docker compose` here uses the classic builder (no buildx plugin); the harness builds the three images itself (`buildImages()`), not through compose `build:`.
- Harness processes (`fake`, `dns`, `canary`) run from the bind-mounted `apps/anchor` and `node_modules` (zod), so edits need only `restart('fake')`, not a rebuild.
- getent/glibc in the anchor image does not query AAAA without IPv6 (use `dns.queries()` to see what was asked); `getent ahostsv6` returns nothing for AAAA-only answers.
