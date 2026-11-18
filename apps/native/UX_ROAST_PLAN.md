# Novarum native: UX roast and fix plan

Reviewed on a real phone over adb (1080x2392, 2.34 px/dp, Android gesture nav), Novarum v0.2.1 / `5470ba3`, dark theme. Walked: chat, channel list, Home/DMs, Friends, new DM, server options, notification menu, server settings, members, profile card, message actions, canvas, image viewer, user settings, account switcher, create server.

Not exercised, so not judged here: sending/editing, DMs (opening one would mark it read), voice calls, login/registration, light theme, the keyboard-open state of the composer.

## The short version

The app is a desktop Discord layout squeezed onto a phone. It works, but almost every control is smaller than a thumb, nothing lives where a thumb rests, and there are four different ideas of what a "screen" looks like. The two real bugs are the back button and the screen-reader tree.

## P0: bugs

### 1. System back with a sheet open throws you out of the app
Open any bottom sheet (new DM, server options, message actions) and press/gesture back: the app goes to the background and the sheet is still open when you return. Back should close the sheet. Only `canvas-panel.tsx` registers a `BackHandler`; `components/ui/sheet.tsx` does not.

- Fix once in `ui/sheet.tsx`: while `open`, subscribe to `hardwareBackPress`, dismiss, return `true`.

### 2. Sheets and the viewer are invisible or leaky to screen readers
- With a sheet open, the accessibility tree mostly exposes only "Bottom sheet backdrop" plus the whole screen behind it. Sheet content shows up inconsistently (it did for server settings, then vanished after scrolling).
- Pushed screens (Friends, Members, image viewer) keep the previous screen's nodes in the tree, so TalkBack reads through to what is underneath.
- The Members back button announces itself as `[server]/[...rest], back`, the raw route name.
- Every settings `Switch` has an empty label. Only the 46x27dp switch is tappable, not the row.
- Mute and deafen both announce "Undeafen" when deafened (`user-area.tsx:187`). Correct by the logic, useless to the listener.

Fixes: set `importantForAccessibility="no-hide-descendants"` on covered content, give the Members screen a `headerBackTitle`/label, make `settings-row` a pressable row that forwards its title as the switch label, and label mute as "Unmute (deafened)" or similar.

## P1: it is a phone, act like it

### 3. Tap targets are 30 to 40dp nearly everywhere
Measured from the layout dump (Android minimum is 48dp):

| Control | Size |
| --- | --- |
| Chat header: back, canvas, members | 38dp |
| Server row: notification bell, settings gear | 37 x 32dp |
| "Add channel" plus | 38dp |
| Friends tabs (Online / All / Pending) | 32dp tall |
| Friend row: message, more | 38dp |
| Channel rows | 38dp tall |
| Server icons in the rail | 42dp |
| User bar: mute, deafen, settings | 39dp, packed edge to edge |

Root cause, from the code: the components ask for sensible sizes (`min-h-11`, `size-11`, `size-12`, i.e. 44 and 48 on the web), but NativeWind's default `rem` on native is 14, not 16, and `metro.config.js` does not override it. So every rem-based class renders 12.5% smaller than intended: `size-11` is 38.5dp, `size-12` is 42dp, `text-sm` is about 12dp and `text-xs` about 10.5dp. That matches every measurement above.

- Set `inlineRem: 16` in `withNativeWind(config, { input, inlineRem: 16 })` and re-check the layouts. This fixes most of the table and the small type in one line.
- Then fix what is small by design: `Button size="sm"` (`min-h-9`, used for the bell and gear), the Friends tabs, and the call controls (`size-10` with 14px icons).
- There are only 10 `hitSlop` uses in the whole app; add it to icon buttons in `ui/button.tsx`.

### 4. Nothing is in thumb reach
Everything actionable sits in the top third: back, canvas, members, add DM, add friend, invite, server settings. The bottom of the channel list is 500dp of nothing, then a desktop-style user bar.

- Replace the user bar with a real bottom tab bar: Home/DMs, Servers, Notifications (or Friends), You. Settings moves under "You".
- Move primary creates ("new DM", "add friend") to a bottom-right FAB or into the tab bar.

### 5. The user bar is a desktop leftover
Mute and deafen are permanently on screen, in red, while not in any call. On a phone they mean nothing outside a call and they push the settings gear into a corner. Show them only in the call UI / mini-call. Related: Appearance has a "Show member list: display the member sidebar in channels" toggle. In `[...rest].tsx` it only takes effect at widths of 1024 and up, so on a phone it is a switch that does nothing. Hide it below that width.

### 6. Three gears and three ways to do the same thing
The server screen shows Invite, a bell and a gear as buttons, and tapping the server name opens a sheet with Invite, Create Channel, Settings and Notification Settings again. A second gear (user settings) sits at the bottom of the same screen.

- Keep the server-name sheet as the single home for server actions; drop the button row, or keep just Invite.
- "Copy Guild ID" and "Copy Message ID" belong behind a developer-mode setting.
- The server sheet has no "Leave server" and no "Mark as read".

### 7. No search, anywhere that matters
No message search, no channel/server jump, no member search (23 members is fine, 2,300 is not). Search exists only for friends. Minimum: a search field on Home that filters DMs and channels, and a filter on Members.

### 8. Swipes exist but nobody would find them
Swipe right in chat goes back to the channel list (good). Swipe left on a message replies, and on your own message swiping further switches to edit (`message.tsx`, `EDIT_THRESHOLD`). Nothing hints at either.

- The reply/edit boundary is an invisible distance, so a slightly long swipe on your own message opens the editor when you wanted to reply. The only cue is a 20px gray icon changing from an arrow to a pencil under your thumb.
- Because left swipe is taken by reply, members stays a 38dp icon in the far corner. Either start the members swipe from the right edge only, or accept the button and make it bigger.
- Show the swipe once (a first-run nudge, or a peek animation on the first message).

## P2: lists that don't tell you enough

### 9. DM list
- No last-message preview. Each row is a name and a date. (There is an online dot, but it is 9dp and only appears when the person is online; offline and "unknown" look the same.)
- Absolute dates ("12 Nov 2026") in 12px gray for anything older than today. Use relative time for recent ones ("2d", "Tue").
- Two rows both called "guille" with nothing to tell them apart, since the handle is hidden here but shown in Friends. Show the homeserver when display names collide.
- One row ("tormentika") has no date at all, so the right column is ragged.

### 10. Server rail
- Unread is a 4x8dp white pill on the left edge of the rail; mentions get a red badge. The pill is easy to miss against the screen edge, and I saw none during the session, so check it is noticeable with real unreads.
- Unread DMs are injected into the rail as extra avatars with a red dot, while the Home button deliberately does not light up. The rail reshuffles under your thumb whenever a DM arrives.
- Reordering servers is long-press, "Move up" or "Move down", one slot per sheet. Moving a server ten places is ten long-presses. Same for channels. Use drag to reorder.
- A server whose homeserver is down is a red tile at 40% opacity that does nothing when tapped, with no explanation.
- The long-press sheet has no "Leave server", "Mark as read" or "Invite".
- The Home button is a sunrise icon. Nobody guesses "DMs" from that.
- "Add server" only offers Create. There is no "join with an invite link" path.
- Servers without an icon are near-black squares on a near-black rail ("S", "H", "H", "N").

### 11. Friends
- Opens on "Online", which is empty, with a big empty state. Default to All when nobody is online, or merge into one list sorted online first.
- The selected tab is the darker one, so it reads as a hole rather than as active.
- Pending has no count on the tab, no incoming/outgoing split, and hides handles (which "lilith"?).
- All is unsorted. Tapping the row and tapping the chat icon both do "Message"; drop one.
- Presence is a 6dp gray square on the avatar corner.

### 12. Members
- No handles and no search: two "guille", two "lilith", two "testttt".
- Offline rows are dimmed to the point of low contrast on the avatar and the name.
- List content peeks out above the header line while scrolling.

## P3: consistency and polish

### 13. Four screen chromes
1. Custom header with a chevron (chat, Friends).
2. Native stack header with an arrow and a large title (Settings).
3. iOS-style modal card with rounded corners (Members).
4. Bottom sheets, including full-height ones used as screens (Server settings).

Pick one header (`screen-header.tsx`) and use it for Settings and Members too. Server settings should be a pushed screen, not a 95%-height sheet.

### 14. Surfaces and shapes disagree
- Backgrounds flip between near-black (chat, Friends, Settings) and purple-gray (channel list, sheets) with no rule.
- Everything is hard-edged squares, except the Members modal (rounded), the server picture in Guild Settings (a circle, with "Round icons" off), and switches.
- Handles are monospace in the new-DM sheet and profile card, proportional in Friends and settings.
- Settings row dividers are bright near-white lines, the loudest thing on the page.
- The off state of the switch looks broken: the thumb overlaps a short, pale track (Appearance > Round icons).

### 15. "Guild" vs "Server"
"Create Server", "Mute Server", "server options" versus "Guild Settings", "Guild Name", "Guild Picture", "Copy Guild ID". Users see "server"; say "server".

### 16. Server settings
- Name and description are rendered so dim they look disabled or like placeholders.
- "More guild settings are coming soon!" followed by a member list that has no actions and duplicates the Members screen.
- No visible save, and the fields share a sheet you can swipe away by accident.

### 17. Message actions
- No reactions at all (no quick emoji row, nothing in the sheet).
- "Copy Text" and "Edit Message" are offered on an image-only message with no text.
- Delete is the last row, right above the home gesture bar. The confirm dialog saves it; still, add a gap or move it up.
- Header is 11px text ("StonePlatoon · 11 Nov 2026 at 22:40"); a one-line preview of the message would confirm what you long-pressed.

### 18. Chat
- Header icons are unlabeled; the notebook-with-pen for Canvas is not guessable.
- Reply previews are about 11px in low-contrast gray.
- The composer is a boxed rectangle with only attach and send. No emoji button.
- Timestamps next to names show time only, so the date is only knowable from the divider.

### 19. Canvas
- Replaces the chat instead of sitting next to or above it, with a tiny "Canvas" label as the only cue.
- Formatting toolbar is pinned to the top of the screen. It should dock above the keyboard. Eleven 38dp buttons in a row.

### 20. Image viewer
- The backdrop is translucent, so chat text ghosts through around the image. Make it opaque (or 95%+).
- Close, share and download are small and top-right. Swipe down to dismiss, pinch and double-tap zoom are implemented, which is the right set.
- "Saved to your photos" is a blocking system alert with an OK button. That should be a toast.

### 21. Profile card
- A user without a banner gets a flat light-gray slab about 180dp tall on a dark sheet. Use their avatar color or collapse it.
- Mentions in "About" are plain text, not tappable.

### 22. Account settings
- Display name and email look like read-only text. If they are editable, add a chevron; if not, say so.
- "Save about" is its own button inside the field; the bio shows raw markdown with no preview.
- Colors are shown as hex codes (`#A49478`), which is a developer's idea of a color name.

### 23. Appearance
- Dark mode is a single on/off switch: no "follow system".
- No text size or compact-message option.

## Round 2: found by reading the code

These come from the source, not from the phone, so each one names its file. I did not trigger them on the device.

### 24. Drafts are thrown away
`message-input.tsx` keeps the text and picked files in local `useState`. Leave the channel, get a call, or have the app killed in the background and the half-typed message is gone. Persist a draft per channel (the store already keys everything else by channel id).

### 25. No feedback layer
There is no toast or snackbar anywhere in `src`. Consequences:
- Copy Text / Copy Link / Copy ID in the message sheet close silently. The channel sheet at least buzzes; the message sheet does not.
- Success and failure both use blocking `Alert.alert` ("Saved to your photos", "Could not edit the message").
- Failures like camera permission denied surface as red text inside the composer ("Allow camera access in Settings to take photos.") with no button that opens Settings.

Add one toast component and route copies, saves and soft errors through it.

### 26. Destructive actions with no confirm
Deleting a message and removing a friend ask first. These do not:
- **Log out** (`settings/index.tsx`): one tap on a row at the bottom of a list.
- **Remove device** (`settings/devices.tsx`): signs another device out immediately.
- **Close Direct Message** (`dm-sidebar.tsx`): in a sheet with no title, so it does not even say which DM.
- **Leave call** (`voice-area.tsx`): see #28.
- **Only Owner Can Send** (`channel-sidebar.tsx`): locks a channel for everyone in one tap.
- Decline / cancel friend request (`friends-home.tsx`): fine without a confirm, but there is no undo either.

### 27. Editing happens inside the scrolling list
`EditBox` in `message.tsx` replaces the message text with an autofocused textarea plus Save and Cancel buttons, inside an inverted `FlatList`. On a phone the keyboard then covers half the list and the row being edited can end up under it. Phone chat apps move the text into the composer with an "Editing" bar, the same way the reply bar already works here. Reuse that.

### 28. Call controls are the smallest buttons in the app
`voice-area.tsx`: up to nine controls at `size-10` (35dp with the current rem) with 14px icons and 6dp gaps, in a pill that wraps to a second row when it runs out of width.
- The red Leave button is the same size as the rest and sits 6dp from its neighbour. A missed tap hangs up, with no confirm.
- Controls fade out after a few idle seconds, including in an audio-only call where there is no video to uncover. Muting then takes two taps: one to wake, one to mute. Only auto-hide while video or a screen share is on stage.
- Mute and Leave should be 56dp and separated from the secondary controls (camera flip, output, stream volume), which can live in an overflow.
- The expand/minimize button is absolutely positioned at the right edge on the same line as the pill, so it collides with a wide or wrapped control row.
- The call resize handle (`chat-area.tsx`) is a 24dp-tall strip with a 4dp bar.

### 29. The voice channel lobby tells you nothing
Before joining: "Join voice / Connect when you are ready." and a button. It does not list who is already in the channel, though the channel list underneath does. Show the participants and whether you will join muted.

### 30. Composer
- No emoji button. Emoji only exist if you know to type `:name`.
- Mention and emoji suggestions are a single 44-unit-high horizontal strip with 10-12px text; with similar names you scroll sideways through chips. A short vertical list above the composer (like the slash-command list already is) reads better.
- One oversized file rejects the whole batch you picked (`addFiles`), instead of adding the ones that fit.
- The attach sheet stays open behind the system picker until it returns.
- The character counter only appears in the last 200 characters, which is good. Keep it.

### 31. Chat list
- Jump-to-latest is a bare chevron (`chat-area.tsx`). It does not say that new messages arrived while you were scrolled up, or how many.
- The channel topic is one truncated line in the header with no way to read the rest.
- In a DM, the header avatar and name are not tappable, so there is no obvious route to the other person's profile.
- `(edited 14 Nov 2026 at 00:39)` is appended in full after the message text. "(edited)" with the time in the long-press sheet is enough.
- Tapping a non-PDF file calls `Linking.openURL`, which throws you into the browser to download it.
- In a multi-attachment message, file tiles are half-width with a one-line 12px filename, so most names are cut to a dozen characters.
- The reply preview that jumps to the original is a 20-unit-high tap target.
- The "New" unread divider and the mention badges use the destructive red. Red should mean danger or error, not "unread".

### 32. Channel list
- Collapsed categories are local state (`channel-sidebar.tsx`), so they reopen every time the screen remounts.
- "Edit Channel" is shown in the long-press sheet to everyone; only Move and the owner-only toggle are behind `canManageChannels`. Either the dialog is read-only for members or it lets them try and fail. Hide it.
- "Create Channel" from the server sheet always targets the first category.
- Members without manage rights get a header with one full-width "Notifications" button, which is a lot of chrome for one setting.

### 33. Auth
- Login has no show-password toggle; Register and Reset password both have one.
- First field on the login screen is "Home server". Correct for a federated app, but a new user does not know what to put there. Keep the default prefilled and collapse it behind "Sign in to a different server".
- MFA copy says "Click that fancy button below". Nobody clicks on a phone, and the tone does not match the rest of the app.
- Errors render below the submit button, where the keyboard is.
- Adding a friend only accepts a full `@name:server` handle (`friends-home.tsx`). No QR code, no share-my-handle, no search by name.

### 34. Sheets as a pattern
- Sheet items are inconsistent: some have icons, some do not ("Notification Settings" has a bell in one sheet and nothing in two others).
- Several sheets have no title, so after a long-press you rely on memory for what you pressed (DM actions).
- Sheet-to-sheet transitions (actions, then notification settings) close one sheet and open another instead of pushing inside the same sheet.

## Corrections to my first pass

Reading the code showed three things I had wrong after the phone session; they are fixed in the sections above:
- Swipe left on a message does reply. My test swipe actually triggered it.
- The server rail does have unread pills and mention badges.
- The DM list does have an online dot, and the image viewer does have swipe-down to dismiss.

## Suggested order

1. Sheet back handling (#1) and accessibility labels/tree (#2). Small, isolated.
2. `inlineRem: 16` and the tap target pass (#3), then the call controls (#28). Biggest win per line changed, but it moves every layout, so it needs a visual pass over each screen.
3. Confirms for log out, remove device, close DM (#26); a toast component (#25); per-channel drafts (#24).
4. DM row preview and relative time (#9), server rail fixes (#10).
5. Bottom tab bar and removal of the desktop user bar (#4, #5), then collapse duplicate server actions (#6).
6. Edit in the composer (#27), swipe discoverability (#8), composer and chat list items (#30, #31).
7. One header and one surface/shape rule (#13, #14), wording (#15), sheet consistency (#34).
8. Search (#7).
9. Reactions (#17) need backend work in Anchor first, so plan that separately.
10. Remaining polish (#11, #12, #16, #18 to #23, #29, #32, #33).

Web parity: items 9 to 12, 15, 17, 24 and 26 likely apply to `apps/frontend` as well; the rest are native-only.
