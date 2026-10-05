# Anchor testing plan

Status: proposal. Scope: `apps/anchor` only; the frontend is covered only where it consumes the `App` Eden type.

Already in place (prerequisites done ahead of the harness):

- `ANCHOR_CONFIG` env var selects the config file (`utils/config.ts`). It defaults to `./config.toml`.
- `test/config.toml` is a committed, placeholder-only config for unit tests and the template for harness configs. It's whitelisted in `apps/anchor/.gitignore`.
- `bun run --filter anchor check` (`tsc --noEmit`).
- `cli rotate-keys` (`bun run src/index.ts cli rotate-keys`) generates and activates a new federation key.
- Discovery and signed federation POSTs use `redirect: 'error'`, like `fetchFederatedUser` already did.
- `extAnchorDown` is also set when a remote times out or refuses the connection, not only on non-2xx discovery.
- The per-socket `misc.ping` interval is cleared on close. Every socket now gets pings, not only a user's first one.

## 0. What the code tells us before we start

These facts shape the harness. Most are constraints. Rows marked **Verify** or **Known gap** are behaviour the first tests should pin down.

| Fact | Where | Consequence for testing |
| --- | --- | --- |
| `getConfig()` re-reads the config on every call, from `ANCHOR_CONFIG` or else `./config.toml` in the **cwd**. `config.toml` is gitignored, so CI has none | `utils/config.ts`, `.gitignore` | Each test process sets `ANCHOR_CONFIG`. `test/config.toml` is the committed fixture. |
| `src/db/index.ts`, `drizzle.config.ts` and `fix-push.ts` prefer `DATABASE_URL` over `database_url` | `src/db/index.ts` | L2 tests point each file at its own database through `DATABASE_URL`, with no extra config file. |
| `src/db` calls `getConfig()` when imported, and `discovery.ts`, `keys.ts`, `attachments.ts`, `emojiSearch.ts`, `federationRealtime.ts` and `friends/model.ts` all import it | `src/db/index.ts` | "Pure" unit targets still need `ANCHOR_CONFIG`. The Postgres connection is lazy, so they don't need a running DB (checked). |
| `src/index.ts` runs migrations (from `./drizzle`, relative to cwd), S3 CORS setup, emoji download, online-user cleanup and `.listen()` at import time | `src/index.ts` | Spawned anchors run with `cwd = apps/anchor`. In-process `app.handle()` needs the §2.1 refactor. |
| Some modules start timers when imported: presence cleanup every 3s (`modules/realtime/services.ts`) and friend sync retry every 30s (`modules/friends/services.ts`) | module top level | Importing the app in-process starts background DB queries and keeps `bun test` alive. §2.1 seam 2 has to move these too. |
| Homeserver names **cannot contain `:`** (rejected in `normalizeFederationHomeserver`) | `utils/discovery.ts` | Federation targets must listen on port 80 (http) or 443 (https). The dev config's `homeserver = "localhost:5049"` can't be federated *to*. |
| Plain http is only allowed when the target is `localhost`, `*.localhost` or a private IP, **and** our own `base_url` is local/private | `utils/discovery.ts` | Multi-server tests use private IPs on a Docker network (see §5.1). |
| Signing string is `v1\nMETHOD\npath\nhost\nhomeserver\ndate\nnonce\nbodyHash` (ed25519, base64). WebSocket bridges pass the headers as query params | `utils/discovery.ts`, `modules/federation/services.ts` | A standalone test signer can impersonate a hostile homeserver, and it doubles as a wire-protocol spec test. |
| A `user` payload whose homeserver doesn't match the signer gets **401** `Federation user homeserver mismatch` on guild/channel/DM routes, and **403** on the friends routes | `modules/federation/services.ts:218,291,383,461…` | The impersonation matrix asserts the status for each route family (§5.2). |
| Auth rate limits are in memory, keyed by IP via `elysia-ip` with `headersFirst: true`. Login is 10/min, `login/mfa/email` 3/15min, signup 5/hour, `reset-password` 5/15min and `password-reset/request` 3/15min | `modules/auth/services.tsx`, `src/index.ts` | `signup()` must rotate `X-Forwarded-For`, which also proves the spoofing bypass. Limits reset on restart. |
| Password reset does **not** revoke existing sessions | `modules/auth/services.tsx` | **Known gap.** §4.1 asserts revocation and fails until the auth fix lands. |
| `syncPending` friendships are retried every 30s and on `GET /friends` | `modules/friends/services.ts:66,290` | Convergence tests wait up to about 40s. |
| `writeEmojis()` fetches from jsdelivr at boot (errors are swallowed) | `utils/emojiWriter.ts` | Boot works offline, but emoji tables stay empty. Emoji tests must seed a fixture. |
| Guild WS bridges start only from `GET /guilds/list`. DM bridges are restored at boot | `modules/guilds/services.ts:391`, `src/index.ts:87` | Restart tests must cover both paths. |
| Federated invite accept stores and publishes the shadow guild with `ownerId: session.userId` | `modules/invite/services.ts:153,303` | **Verify:** the first local joiner must not gain owner powers (channel create, invites, PATCH, reorder) on a `fed:guild:*` shadow. |
| The WS bridge access check compares `member.user.homeserver === origin.homeserver` case-sensitively. Federated users are always stored lower-cased (`upsertFederatedUser`), so this can't be triggered over the wire | `modules/federation/services.ts:1473,1524`, `utils/federationPayload.ts` | **Verify** by seeding a mixed-case member row directly, and add a test that every federated-user write path lower-cases. |
| Federation nonces are unique per `(homeserver, nonce)`. Expired ones are cleaned up lazily, at most once per 60s, and only when a federation request arrives | `utils/keys.ts`, `src/db/schema.ts` | The cleanup test has to send a request to trigger it. A concurrent replay must give 401, never 500. |
| `discoverRemoteAnchor` checks the resolved IPs, then `fetch` resolves the name again | `utils/discovery.ts` | **Known gap (DNS rebinding).** Bun's `fetch` can't pin an IP while keeping SNI, so this is closed at the egress proxy (`network.proxy_url`), not in process. See §5.4. |
| `fetchFederatedUser` and the realtime bridges (`new WebSocket`) reuse the cached `baseUrl` without calling `assertSafeFederationUrl` again | `utils/federationPayload.ts`, `utils/federationRealtime.ts` | **Known gap.** A host that rebinds after discovery is reached directly, for up to 5 minutes. §5.4 E. |
| Bun's `fetch` honours `HTTP_PROXY`/`HTTPS_PROXY`; Bun's `WebSocket` ignores them (checked on Bun 1.4.2) | Bun runtime | **Known gap.** With `network.proxy_url` set, federation bridges still connect directly, bypassing the egress filter. §5.4 F. |
| Discovery runs **before** the signature check, so any request with the federation headers present makes the anchor discover an arbitrary homeserver. `discoveryCache` has no size limit | `modules/federation/services.ts` `verifyFederationRequest`, `utils/discovery.ts` | Outbound requests can be triggered pre-auth: an amplification and memory-growth vector. §5.4 G. |
| The discovered `baseUrl` may point at any public host and port, not only the homeserver's own. The signing string covers the recipient `host` but not the intended recipient homeserver | `utils/discovery.ts` | **Verify (confused deputy):** homeserver `evil.test` can declare `baseUrl = https://b.test`. A then sends B requests that B accepts as genuinely meant for B. §5.4 C. |
| IPv6 `baseUrl`s like `https://[::1]/` are refused only by accident. `URL.hostname` keeps the brackets, so `isPrivateIp` says "public" and the request fails only because `dns.lookup('[::1]')` returns `ENOTFOUND` | `utils/discovery.ts` `assertSafeFederationUrl` | **Verify.** Pin the refusal, and strip brackets before the IP check. |
| `isPrivateIp` misses IPv4-compatible (`::127.0.0.1`), hex-mapped (`::ffff:7f00:1`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) forms of private addresses | `utils/discovery.ts` | **Known gap.** §5.4 A. |
| Remote response bodies (discovery, POST results) have no size limit, and `fetch` decompresses gzip automatically | `utils/discovery.ts`, `utils/federationPayload.ts` | **Verify:** huge bodies and gzip bombs from a hostile peer. §5.4 H. |
| When our own `base_url` is local/private, **every** private target is allowed, including loopback and `169.254.169.254` | `utils/discovery.ts` `allowLocalFederationTargets` | Pinned as designed in §5.4 I. Whether loopback/link-local should still be refused is in §11. |
| Presence, rate limits, bridges and realtime pub/sub are all per process. `clearOnlineUsers` marks offline anyone not connected to *this* process | `modules/realtime/services.ts` | **One anchor process per database is a requirement.** It's tested as a documented constraint, not a supported mode. |
| `fix-push.ts` backfills migration hashes for DBs created with `db:push` | `src/db/fix-push.ts` | Gets its own migration scenario (§6). |
| `package.json` `test` script exits 1 | `apps/anchor/package.json` | Replace it (§9). |
| The Dockerfile copies only `apps/anchor/package.json` and runs `bun install` without `bun.lock` | `apps/anchor/Dockerfile` | Containers would run different dependency versions than host tests. Fix it before the federation stack (§10 step 5). |

## 1. Goals and layers

| Layer | Runs against | Speed | Run on |
| --- | --- | --- | --- |
| L1 Unit | Pure functions (with `ANCHOR_CONFIG`), no DB | ms | every save / PR |
| L2 DB integration | Real Postgres, database per test file via `DATABASE_URL` | seconds | PR |
| L3 API integration (single server) | One spawned anchor + Postgres + Garage + Mailpit | ~1 min | PR |
| L4 Realtime | L3 stack + WebSocket clients | ~1 min | PR |
| L5 Federation | 3 anchors + 1 hostile fake anchor on a Docker network | few min | PR (smoke) / nightly (full) |
| L6 Migrations | Postgres only | ~1 min | PR when `drizzle/` or `schema.ts` changes, plus nightly |
| L7 Security / fuzz | L3/L5 stacks | few min | nightly |
| L8 Perf / soak | Benchmarks: Postgres only. Soak: L5 stack | long | weekly + manual (`workflow_dispatch`) |

Pass criteria for "anchor is tested": L1–L6 green in CI on every PR. Every federation route has positive, auth-negative and impersonation-negative cases. Every migration is proven to upgrade from its predecessor with realistic data. Tests for known gaps are written up front and marked `test.failing` until they're fixed, so a fix flips them green and an accidental regression turns them red again.

## 2. Tooling

- **Runner:** `bun test` (built in, no new deps). Files live in `apps/anchor/test/**` as `*.test.ts`.
- **Client:** `treaty<App>` from `@elysia/eden` (already used by the frontend), so tests are type-checked against real routes. Raw `fetch` is for malformed or hostile requests.
- **WS client:** Bun's native `WebSocket` with a cookie header.
- **Assertions on shapes:** reuse the Zod response schemas from `src/db/zod.ts` (`schema.parse(body)`), per repo convention. No hand-rolled `typeof` checks.
- **Infra:** `test/compose.yml` (separate from `dev/compose.yml`, with tmpfs volumes so it starts clean every time):
  - `postgres:18-alpine` with `tmpfs` data, `fsync=off`
  - `garage` (single node, same as dev)
  - `axllent/mailpit` as the SMTP sink (port 1025, matching `test/config.toml`), with its HTTP API used to read OTP emails
  - `livekit-server --dev` (only for voice tests; tagged so you can skip it)

### 2.1 Testability seams

1. **`ANCHOR_CONFIG` env var.** Done.
2. **Split `src/index.ts`** into `src/app.ts` (`export const createApp = () => new Elysia()...` with no side effects) and `src/index.ts` (migrate → boot tasks → timers → `createApp().listen()`). The module-level `setInterval`s in `realtime/services.ts` and `friends/services.ts` move into exported `start…()` functions that `index.ts` calls. L3 tests can then use `app.handle(new Request(...))` in-process, which is roughly 10× faster than spawning. Keep `export type App` pointing at the same type.
3. **`misc.skip_emoji_download` config flag (optional)** so boot doesn't hit the network in CI.

The harness in §2.2 only needs seam 1. Seams 2 and 3 are speedups.

### 2.2 Harness (`test/harness/`)

```
test/harness/
  anchor.ts      # spawnAnchor({ name, homeserver, baseUrl, port, db, s3? }) → { url, stop, restart, logs }
  db.ts          # createDatabase(name) / dropDatabase(name) via an admin connection
  users.ts       # signup(api, overrides?) → { user, cookie, api }  (rotates X-Forwarded-For per call)
  signer.ts      # standalone v1 ed25519 signer (mirrors signFederationRequest)
  fakeAnchor.ts  # hostile/controllable homeserver(s): serves /.well-known/anchor/info, signs arbitrary requests,
                 # answers http (private side) and https with SNI certs (public side); per-route behaviours
                 # (redirect, hang, drip, huge body, gzip bomb, bad key) and request counters over an admin port
  dns.ts         # authoritative *.test resolver with runtime-editable records/TTLs (rebinding, NXDOMAIN, SERVFAIL, timeouts)
  canary.ts      # catch-all listener that records every hit; `hits()` must be empty after each §5.4 case
  mail.ts        # mailpit helpers: latestOtpFor(email)
  ws.ts          # openRealtime(cookie) → { events: AsyncQueue, send, close, waitFor(type, pred) }
  wait.ts        # eventually(fn, timeout) for async federation effects
```

`spawnAnchor` reads `test/config.toml` and overrides `database_url`, `homeserver`, `base_url`, `listen_port` and `key_dir`. It keeps `s3_disable_cors = true` unless the test passes `s3: true` (only upload tests need Garage CORS). It writes the result to a temp dir and runs `bun <abs>/src/index.ts` with `cwd = apps/anchor` (so `./drizzle` resolves) and `ANCHOR_CONFIG=<tmp>/config.toml`. It waits for `GET /` → `this is anchor` and captures stdout so failures can print logs. Each test file gets a fresh database (`anchor_<file>_<rand>`), so files can run in parallel.

## 3. L1: Unit tests

All unit tests run with `ANCHOR_CONFIG=test/config.toml` (the `test:unit` script sets it).

| Target | Cases |
| --- | --- |
| `utils/federationIds.ts` | round-trip make/parse for guild and channel; homeservers/IDs containing `:` `%` `/` and unicode; reject wrong prefix/kind/part count; malformed `%` escapes return `null` |
| `utils/discovery.ts` `normalizeFederationHomeserver` (export it or test via `discoverRemoteAnchor`) | rejects `://`, `/`, `\`, `@`, `:`, `_`, unicode, leading/trailing `.`, `..`, empty, non-string; lower-cases and trims trailing `/` |
| `isPrivateIp` / `isLocalHostname` | full table: 0/8, 10/8, 127/8, 100.64/10, 169.254/16, 172.16/12 boundaries (172.15 / 172.32 are public), 192.168, 192.0, 198.18/15, ≥224, `::`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:10.0.0.1`, plus public counter-examples |
| `utils/keys.ts` `signMessage`/`verifyMessage` | sign→verify; tampered message/signature/key fails; wrong key type throws or returns false (decide which and pin it) |
| Signing string | golden test: a fixed key, date and nonce produce a known signature. Any accidental protocol change breaks it |
| `friends/model.ts` `friendAuthority` | order-independent, case-insensitive, stable |
| `friends/model.ts` `nextFriendshipState` | the full state × action × actor matrix (NONE/PENDING/ACCEPTED/DECLINED × REQUEST/ACCEPT/DECLINE/CANCEL/REMOVE × requester/recipient). Snapshot the table so changes are deliberate |
| `utils/otp.ts` | TOTP vectors from RFC 6238; grace window ±1 step; base32 round-trip; pepper effect |
| `utils/messageCursor.ts` | ordering ties on `createdAt` broken by `id` |
| `utils/mentions.ts` `mentionHandles` | only the `@user:homeserver` form matches (plain `@user` never does); handles inside URLs are ignored; lower-cased and de-duplicated; no match after `.`/alnum (emails) |
| `utils/emojiSearch.ts` | fuzzy search ranking |
| `utils/config.ts` | valid minimal config; `ANCHOR_CONFIG` overrides the path; defaults (`listen_port` 5049, `nonce_max_age_seconds` 300, CORS `*` collapse, origin augmentation); bad `database_url`/`base_url`/`livekit_url` rejected |
| `utils/sniffAudioVideo.ts`, `utils/attachments.ts` | MIME allow-list, size limits, spoofed extension vs magic bytes |
| `realtimeEventSchema` + `mapFederatedRealtimeEvent` (`utils/federationRealtime.ts`) | every event type is mapped to `fed:` IDs exactly once (never double-prefixed); unknown or malformed events are dropped |

## 4. L2–L4: Single-server integration

Each area lists the happy path first, then the negative cases. Every authenticated route also gets a **no cookie → 401** and an **expired/forged session → 401** case. Generate these from the OpenAPI document (`/openapi/json`) so new routes are covered automatically.

### 4.1 Auth (`/auth`)
- signup → cookie set (`HttpOnly`, `SameSite=Lax`, not `Secure` on http; `Secure`/`None`/`Partitioned` when `base_url` is https); duplicate email → 409; duplicate username → 409; username pattern and length bounds; password min length.
- login with password → session; wrong password; unknown email; behaviour is identical for both (no user enumeration through status or timing, within a tolerance).
- MFA: enable TOTP (`/mfa/totp/enable`, `/mfa/totp/qr`), login → `mfaRequired` challenge → `/login/mfa` with a valid, expired or reused code; email MFA via Mailpit (`/login/mfa/email`); toggles; `DELETE /mfa`.
- Password reset: request → Mailpit OTP → reset; the OTP is single-use and expires; **every session created before the reset is revoked** (the old cookie → 401, from both the browser that reset and a second one). `test.failing` until the auth fix lands (§0).
- `/logout` deletes the session row, and replaying the old cookie → 401.
- Session token tampering: wrong secret with a valid id; malformed token; an expired row is deleted on access.
- **Rate limits:** the 11th `/login` in 60s from one IP → 429; another IP is unaffected; the 6th signup in an hour → 429; **spoofed `X-Forwarded-For` bypass** (document the expected deployment: a trusted proxy must overwrite the header); a restart clears the counters (in-memory, pinned so it's a deliberate choice).

### 4.2 Users (`/user`), friends (`/friends`), uploads (`/upload`)
- Avatar/banner presign → PUT to Garage → confirm; size > `max_avatar_size` rejected; non-image rejected; `avatar/color` computed. (Spawn with `s3: true`.)
- `about` read and update, length limits.
- Local friends: request / accept / decline / cancel / remove; self-request → 400; bot target → 404; double request is idempotent; realtime `friends.changed` is delivered to both users.
- Attachment presign → upload → send message with `attachmentIds`; unknown, foreign or duplicate IDs rejected; `> maxAttachmentCount` rejected; preview generation when `save_attachment_thumbnails`; CDN signing params when `cdn_signing_secret` is set.

### 4.3 Guilds, channels, invites, messages
- Guild create / list / patch / reorder / avatar; only the owner can patch or create invites (pin the permission matrix: owner vs member vs non-member).
- Channel create / order / users / read state / typing; non-member → 403/404 (pin which).
- Invites: create with or without expiry; GET preview; accept twice is idempotent; expired → 404; member positions shift (new guild at position 0).
- Messages: send / edit / delete by author only; non-author edit → 403; `list` pagination with the cursor across identical `createdAt` timestamps (insert 3 messages with the same timestamp); `nonce` echo; replies; pings populate `message_ping` and unread mentions.
- DMs (`/dm`): requires an accepted friendship (403 otherwise); open is idempotent (`dmKey` unique); close/reopen (`closed` flag); a new message reopens a closed DM; **write is blocked after unfriending, read still works** (`canAccessChannel`).

### 4.4 Realtime (`/realtime` WS)
- No or invalid cookie → close 1008.
- Messages sent before `open` finishes are handled after session validation (send immediately after connect).
- Subscriptions: receives `guildEvents` for member guilds only; `subscribe.guild` for a non-member guild is ignored or refused.
- Presence: online on connect; offline about 3s after the last socket closes (two tabs → still online after one closes).
- Keepalive: every socket (including a user's second tab) gets `misc.ping` every 30s; after close, no further sends are attempted for that socket (fake timers, or a short interval in a test build).
- Every event type in `RealtimeEvent` has at least one test that triggers it via REST and asserts the payload with the Zod schema.
- `voice.join` / `voice.leave` / `call.ring` / `emoji.search` / `emoji.query` (with a seeded emoji fixture); bad body → validation error, not a crash.

### 4.5 Voice (tagged `@livekit`)
- `/channel/:id/call/token` returns a JWT with correct room/identity/grants; non-member → 403.
- `/channel/livekit/webhook` with an invalid signature → 401; a valid `participant_joined`/`left` updates presence and publishes `voice.state.changed`.

## 5. L5: Federation

### 5.1 Topology

`test/federation/compose.yml` runs two user-defined bridge networks:

- **`fed` (`172.30.0.0/24`):** the private segment, where the federation flows run.
- **`pub` (`203.0.113.0/24`):** TEST-NET-3, which `isPrivateIp` treats as public. Anchors that federate in public mode live here (§5.4).

Every anchor uses `listen_port = 80`, because homeservers can't carry a port.

| Service | IP | `homeserver` | `base_url` | Notes |
| --- | --- | --- | --- | --- |
| `anchor-a` | 172.30.0.11 | `172.30.0.11` | `http://172.30.0.11` | |
| `anchor-b` | 172.30.0.12 | `172.30.0.12` | `http://172.30.0.12` | |
| `anchor-c` | 172.30.0.13 | `172.30.0.13` | `http://172.30.0.13` | used for 3-way and third-party impersonation tests |
| `fake` | 172.30.0.66, 172.30.0.67 | `172.30.0.66`, `172.30.0.67` | `http://<ip>` | `test/harness/fakeAnchor.ts`. Two identities with separate keys, so nonce scoping and cross-homeserver cases need no third real anchor. Controlled by the test over an admin port. The same process also serves the public side below |
| `postgres` | 172.30.0.5 | | | one DB per anchor (`anchor_a`, `anchor_b`, `anchor_c`, `anchor_p`, `anchor_q`) |
| `garage`, `mailpit`, `livekit` | | | | shared |
| `anchor-p` | 203.0.113.10 + 172.30.0.20 | `p.test` | `https://p.test` | **public mode** (its `base_url` isn't local or private). Also on `fed`, so private targets are *routable*: a refusal proves the policy, not the routing. Trusts the test CA via `NODE_EXTRA_CA_CERTS`. Uses `dns` as its resolver |
| `anchor-q` | `egress` only | `q.test` | `https://q.test` | public mode, with `network.proxy_url` set to `proxy`. Its only network is the `internal: true` network `egress`, shared with `proxy` and `dns`, so it has no direct route out (egress-proxy variant) |
| `fake` (public side) | 203.0.113.66, 203.0.113.67 | `evil.test`, `evil2.test` | `https://<name>` | the same `fakeAnchor.ts` process, serving https with SNI-selected certs from the test CA. It also serves deliberately bad certs under `wrongcert.test`, `selfsigned.test` and `expired.test` |
| `b-proxy` | 203.0.113.12 | `b.test` | `https://b.test` | Caddy in front of `anchor-b`, with a test-CA cert. Doubles as the Caddy variant below and as the confused-deputy target (§5.4 C) |
| `dns` | 203.0.113.53 (also on `egress`) | | | `test/harness/dns.ts`: an authoritative resolver for `*.test`. Records and TTLs can be changed at runtime over an admin port, for rebinding |
| `proxy` | 203.0.113.80 (also on `egress`) | | | smokescreen (an SSRF-filtering CONNECT proxy) that denies private, loopback and link-local destinations |
| `canary` | 172.30.0.99 | | | `test/harness/canary.ts`: answers anything on ports 80, 443, 6379 and 8080, and counts every hit by source and path |
| `canary-p` | anchor-p's network namespace (`network_mode: service:anchor-p`) | | | the same canary, listening on `127.0.0.1:8080`, `127.0.0.1:443` and `169.254.169.254:80` (added to `lo` with `NET_ADMIN`), so loopback and metadata hits from anchor-p are visible. `canary-a` does the same for anchor-a |

Every §5.4 test asserts that the canaries and the fake's "target" counters saw **zero** requests, unless the case expects a hit.

The test CA (`test/federation/certs/gen.sh`, committed; the generated keys stay out of git) must use ECDSA P-256 or RSA. Bun failed to verify an ed25519 CA in our check. A boot smoke test confirms that the pinned Bun version (1.4.2 in the Dockerfile) honours `NODE_EXTRA_CA_CERTS`.

Why IPs: homeservers can't carry a port, plain http is only allowed for private/local targets, and IP literals skip DNS (`*.localhost` resolution inside containers isn't reliable). Anchors build from `apps/anchor/Dockerfile` (after the lockfile fix, §10 step 5) and get the harness-generated config mounted at `/app/config.toml`, with `s3_disable_cors = true` except on `anchor-a`, which covers the attachment flows. The test runner runs on the host (Linux can route to bridge IPs) or as a `runner` container on the same network (needed on macOS).

The public segment also covers two variants:

- **Caddy variant:** `b-proxy` covers the reverse-proxy `Host`/`X-Forwarded-*` path that production uses.
- **Egress-proxy variant:** `anchor-q` covers DNS rebinding and proxy bypass (§5.4 E–F).

Harness helpers: `restart('b')`, `stop('b')` (to test remote-down behaviour), `pause('b')` (`docker pause`, for timeouts), `exec('a', cmd)`, `dns.set(name, records, ttl)`, `dns.rebind(name, [first, then])`, `canary.hits()`, `fake.respond(route, behaviour)`, and per-anchor log capture.

### 5.2 Discovery and request verification (mostly against `fake`)

Every row is one test. Drive signed requests at `anchor-a` from `fake` using `signer.ts`:

| Case | Expected |
| --- | --- |
| Valid signed request | 2xx |
| Missing `X-Novarum-Homeserver` / any other header | 400 |
| `Date` older or newer than `nonce_max_age_seconds` | 401 Stale |
| Unparseable `Date` | 401 |
| Same nonce twice | second → 401; **nonce isn't consumed by a request with a bad signature** (a bad request followed by a good one with the same nonce → 2xx) |
| Same nonce sent twice **concurrently** | exactly one 2xx, the other 401 (never 500) |
| Same nonce from `fake` .66 and .67 | both accepted (nonce is scoped by homeserver) |
| Body hash mismatch | 401 |
| Signature over a different path / method / host / homeserver | 401 each |
| Unknown key id → triggers a refresh; `fake` rotates its key between requests | accepted after refresh |
| Unknown key id that's still unknown after refresh | 401 |
| `fake` discovery returns a different `homeserver` | 400 Could not discover |
| `fake` discovery `baseUrl` with query/userinfo/hash, or pointing at a public host from a public anchor | rejected |
| `fake` discovery answers with a 3xx | rejected (`redirect: 'error'`); no request reaches the redirect target (assert with a counter on the target) |
| `fake` answers a signed federation POST from A with a 3xx | the call fails; the redirect target receives nothing |
| `fake` discovery hangs past 10s | rejected within about 10s; failure cached 30s; success cached 5m (assert with a request counter in `fake`) |
| Discovery 5xx, connection refused, or timeout | `guilds.extAnchorDown = true` for that homeserver's shadow guilds; flips back on the first successful call after recovery |
| Signed POST to a remote that refuses or times out | `extAnchorDown = true`, and the next call re-discovers instead of using the 5m cache |
| Non-JSON body that verifies | 400 Invalid federation JSON body |
| Nonce table cleanup | with `nonce_max_age_seconds = 2`: send a request, wait more than 60s, send another, and the old rows are gone. Without the second request they stay (cleanup is lazy) |

**Impersonation matrix.** For *every* POST in `modules/federation/services.ts` that takes a `user` payload, `fake` signs a valid request whose `user.homeserver` is `172.30.0.12` (anchor-b). Guild, channel, message, invite and DM routes → **401** `Federation user homeserver mismatch`; friends `/command` and `/sync` → **403**. Generate the list from the route table, with the expected status keyed by route family, so new routes can't skip it. Repeat with mixed case (`User.Homeserver` vs lower) to prove normalization.

SSRF and every other outbound-request case is in §5.4.

### 5.3 Functional federation flows (A, B, C real anchors)

Use `eventually()` for cross-server effects, with a default timeout of 5s (40s for anything that depends on the friend sync retry).

1. **User lookup:** `GET B/federation/users/alice` → profile; unknown → 404; a remote shadow user is not served as local.
2. **Friends (authority = lexicographically smaller homeserver, here A for A↔B):**
   - A→B request, B accepts, both sides show `ACCEPTED` and versions match.
   - Initiated from the non-authoritative side (B→A) goes through `/friends/command` on A, then `/friends/sync` back.
   - **Simultaneous requests** from both sides converge to `ACCEPTED` or one pending, never divergent (run 20 iterations).
   - Stale `expectedVersion` → 409 with a snapshot; the client retries successfully.
   - Re-sending the same `commandId` is idempotent (`changed: false`).
   - B down during accept on A → `syncPending` stays true; after B restarts, the 30s retry loop converges it within about 40s with no client action. A `GET /friends` on A triggers the retry immediately (assert both paths).
   - `/friends/sync` sent by the non-authority → 403; a snapshot about a bot or unknown local user → 404.
3. **DMs across servers (host = authority):**
   - Requires an accepted friendship on both sides.
   - Opened from the host side → `/dms/notify` creates a `fed:channel:` shadow on the other side.
   - Opened from the non-host side → `/dms/open` returns the canonical channel.
   - Messages both directions; `/dms/latest`; edit/delete propagate; unfriend → writes refused on the host, reads allowed.
   - Close the DM on B, A sends → reopens on B via the bridge.
   - **Restart B** → the DM bridge is restored at boot (no client action) and the next message arrives.
4. **Guilds and invites:**
   - B user accepts an invite to an A guild → shadow guild on B, `guild.created` published to the B user, member list on A includes the B user.
   - **Shadow guild ownership:** the B joiner can't create channels, invites, patch, or reorder on the `fed:guild:` ID (this checks the `ownerId: session.userId` concern).
   - Expired or unknown remote invite → error relayed with the right status; A down → 502.
   - Messages send/edit/delete/list through `/federation/channels/:id/messages*`, pagination via base64url cursor (limit bounds 1..100, malformed cursor → 400).
   - Attachments presign via A; size limit uses A's `maxFileSize`.
   - Typing, `users`, `users/status`, `unread-mentions` (≤1000 channels, cursor handling).
   - Voice: `/channels/:id/call/token`, `/voice-state`, `/ring` (with livekit tag).
5. **Realtime bridges:**
   - B client connected to `/realtime` receives A guild events, with IDs mapped to `fed:guild:172.30.0.11:<id>` and `fed:channel:...` (assert there's no double mapping).
   - Bridge auth: an unsigned connection or a bad signature → close 1008; a homeserver with no member in the guild/DM → 1008 Forbidden.
   - **Mixed-case member row** (Caddy variant, since IP homeservers have no letters): insert a guild member with `users.homeserver = 'B.test'` directly into A's DB. `b.test`'s bridge is accepted. `test.failing` until the comparison lower-cases both sides.
   - A restarts → B reconnects with backoff (1s, 2s, 4s…, cap 5 min; assert the first two delays) and events resume.
   - A closes with 1008 (B's last member left) → B does **not** reconnect.
   - Remote voice presence is cleared on B when the bridge drops.
   - Guild bridge after a **B restart** is only re-created once a B client calls `GET /guilds/list`. Assert this is true, then decide whether it's acceptable.
   - Malformed or unknown event from `fake` over a bridge is ignored; the bridge stays up.
6. **Three-way (A, B, C):**
   - A guild with members from B and C: messages from C reach B through A's bridge; C can't read a DM between A and B (`/federation/channels/:dm/messages` signed by C → 403); C can't open B's guild bridge for a guild where C has no member.
   - Friend chains A↔B, B↔C, A↔C with three different authorities, all consistent.
7. **Key rotation:** `exec('a', 'bun run src/index.ts cli rotate-keys')`.
   - The next A→B request carries the new key id. B sees an unknown id, refreshes and accepts it.
   - Once B has refreshed, a signature with A's old key → 401 `Unknown federation key`. Before that refresh, B still accepts the old key for up to 5 minutes (its discovery cache). Pin this so it's a deliberate choice.
   - A's `/.well-known/anchor/info` publishes the new key.
   - Deleting the active key file and restarting A logs `Active homeserver key file is missing` and publishes a replacement.
8. **Partitions and slowness:** `docker pause B` → A's federation calls fail within about 10s with 502 and don't hang the request; A marks B's shadow guilds `extAnchorDown`; A's own local features are unaffected (latency check on a local route during the partition). `docker unpause B` → the next call re-discovers and `extAnchorDown` flips back.

### 5.4 SSRF and outbound requests (public segment)

Unless a group says otherwise, `anchor-p` is the anchor under test. Each target is attempted through every **trigger**:

| Trigger | Auth | Outbound calls it causes |
| --- | --- | --- |
| T1 Inbound federation request with all headers present and a garbage signature, `X-Novarum-Homeserver: <target>` | none (pre-auth) | discovery |
| T2 Inbound bridge WebSocket `/federation/realtime/guilds/x?X-Novarum-Homeserver=<target>&…` | none (pre-auth) | discovery |
| T3 `POST /friends` for `alice` on `<target>` | local user | discovery, then the `/federation/users/:name` GET |
| T4 `POST /invite/accept` with `homeserver: <target>` | local user | discovery, then a signed POST |
| T5 A shadow guild/DM on `<target>` followed by `GET /guilds/list`, or a reboot for DMs | local member | discovery, then the WebSocket bridge |
| T6 Message send, typing, voice token, unread mentions or DM latest on a `<target>` shadow channel | local member | discovery, then a signed POST |

For T5 and T6, the shadow row is seeded straight into `anchor-p`'s DB, so the test doesn't need a cooperating remote.

Expected unless noted: the trigger fails cleanly (4xx/502, no 500), and the canaries and target counters record nothing. Rows marked **failing** are known gaps written as `test.failing`.

**A. Address policy (homeserver names and DNS answers)**

| Target | Expected |
| --- | --- |
| `127.0.0.1`, `10.0.0.1`, `172.30.0.99` (canary), `169.254.169.254`, `0.0.0.0`, `100.64.0.1`, `192.168.1.1`, `198.18.0.1`, `224.0.0.1`, `255.255.255.255` | refused |
| Numeric forms that URL parsing turns into loopback: `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `017700000001` | refused (assert the normalized hostname in the log) |
| `localhost`, `LOCALHOST`, `foo.localhost` | refused |
| `localhost.`, `evil.test.`, `evil..test`, `evil_test`, names with `:` `/` `@` `\`, unicode/IDN | rejected by `normalizeFederationHomeserver` before any network I/O (assert `dns` saw no query) |
| DNS: A → 10.0.0.1; A → 127.0.0.1; A → 169.254.169.254; CNAME → a private name | refused |
| DNS: two A records, one public and one private | refused (any private answer refuses) |
| DNS: AAAA `::1`, `::ffff:127.0.0.1`, `fc00::1`, `fe80::1` | refused |
| DNS: AAAA `::127.0.0.1`, `::ffff:7f00:1`, `64:ff9b::a00:1`, `2002:a00:1::` | refused (**failing**: `isPrivateIp` misses these forms) |
| DNS: NXDOMAIN, SERVFAIL, or no answer within 10s | refused within about 10s |
| `evil.test` (public, valid cert) | succeeds. This is the positive control proving the setup can reach a public target |
| `203.0.113.66` as a bare IP homeserver | succeeds only if the cert has that IP SAN; pin whichever happens |

**B. Scheme and TLS**

| Case | Expected |
| --- | --- |
| Target that only serves http | refused (public mode requires https) |
| `wrongcert.test`, `selfsigned.test`, `expired.test` | refused (TLS validation is on) |
| `anchor-p` booted without `NODE_EXTRA_CA_CERTS` | `evil.test` refused (proves the positive control depends on the CA, not on disabled checks) |

**C. Discovered `baseUrl`** (`evil.test` answers discovery with the following `baseUrl`)

| `baseUrl` | Expected |
| --- | --- |
| `http://evil.test` | refused (no https) |
| `https://10.0.0.1`, `https://127.0.0.1:8080`, `https://169.254.169.254`, a name resolving private | refused |
| `https://[::1]/`, `https://[::ffff:127.0.0.1]/` | refused. Also assert *why*: today it fails on `ENOTFOUND` for the bracketed name, not on the IP check. **failing** until brackets are stripped before the IP check |
| `https://user:pw@evil.test`, `?q=1`, `#x` | refused |
| `https://evil.test:6379` (non-default public port) | currently allowed: the canary-like listener on the fake receives the request. Pin it; whether ports should be limited to 443 is in §11 |
| `https://evil.test/prefix/` | requests go to `/federation/...` at the root (prefix dropped); pin it |
| `https://b.test` (another real anchor) | **Confused deputy, failing.** Set up a real invite on B with a known code. A local user on `anchor-p` accepts "invite `<code>` on `evil.test`" (T4). Today A signs for host `b.test`, B verifies it, and the user joins B's guild. Expected: refused, either because `baseUrl` must match the homeserver or because the signing string names the recipient homeserver |
| Discovery for `evil.test` returning `homeserver: "b.test"` | refused (existing mismatch check, regression test) |

**D. Redirects**

For each of 301, 302, 303, 307 and 308, with `Location` pointing at the canary, at `http://127.0.0.1:8080`, at another public host, and as a relative path:

| Where | Expected |
| --- | --- |
| Discovery (`/.well-known/anchor/info`) | refused, nothing follows |
| Signed POST (T4/T6) | the call fails, nothing follows |
| User lookup (T3) | refused (`fetchFederatedUser` already uses `redirect: 'error'`) |
| WebSocket bridge handshake answered with a 3xx (T5) | the bridge doesn't connect anywhere else |

**E. DNS rebinding and time-of-check vs time-of-use**

`dns.rebind(name, [public, private])` with TTL 0:

| Case | Expected |
| --- | --- |
| Discovery: the safety check sees the public answer, then `fetch` gets the private one | canary hit = **failing** in-process; passes on `anchor-q` (proxy) |
| `baseUrl` host is public at discovery and rebinds to private within the 5 min cache, then a signed POST | same window as above: **failing** on `anchor-p`, passes on `anchor-q` |
| Same rebind, then the user lookup (T3) or a bridge (T5) | **failing**: neither path re-checks the address. Expected: refused |
| Rebind to anchor-p's own `127.0.0.1:80` (the anchor itself) | refused; also asserts the anchor can't be made to call its own unauthenticated routes |

**F. Egress-proxy variant (`anchor-q`)**

| Case | Expected |
| --- | --- |
| A-group targets through T1–T6 | refused, either by `assertSafeFederationUrl` or by `proxy` (assert `proxy`'s deny log for the rebinding rows) |
| `evil.test` positive control (discovery, POST, user lookup) | succeeds through `proxy` |
| Bridge (T5) to `evil.test` | **failing**: Bun's `WebSocket` ignores `HTTP_PROXY`, so with no direct route the bridge never connects. Expected: the bridge goes through `proxy` |
| `dns` stopped | every federation call fails closed (the in-process check needs a resolver), and local features are unaffected |

**G. Triggers, amplification and resource growth**

| Case | Expected |
| --- | --- |
| T1 with a garbage signature and `X-Novarum-Homeserver: evil.test` | **pin:** `fake` sees a discovery request even though the signature is wrong (discovery precedes verification) |
| 500 T1 requests with distinct homeservers `r<n>.evil.test` | **Verify:** today that's 500 outbound discoveries and 500 `discoveryCache` entries. Expected: bounded by a rate limit or a cache cap. Log RSS before and after |
| 500 T1 requests for the same unreachable homeserver | one outbound attempt per 30s (failure cache), not 500 |
| T3/T4 with `username`/`code` set to `../x`, `//canary/x`, `a?b`, `a#b`, `%2f`, `%00`, 10 KB strings | the request reaches `fake` at `/federation/...` on the expected host, with the value percent-encoded in one path segment (assert the path `fake` recorded) |

**H. Hostile response bodies** (`fake` behaviour on discovery and on POST responses)

| Behaviour | Expected |
| --- | --- |
| 1 GB body; endless chunked stream; 1 byte/s drip | aborted within about 10s; anchor RSS growth under 100 MB (**Verify**: there's no size limit today) |
| `Content-Encoding: gzip` bomb (10 MB → 10 GB) | same as above |
| Invalid UTF-8, non-JSON, a 10k-deep nested JSON | 400/502, no crash |
| `publicKey.key` that isn't valid base64 or isn't an ed25519 SPKI | 401, never 500 (`verifyMessage` throwing must be handled) |
| Discovery `version` or `baseUrl` of the wrong type | refused (existing checks, regression tests) |

**I. Private-mode anchors** (`anchor-a`, whose `base_url` is private)

| Case | Expected |
| --- | --- |
| T1–T4 to `127.0.0.1:8080` (via a `baseUrl`) and `169.254.169.254` | **pin:** currently allowed, so `canary-a` sees the hit. Whether loopback, link-local and metadata should be refused even in private mode is in §11 |
| Public target from a private-mode anchor (`evil.test` while `anchor-a` is on `pub`) | succeeds over https; http still refused for public targets |

## 6. L6: Database migrations

Migrations are drizzle-kit SQL folders in `apps/anchor/drizzle/` (15 so far), applied at boot by `migrate()` from `drizzle-orm/bun-sql/migrator`.

### 6.1 Static checks (fast, every PR)
- **No drift:** `bunx drizzle-kit generate` (or `drizzle-kit check`) against `schema.ts` produces **no new migration**. CI fails if it would. `drizzle.config.ts` honours `DATABASE_URL`, and `ANCHOR_CONFIG=test/config.toml` covers the rest.
- **Snapshot integrity:** every folder has `migration.sql` and `snapshot.json`; names sort chronologically; nobody edits an old migration (CI diffs `drizzle/*/migration.sql` against `main`; only additions are allowed).
- **Lint dangerous SQL** in new migrations (grep-level): `DROP COLUMN`, `DROP TABLE`, `ALTER ... TYPE`, `SET NOT NULL` without a backfill, `ADD CONSTRAINT ... UNIQUE` on an existing table → require an explicit `-- reviewed: <reason>` comment.

### 6.2 Fresh install
- Empty DB → boot → all migrations applied → `drizzle.__drizzle_migrations` has 15 rows → `information_schema` matches the result of `drizzle-kit push` on another empty DB (compare `pg_dump --schema-only`, normalized). This proves `migrate` and `push` agree.
- Boot twice → second boot is a no-op (idempotent).
- Concurrent boot isn't tested as a feature. Running more than one anchor process per database is unsupported (§0), and the deployment docs say so.

### 6.3 Step-wise upgrade with data (the important one)
For each migration *N* (in a loop):
1. Fresh DB, apply migrations `1..N-1` (copy the first N-1 folders into a temp `drizzle/`, run the migrator).
2. Run **seed N-1**: a fixture that writes realistic rows valid for that schema version (users, sessions, guilds, channels, messages with pings and attachments, friendships, keys, nonces, plus a federated shadow guild/channel/user).
3. Apply migration *N*.
4. Assert: no error; row counts preserved; per-migration invariants hold.

Specific invariants for known migrations:
- `20260927212232_add_dm_channels`: existing guild channels keep `guildId`; the `channel_guild_or_dm_check` constraint accepts existing rows; `dmKey` is NULL for guild channels; `channel_member` FKs cascade on channel and user delete.
- Every migration that adds a `NOT NULL` column must work on a non-empty table.

To keep this maintainable, seeds are written once at the latest schema and **down-projected** by a per-version column map, or kept as SQL fixtures under `test/migrations/seeds/<migration>.sql`. Once a migration is merged its seed is frozen.

### 6.4 Production-like upgrade
- Nightly: restore an anonymized `pg_dump` of a real instance (or a large synthetic seed: 100k messages, 5k users, 500 guilds), run boot, and record duration and lock waits (`log_lock_waits=on`). Fail if a migration takes an `ACCESS EXCLUSIVE` lock for over N seconds on the large seed.

### 6.5 `db:push` recovery path (`fix-push.ts`)
- DB created with `db:push` (no `__drizzle_migrations` rows) → `bun run --filter anchor db:pushfix` → boot → no migration re-applied, no errors.
- Partially recorded table (first k hashes only) → fix-push inserts the rest exactly once; running it twice inserts nothing.

### 6.6 Failure behaviour
- Corrupt a migration (bad SQL) → boot logs `[DB] Error when migrating` and **exits 1** before listening; the DB is left at the previous version (transactional), with no partial schema.
- DB unreachable at boot → exits non-zero with a clear message.

### 6.7 Rollback policy
Drizzle has no down migrations. Document "roll back = restore from backup + previous image", and test the restore: `pg_dump` before the upgrade → upgrade → restore → the previous image boots.

## 7. L7: Security and robustness

- **Authz matrix test:** for each route × each actor (anonymous, non-member, member, owner, remote member, remote non-member), generated from OpenAPI plus a small table of expected outcomes. This is the highest-value security test.
- **Input fuzzing:** for every route, send bodies generated from its TypeBox/Zod schema plus mutations (oversize strings, unicode, nulls, extra fields, deep nesting, 10MB body). Expect 4xx, never 5xx or a crash. Same for the realtime WS message union.
- **Federation fuzz:** `fake` sends random valid-signature payloads to every federation route. Expect 4xx and no DB writes on failure (assert row counts).
- **Replay across restart:** nonces persist in DB, so a replay after an anchor restart → still 401.
- **Concurrent replay:** 20 parallel copies of one signed request → exactly one 2xx (unique `(homeserver, nonce)` constraint), the rest 401.
- **Upload abuse:** presign then upload a bigger file than declared, a different content type, or an SVG/HTML posing as an image; the preview/thumbnail path with malformed media (`node-av`, `sharp`) doesn't crash the process.
- **Header spoofing:** `X-Forwarded-For` rate-limit bypass (§4.1). `Host` header manipulation must not change the signature host check result for incoming federation (behind a proxy, `request.url` host must equal what the sender signed. Test with the Caddy variant).
- **Outbound fetch policy:** a static check (grep-level, under `utils/` and `modules/`) that every `fetch(` aimed at a remote anchor sets `redirect: 'error'` and is preceded by `assertSafeFederationUrl`, and that every `new WebSocket(` is too. The jsdelivr emoji fetch and the upload fetch to our own S3 are allow-listed. The behavioural side is §5.4.
- **Secrets:** `config.toml` is gitignored. Only `test/config.toml` (placeholders) and the dev-only Garage keys in `dev/compose.yml` are committed. Run gitleaks in CI, with those two files allow-listed.

## 8. L8: Performance and soak

- **DB query benchmarks** (separate from the soak below; needs only Postgres). Turn `benchmarks/` from the one-off Prisma-vs-Drizzle comparison into a small Drizzle-only suite that watches the queries anchor actually runs on hot paths:
  1. **Drop the comparison.** Remove `prismaNextAdapter`, the `Adapter` indirection and the `isDrizzle` switch from `run.ts`, and import `drizzle-orm/bun-sql`, `src/db/schema` and `src/db/relations` statically. Importing those directly instead of `src/db` means the suite still needs only `DATABASE_URL` and no config file. Remove the Prisma instructions, the "AI generated" disclaimer and the worktree steps from `benchmarks/README.md`, and the `apps/anchor/benchmarks/report` entry from the root `.gitignore`.
  2. **Scenarios.** Each mirrors a real query shape:
     - user by primary key, membership by compound key, insert message and update user (kept from today)
     - a message page with author and attachments: the latest 50, plus one at `offset` 5000 on a 10k-message channel. `/message/list` paginates by offset, so the deep page is the one that degrades as channels grow
     - guild list for a user in 50 guilds (`guildMembers` with `guild`, plus read states and pings), as `GET /guilds/list` does
     - federation nonce lookup + insert, as every incoming federation request does (`storeNonce`), on a table pre-filled with 100k rows
     - online-user scan (`status = 'ONLINE'` for the homeserver), which the presence loop runs every 3s, on 5k users
  3. **Output and gate.** `run.ts` keeps writing one JSON file (drop `implementation`/`version`; keep `commit`, `runtime`, `machine`, `config` and per-scenario p50/p95/mean/ops/s). Replace `report.ts` (SVG charts) with `benchmarks/compare.ts <baseline.json> <current.json>`. It prints a Markdown table of p95 and throughput changes (for the job summary) and exits 1 when any scenario's p95 is more than `BENCH_MAX_REGRESSION` (default 20%) slower. Replace `bench:report` with `bench:compare` in `package.json`.
  4. **CI** (weekly job 6). Run the suite three times against a fresh Postgres service and keep the median per scenario. `main` runs upload the result as the baseline artifact; other runs compare against the latest `main` baseline. Tune the threshold after a few weeks of runner noise. Until then the job can report without failing.
- **Federation soak** (weekly + manual `workflow_dispatch`; unrelated to `benchmarks/`): 3 anchors, 200 simulated users, 30 minutes of mixed traffic (messages, typing, friend churn, B restarts every 5 minutes, clients reconnecting every few minutes). Assert:
  - no message loss (every sent `nonce` arrives at every subscriber)
  - bounded memory: `activeBridges`, `bridgedVoicePresence`, `activeRealtimeConnections` and `pingIntervals` sizes are logged, and `pingIntervals.size` equals the open socket count
  - a bounded `federation_nonces` table
  - no unbounded reconnect storms
- Presence loop: `setInterval` every 3s in `realtime/services.ts` hits the DB. Measure DB load with 1k connected users.

## 9. Scripts and CI

`apps/anchor/package.json` (`check` already exists):
```json
"check": "tsc --noEmit -p .",
"test": "ANCHOR_CONFIG=test/config.toml bun test test/unit test/integration",
"test:unit": "ANCHOR_CONFIG=test/config.toml bun test test/unit",
"test:fed": "bun test/federation/run.ts",
"test:migrations": "ANCHOR_CONFIG=test/config.toml bun test test/migrations"
```

`test/federation/run.ts` runs `docker compose -f test/federation/compose.yml up -d --build --wait`, then `bun test test/federation`, and always runs `docker compose ... down -v` in a `finally`. It then exits with the **test** exit code. A shell `a && b; c` chain would exit with `down`'s status and hide failures, so the script is TypeScript instead.

Run from the root as `bun run --filter anchor test`. The filter sets cwd to `apps/anchor`, and the harness resolves the other paths absolutely.

GitHub Actions (`.github/workflows/anchor-test.yml`, alongside the existing image workflows).

All test jobs use `runs-on: ubuntu-latest`. The repo is public, so standard GitHub runners are free with no minute limit and have 4 vCPU / 16 GB, enough for the three-anchor federation stack. Blacksmith stays reserved for the existing image and release builds, which keeps the tests out of its free-minute budget. Cache the anchor Docker image for the federation jobs with the GitHub Actions cache backend for `docker buildx` (`cache-from`/`cache-to: type=gha`). That cache is limited to 10 GB per repo.
1. `unit` (no services) → `bun run --filter anchor check` and `bun run --filter anchor test:unit`.
2. `integration` (services: postgres, garage, mailpit) → `test`.
3. `migrations` (postgres) → drift check, plus step-wise upgrade. Always runs when `apps/anchor/drizzle/**` or `src/db/**` changes.
4. `federation-smoke` → §5.2, §5.3 flows 1–4 and §5.4 groups A–D and G on every PR touching `modules/federation`, `utils/discovery.ts`, `utils/keys.ts`, `utils/federation*`, `modules/{dm,friends,invite}`, or `apps/anchor/Dockerfile`.
5. Nightly: full federation, including all of §5.4 (rebinding, the egress-proxy variant `anchor-q`, and hostile bodies with RSS checks), plus fuzz and production-like migration.
6. Weekly (cron) + `workflow_dispatch`: soak and benchmark regression (§8). Trigger manually for PRs touching bridges, presence or realtime code.

Artifacts on failure: each anchor's logs, a `pg_dump` per DB, and the Mailpit messages.

## 10. Rollout order

1. Harness (`anchor.ts`, `db.ts`, `users.ts`) + `test/compose.yml` + `test` scripts + CI jobs 1–2 with the auth and guild smoke tests, including the `test.failing` password-reset revocation test.
2. Migration static checks + fresh install + `add_dm_channels` upgrade test.
3. Unit tests for discovery, IDs, signer golden test, friend state machine, mentions.
4. `fakeAnchor` (two identities) + the §5.2 verification matrix and the impersonation matrix (highest security value).
4b. Public segment: `pub` network, test CA, `dns`, `canary`/`canary-p`, `anchor-p` + §5.4 A–D and G. This includes the `test.failing` rows (IPv6 forms, bracketed `baseUrl`s, confused deputy), so each fix has a test waiting for it.
5. **Dockerfile lockfile fix:** copy the root `package.json`, `bun.lock` and every `apps/*/package.json`, then run `bun install --frozen-lockfile --production --filter anchor`, and confirm the production image still builds and boots. Then the three-anchor compose + flows 5.3.1–5.3.4 (friends, DMs, invites, messages).
6. Bridges and restart/partition tests (5.3.5, 5.3.8), key rotation (5.3.7).
7. Authz matrix + fuzzing + `proxy`/`anchor-q` + §5.4 E, F, H and I.
8. Step-wise migration seeds for all historical migrations, plus nightly prod-like migration and weekly soak runs.

## 11. Open questions for the maintainers

- Should guild bridges be restored at boot like DM bridges?
- Is the `ownerId: session.userId` on federated shadow guilds intentional (is it used only for display)?
- What's the expected deployment for `X-Forwarded-For`: always behind a trusted proxy?
- Should production deployments be required (or just advised) to set `network.proxy_url` to an SSRF-filtering egress proxy, given the DNS-rebinding gap?
- Confused deputy: should a discovered `baseUrl` be required to match the homeserver's host, or should the signing string add the intended recipient homeserver (a protocol bump to `v2`)? The second keeps delegation possible.
- Should a `baseUrl` be allowed to use a port other than 443?
- In private mode (our `base_url` is local/private), should loopback, link-local and `169.254.169.254` still be refused?
- Should discovery move after a cheap pre-check (e.g. a rate limit per source IP) so that unauthenticated requests can't make the anchor send arbitrary outbound requests?
- Should remote response bodies have a size limit (e.g. 1 MB for discovery, `max_file_size` for payloads)?
- Is it acceptable that a remote keeps accepting the old key for up to 5 minutes after `rotate-keys`, or should rotation actively notify peers?
