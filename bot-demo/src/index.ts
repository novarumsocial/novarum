import { Client, EmbedBuilder } from '@novarum/sdk';
import { commands, onButton } from './commands.ts';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error(
    'Set BOT_TOKEN (copy .env.example to .env). Get one in Novarum: Developers -> your bot -> Token.'
  );
  process.exit(1);
}

const client = new Client({ token, baseUrl: process.env.ANCHOR_URL ?? 'http://localhost:5049' });

client.on('ready', async () => {
  await client.commands.set(commands.map((command) => command.data));
  console.log(`Logged in as ${client.user!.tag} in ${client.guilds.size} guild(s)`);
  console.log(`Registered /${commands.map((c) => c.data.toJSON().name).join(', /')}`);
});

client.on('guildCreate', (guild) => {
  console.log(`Added to ${guild.name}`);
  const channel = [...guild.channels.values()].find((c) => c.isText());
  void channel?.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Hi ${guild.name}! 👋`)
        .setDescription("I'm a demo bot. Type `/` to see my commands, or say `!hello`.")
        .setColor('#7c9cff'),
    ],
  });
});

// a prefix command, the old-school way
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() === '!hello') {
    await message.reply(`Hello, ${message.author.displayName}! Try \`/poll\` or \`/weather\`.`);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) return await onButton(interaction);
    const command = commands.find((c) => c.data.toJSON().name === interaction.commandName);
    if (interaction.isAutocomplete()) return await command?.autocomplete?.(interaction);
    if (interaction.isCommand() && command) await command.run(interaction);
  } catch (error) {
    console.error(error);
  }
});

client.on('error', (error) => console.error('client error:', error.message));
client.on('disconnect', (code, reason) =>
  console.log(`disconnected (${code}) ${reason}, reconnecting…`)
);

await client.login();
