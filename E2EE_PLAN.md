# End-to-end encryption plan

## What this is about

Today a homeserver can read everything: message text sits in `message.content`, attachments sit
in Garage as plain files, push notifications carry a snippet, canvases are merged by the server,
and voice goes through LiveKit with transport encryption only.

This plan makes the content of conversations readable only by the devices of the people in them.
The homeserver (yours, and the other side's when federated) keeps doing its job of storing,
ordering and delivering, but on ciphertext.

Covered: messages, edits, attachments, push previews, voice/video/screen share, canvases, across
web, Electron, native, and federation.

## Decisions

These are the choices the rest of the plan is built on. 1 to 4 are confirmed (2026-11-09); 5 to 7
are still recommendations the plan assumes.

| # | Decision | Choice |
|---|----------|--------|
| 1 | Which conversations are encrypted | DMs, group DMs and their calls: always. Guild channels: not in this plan, see [Later: guild channels](#later-guild-channels). |
| 2 | Key agreement | Per-channel epoch keys wrapped to each device (the Keybase teams model), not MLS. See [Why not MLS](#why-not-mls). |
| 3 | Account recovery | A generated recovery key shown once at setup. No passphrase, and never the login password (Anchor sees it at login). |
| 4 | Existing plaintext DM history | Stays as it is, marked "sent before encryption". New messages are encrypted. A "delete old plaintext" action can come later. |
| 5 | DMs with a homeserver that has no E2EE yet | Stay unencrypted with a visible open-lock, and upgrade one way as soon as both sides support it. |
| 6 | Bots | Cannot read encrypted channels in v1 (they already cannot open DMs). |
| 7 | `apps/mobile` (Capacitor wrapper) | Gets E2EE for free through the web frontend, but generic push text only. |
| 8 | Size limit for encrypted guild channels | 1,000 members (confirmed), applies when guild channels are done. |

## What stays visible to homeservers

E2EE hides content, not activity. Written down so nobody is surprised later:

- who is in which guild, channel and DM, and who is friends with whom
- who sent a message, when, in which channel, how big it is, and what it replies to
- who a message mentions (needed for pings, unread badges and push)
- attachment sizes and counts
- profiles, guild and channel names, presence, typing, read states
- who is in a voice call and when

A malicious homeserver also controls membership lists, so it can add a user to a group DM.
Clients cannot prevent that, only make it visible (the member shows up in the member list and a
"keys shared with X" line). For 1:1 DMs the client pins the two participants itself and refuses
to share keys with anyone else.

The web frontend is a trust root too: whoever serves the JS can serve bad JS. Electron and native
builds are the stronger option, and the frontend host is already separate from the homeserver.

## Design

### Keys

```
recovery key (32 random bytes, shown once, user stores it)
 ├─ HKDF → identity key      Ed25519   signs the user's devices
 └─ HKDF → recovery device   X25519    receives a copy of every channel key

per device (= per session), generated on that device, never leaves it
 ├─ signing key              Ed25519   signs messages
 └─ encryption key           X25519    channel keys are wrapped to this

per encrypted channel
 └─ epoch key N              32 bytes  encrypts everything in the channel during epoch N
     ├─ message key          HKDF(epoch key, "msg")
     ├─ voice key            HKDF(epoch key, "voice")
     └─ canvas key           HKDF(epoch key, "canvas")
```

- **Device = session.** The `session` table already is the list of logged-in devices, and push
  subscriptions already hang off it. Logging out deletes the device.
- **Verified device** = its public keys are signed by the identity key. Only verified devices are
  given channel keys. A device becomes verified by typing the recovery key, or by being approved
  from an already verified device (QR code or short code), which hands it the recovery key
  encrypted to its device key.
- **The server stores no private key material at all.** Not even an encrypted backup: the recovery
  device is a public key, and channel keys wrapped to it are the backup. A new device that knows
  the recovery key unwraps them and re-wraps them to itself, so history works with no other device
  online.
- **Trusting other users** is trust-on-first-use: the first identity key seen for a user is pinned
  on the device. If it ever changes, the conversation shows a warning until the user accepts it.
  Users can compare a safety number (hash of both identity keys) to rule out a swapped key.
- **Losing the recovery key and every device** means old encrypted history is gone and the
  identity is reset (contacts see the "key changed" warning). Password reset does not touch keys.

### Epochs

An encrypted channel has an epoch counter. Each epoch has one random key.

- **New epoch** when someone leaves or is removed, a device is removed, an identity is reset, or
  the current epoch is older than 7 days. The next device that wants to send does it: generates
  the key, wraps it for every verified device of every member plus each member's recovery device,
  and uploads the wraps.
- **Races** are settled by the channel's host homeserver: the upload only succeeds if
  `epoch = current + 1`. The loser fetches the winner's key and encrypts with that.
- **New member or new device** needs no new epoch. Before sending, a client asks the host which
  devices lack the current key and uploads wraps for them.
- A device with no key for a message shows "Waiting for keys" and the host pings online members
  (`e2ee.keys.needed`) to share them.

This gives forward secrecy and recovery from a compromised device at epoch granularity, not per
message. That is the trade for readable history on new devices, and it is the same one Matrix
makes once key backup is on.

### Message format

`message.content` stays for unencrypted channels. Encrypted messages have `content = null` and an
envelope:

```
{ v: 1, epoch, deviceId, nonce, ciphertext, signature }
```

- Ciphertext: XChaCha20-Poly1305 over the JSON payload
  `{ content, attachments: [{ id, key, hash, filename, contentType, size, width, height, thumb }] }`.
- Additional data binds the envelope to `channelId`, `authorId`, the client message `nonce` and
  `epoch`, so a server cannot move it to another channel, author or message.
- Signature: the sending device's Ed25519 key over the whole envelope. Clients check that the
  device belongs to `authorId` and is signed by that user's pinned identity key.
- Edits are a new envelope for the same message `nonce`; clients accept one only from a device of
  the original author.
- Sent in the clear next to it: `replyTo`, `attachmentIds`, `mentions: userId[]` and
  `mentionsEveryone`. The server can no longer read `@handles` out of the content, so the client
  states them and the server checks they are members.
- `v` is the escape hatch: a different key agreement or cipher later is a new version, not a new
  message table.

### Attachments

The client makes a random file key, encrypts the file in 64 KiB chunks, and uploads it through the
existing presign flow as `application/octet-stream` with a random filename. The real name, type,
dimensions, key and SHA-256 live inside the encrypted message payload.

Server-side this turns off image-size sniffing and `/attachment/:id/preview` for these files. The
client makes the thumbnail instead: a tiny thumbhash inline for the placeholder, and an encrypted
thumbnail uploaded as its own object. v1 downloads and decrypts a file fully before showing it;
streaming large encrypted video is a later improvement (the chunked format allows it).

### Push

The server cannot build a snippet. v1 sends "Sent you a message" / "Mentioned you" for encrypted
channels, which is what `messagePreview: false` already does. v2 puts the envelope in the push
(when it fits Web Push's 4 KB) and decrypts in the service worker and the native push handler.

### Voice

LiveKit's built-in E2EE (frame encryption with an external key provider), keyed with the channel's
voice key and re-keyed on every new epoch. DM calls use the DM's keys. LiveKit still sees who is
in the room and who is talking.

### Canvases

Anchor merges Yjs updates itself today (`utils/canvas.ts`), which it cannot do with ciphertext.
For encrypted channels it becomes a relay: it appends encrypted updates to a log and broadcasts
them; clients fold the log into an encrypted snapshot now and then (accepted only if the log
position matches). `ownerOnly` write checks stay on the server. Awareness is encrypted too.

### Federation

The host of a channel is already the authority for it, and other homeservers proxy to it with
`callRemote`. E2EE keeps that shape: the host stores the wraps and orders the epochs.

- New feature flag `e2ee` in `utils/federationFeatures.ts`. Nothing encrypted is sent to a
  homeserver that does not list it.
- A homeserver serves its users' identity key and device list to other homeservers, and announces
  changes over the realtime bridge. The receiving side caches them.
- Key wraps, epoch changes and envelopes travel through the existing channel proxy routes and
  bridge events.
- A remote homeserver is no more trusted than a local one: clients verify every device signature
  themselves, so a hostile server can withhold or reorder but not read or forge.

### Why not MLS

MLS (RFC 9420) is the standard answer and scales better: a key change costs O(log n) instead of
one wrap per device. It was not picked because:

- it needs one implementation that runs in browsers, Bun tests and Hermes (no WASM on Hermes), and
  the JavaScript options are young;
- MLS deliberately gives new devices no history, so history would need a second mechanism on top
  anyway;
- the server side (key packages, welcomes, commit ordering across federation) is a lot more
  moving parts than "upload wraps, compare-and-set the epoch".

Wrapping is fine for DMs, group DMs and channels up to about a thousand members. If encrypted
guild channels ever need more, MLS can replace the key agreement behind envelope `v: 2` without
touching storage, attachments, push or voice.

### Libraries

One shared workspace, `apps/e2ee`, holds the whole protocol as pure functions and is used by the
frontend, the native app and Anchor's tests. Anchor itself never imports the crypto, only the Zod
schemas for envelopes and wraps.

- Primitives: `@noble/curves`, `@noble/ciphers`, `@noble/hashes` (audited, pure JS, same code
  everywhere).
- Key storage: IndexedDB on web, wrapped with Electron `safeStorage` on desktop, `expo-secure-store`
  plus encrypted MMKV on native.
- Voice: `livekit-client` E2EE and its React Native counterpart.

## Milestones

Each milestone is one or more commits, leaves `main` shippable, and follows the checklist in
`AGENTS.md` (tests, authz matrix, schemas, migration tests, native parity, format). Everything is
behind `e2ee.enabled` in `config.toml` until milestone 10.

### 0. Spike (no production code)

Answer the questions the design depends on, in throwaway code:

- noble on Hermes: correctness, speed of chunked encryption on a 50 MB file, and a secure
  `getRandomValues`. If too slow, attachments get a native cipher behind the same interface.
- LiveKit E2EE on `@livekit/react-native`, and web in Firefox and Safari. Check current docs
  through Context7.
- Whether the native push handler can run JS to decrypt in the background.
- IndexedDB access from the service worker for push decryption.

Outcome: this file updated with what was found.

### 1. `apps/e2ee`: the protocol package

- Key derivation from the recovery key, device key generation, device signing and verification.
- Wrap/unwrap an epoch key, envelope seal/open, chunked file encryption, safety numbers.
- Zod schemas for every wire shape.
- Tests with fixed test vectors, tamper tests for every field of the envelope and additional
  data, and wrong-key, wrong-epoch and wrong-author cases.

### 2. Anchor: identities and devices

- Schema: `user_identity` (identity key, recovery device key), `device` (session, signing key,
  encryption key, identity signature, name, last seen). Device rows cascade from `session`.
- Routes under `/e2ee`: set up identity, register this device, list own devices, upload a device
  signature, remove a device, fetch keys for a list of users, reset identity.
- Realtime: `device.added`, `device.removed`, `identity.changed` to the user and to everyone
  sharing a channel with them.
- Verification hand-off: a short-lived relay for the encrypted recovery key between two devices
  of the same user.
- Tests: integration for each route, authz matrix and openapi-auth entries, fuzz, rate limits on
  key uploads and key lookups, migration test.

### 3. Clients: setup, recovery, verification

- `e2ee` store on web (`e2ee.svelte.ts`) and native (`e2ee.ts`) with the same method names.
- First-run setup: generate the recovery key, make the user save it, register the device.
- New login: enter the recovery key, or approve from another device (QR / short code).
- Settings: device list with verified state, remove device, show recovery key, reset identity.
- Logout wipes local keys.

### 4. Anchor: encrypted channels and messages

- Schema: `channel.encrypted`, `channel.encryptionEpoch`, `message.envelope`, `channel_key`
  (channel, epoch, recipient device, sender device, wrapped key).
- Routes: upload an epoch (compare-and-set), upload wraps for missing devices, fetch own wraps,
  list which devices lack the current key.
- `/message/send` and `/message/edit` accept an envelope with `mentions`; reject plaintext in an
  encrypted channel and envelopes in a plain one; nonce replay compares the envelope.
- Realtime: `e2ee.epoch.changed`, `e2ee.keys.available`, `e2ee.keys.needed`.
- `notify.ts`: no snippet for encrypted channels.
- New DMs are created encrypted.
- Tests: all of the above, plus a leak test that sends a marker string in an encrypted DM and
  greps the database, object storage, push payloads and realtime frames for it.

### 5. Clients: encrypted DMs on one homeserver

- `chat.sendMessage`, edit, list and realtime paths seal and open envelopes; epoch rotation and
  key sharing before send; "Waiting for keys" state.
- Local message cache for decrypted text, and client-side mention detection from `mentions`.
- UI: lock in the DM header, pre-encryption history marker, identity-changed warning, safety
  number screen.
- Web and native together. First milestone a user can feel.

### 6. Federation

- `e2ee` feature flag; `federatedMessageSchema` and the proxied send/edit/list routes carry
  envelopes.
- Federated key directory route and bridge events for device and identity changes.
- Channel key routes proxied to the host through `federationChannelPath`.
- `/federation/push` sends no snippet for encrypted channels.
- Fallback and one-way upgrade for peers without the feature.
- Tests in `test/federation`: happy path across two homeservers, three-way group, old-peer
  fallback, and hostile cases: injected device without a valid signature, swapped identity key,
  replayed old wraps, withheld keys, envelope moved between channels.

### 7. Attachments

- Client encrypt/upload and download/decrypt, thumbnails and thumbhash, viewer and players
  reading decrypted blobs.
- Anchor: skip size sniffing and previews for encrypted channels, check ciphertext size, reject
  typed uploads in encrypted channels.
- Tests: extend `uploads.test.ts` and `upload-abuse.test.ts`; federated presign path.

### 8. Push previews

- Envelope in the push payload when it fits; decrypt in `service-worker.ts` and the native push
  handler; generic text otherwise.
- Depends on the spike. If background decryption is not possible on a platform, it keeps the
  generic text and this is noted in the settings UI.

### 9. Voice

- Derive the voice key, enable LiveKit E2EE in `voice.svelte.ts` and native `voice.ts`, re-key on
  epoch change, show the lock in the call UI, refuse to join an encrypted call without keys.
- Noise suppression runs before encoding, so it is unaffected.

### 10. Canvases, group DMs, and turning it on

- Encrypted canvas relay and client-side snapshots for DM canvases.
- Group DMs encrypted from the start when they are built (the schema allows them, no routes yet),
  with "keys shared with X" lines when someone is added.
- Remove the config flag, write the user-facing explanation and the threat model in the docs.
- Get an outside review of `apps/e2ee` and the protocol before dropping any "beta" label.

## Later: guild channels

Not part of the milestones above. Guild text and voice channels stay unencrypted until this is
picked up, and the UI says so (no lock on guild channels).

**Private channels come first.** Guild channels have no member list of their own today:
`canAccessChannel` lets every guild member into every channel. Encrypting such a channel hides it
from the server operator but not from anyone who joins the guild, and any size limit would have
to freeze the whole guild. So the prerequisite is a separate feature: guild channels with their
own member list in `channel_member`, like DMs have, with the access checks and the UI to add and
remove people.

Once that exists, encrypting a private channel reuses everything built for DMs:

- An "encrypted" option when creating a private channel, one way, cannot be turned off.
- **Member cap of 1,000** per encrypted channel (`e2ee.max_channel_members` in `config.toml`).
  Every new epoch costs one wrap per device, paid by whoever sends next, and big channels change
  members all the time. The host homeserver checks it when a member is added, including over
  federation, with tests for the boundary and for two adds racing at 999. The guild itself can be
  any size.
- History for new members: whoever shares the current key also shares the earlier epoch keys they
  hold, so a new member can read back like they can today.
- Voice channels: the same LiveKit E2EE as DM calls, keyed from the channel's epoch key.
- Canvases: the same encrypted relay as DM canvases.
- The cap goes away if MLS replaces the key agreement.

## Things that get harder afterwards

- **Search**: there is no message search yet; when it comes, it has to be a client-side index
  for encrypted channels.
- **Link previews and embeds**: must be generated by the sender's client, never the server.
- **Moderation**: reports have to include the decrypted message, sent by the reporter.
- **Bots and the SDK**: a bot would need to be a device with keys.
- **Data export / account migration** between homeservers: ciphertext moves, keys come from the
  recovery key.
