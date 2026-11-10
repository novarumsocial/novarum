import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
} from '@novarum/sdk';

type Command = {
  data: SlashCommandBuilder;
  run: (interaction: CommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
};

const brand = '#7c9cff';

// ---- polls: buttons that update the message they are on ----------------------------------------

type Poll = { question: string; options: string[]; votes: Map<string, number> };
const polls = new Map<string, Poll>();

function pollMessage(id: string, poll: Poll, closed = false) {
  const total = poll.votes.size;
  const counts = poll.options.map((_, i) => [...poll.votes.values()].filter((v) => v === i).length);
  const bar = (count: number) => {
    const filled = total ? Math.round((count / total) * 12) : 0;
    return '█'.repeat(filled) + '░'.repeat(12 - filled);
  };
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(poll.question)
        .setColor(closed ? '#8a8f98' : brand)
        .setDescription(
          poll.options
            .map(
              (option, i) =>
                `**${option}**\n\`${bar(counts[i]!)}\` ${counts[i]} vote${counts[i] === 1 ? '' : 's'}`
            )
            .join('\n\n')
        )
        .setFooter({
          text: closed
            ? `Closed with ${total} votes`
            : `${total} vote${total === 1 ? '' : 's'} so far`,
        }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        ...poll.options.map((option, i) =>
          new ButtonBuilder()
            .setCustomId(`poll:${id}:${i}`)
            .setLabel(option)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(closed)
        ),
        new ButtonBuilder()
          .setCustomId(`poll:${id}:close`)
          .setLabel('Close poll')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(closed)
      ),
    ],
  };
}

export async function onButton(interaction: ButtonInteraction) {
  const [kind, id, choice] = interaction.customId.split(':');
  if (kind === 'poll' && id) {
    const poll = polls.get(id);
    if (!poll) return interaction.reply({ content: 'This poll has ended.', ephemeral: true });
    if (choice === 'close') return interaction.update(pollMessage(id, poll, true));
    poll.votes.set(interaction.user.tag, Number(choice));
    return interaction.update(pollMessage(id, poll));
  }
  if (kind === 'coin') {
    const side = Math.random() < 0.5 ? 'Heads' : 'Tails';
    return interaction.update({ content: `🪙 **${side}**! Flip again?` });
  }
}

// ---- the commands ------------------------------------------------------------------------------

const cities: Record<string, { country: string; temp: number; sky: string }> = {
  lisbon: { country: 'Portugal', temp: 21, sky: '☀️ Sunny' },
  porto: { country: 'Portugal', temp: 17, sky: '🌦️ Showers' },
  madrid: { country: 'Spain', temp: 24, sky: '☀️ Sunny' },
  barcelona: { country: 'Spain', temp: 22, sky: '⛅ Partly cloudy' },
  paris: { country: 'France', temp: 15, sky: '☁️ Overcast' },
  berlin: { country: 'Germany', temp: 12, sky: '🌧️ Rain' },
  amsterdam: { country: 'Netherlands', temp: 13, sky: '💨 Windy' },
  london: { country: 'United Kingdom', temp: 14, sky: '🌫️ Fog' },
  tokyo: { country: 'Japan', temp: 19, sky: '⛅ Partly cloudy' },
  'new york': { country: 'United States', temp: 16, sky: '☀️ Clear' },
};
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export const commands: Command[] = [
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Checks that the bot is alive'),
    async run(interaction) {
      const started = Date.now();
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply(`🏓 Pong! The round trip took ${Date.now() - started} ms.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('roll')
      .setDescription('Rolls some dice')
      .addIntegerOption((o) =>
        o.setName('sides').setDescription('Sides on each die').setMinValue(2).setMaxValue(100)
      )
      .addIntegerOption((o) =>
        o.setName('dice').setDescription('How many dice').setMinValue(1).setMaxValue(10)
      ),
    async run(interaction) {
      const sides = interaction.options.getInteger('sides') ?? 6;
      const count = interaction.options.getInteger('dice') ?? 1;
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🎲 ${rolls.reduce((a, b) => a + b, 0)}`)
            .setDescription(`${count}d${sides}: ${rolls.join(' + ')}`)
            .setColor(brand),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Starts a poll everyone can vote in')
      .addStringOption((o) =>
        o.setName('question').setDescription('What to ask').setRequired().setMaxLength(200)
      )
      .addStringOption((o) =>
        o
          .setName('options')
          .setDescription('Up to 4 answers, separated by commas')
          .setRequired()
          .setMaxLength(200)
      ),
    async run(interaction) {
      const options = interaction.options
        .getString('options', true)
        .split(',')
        .map((option) => option.trim())
        .filter(Boolean)
        .slice(0, 4);
      if (options.length < 2) {
        return interaction.reply({
          content: 'A poll needs at least two answers.',
          ephemeral: true,
        });
      }
      const poll = {
        question: interaction.options.getString('question', true),
        options,
        votes: new Map(),
      };
      polls.set(interaction.id, poll);
      await interaction.reply(pollMessage(interaction.id, poll));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('weather')
      .setDescription('Shows the (made up) weather in a city')
      .addStringOption((o) =>
        o.setName('city').setDescription('Start typing a city').setRequired().setAutocomplete()
      ),
    async autocomplete(interaction) {
      const typed = interaction.options.getFocused().value.toLowerCase();
      await interaction.respond(
        Object.keys(cities)
          .filter((city) => city.includes(typed))
          .map((city) => ({ name: `${title(city)}, ${cities[city]!.country}`, value: city }))
      );
    },
    async run(interaction) {
      const key = interaction.options.getString('city', true).toLowerCase();
      const city = cities[key];
      if (!city) return interaction.reply({ content: `I don't know ${key} yet.`, ephemeral: true });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setAuthor({ name: city.country })
            .setTitle(`Weather in ${title(key)}`)
            .setColor(city.temp > 20 ? '#f5a524' : '#5aa9e6')
            .addFields(
              { name: 'Sky', value: city.sky, inline: true },
              { name: 'Temperature', value: `${city.temp} °C`, inline: true },
              { name: 'Feels like', value: `${city.temp - 2} °C`, inline: true }
            )
            .setFooter({ text: 'Not a real forecast' })
            .setTimestamp(),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('whois')
      .setDescription('Shows who someone is')
      .addUserOption((o) => o.setName('member').setDescription('Who to look up').setRequired()),
    async run(interaction) {
      const user = interaction.options.getUser('member', true);
      const embed = new EmbedBuilder()
        .setTitle(user.displayName)
        .setDescription(user.data.about ?? '*No bio yet.*')
        .setColor(
          user.data.avatarColor?.startsWith('#') ? (user.data.avatarColor as `#${string}`) : brand
        )
        .addFields(
          { name: 'Handle', value: user.tag, inline: true },
          { name: 'Homeserver', value: user.homeserver, inline: true },
          { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true }
        );
      if (user.avatarUrl) embed.setThumbnail(user.avatarUrl);
      await interaction.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('remind')
      .setDescription('Reminds you of something later (only you see it)')
      .addStringOption((o) =>
        o.setName('what').setDescription('What to remind you of').setRequired()
      )
      .addIntegerOption((o) =>
        o.setName('seconds').setDescription('In how many seconds').setMinValue(5).setMaxValue(600)
      ),
    async run(interaction) {
      const seconds = interaction.options.getInteger('seconds') ?? 30;
      const what = interaction.options.getString('what', true);
      await interaction.reply({
        content: `⏰ Got it, I'll remind you in ${seconds} seconds.`,
        ephemeral: true,
      });
      // interaction tokens last 15 minutes, which is why /remind stops at 10
      setTimeout(
        () => void interaction.followUp({ content: `⏰ Reminder: ${what}`, ephemeral: true }),
        seconds * 1000
      );
    },
  },
  {
    data: new SlashCommandBuilder().setName('coin').setDescription('Flips a coin'),
    async run(interaction) {
      await interaction.reply({
        content: '🪙 Ready to flip.',
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('coin:flip')
              .setLabel('Flip')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setURL('https://en.wikipedia.org/wiki/Coin_flipping')
              .setLabel('About coins')
              .setStyle(ButtonStyle.Link)
          ),
        ],
      });
    },
  },
];
