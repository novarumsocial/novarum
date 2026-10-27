# Repository Instructions

## Workspace

- Use Bun, not npm/pnpm/yarn. The root `package.json` uses Bun workspaces over `apps/*`; `bun.lock` is the root lockfile.
- Run all dev servers with `bun run dev` from the repo root. It first starts `dev/compose.yml` (Postgres, LiveKit, Garage) with Docker, then runs every workspace `dev` script in parallel.
- Run one app with `bun run --filter <app> <script>` (apps: `frontend`, `anchor`, `electron`, `mobile`, `native`, `landing`).
- Root scripts: `bun run check` (`tsc --noEmit`), `format` (changed files), `format:check`, `format:all`. There is no root test script; use per-app scripts below.
- Package scripts should be run through Bun workspace filters from the repo root; Anchor reads `./config.toml`, so running files directly from the wrong cwd can break config loading.

## Frontend (`apps/frontend`)

- SvelteKit app using Vite, Svelte 5 runes mode, Tailwind CSS v4, and shadcn-svelte. Project files are forced into runes mode by `vite.config.ts`.
- Frontend verification: `bun run --filter frontend check` runs `svelte-kit sync` and `svelte-check`; `bun run --filter frontend build` runs the Vite build; `bun run --filter frontend test` runs `bun test src/lib`.
- Routes are SPA-only: `src/routes/+layout.server.ts` sets `ssr = false` and `prerender = false`.
- The typed API client is `src/lib/api.ts` using `@elysia/eden` against the backend `App` type exported by the `anchor` workspace.
- Active homeserver state lives in `src/lib/anchor.svelte.ts`: `localStorage` keys are `novarum:home-server` and `novarum:anchor-base-url`; localhost-style homeservers are forced to `http://`, others to `https://`.
- Use shadcn-svelte components wherever possible.
- shadcn-svelte component config lives in `apps/frontend/components.json`; generated UI components go under `$lib/components/ui`.

## Backend (`apps/anchor`)

- Elysia/Bun backend entrypoint is `apps/anchor/src/index.ts`; it exports `type App` for frontend Eden typing.
- Server config is `apps/anchor/config.toml`, validated by `utils/config.ts`; `listen_port` defaults to `5049` if omitted.
- The app is built in `src/app.ts` (`createApp`); `src/index.ts` runs migrations and listens. Routes are mounted from `apps/anchor/modules/*/services.ts`: auth, guilds, realtime, channel, message, invite, federation, upload, user, friends, dm, notifications, and `/.well-known/anchor`.
- Config path can be overridden with `ANCHOR_CONFIG`.
- Backend dev server: `bun run --filter anchor dev`. Typecheck: `bun run --filter anchor check`.
- Tests: start infra with `bun run --filter anchor test:infra`, then `test`, `test:unit`, `test:integration`, `test:migrations`, or `test:fed`.
- DB (Drizzle): `db:generate`, `db:migrate`, `db:push`; migrations in `apps/anchor/drizzle` run on startup.

## Other apps
- `apps/electron` (desktop shell around the frontend), `apps/mobile` (Capacitor wrapper), `apps/native` (Expo/React Native rewrite, see `NATIVE_APP_PLAN.md`), `apps/landing` (Astro), and `worker` (Cloudflare Worker).

## Formatting

- Formatting uses oxfmt (`.oxfmtrc.json`): 2 spaces, single quotes, semicolons, es5 trailing commas, printWidth 100, Svelte supported. Run `bun run format`.

## Code style

Whenever possible, use the following conventions:

- If there's an object you need to check, use Zod schema validation. No ugly helper functions with `if (typeof x === 'string')` or `if (x instanceof Array)`. Use Zod's `z.string()`, `z.array()`, etc.
- On fixes or additions, try to implement them in the simplest and most human way possible, while implementing the fix fully. This is, try to minimize the amount of lines needed to do fixes or features.
- Do not abuse comments. If there's something really hard to understand that a human would have to read, then add a comment. Otherwise, let the code speak for itself.
- If it's too hard to understand, maybe the code is too complex. Refactor it into smaller pieces, but do not abuse this! Sometimes you need to have hard functions that are 100 lines long instead of something smaller that ends up racking up 500 lines.

## Implementing features (checklist)

- **Frontend feature → native parity.** When adding or changing user-facing behavior in `apps/frontend`, implement the same in `apps/native` where applicable (same store/method names, file starts with a comment naming its web counterpart; see `NATIVE_APP_PLAN.md`). If a web control is a stub with no backend, hide it on native. If it genuinely doesn't apply to native (e.g. Electron/desktop-only, or feature not necessary on mobile), say so in the summary. Run `bun run --filter native check` as well as the frontend checks.
- **Anchor changes need tests.** Add or update tests in `apps/anchor/test` (`unit` for pure helpers, `integration` for routes/realtime, `federation` for cross-server flows) using the helpers in `test/harness`. Cover the happy path and failure cases.
- **Anchor security tests.** For any new or changed route, realtime event, upload or federation endpoint, also test authentication, authorization (extend `integration/authz-matrix.test.ts`, which checks every route against access rules; also `openapi-auth.test.ts`), input validation/abuse (see `fuzz.test.ts`, `upload-abuse.test.ts`), rate limits where relevant, and for outbound requests SSRF (`harness/ssrf.ts`). Never leak private data to users who lack access.
- **Data structure changes.** When a response, request, realtime payload, or federation payload shape changes in Anchor, update the Zod schemas (`src/db/zod.ts`, route schemas) and fix every test that validates the old shape. Update the consumers too: `apps/frontend` and `apps/native` (Eden infers types from `App`, so run both `check`s) and any federation compatibility handling.
- **Migrations.** After changing `src/db/schema.ts`, generate a migration with `bun run --filter anchor db:generate` (never hand-edit applied migrations) and add a migration test in `apps/anchor/test/migrations` that applies it onto data in the old shape and verifies the data survives/transforms correctly.
- **Verify before finishing.** Run the relevant checks and tests (`check` for each touched app, Anchor tests with `test:infra` up) and `bun run format`. Report anything you couldn't run.
