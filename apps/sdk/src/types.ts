// The shapes the Anchor bot API speaks. They mirror apps/anchor (utils/botSchemas.ts,
// modules/interactions/schemas.ts and the message/realtime payloads).

export interface APIUser {
  userId: string;
  username: string;
  homeserver: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarColor: string | null;
  speakingRingColor: string | null;
  bannerUrl: string | null;
  about: string | null;
  isBot: boolean;
}

export interface APIBot extends APIUser {
  handle: string;
  public: boolean;
  createdAt: string;
  commands: APICommand[];
  guildCount: number;
}

export interface APIEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string; iconUrl?: string };
  footer?: { text: string; iconUrl?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export type APIButton =
  | {
      type: 'button';
      style: 'primary' | 'secondary' | 'success' | 'danger';
      label: string;
      customId: string;
      disabled?: boolean;
    }
  | { type: 'button'; style: 'link'; label: string; url: string; disabled?: boolean };

export interface APIActionRow {
  type: 'actionRow';
  components: APIButton[];
}

export interface APIMessageInteraction {
  id: string;
  name: string;
  user: APIUser;
}

export interface APIAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  previewUrl?: string;
  width?: number | null;
  height?: number | null;
}

export interface APIMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  content: string | null;
  nonce: string;
  replyTo: string | null;
  edited?: boolean;
  editedTime?: string;
  pingedHandles?: string[];
  attachments: APIAttachment[];
  createdAt: string;
  author: APIUser;
  embeds?: APIEmbed[];
  components?: APIActionRow[];
  interaction?: APIMessageInteraction | null;
}

export interface APIEphemeralMessage extends Omit<APIMessage, 'nonce' | 'replyTo' | 'attachments'> {
  ephemeral: true;
}

export interface APIChannel {
  id: string;
  guildId: string;
  name: string;
  type: 'TEXT' | 'VOICE';
  position: number;
  ownerOnly: boolean;
}

export interface APIGuild {
  id: string;
  name: string;
  avatarUrl: string | null;
  description: string | null;
  canManageChannels?: boolean;
  channels: APIChannel[];
}

export interface APIMember extends APIUser {
  status: 'ONLINE' | 'OFFLINE';
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
}

export type APICommandOptionType = 'string' | 'integer' | 'number' | 'boolean' | 'user';

export interface APICommandOption {
  name: string;
  description: string;
  type: APICommandOptionType;
  required?: boolean;
  choices?: { name: string; value: string | number }[];
  autocomplete?: boolean;
  minValue?: number;
  maxValue?: number;
  minLength?: number;
  maxLength?: number;
}

export interface APICommand {
  name: string;
  description: string;
  options?: APICommandOption[];
}

export interface APIResolvedOption {
  name: string;
  type: APICommandOptionType;
  value: string | number | boolean;
  focused?: boolean;
  user?: APIUser;
}

export interface APIInteraction {
  id: string;
  token: string;
  type: 'command' | 'autocomplete' | 'button';
  guildId: string;
  channelId: string;
  user: APIUser;
  data: { name: string; options?: APIResolvedOption[]; customId?: string };
  message?: { id: string; ephemeral: boolean; content: string | null };
}

export interface APIMessageBody {
  content?: string | null;
  embeds?: APIEmbed[];
  components?: APIActionRow[];
}

export interface APIResponseMessage extends APIMessageBody {
  ephemeral?: boolean;
}

export type APIRealtimeEvent =
  | { type: 'guild.created'; data: APIGuild & { ownerId: string } }
  | { type: 'guild.deleted'; data: { guildId: string } }
  | { type: 'channel.created' | 'channel.updated'; data: APIChannel }
  | { type: 'guild.channels.reordered'; data: { guildId: string; channelIds: string[] } }
  | { type: 'message.created' | 'message.updated'; data: APIMessage }
  | { type: 'message.deleted'; data: { id: string; channelId: string; guildId: string | null } }
  | {
      type: 'member.joined';
      data: { guildId: string; user: APIUser & { status: 'ONLINE' | 'OFFLINE' } };
    }
  | { type: 'member.left'; data: { guildId: string; userId: string } }
  | { type: 'user.status.changed'; data: { userId: string; status: 'ONLINE' | 'OFFLINE' } }
  | { type: 'user.updated'; data: { user: APIUser } }
  | {
      type: 'channel.typing';
      data: {
        channelId: string;
        userId: string;
        username: string;
        displayName: string | null;
        homeserver: string;
        time: string;
      };
    }
  | { type: 'interaction.created'; data: APIInteraction }
  | { type: 'voice.states.snapshot'; data: { guildIds: string[]; states: unknown[] } }
  | { type: 'misc.ping' }
  | { type: string; data?: unknown };
