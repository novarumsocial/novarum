# Novarum native app

Expo + React Native + NativeWind + Eden treaty. A native port of `apps/frontend`; the plan is in
[`NATIVE_APP_PLAN.md`](../../NATIVE_APP_PLAN.md).

## Run

Needs a dev build (LiveKit, MMKV and UnifiedPush are native code), not Expo Go.

```sh
bun install
bun run --filter native android   # or ios
bun run --filter native start     # Metro only, once a dev build is installed
```

## Checks

```sh
bun run --filter native check   # types (only errors in apps/native count, see scripts/check.ts)
bun run --filter native bundle  # full Hermes bundle, catches bad imports
bun run --filter native sync-theme  # after editing colors in apps/frontend/src/routes/layout.css
bun run --filter native build-canvas  # after editing canvas-editor/ (the canvas WebView page)
```

## Where things are

Every file starts with `// Port of apps/frontend/...` naming its web counterpart, with the same names.

- `src/app/` screens (Expo Router). `(app)/guilds/[...path].tsx` is the whole chat shell, like the web.
- `src/lib/` stores (`useX` hook + `x()` for non-React code), API client, realtime, voice, push.
- `src/components/` one file per web component; `ui/` are the small base components.
- `global.css`, `theme.generated.json` are generated from the web theme, do not edit.
