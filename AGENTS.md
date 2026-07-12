# Repository Instructions

## Workspace

- Use Bun, not npm/pnpm/yarn. The root `package.json` uses Bun workspaces over `apps/*`; `bun.lock` is the root lockfile.
- Run all dev servers with `bun run dev` from the repo root. It runs every workspace `dev` script in parallel.
- Run one app with `bun run --filter frontend <script>` or `bun run --filter anchor <script>`.
- There is no root lint, test, typecheck, or format script. Prefer focused package scripts listed below.
- Package scripts should be run through Bun workspace filters from the repo root; Anchor reads `./config.toml`, so running files directly from the wrong cwd can break config loading.

## Frontend (`apps/frontend`)

- SvelteKit app using Vite, Svelte 5 runes mode, Tailwind CSS v4, and shadcn-svelte. Project files are forced into runes mode by `vite.config.ts`.
- Frontend verification: `bun run --filter frontend check` runs `svelte-kit sync` and `svelte-check`; `bun run --filter frontend build` runs the Vite build.
- Routes are SPA-only: `src/routes/+layout.server.ts` sets `ssr = false` and `prerender = false`.
- The typed API client is `src/lib/api.ts` using `@elysia/eden` against the backend `App` type exported by the `anchor` workspace.
- Active homeserver state lives in `src/lib/anchor.svelte.ts`: `localStorage` keys are `novarum:home-server` and `novarum:anchor-base-url`; localhost-style homeservers are forced to `http://`, others to `https://`.
- Use shadcn-svelte components wherever possible.
- shadcn-svelte component config lives in `apps/frontend/components.json`; generated UI components go under `$lib/components/ui`.

## Backend (`apps/anchor`)

- Elysia/Bun backend entrypoint is `apps/anchor/src/index.ts`; it exports `type App` for frontend Eden typing.
- Server config is `apps/anchor/config.toml`, validated by `utils/config.ts`; `listen_port` defaults to `5049` if omitted.
- Backend routes are mounted from `apps/anchor/modules`, not only `src`: `/auth`, `/guilds`, `/realtime`, `/channel`, `/message`, `/invite`, `/federation`, and `/.well-known/anchor` are wired in `src/index.ts`.
- Backend dev server: `bun run --filter anchor dev`.
- `apps/anchor/package.json` has a placeholder `test` script that exits 1; do not use it as verification.

## Prisma Next / Database

- Anchor uses Prisma Next with Postgres. `apps/anchor/prisma-next.config.ts` reads `DATABASE_URL` if set, otherwise falls back to `config.toml`.
- Edit the contract at `apps/anchor/prisma/contract.prisma`; generated companions `contract.json` and `contract.d.ts` are committed and must be regenerated after contract changes.
- From the root, use `bun run --filter anchor contract:emit` after changing the contract.
- Migrations live under `apps/anchor/migrations/app`; generated migration contract snapshots are committed there too.
- DB commands are package scripts: `db:init`, `db:update`, `db:verify`, `migration:plan`, `migrate`, `migration:status`, and `migration:show` on the `anchor` workspace.
- Runtime DB access is `apps/anchor/prisma/db.ts` and uses `db.orm.public.<Model>`.

## Formatting

- Prettier config is root `.prettierrc`: 2 spaces, single quotes, semicolons, trailing commas where valid, and `prettier-plugin-svelte` for `.svelte` files.

## Code style

Whenever possible, use the following conventions:

- If there's an object you need to check, use Zod schema validation. No ugly helper functions with `if (typeof x === 'string')` or `if (x instanceof Array)`. Use Zod's `z.string()`, `z.array()`, etc.
