# Federation refactor plan

## Status

Implemented: everything in Parts 1 and 2, and 3.0, 3.1 and 3.2 of Part 3.

Left out on purpose (the plan said "measure first"): 3.3, i.e. combining typing updates (it changes timing)
and moving the old-nonce cleanup out of the request path.

Where the code differs from the plan:

- The shared message writes (1.7) live in `modules/message/store.ts` (`createMessage`, `editMessage`,
  `deleteMessage`, `pingedUserIds`). The response bodies of local and federated messages are still built by
  their own routes.
- The three "user went online or offline" routes sit together in `modules/federation/routes/status.ts`.
- The `federated` / `federatedUser` macro does not need `parse: 'none'`: Elysia only parses a body that a
  handler asks for.
- Two small behaviour differences, both only in failure cases:
  - Sending a local message now fails (500) if one of its attachments was claimed by another message in the
    meantime. The old code had that check, but it could never fire.
  - A database error while storing a nonce is now a 500 instead of being reported as "nonce already used".

## What this is about

Federation is how two Anchor servers talk to each other. When someone on `a.test` chats in a guild hosted on
`b.test`, `a.test` sends signed requests to `b.test`, and `b.test` streams live events back over a WebSocket.

Most of that code lives in one file, `modules/federation/services.ts`, which is almost 1,900 lines long. It works, but:

- Every route starts with the same copy-pasted block to check the signature and the sender's user.
- Request bodies are checked by hand (`typeof x === 'string'`) instead of with Zod.
- Two WebSocket endpoints are near-identical copies.
- Some routes load far more from the database than they need.
- We open one WebSocket per remote guild and one per remote DM, even when they all go to the same server.

This plan cleans that up in small, safe steps.

## Ground rules

Every step has to follow these:

1. **Other servers must not notice.** Same URLs, same status codes, same error messages, same response shapes. An old
   server must keep working with a new one, and the other way round.
2. **Security stays exactly as strict.** All current checks stay: the signature and body hash, the timestamp window,
   the replay guard (each request ID can only be used once), "is this user really from the server that sent the
   request", and guild/DM access checks.
3. **Small PRs.** Each step is its own PR and passes:
   `bun run --filter anchor check`, `test:unit`, `test:integration` and the full `test:fed` suite.

The work is split into three parts:

| Part | What it does | Changes how servers talk? |
| --- | --- | --- |
| 1. Clean up the code | Split the big file, remove the repeated code | No |
| 2. Fewer database queries | Ask the database only for what we need | No |
| 3. Fewer connections and requests | Share one socket per server, batch status updates | Yes, but only between servers that both support it |

---

## Part 1: Clean up the code

Nothing in this part changes behaviour. It only moves code around and removes repetition.

### 1.1 Split the big file

Break `services.ts` into small files, grouped by topic:

```
modules/federation/
  index.ts        puts all the routes together under /federation
  verify.ts       signature checking (moved as-is)
  plugin.ts       the shared "check this request" step (see 1.2)
  access.ts       "can this user see this channel/guild?" helpers
  schemas.ts      Zod schemas for request and response bodies
  routes/
    users.ts      look up a user
    friends.ts    friend requests, friend sync, friend status
    invites.ts    look at and accept invites
    messages.ts   list, send, edit and delete messages, upload attachments
    channels.ts   member list, typing, voice calls, ringing
    guilds.ts     guild status updates, unread mentions
    dms.ts        open DMs, DM notifications, latest DM messages
    push.ts       push notifications, plus the "max pushes per minute" limit
    realtime.ts   the WebSocket endpoints
```

Each file is short enough to read in one go, and you can find a route by its name.

### 1.2 Write the "check this request" step once

Almost every route starts with the same 7 lines:

```ts
const parsed = await verifiedFederationJsonBody(request);
if (!parsed.ok) return status(parsed.status, { error: parsed.error });
const userPayload = parseFederationUserPayload(getObjectProperty(parsed.body, 'user'));
if (!userPayload) return status(400, { error: 'Invalid federation user' });
if (userPayload.homeserver.toLowerCase() !== parsed.origin.homeserver) {
  return status(401, { error: 'Federation user homeserver mismatch' });
}
```

This block is copied about 20 times. Instead, we add one Elysia **macro** (a reusable option for a route). A route
just says it is a federation route, and gets the checked values handed to it:

```ts
.post('/channels/:id/typing', ({ origin, body, remoteUser }) => { ... }, {
  federated: 'user',   // check the signature AND the `user` field
  parse: 'none',       // keep the raw body so we check the signature against the exact bytes we received
})
```

- `federated: true` checks the signature only (for the friends, push and DM-notify routes).
- `federated: 'user'` also checks the `user` field, with exactly the same error messages as today.
- If a check fails, the route never runs and the same error is returned.

The error responses that every route shares (`400`, `401`) also go into one shared object, so each route only lists
its own special cases.

### 1.3 Check request bodies with Zod

Today bodies are checked by hand, with helpers like `getObjectProperty` and lots of `typeof` checks. The repo's own
style guide (`AGENTS.md`) asks for Zod instead. For example, sending a message becomes:

```ts
const sendBody = z.object({
  content: z.string().nullable(),
  nonce: z.string(),
  replyTo: z.string().nullish(),
});
```

One thing to watch: some routes return **different error messages for different fields**. For example, sending a
message says `Invalid federation message` for bad text but `Invalid attachment IDs` for bad attachments. Those keep
separate schemas so the messages don't change. Before merging, we compare every error message in the old and new code
to make sure none changed.

### 1.4 Merge the two WebSocket endpoints

`/realtime/dms/:id` and `/realtime/guilds/:id` are the same code twice. The only differences are which table they
check, which topic they subscribe to, and which voice snapshot they send. One function builds both:

```ts
.ws('/realtime/dms/:id', federationSocket('dms'))
.ws('/realtime/guilds/:id', federationSocket('guilds'))
```

### 1.5 Small tidy-ups

- Replace `any` in `federatedMessageResponse` with real types, so mistakes show up when type-checking.
- Add a tiny `requireVoiceChannel` helper for the repeated "is this a voice channel or DM?" check.
- Add a `guildResponse` helper for the guild info that both invite routes build by hand.
- Delete the old "I really have to refactor this" TODO comments once they are done.

### 1.6 Same idea for the outgoing side

When **we** call another server, about 12 places in other modules repeat the same steps: send the request, return 502
if it fails, pass on some error codes, check the response with Zod. One helper does all of that:

```ts
const result = await callFederatedChannel(channelId, 'messages/send', body, responseSchema);
```

It also builds the `/federation/channels/<id>/...` URL, which is currently written out by hand 12 times.

### 1.7 Share the message code with the local path

Sending, editing and deleting a message is written twice: once for local users (`modules/message`) and once for users
from other servers (federation). Both do the same things: avoid duplicates, attach uploads, record mentions, reopen
closed DMs and send notifications.

We move that into shared functions (`createMessage`, `editMessage`, `deleteMessage`) used by both paths. This one
touches another module, so it comes **last** in Part 1. First we compare the two versions line by line. Anything
that really differs becomes an explicit option, so nothing changes by accident.

---

## Part 2: Fewer database queries

Still no change in what other servers see. We just stop asking the database for things we don't need.

| Where | What happens today | What we change | Why it's safe |
| --- | --- | --- | --- |
| Replay check on every request | 3 queries: "seen it?", then "seen it?" again, then save | Keep the first quick check; save with a single "insert unless it already exists" | The database already has a unique rule on these IDs, so the insert alone blocks replays. 3 queries become 2 |
| Every channel request (even typing) | Rewrites the remote user's profile every time | Only write when the name/avatar actually changed | The stored profile ends up the same. Only `updatedAt` stops changing on no-op requests, so we first check nothing uses it as "last seen" |
| Channel access check | Loads the channel, then the user, one after the other | Load both at the same time | They don't depend on each other |
| `/unread-mentions` | Loads **every mention the user has ever had**, then filters in code | Ask the database only for mentions in the requested channels | Same mentions get counted. We keep the "after the last read message" comparison in code, because the database stores time more precisely than JavaScript |
| Invite preview | Loads every member just to count them | Ask the database for the count | Same number |
| `/push` | Loads every member of the guild | Load only the users we are trying to notify | Same result |
| WebSocket access check | Loads every member and their user to check one thing | Ask the database "is there any member from this server?" | Same check |

Each row is its own small commit, so any one of them is easy to revert.

---

## Part 3: Fewer connections and requests

These are the bigger wins, but they need **new endpoints**. To keep old servers working:

- Servers tell each other what they support (see 3.0).
- We only use a new endpoint if the other server says it supports it. Otherwise we do exactly what we do today.
- The old endpoints stay.

### 3.0 Servers say what they support

Add a `features` list to `/.well-known/anchor/info`, for example `features: ['realtime-mux', 'status-batch']`. Older
servers ignore fields they don't know, so this is safe to add.

### 3.1 One live connection per server, not one per guild or DM

**Today:** for every guild or DM hosted on another server, we open a separate WebSocket to that server. If you have
30 DMs and 5 guilds with people on `b.test`, that is **35 sockets** to the same server. Each one does its own signed
login, its own database checks on `b.test`, and has its own reconnect timer. After a restart, we reopen all of them
at once.

**After:** one WebSocket per server (`/federation/realtime`). Over that single connection we say which guilds and DMs
we want:

1. **Connect.** The login is signed exactly like today.
2. **Subscribe.** We send `{ type: 'subscribe', guilds: [...], dms: [...] }`, and send it again when a new guild or
   DM shows up.
3. **Access check per item.** The other server checks each guild/DM with **the same access check as today**. If one
   is refused, it says so (`{ type: 'refused', id }`) and we drop just that one, like a refused connection today.
4. **Events are labelled.** Each event comes wrapped as `{ kind, id, event }`, so we know which guild or DM it belongs
   to. This is needed because some events (like `user.status.changed`) don't say which guild they're for.

**On the sending side**, events are only wrapped and sent if another server is actually listening. Servers with no
remote listeners do no extra work.

**On the receiving side**, the existing `ensureFederatedGuildRealtimeBridge` and `ensureFederatedDmRealtimeBridge`
functions keep the same names and inputs. They now add the guild/DM to the shared connection instead of opening a new
one, so callers don't need to change. If the connection drops, everyone on it is shown as "left voice" like today,
and the reconnect resubscribes everything at once.

**Security:**
- Every guild and DM is still checked one by one. Being connected doesn't give access to anything extra.
- Limit how many guilds/DMs can be subscribed per message and per connection, and check messages with Zod.
- One gap exists today: if a server loses access to a guild, it keeps getting events until it reconnects. The new
  connection behaves the same way, so nothing gets worse. Fixing it changes behaviour, so it gets its own PR.

**New tests:** new server ↔ new server, new ↔ old in both directions, one refusal doesn't affect the rest, a restart
resubscribes everything, and voice presence is cleaned up when the connection drops. The existing bridge tests must
still pass unchanged.

### 3.2 One status update per server, not one per guild

**Today:** when you come online or go offline, we send one request to each other server for your friends, **plus one
per guild** hosted there. Being in 8 guilds on `b.test` means 9 requests to `b.test` every time you connect or
disconnect.

**After:** one request per server, `POST /federation/users/status`, with `{ user, status, guildIds }`. The other server
runs the existing friend logic once and the existing guild logic for each guild, still checking membership in each.
Guilds you're not in get skipped, like today's individual requests fail.

### 3.3 Maybe later (measure first)

- **Typing:** we send one signed request per "is typing" update. If the app sends these very often, we could skip
  repeats within a few seconds. That changes timing, so only do it if the numbers show it matters.
- **Old replay records:** expired replay records are currently cleaned up during normal requests. Move this into a
  background timer like the other cleanup jobs, so requests don't wait on it.

---

## Order of work

1. Split the file, add the shared check, merge the WebSocket endpoints (1.1, 1.2, 1.4). This is the biggest
   readability win.
2. Zod schemas and tidy-ups (1.3, 1.5).
3. Database query improvements (Part 2), one commit each.
4. The outgoing helper, then the shared message code (1.6, 1.7). These touch other modules, so they come later.
5. Feature flags and the shared connection (3.0, 3.1), then batched status (3.2).

**Testing for every PR:** `check`, `test:unit`, `test:integration` and the full `test:fed` suite. For Part 3, also run
the long-running soak tests (`FED_SUITE=soak`) before and after, to check that the number of sockets and requests
actually went down.
