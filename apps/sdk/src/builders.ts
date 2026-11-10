import type {
  APIActionRow,
  APIButton,
  APICommand,
  APICommandOption,
  APICommandOptionType,
  APIEmbed,
} from './types.js';

// Builders in the style of discord.js. Every builder has `toJSON()`, and anything that takes a
// builder also takes the plain object.

export type JSONEncodable<T> = { toJSON(): T };
export type Buildable<T> = T | JSONEncodable<T>;
export const resolveBuildable = <T>(value: Buildable<T>): T =>
  value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function'
    ? (value as JSONEncodable<T>).toJSON()
    : (value as T);

// ---- slash commands ---------------------------------------------------------------------------

const namePattern = /^[a-z0-9_-]{1,32}$/;
function checkName(name: string) {
  if (!namePattern.test(name)) {
    throw new RangeError(
      `"${name}" is not a valid name: use 1-32 lowercase letters, digits, - or _`
    );
  }
  return name;
}

class OptionBuilder<Type extends APICommandOptionType> {
  protected data: APICommandOption;
  constructor(type: Type) {
    this.data = { name: '', description: '', type, required: false };
  }
  setName(name: string) {
    this.data.name = checkName(name);
    return this;
  }
  setDescription(description: string) {
    this.data.description = description;
    return this;
  }
  setRequired(required = true) {
    this.data.required = required;
    return this;
  }
  toJSON(): APICommandOption {
    return { ...this.data };
  }
}

class ChoiceOptionBuilder<
  Type extends 'string' | 'integer' | 'number',
  Value extends string | number,
> extends OptionBuilder<Type> {
  addChoices(...choices: { name: string; value: Value }[]) {
    this.data.choices = [...(this.data.choices ?? []), ...choices];
    return this;
  }
  /** Ask the bot for suggestions while the person types (the `interactionCreate` autocomplete). */
  setAutocomplete(autocomplete = true) {
    this.data.autocomplete = autocomplete;
    return this;
  }
}

export class StringOptionBuilder extends ChoiceOptionBuilder<'string', string> {
  constructor() {
    super('string');
  }
  setMinLength(length: number) {
    this.data.minLength = length;
    return this;
  }
  setMaxLength(length: number) {
    this.data.maxLength = length;
    return this;
  }
}

class NumericOptionBuilder<Type extends 'integer' | 'number'> extends ChoiceOptionBuilder<
  Type,
  number
> {
  setMinValue(value: number) {
    this.data.minValue = value;
    return this;
  }
  setMaxValue(value: number) {
    this.data.maxValue = value;
    return this;
  }
}

export class IntegerOptionBuilder extends NumericOptionBuilder<'integer'> {
  constructor() {
    super('integer');
  }
}
export class NumberOptionBuilder extends NumericOptionBuilder<'number'> {
  constructor() {
    super('number');
  }
}
export class BooleanOptionBuilder extends OptionBuilder<'boolean'> {
  constructor() {
    super('boolean');
  }
}
export class UserOptionBuilder extends OptionBuilder<'user'> {
  constructor() {
    super('user');
  }
}

type Configure<B> = B | ((builder: B) => B);
const configure = <B>(input: Configure<B>, make: () => B) =>
  typeof input === 'function' ? (input as (builder: B) => B)(make()) : input;

/**
 * A global slash command.
 *
 * ```ts
 * new SlashCommandBuilder()
 *   .setName('echo')
 *   .setDescription('Says it back')
 *   .addStringOption((o) => o.setName('text').setDescription('What to say').setRequired());
 * ```
 */
export class SlashCommandBuilder {
  private data: APICommand & { options: APICommandOption[] } = {
    name: '',
    description: '',
    options: [],
  };
  setName(name: string) {
    this.data.name = checkName(name);
    return this;
  }
  setDescription(description: string) {
    this.data.description = description;
    return this;
  }
  private add(option: JSONEncodable<APICommandOption>) {
    this.data.options.push(option.toJSON());
    return this;
  }
  addStringOption = (o: Configure<StringOptionBuilder>) =>
    this.add(configure(o, () => new StringOptionBuilder()));
  addIntegerOption = (o: Configure<IntegerOptionBuilder>) =>
    this.add(configure(o, () => new IntegerOptionBuilder()));
  addNumberOption = (o: Configure<NumberOptionBuilder>) =>
    this.add(configure(o, () => new NumberOptionBuilder()));
  addBooleanOption = (o: Configure<BooleanOptionBuilder>) =>
    this.add(configure(o, () => new BooleanOptionBuilder()));
  addUserOption = (o: Configure<UserOptionBuilder>) =>
    this.add(configure(o, () => new UserOptionBuilder()));

  toJSON(): APICommand {
    // Anchor wants required options first, so keep the order people wrote but sort stably
    const options = [...this.data.options].sort(
      (a, b) => Number(!!b.required) - Number(!!a.required)
    );
    return { ...this.data, options };
  }
}

// ---- embeds -----------------------------------------------------------------------------------

export type ColorResolvable = number | `#${string}`;
const resolveColor = (color: ColorResolvable) =>
  typeof color === 'number' ? color : Number.parseInt(color.slice(1), 16);

/** A rich embed card. */
export class EmbedBuilder {
  private data: APIEmbed;
  constructor(data: APIEmbed = {}) {
    this.data = { ...data };
  }
  setTitle(title: string | null) {
    this.data.title = title ?? undefined;
    return this;
  }
  setDescription(description: string | null) {
    this.data.description = description ?? undefined;
    return this;
  }
  setURL(url: string | null) {
    this.data.url = url ?? undefined;
    return this;
  }
  setColor(color: ColorResolvable | null) {
    this.data.color = color === null ? undefined : resolveColor(color);
    return this;
  }
  setTimestamp(timestamp: Date | number | null = new Date()) {
    this.data.timestamp = timestamp === null ? undefined : new Date(timestamp).toISOString();
    return this;
  }
  setAuthor(author: APIEmbed['author'] | null) {
    this.data.author = author ?? undefined;
    return this;
  }
  setFooter(footer: APIEmbed['footer'] | null) {
    this.data.footer = footer ?? undefined;
    return this;
  }
  setImage(url: string | null) {
    this.data.image = url ? { url } : undefined;
    return this;
  }
  setThumbnail(url: string | null) {
    this.data.thumbnail = url ? { url } : undefined;
    return this;
  }
  addFields(...fields: NonNullable<APIEmbed['fields']>) {
    this.data.fields = [...(this.data.fields ?? []), ...fields];
    return this;
  }
  setFields(...fields: NonNullable<APIEmbed['fields']>) {
    this.data.fields = fields;
    return this;
  }
  toJSON(): APIEmbed {
    return { ...this.data };
  }
}

// ---- buttons ----------------------------------------------------------------------------------

export const ButtonStyle = {
  Primary: 'primary',
  Secondary: 'secondary',
  Success: 'success',
  Danger: 'danger',
  Link: 'link',
} as const;
export type ButtonStyle = (typeof ButtonStyle)[keyof typeof ButtonStyle];

/** A button. Give it a custom id, or a URL with the Link style. */
export class ButtonBuilder {
  private data: {
    label?: string;
    style: ButtonStyle;
    customId?: string;
    url?: string;
    disabled?: boolean;
  } = {
    style: ButtonStyle.Secondary,
  };
  setLabel(label: string) {
    this.data.label = label;
    return this;
  }
  setStyle(style: ButtonStyle) {
    this.data.style = style;
    return this;
  }
  setCustomId(customId: string) {
    this.data.customId = customId;
    return this;
  }
  setURL(url: string) {
    this.data.url = url;
    return this;
  }
  setDisabled(disabled = true) {
    this.data.disabled = disabled;
    return this;
  }
  toJSON(): APIButton {
    const { label, style, customId, url, disabled } = this.data;
    if (!label) throw new RangeError('A button needs a label');
    if (style === 'link') {
      if (!url) throw new RangeError('A link button needs a URL');
      return { type: 'button', style, label, url, disabled };
    }
    if (!customId) throw new RangeError('A button needs a custom id');
    return { type: 'button', style, label, customId, disabled };
  }
}

/** A row of up to five buttons. A message has up to five rows. */
export class ActionRowBuilder {
  private components: Buildable<APIButton>[] = [];
  addComponents(...components: (Buildable<APIButton> | Buildable<APIButton>[])[]) {
    this.components.push(...components.flat());
    return this;
  }
  setComponents(...components: (Buildable<APIButton> | Buildable<APIButton>[])[]) {
    this.components = components.flat();
    return this;
  }
  toJSON(): APIActionRow {
    return { type: 'actionRow', components: this.components.map(resolveBuildable) };
  }
}
