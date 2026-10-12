# Native app plan (Expo + React Native + NativeWind)

## What this is about

Today the phone app is the web frontend (`apps/frontend`) wrapped in Capacitor (`apps/mobile`). It works,
but it is a website in a WebView: scrolling, the keyboard, gestures, media, calls and notifications all feel
like a website.

This plan builds a real native app in a new workspace, `apps/native`, with:

- **Expo** (managed workflow + dev builds) and **Expo Router** for screens,
- **NativeWind** for styling, using the same Tailwind class names and theme tokens as the web,
- **Eden treaty** (`@elysia/eden`) against the backend's `App` type, exactly like `apps/frontend/src/lib/api.ts`.

The goal is:

1. **Feature parity** with the website (everything listed in [Feature inventory](#feature-inventory)).
2. **Looks like the website.** Same colors, font, square corners, icons, spacing and layout widths.
3. **Feels like a phone app.** Native gestures, sheets, haptics, keyboard handling, media viewer, push
   notifications and calls (see [Mobile UX upgrades](#mobile-ux-upgrades)).
4. **Easy to read.** Every native file has one obvious web counterpart, with the same names and the same
   flow. If you know the frontend, you should be able to find your way around in minutes.

## Ground rules

1. **No surprise backend changes.** The app must work against an unchanged Anchor, except for the two
   decisions listed in [Backend changes](#backend-changes). Those come as separate, small PRs.
2. **Same names as the web.** `chat`, `realtime`, `session`, `anchor`, `dms`, `friends`, `settings`,
   `notificationSettings`, `voice` stay the same objects with the same method names (`chat.sendMessage`,
   `friends.request`, `voice.setMuted`, ...).
3. **One web file → one native file.** Each native file starts with a one-line comment naming the web file it
   comes from, e.g. `// Port of apps/frontend/src/lib/chat-state.svelte.ts`.
4. **Zod for anything we check**, same as the rest of the repo (see `AGENTS.md`). No hand-written
   `typeof` checks.
5. **Small, simple code.** No custom frameworks or "clever" abstractions. Use a well-known library when one
   exists.
6. **Web stubs stay stubs.** If a web button has no backend yet (delete channel, leave guild, roles, kick/ban,
   ...), the native app hides it instead of faking it. It gets added on both sides when the backend has it.
7. **Small PRs.** Each phase below is one or more PRs, and each one passes
   `bun run --filter native check` and `bun run --filter native lint` and runs on an iOS and an Android
   dev build.

---

## Stack

| Concern | Web (today) | Native (planned) | Why |
| --- | --- | --- | --- |
| Framework | SvelteKit (SPA) | Expo (latest SDK), React Native, New Architecture | Required |
| Routing | SvelteKit routes | Expo Router (file-based, typed routes) | Same mental model as SvelteKit: files are screens |
| Styling | Tailwind v4 | NativeWind (v5 if it is stable when we start, otherwise v4) | Same class names; v5 also reads a Tailwind v4 CSS theme, like the web |
| UI kit | shadcn-svelte (bits-ui) | `react-native-reusables` (shadcn for React Native, built on NativeWind) | Same components and naming as shadcn-svelte |
| Icons | `@lucide/svelte` | `lucide-react-native` | Same icon set and names |
| Font | IBM Plex Sans Variable | `@expo-google-fonts/ibm-plex-sans` (400/500/600/700) | Same font |
| API | `@elysia/eden` treaty | `@elysia/eden` treaty | Required, and same code |
| Validation | Zod | Zod | Same schemas |
| State | Svelte rune classes (`$state`) | Zustand, one store per web state file | Small, hook-based, easy to read |
| Storage | `localStorage` | `react-native-mmkv` (sync, same key names) | Same synchronous API as `localStorage` |
| Lists | DOM scroll | `@shopify/flash-list` (v2) | Fast long lists, keeps scroll position when older messages are prepended |
| Gestures & animation | CSS / touch events | `react-native-gesture-handler` + `react-native-reanimated` | Native-thread swipes and drawers |
| Sheets & menus | dialogs, dropdowns, context menus | `@gorhom/bottom-sheet` | The phone way to show menus |
| Keyboard | browser | `react-native-keyboard-controller` | Composer that moves with the keyboard |
| Images | `<img>`, canvas GIF freeze | `expo-image` | Caching, GIF/WebP animation, placeholders |
| Video / audio | `@videojs/html` | `expo-video`, `expo-audio` | Native players, PiP, background audio |
| Sounds | Howler / `svelte-sound` | `expo-audio` | Same `.opus` files, copied from `apps/frontend/src/lib/sounds` |
| Voice / video | `livekit-client` | `@livekit/react-native` + `@livekit/react-native-webrtc` + Expo config plugin | Official LiveKit SDK |
| Push | Web Push / UnifiedPush (Capacitor plugin) | UnifiedPush (Android, ported plugin), plus an iOS choice (see [Backend changes](#backend-changes)) | Works with today's backend on Android |
| Files | `<input type=file>`, drag & drop, paste | `expo-image-picker`, `expo-document-picker`, `expo-image-manipulator` | Native pickers and camera |
| Haptics | none | `expo-haptics` | Small touch feedback |
| Updates | `@capgo/capacitor-updater` | `expo-updates` (EAS Update or self-hosted) | Same idea: ship JS fixes without a store release |
| Builds | Capacitor CLI | EAS Build (or `expo run:*` locally) | Standard Expo setup |

> Check exact versions when scaffolding. Use `bun create expo` with the latest SDK, then
> `bun x expo install <pkg>` for each library so the versions match that SDK.

The app needs a **dev build**, not Expo Go, because LiveKit, MMKV and the UnifiedPush module are native code.

---

## How the code is laid out

```
apps/native/
  app.config.ts               # Expo config (name, bundle id, plugins, deep links)
  global.css                  # Theme tokens, generated from apps/frontend/src/routes/layout.css
  tailwind.config.ts          # Only if we use NativeWind v4 (v5 keeps the theme in global.css)
  metro.config.js             # NativeWind + monorepo setup
  scripts/
    sync-theme.ts             # Turns the web's oklch tokens into hex for React Native
  modules/
    unified-push/             # Local Expo module: port of apps/mobile/.../UnifiedPush*.java
  assets/
    sounds/                   # Copies of apps/frontend/src/lib/sounds/*.opus
  src/
    app/                      # Expo Router screens (one file = one screen)
      _layout.tsx             # Fonts, theme, providers, boot (≈ routes/+layout.svelte)
      (auth)/
        login.tsx             # ≈ routes/login/+page.svelte
        register.tsx          # ≈ routes/register/+page.svelte
        reset-password.tsx    # ≈ routes/reset-password/+page.svelte
      (app)/
        _layout.tsx           # The three-panel shell (≈ components/app-shell.svelte)
        index.tsx             # Home: friends (≈ components/friends-home.svelte)
        guilds/[guildId]/[channelId].tsx   # Text or voice channel
        dms/[channelId].tsx   # DM chat (+ embedded call)
        settings/             # One screen per web settings tab
          index.tsx           # The settings list (≈ settings-dialog nav)
          account.tsx
          security.tsx
          appearance.tsx
          notifications.tsx
          voice.tsx
          language.tsx
      i/[code].tsx            # Invite page (≈ routes/i/[code]/+page.svelte)
      viewer.tsx              # Full-screen attachment viewer (modal)
    lib/
      api.ts                  # Eden client + discovery (≈ lib/api.ts, nearly a copy)
      anchor.ts               # Active homeserver store (≈ lib/anchor.svelte.ts)
      session.ts              # ≈ lib/session.svelte.ts
      chat-state.ts           # ≈ lib/chat-state.svelte.ts
      realtime.ts             # ≈ lib/realtime.svelte.ts
      dms.ts                  # ≈ lib/dms.svelte.ts
      friends.ts              # ≈ lib/friends.svelte.ts
      settings.ts             # ≈ lib/settings.svelte.ts
      notification-settings.ts# ≈ lib/notification-settings.svelte.ts
      notifications.ts        # ≈ lib/notifications.ts (local notifications + sound)
      push.ts                 # ≈ lib/push.ts (UnifiedPush / iOS)
      voice.ts                # ≈ lib/voice.svelte.ts (LiveKit)
      voice-layout.ts         # ≈ lib/voice-layout.ts (copied, it is plain TS)
      format-date.ts          # ≈ lib/formatDate.ts (copied)
      utils.ts                # cn(), formatBytes, urlPattern (≈ lib/utils.ts)
      storage.ts              # MMKV instance (our localStorage)
      types/chat.ts           # ≈ lib/types/chat.ts (copied)
    components/
      ui/                     # react-native-reusables components (≈ lib/components/ui)
      ...                     # One file per web component, same name: message.tsx, message-input.tsx, ...
```

### The web → native map

This is the table to keep open while reading the code. Names match on purpose.

| Web file (`apps/frontend/src/...`) | Native file (`apps/native/src/...`) | Notes |
| --- | --- | --- |
| `lib/api.ts` | `lib/api.ts` | Same code. Only the `fetch` options change (see [Auth](#auth-cookies-and-the-session)). |
| `lib/anchor.svelte.ts` | `lib/anchor.ts` | `localStorage` → MMKV, same keys. |
| `lib/session.svelte.ts` | `lib/session.ts` | Same methods. `switchAccount` re-boots the app instead of `window.location.href = '/'`. |
| `lib/chat-state.svelte.ts` | `lib/chat-state.ts` | Same methods. URL-derived route → Expo Router params. Canvas re-encode → `expo-image-manipulator`. |
| `lib/realtime.svelte.ts` | `lib/realtime.ts` | Same Zod schemas and handlers. `focus`/`blur`/`visibilitychange` → `AppState`. `online` → `@react-native-community/netinfo`. |
| `lib/dms.svelte.ts`, `lib/friends.svelte.ts` | `lib/dms.ts`, `lib/friends.ts` | Nearly copies. |
| `lib/settings.svelte.ts` | `lib/settings.ts` | Same keys and defaults. Desktop-only keys dropped. |
| `lib/notification-settings.svelte.ts` | `lib/notification-settings.ts` | Same, uses `anchor/notification-level`. |
| `lib/notifications.ts` | `lib/notifications.ts` | `new Notification` → `expo-notifications` local notification; Howler → `expo-audio`. |
| `lib/push.ts` | `lib/push.ts` | Capacitor plugin → local Expo module (Android). iOS: see below. |
| `lib/voice.svelte.ts` | `lib/voice.ts` | `livekit-client` → `@livekit/react-native`. Same state shape (`VoiceState`). |
| `lib/voice-layout.ts`, `lib/formatDate.ts`, `lib/types/chat.ts` | same names | Plain TypeScript, copied. |
| `components/app-shell.svelte` | `app/(app)/_layout.tsx` + `components/panels.tsx` | Boot, swipe panels, call ringing. |
| `components/guild-sidebar.svelte` | `components/guild-sidebar.tsx` | |
| `components/channel-sidebar.svelte` | `components/channel-sidebar.tsx` | |
| `components/dm-sidebar.svelte` | `components/dm-sidebar.tsx` | |
| `components/member-sidebar.svelte` | `components/member-sidebar.tsx` | |
| `components/chat-area.svelte` | `components/chat-area.tsx` | |
| `components/message.svelte` | `components/message.tsx` | |
| `components/message-input.svelte` | `components/message-input.tsx` | |
| `components/emoji-text.svelte` | `components/emoji-text.tsx` | |
| `components/attachment-viewer.svelte` | `app/viewer.tsx` | A modal screen instead of a dialog. |
| `components/profile-card.svelte` | `components/profile-card.tsx` | Bottom sheet instead of popover. |
| `components/user-area.svelte` | `components/user-area.tsx` | |
| `components/voice-area.svelte`, `voice-stage.svelte`, `voice-tile.svelte` | same names `.tsx` | |
| `components/call-ringing.svelte` | `components/call-ringing.tsx` | Plus native call UI (later phase). |
| `components/*-dialog.svelte` | same names `.tsx` | Bottom sheets (short forms) or modal screens (long forms). |
| `components/settings-dialog.svelte` | `app/(app)/settings/*.tsx` | One screen per tab. |
| `components/settings-group.svelte`, `settings-row.svelte` | same names `.tsx` | |
| `components/notification-menu.svelte` | `components/notification-menu.tsx` | Rendered inside sheets. |
| `components/avatar.svelte`, `animated-image.svelte` | `components/avatar.tsx` | `expo-image` handles GIFs; freeze-when-unfocused via `autoplay`. |
| `components/initial-loader.svelte` | `components/initial-loader.tsx` | Same sunrise, built with `react-native-svg` + Reanimated. |
| `components/constellation-background.svelte` | `components/constellation-background.tsx` | `@shopify/react-native-skia` canvas, or a static image at first. |
| `routes/login`, `register`, `reset-password`, `i/[code]` | `app/(auth)/*`, `app/i/[code].tsx` | |

Things that are **not** ported because they are web/desktop only: `electron-api.ts`, `ota.ts` (replaced by
`expo-updates`), `service-worker.ts`, `device.svelte.ts` (always a phone; tablets get the wide layout),
`rnnoise-processor.ts` (see [Voice](#voice-and-calls)), Custom CSS, the desktop app settings tab.

### Store style

Every store is a Zustand store with the **same fields and methods** as the Svelte class it replaces. For
example, the start of `lib/friends.ts` looks like this:

```ts
// Port of apps/frontend/src/lib/friends.svelte.ts
import { create } from 'zustand';
import { anchor } from './anchor';

type FriendsState = {
  accepted: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
  busyUserIds: string[];
  load: () => Promise<void>;
  request: (username: string, homeserver: string) => Promise<void>;
  // ...same methods as the web
};

export const useFriends = create<FriendsState>((set, get) => ({
  accepted: [],
  incoming: [],
  outgoing: [],
  busyUserIds: [],
  async load() {
    const { data } = await anchor().client.friends.get();
    if (data) set(data);
  },
  // ...
}));

// Same name as on the web, for code that runs outside React (realtime handlers, push taps).
export const friends = useFriends.getState;
```

- Components read with selectors: `const incoming = useFriends((s) => s.incoming);`
- Non-React code (like `realtime.ts`) calls `friends().load()`, which reads almost the same as the web's
  `friends.load()`.
- Derived values (`$derived` on the web) become small selector functions next to the store, e.g.
  `selectGuildMentions(state)`.

---

## Auth, cookies and the session

The backend authenticates every HTTP request and the realtime socket with **one `session_token` cookie**.
There is no `Authorization` header support (`apps/anchor/modules/auth/provider.ts`).

The plan is to **use the phone's native cookie store**, exactly like the browser does:

- iOS (`NSHTTPCookieStorage`) and Android (OkHttp cookie jar) store `Set-Cookie` from `fetch` responses and
  send them again on later requests **and on the WebSocket upgrade**.
- So `createAnchorClient` stays the same as the web: `treaty(baseUrl, { fetch: { credentials: 'include' } })`,
  and `anchor.client.realtime.subscribe()` works without changes.
- Cookies are per host, so the web's **one account per homeserver** model (`novarum:accounts`) works
  unchanged.

**Phase 0 checks this works** (login, restart the app, `GET /auth/me`, open the socket, on both platforms).
If it does not, the fallback is the small backend change in [Backend changes](#backend-changes) (B1).

Other auth notes:

- `credentials: 'include'` is ignored by React Native's `fetch`, which always uses the cookie store. We keep
  it so `api.ts` stays identical to the web.
- Hermes is missing some web APIs that Eden uses. Phase 0 adds whatever polyfills are needed (most likely
  `react-native-url-polyfill`), in one file, `src/polyfills.ts`, imported first in `_layout.tsx`.
- Types: `import type { App, RealtimeEvent } from 'anchor'` only. A value import from `'anchor'` would
  bundle the whole server. Runtime imports are allowed only from `anchor/public-user` and
  `anchor/notification-level`, same as the web.
- `apps/native/tsconfig.json` needs `"types": ["bun"]` (or `bun-types`) so type-checking Anchor's sources
  works, the same as the frontend does today.

---

## Look and feel: matching the website

### Theme tokens

`apps/frontend/src/routes/layout.css` defines all colors as `oklch(...)`. React Native cannot read
`oklch`, so:

- `scripts/sync-theme.ts` reads the `:root` and `.dark` blocks from the web CSS, converts each value to hex
  (with `culori`), and writes `apps/native/global.css` as CSS variables.
- Run it with `bun run --filter native sync-theme`. The output is committed, and has a header saying it is
  generated.
- So `bg-sidebar`, `text-muted-foreground`, `bg-primary/10`, `border-border`, `text-link`, `bg-destructive`,
  ... all exist in native with the same values. Dark mode uses NativeWind's `dark:` / color scheme, controlled
  by the same `darkMode` setting (default on).

### Shape and type

- **Square corners by default** (`--radius: 0`), and the same `circleIcons` setting that makes avatars,
  guild tiles, badges and status dots round.
- IBM Plex Sans for everything. A monospace font for handles (`@user:server`) and file sizes, like the web.
- Same Lucide icons, same sizes.
- Same accents: `bg-emerald-500` for online, `bg-amber-400/10` + amber bar for messages that mention you,
  `text-rose-400` for mute icons, red `bg-destructive` badges with a "99+" cap, the red "New" divider, the
  12-color avatar palette from `voice-layout.ts`, and the default speaking ring `#00d492`.

### Layout

On phones, the web already uses a "panels" layout: swipe right for servers and channels, swipe left for
members. The native app keeps that layout, but does it with native gestures:

```
 ┌──────┬───────────────┐┌────────────────────┐┌──────────────┐
 │guild │ channel list  ││  chat / voice      ││  members     │
 │ rail │  or DM list   ││  (center panel)    ││  (guilds     │
 │ w-14 │   w-60        ││                    ││   only)      │
 │      ├───────────────┤│                    ││              │
 │      │  user area    ││                    ││              │
 └──────┴───────────────┘└────────────────────┘└──────────────┘
   left panel (swipe →)      always mounted       right panel (swipe ←)
```

- Built in `components/panels.tsx` with gesture-handler + Reanimated. The center panel slides over and
  follows your finger, like Discord.
- Widths are the web's: rail `w-14`, channel/DM list `w-60`, members `w-56`, headers `h-12`.
- **Tablets and landscape** (width ≥ 768) show the left panel next to the chat, and members at ≥ 1024. These
  are the same breakpoints as the web (`md`, `lg`).
- Android back button and the iOS edge swipe close an open panel first, then go back.

---

## Mobile UX upgrades

These are the things that should feel better than the Capacitor app. Each one has a place in the phases
below.

**Chat**
- Composer is attached to the keyboard (`react-native-keyboard-controller`). No jumping or hidden input.
- **Swipe a message right to reply** (with a haptic tick).
- **Long-press a message** for a bottom sheet with Reply, Edit, Copy Text, Copy Link, Copy ID and Delete.
  This replaces the web's hover toolbar and right-click menu.
- Mention and emoji autocomplete appear as a strip above the keyboard.
- **Optimistic send.** The message shows right away as "sending" and can be retried if it fails (the nonce
  already makes this safe).
- Attach from the **camera**, gallery or files. Upload progress shows on each tile.
- Smooth "load older messages" with no jump (FlashList keeps the visible message in place).
- A "jump to latest" button when you scroll up. Tapping the status bar scrolls up (iOS default).

**Media**
- Full-screen viewer: pinch to zoom, double-tap to zoom, swipe between attachments, **swipe down to close**.
- Save to photos and the native share sheet, instead of "open in new tab".
- Native video player with fullscreen and picture-in-picture.
- GIFs and avatars cached on disk (`expo-image`).

**Navigation and system**
- Deep links: `novarum://` and `https://app.novarum.me/i/<code>` and `/guilds/...` open the right screen
  (the same paths the push payload `url` already uses).
- Invite links use the **native share sheet**.
- **Push notifications that open the right message**, and an **app badge** with the unread count (same number
  the web shows in the tab title).
- Settings are native screens with native switches, pickers and back navigation.
- Pull to refresh on the friends and DM lists.
- Offline banner and automatic reconnect when the network comes back or the app returns to the foreground.
- Haptics on send, on long-press, on mute/deafen, and on incoming calls.
- Safe areas, edge-to-edge on Android, and Dynamic Type / font scaling respected.

**Calls**
- Voice keeps running with the screen off or the app in the background (audio background mode).
- Earpiece / speaker / Bluetooth switching.
- Later phase: **incoming DM calls as real phone calls** (CallKit on iOS, ConnectionService on Android), and a
  floating mini call view while browsing other channels.

---

## Feature inventory

Everything the website does today, and where it lands. ✅ = same feature, 📱 = same feature with a phone
version of the UI.

### Auth and accounts
| Feature | Native |
| --- | --- |
| Login with homeserver, username, password | ✅ |
| MFA step: TOTP or email code, "try another way", resend, 6-digit OTP auto-submit | ✅ (iOS/Android one-time-code autofill on the OTP field) |
| Register with live `@user:server` preview, password rules, confirm | ✅ |
| Reset password (request → code + new password → done) | ✅ |
| Multiple accounts (one per homeserver), switch, add, forget | ✅ (account switcher sheet from the user area) |
| Log out | ✅ |
| `?redirect=` after login | ✅ via Expo Router params |

### Guilds and channels
| Feature | Native |
| --- | --- |
| Guild rail with Home button, unread-DM dot, mention badges, `down` guilds disabled | ✅ |
| Create guild (name, initials preview) | 📱 bottom sheet |
| Reorder guilds | 📱 long-press and drag |
| Channel list with collapsible category, unread dot, mention badge, active row | ✅ |
| Create channel (text/voice, slug name) | 📱 bottom sheet |
| Reorder channels (if `canManageChannels`) | 📱 long-press and drag |
| Voice channels show connected users, speaking ring, mute/deafen icons | ✅ |
| Channel menu: copy link, copy ID, notification settings, edit (UI only, like web) | 📱 long-press sheet |
| Guild settings: avatar upload with crop (GIF uploaded as is) | 📱 full screen |
| Invite dialog: get or create invite, copy, regenerate | 📱 sheet + native share |
| Join via invite (`/i/<code>@<homeserver>`), including federated invites | ✅ + deep link |
| Member list with online/offline groups and profile cards | ✅ right panel |

### Messages
| Feature | Native |
| --- | --- |
| Send text, Enter-to-send replaced by a send button, newlines allowed | 📱 |
| Replies with preview and "Original message unavailable" | ✅ + swipe to reply |
| Edit (inline), delete (with confirm), "(edited)" label | 📱 long-press sheet |
| Copy text, copy link, copy ID | 📱 long-press sheet |
| Mentions `@user:server` with autocomplete and highlighted pills | ✅ |
| Emoji autocomplete `:name` (realtime `emoji.search`) and emoji images (`emoji.query`) | ✅ |
| Links in messages | ✅ open in in-app browser |
| Attachments: up to 5, `maxFileSize`, presigned upload with progress, metadata stripped from images | ✅ + camera |
| Image grid, video player, audio player, PDF tile, file tile | ✅ |
| Attachment viewer with zoom and carousel | 📱 full screen gestures |
| Load older messages, day dividers, grouping within 5 minutes | ✅ |
| "New" divider at the last read message | ✅ |
| Jump to a message (from links and notifications) with flash | ✅ |
| Typing indicator (send every 5s, show for 6s) | ✅ |
| Read markers (`channel/:id/read`) | ✅ |
| Self-mention highlight | ✅ |

### Friends and DMs
| Feature | Native |
| --- | --- |
| Friends home: Online / All / Pending / Add friend tabs, search | ✅ |
| Accept, ignore, cancel, remove; accepting opens the DM | ✅ |
| Profile card: banner, avatar, status, about, BOT badge, friend button | 📱 bottom sheet |
| DM list sorted by last message, unread, online dot, in-call icon, close DM | ✅ + swipe to close |
| Federated DMs loading per homeserver ("Waiting for ...") | ✅ |
| New DM from friends list | 📱 sheet |

### Notifications
| Feature | Native |
| --- | --- |
| Per guild / channel / DM level (All, Mentions, Nothing, Use default) | 📱 in long-press sheets |
| Mute 1h / 8h / 24h / forever, unmute | 📱 |
| Push on/off, message preview, mention sound, volume | ✅ |
| In-app notification + sound for messages in other channels (`shouldNotify`) | ✅ (in-app banner when the app is open) |
| Tapping a notification opens the message | ✅ |
| Unread count | ✅ app icon badge |

### Settings
| Web tab | Native screen | Contents |
| --- | --- | --- |
| Account | `settings/account` | Banner (crop 3:1) and avatar (crop 1:1) upload, about me (512 chars), avatar color, speaking ring color, read-only display name and email, log out |
| Privacy & security | `settings/security` | Show online status, email MFA toggle, TOTP setup (QR + secret + code), TOTP toggle and delete. On a phone the QR is useless, so show the secret first with "Copy" and "Open in authenticator app" (`otpauth://` link) |
| Appearance | `settings/appearance` | Dark mode, round icons, show member list. Custom CSS is web-only. |
| Notifications | `settings/notifications` | Same as web |
| Voice & audio | `settings/voice` | Echo cancellation, auto gain, noise suppression, mic test with level meter. Device pickers become "audio output: speaker / earpiece / Bluetooth" and front/back camera. |
| Language & time | `settings/language` | Language (stored only, like web), time format |
| — | footer | Frontend/app version, Anchor version, commit hash |

### Voice and calls
| Feature | Native |
| --- | --- |
| Join voice channel, LiveKit token from `channel/:id/call/token` | ✅ |
| Mute, deafen, camera, with the same sounds | ✅ |
| Speaking indicators, per-user volume (0–300%), local mute | ✅ (long-press a tile) |
| Grid and spotlight layouts (`fitTiles`), filmstrip | ✅ |
| Watch screen shares (opt-in), stream volume | ✅ |
| Share your screen | Android in the voice phase; iOS later (needs a broadcast extension) |
| DM calls: start, ring, incoming call toast, accept, decline, embedded call above the chat | ✅ |
| Reconnecting banner, latency indicator in the user area | ✅ |
| Mic test (loopback) | ✅ |

---

## Phases

Each phase ends with something you can install and use. The checkboxes are what "done" means for that phase.

### Phase 0: Foundations and risky checks

Prove the parts that could break the plan before building screens.

- Scaffold `apps/native` with `bun create expo` (TypeScript, Expo Router). Add `"name": "native"` and the
  scripts below. Add `"anchor": "workspace:*"`.
- Set up Metro for the Bun workspace (Expo's monorepo defaults) and NativeWind.
- Write `scripts/sync-theme.ts` and generate `global.css`. Load IBM Plex Sans.
- Add `react-native-reusables` with the base components (Button, Input, Text, Switch, Separator, ...).
- `lib/api.ts`, `lib/storage.ts`, `lib/anchor.ts` and `lib/session.ts`, plus a test screen that logs in and
  shows `auth.me`.
- Open the realtime socket and print events.
- Make a dev build with LiveKit installed and join a voice channel from a test button.

Scripts in `apps/native/package.json`:

```json
{
  "dev": "expo start",
  "ios": "expo run:ios",
  "android": "expo run:android",
  "check": "tsc --noEmit",
  "lint": "expo lint",
  "sync-theme": "bun run scripts/sync-theme.ts"
}
```

Done when:
- [ ] Eden treaty calls are fully typed in the editor (hover `anchor.client.message.list.get`).
- [ ] Login works and **survives an app restart** on iOS and Android (native cookie store).
- [ ] The realtime socket connects with the cookie and receives `message.created`.
- [ ] A dev build joins a LiveKit room and you can hear audio.
- [ ] `bun run --filter native check` passes.
- [ ] `bun run dev` from the root still works for everyone. If running Expo there is noisy, the `native`
  `dev` script can be renamed so `--filter '*' dev` skips it.

If the cookie check fails, do B1 below before Phase 1.

### Phase 1: Auth screens and the app shell

- Login (with MFA), register, reset password. Same Zod form rules as the web pages (copy the schemas).
  Forms use `react-hook-form` + `@hookform/resolvers/zod`, the React counterpart of superforms.
- Constellation background (Skia) and the initial loader animation.
- Boot flow from `app-shell.svelte`: `session.refresh()` → `chat.loadInitialData()`, `friends.load()`,
  `notificationSettings.load()` → realtime connect.
- The three-panel layout with swipe gestures, guild rail and user area (without voice controls yet).
- Account switcher and log out.
- Settings: appearance and language & time (they are local only, a good first test of `settings.ts`).

Done when:
- [ ] You can sign up, sign in (with TOTP and email MFA), reset your password, and switch accounts.
- [ ] Panels open and close smoothly with swipes and the back button.
- [ ] Dark mode and round icons change the whole app.

### Phase 2: Chat

- `chat-state.ts`, `realtime.ts` (all events), `dms.ts`.
- Channel sidebar, DM sidebar, chat area, message, message input, emoji text.
- FlashList message list: older pages, day dividers, grouping, "New" divider, jump-to-message, typing.
- Long-press sheet and swipe-to-reply. Edit and delete.
- Mention and emoji autocomplete.
- Read markers, unread dots and mention badges (same logic as the web).
- `AppState` → `client.state` (important: the server only sends push when this says inactive).
- Reconnect with backoff, `recoverRealtimeState` after reconnect, offline banner.

Done when:
- [ ] A conversation between the app and the website looks the same on both, live, in both directions.
- [ ] Scrolling 1,000+ messages back stays smooth, and the visible message doesn't jump when older ones
  load.
- [ ] The keyboard never covers the composer on either platform.

### Phase 3: Attachments and media

- Pickers (gallery, camera, files), 5-file and `maxFileSize` limits, image re-encode to strip metadata
  (`expo-image-manipulator`), presigned upload with an XHR `PUT` and progress (same as the web).
- Message attachments: image grid, video (`expo-video`), audio (`expo-audio`), PDF and file tiles (open with
  the system viewer or share sheet).
- Full-screen viewer with zoom, swipe between items, swipe down to close, save and share.

Done when:
- [ ] Every content type the backend allows can be sent from the phone and viewed on the phone.
- [ ] A photo sent from the phone has no GPS data on the server copy.

### Phase 4: Guilds, friends, profiles and settings

- Create guild, create channel, reorder guilds and channels (long-press drag), invite sheet with share,
  invite deep link screen, guild settings (avatar with crop).
- Member list panel, profile card sheet.
- Friends home (all tabs), new DM sheet, close DM.
- Settings: account (avatar/banner crop, about, colors), privacy & security (MFA), notifications (levels
  and mutes in all long-press sheets).
- A small crop screen (`components/avatar-crop.tsx`) with gesture-handler and `expo-image-manipulator`,
  matching `avatar-crop-dialog.svelte` (1:1 for avatars, 3:1 at 960×320 for banners).

Done when:
- [ ] Every row in the [Feature inventory](#feature-inventory) above, except push and voice, works.

### Phase 5: Notifications and push

- In-app: `shouldNotify` (copied) decides, a small in-app banner shows, and the mention sound plays.
- **Android:** port the existing UnifiedPush Capacitor plugin (`apps/mobile/android/.../UnifiedPush*.java`)
  to a local Expo module in `modules/unified-push` (Kotlin, with a config plugin for the manifest). The JS
  API stays the same (`register`, `unregister`, `getEndpoint`, `getLaunchUrl`, and the `endpoint`,
  `registrationFailed`, `notificationTapped` events). This works with the **current backend**
  (`kind: 'UNIFIEDPUSH'`).
- **iOS:** depends on decision B2 below.
- Notification taps open the message (same `url` format the backend already sends: `/guilds/...`).
- App icon badge = the web's `unreadTotal`.
- `syncPush()` on start, like the web.

Done when:
- [ ] With the app closed, a DM or mention shows a notification within a few seconds, and tapping it opens
  that message.
- [ ] Turning push off in settings stops them.

### Phase 6: Voice, video and calls

- `voice.ts` port: join/leave, mute/deafen (with sounds), camera, speaking indicators, per-user and stream
  volume, watched streams, reconnecting state, latency.
- Noise suppression: the web's RNNoise worklet can't run in React Native. Use the platform's built-in
  noise suppression (WebRTC `noiseSuppression` constraint, which uses the phone's audio DSP). The setting
  name and default stay the same.
- Voice area, stage (grid + spotlight + filmstrip), tiles, participant long-press sheet.
- Voice controls in the user area and the mic test with a level meter.
- DM calls: start, ring, incoming call toast, embedded call above the chat that you can drag to resize.
- Audio session: background audio, speaker/earpiece/Bluetooth.
- Screen share on Android.

Done when:
- [ ] A 30-minute call with the screen locked keeps working.
- [ ] Voice and video work between the app and the website.

### Phase 7: Polish and release

- Native incoming calls (CallKit / ConnectionService) and a mini call view.
- iOS screen share (broadcast upload extension).
- `expo-updates` for JS updates, replacing `@capgo/capacitor-updater`.
- Accessibility pass (labels on icon buttons, font scaling), tablet layout pass.
- App icons and splash from `apps/electron/icons` / the existing Android resources.
- Store builds with EAS. Use the **same app id as the Capacitor app (`me.novarum.mobile`) and the same Android
  signing key**, so the native app installs as an update over the Capacitor one.
- Once the native app is released, `apps/mobile` (Capacitor) can be retired in its own PR.

---

## Backend changes

Only these, each as its own small PR, and only when needed.

**B1. Bearer token (only if the Phase 0 cookie check fails).**
Accept `Authorization: Bearer <session_token>` wherever the `session_token` cookie is read, and return the
token in the login, MFA and signup responses when the client asks for it. The token check is already one
function (`validateSessionToken`), so this is a small change. The app would then keep the token in
`expo-secure-store` and pass it with Eden's `headers` option. The WebSocket would send it in a header (React
Native's `WebSocket` allows headers).

**B2. iOS push (needed for push on iPhone).**
iOS apps can't receive Web Push or UnifiedPush, only Apple's APNs. The options are:

| Option | Backend work | Notes |
| --- | --- | --- |
| a. Add an `EXPO` push kind that sends through Expo's push service | New enum value + migration, a subscription body without `keys`, a sender that POSTs to Expo | Easiest. Works for Android (FCM) and iOS. But the notification text goes through Expo and Apple/Google in plain text, which matters for a self-hosted, privacy-focused app. Respect the "message preview" setting (send "New message" only). |
| b. Add an `APNS` push kind that talks to Apple directly | Same, plus APNs keys in `config.toml` | No third party except Apple. Every self-hosted Anchor would need Novarum's APNs key, so this really means a small Novarum push relay. |
| c. No push on iOS at first | None | Ship iOS with in-app notifications only, decide later. |

**Recommendation:** (c) for the first iOS release, then (a), with previews off by default for that kind.
Android keeps UnifiedPush either way, with no backend change. This is your call before Phase 5.

Not needed: the `client.state` message already exists. The app must send `active: false` when it goes to
the background, or the server will think you are looking at the app and skip push.

---

## Code conventions for `apps/native`

So the code stays easy to follow:

- **File header:** `// Port of apps/frontend/src/<path>` on every file that has a web counterpart. Anything
  native-only gets one line saying why it exists.
- **Same names as the web** for stores, methods, components and props. If the web has `onSelectChannel`, so
  does native.
- **Screens are thin.** A screen file reads route params and renders components. Logic lives in `lib/`.
- **Eden for every backend call** through `anchor().client`. No raw `fetch` except discovery
  (`/.well-known/anchor/info`) and the presigned S3 `PUT`, both of which the web also does with raw
  `fetch`/XHR.
- **Zod** for socket events, push payloads, deep link params and stored settings.
- **Styling** with NativeWind `className` only. No `StyleSheet.create` unless a library needs a style
  object (for example Reanimated animated styles).
- **Formatting** with the repo's Prettier config (2 spaces, single quotes, semicolons).
- **Comments** explain *why*, like the rest of the repo. Short and few.

## Risks

| Risk | What we do |
| --- | --- |
| Native cookie store doesn't send the cookie on the WebSocket upgrade | Checked in Phase 0; fallback is B1 |
| Eden needs a web API Hermes doesn't have | Checked in Phase 0; polyfill in `src/polyfills.ts` |
| Metro and Bun workspaces don't resolve `anchor` | Checked in Phase 0; Expo's monorepo config + `"anchor": "workspace:*"` |
| NativeWind v5 not stable yet | Use v4 with a `tailwind.config.ts` generated by the same `sync-theme.ts` |
| Chat list performance with mixed-height messages and media | FlashList v2 with known image sizes from attachments; fallback is an inverted `FlatList` |
| iOS screen sharing is complex | Moved to Phase 7 |
| The two apps drift apart over time | Same names + the map table above. Later, the plain TS files (`api.ts`, schemas, `formatDate`, `voice-layout`, `shouldNotify`) can move into a shared workspace both apps import. |
