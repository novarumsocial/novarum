import { describe, expect, test } from 'bun:test';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from '../src/index';

describe('SlashCommandBuilder', () => {
  test('builds a command with every option type, required ones first', () => {
    const command = new SlashCommandBuilder()
      .setName('roll')
      .setDescription('Rolls dice')
      .addIntegerOption((o) =>
        o.setName('sides').setDescription('Sides').setMinValue(2).setMaxValue(100)
      )
      .addStringOption((o) =>
        o
          .setName('label')
          .setDescription('Label')
          .setRequired()
          .addChoices({ name: 'A', value: 'a' })
      )
      .addNumberOption((o) => o.setName('bonus').setDescription('Bonus'))
      .addBooleanOption((o) => o.setName('secret').setDescription('Hide it'))
      .addUserOption((o) => o.setName('for').setDescription('Roll for'))
      .toJSON();
    expect(command.name).toBe('roll');
    expect(command.options!.map((o) => [o.name, o.type, o.required])).toEqual([
      ['label', 'string', true],
      ['sides', 'integer', false],
      ['bonus', 'number', false],
      ['secret', 'boolean', false],
      ['for', 'user', false],
    ]);
    expect(command.options![1]).toMatchObject({ minValue: 2, maxValue: 100 });
    expect(command.options![0]!.choices).toEqual([{ name: 'A', value: 'a' }]);
  });

  test('refuses names Anchor would refuse', () => {
    expect(() => new SlashCommandBuilder().setName('Has Caps')).toThrow(RangeError);
    expect(() => new SlashCommandBuilder().setName('x'.repeat(33))).toThrow(RangeError);
  });

  test('autocomplete and length limits', () => {
    const json = new SlashCommandBuilder()
      .setName('search')
      .setDescription('Search')
      .addStringOption((o) =>
        o.setName('q').setDescription('q').setAutocomplete().setMinLength(1).setMaxLength(50)
      )
      .toJSON();
    expect(json.options![0]).toMatchObject({ autocomplete: true, minLength: 1, maxLength: 50 });
  });
});

describe('EmbedBuilder', () => {
  test('builds an embed and resolves hex colours', () => {
    const embed = new EmbedBuilder()
      .setTitle('Hello')
      .setDescription('World')
      .setColor('#ff8800')
      .setURL('https://example.com')
      .setAuthor({ name: 'Me' })
      .setFooter({ text: 'Footer' })
      .setImage('https://example.com/a.png')
      .setThumbnail('https://example.com/t.png')
      .addFields({ name: 'a', value: 'b', inline: true })
      .setTimestamp(0)
      .toJSON();
    expect(embed).toEqual({
      title: 'Hello',
      description: 'World',
      color: 0xff8800,
      url: 'https://example.com',
      author: { name: 'Me' },
      footer: { text: 'Footer' },
      image: { url: 'https://example.com/a.png' },
      thumbnail: { url: 'https://example.com/t.png' },
      fields: [{ name: 'a', value: 'b', inline: true }],
      timestamp: '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('buttons', () => {
  test('rows of buttons', () => {
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('yes').setLabel('Yes').setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setURL('https://example.com')
          .setLabel('Docs')
          .setStyle(ButtonStyle.Link)
      )
      .toJSON();
    expect(row).toEqual({
      type: 'actionRow',
      components: [
        { type: 'button', style: 'success', label: 'Yes', customId: 'yes', disabled: undefined },
        {
          type: 'button',
          style: 'link',
          label: 'Docs',
          url: 'https://example.com',
          disabled: undefined,
        },
      ],
    });
  });

  test('buttons need a label and an id or a URL', () => {
    expect(() => new ButtonBuilder().setCustomId('x').toJSON()).toThrow(RangeError);
    expect(() => new ButtonBuilder().setLabel('x').toJSON()).toThrow(RangeError);
    expect(() => new ButtonBuilder().setLabel('x').setStyle(ButtonStyle.Link).toJSON()).toThrow(
      RangeError
    );
  });
});
