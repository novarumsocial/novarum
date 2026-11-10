# @novarum/sdk

Build bots for [Novarum](https://novarum.me). If you've written a discord.js bot, this will feel familiar:
a `Client` with events, slash commands, embeds and buttons.

```sh
bun add @novarum/sdk   # or npm install @novarum/sdk
```

```ts
import { Client, EmbedBuilder, SlashCommandBuilder } from '@novarum/sdk';

const client = new Client({
  token: process.env.BOT_TOKEN!, // from the developer panel
  baseUrl: 'https://anchor.example.com', // the homeserver your bot lives on
});

client.on('ready', async () => {
  await client.commands.set([new SlashCommandBuilder().setName('ping').setDescription('Pong!')]);
  console.log(`Logged in as ${client.user!.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content === '!hello') {
    await message.reply({ embeds: [new EmbedBuilder().setTitle('Hello!').setColor('#5865f2')] });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isCommand() && interaction.commandName === 'ping') {
    await interaction.reply({ content: 'Pong!', ephemeral: true });
  }
});

await client.login();
```

Works on Bun and Node.js 20+. The full guide lives in the [Novarum docs](https://novarum.me/bots/getting-started/).

## Development

```sh
bun run --filter @novarum/sdk check     # typecheck
bun run --filter @novarum/sdk test      # unit tests
bun run --filter @novarum/sdk test:e2e  # against a real Anchor (needs `bun run --filter anchor test:infra`)
bun run --filter @novarum/sdk build     # dist/
```
