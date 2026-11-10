# bot-demo

A small Novarum bot built with [`@novarum/sdk`](../apps/sdk). It shows off what bots can do:

| Command    | Shows                                                   |
| ---------- | ------------------------------------------------------- |
| `/ping`    | deferred replies, editing the reply, ephemeral messages |
| `/roll`    | integer options with limits, embeds                     |
| `/poll`    | buttons that update the message they're on              |
| `/weather` | autocomplete, embed fields, colours and timestamps      |
| `/whois`   | user options                                            |
| `/remind`  | ephemeral follow-ups sent later                         |
| `/coin`    | interaction buttons next to a link button               |
| `!hello`   | reading and replying to plain messages                  |

It also says hello in a guild's first text channel when it is added.

## Run it

1. Start Novarum (`bun run dev` from the repo root) and sign in.
2. Open **Developers** under Friends, make a bot and copy its token.
3. `cp .env.example .env` and paste the token into `BOT_TOKEN`.
4. `bun run --filter bot-demo start` (or `bun start` in this folder).
5. In the developer panel, open **Add to a guild** and add the bot to one of your guilds.

Then type `/` in a channel of that guild.
