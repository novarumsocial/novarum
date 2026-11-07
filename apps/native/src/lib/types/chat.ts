import type { ActionRow, Embed } from 'anchor/bot-schemas';
// Port of apps/frontend/src/lib/types/chat.ts
export interface Server {
  id: string;
  name: string;
  initials: string;
  down: boolean;
  canManageChannels: boolean;
  avatarUrl?: string | null;
  description?: string | null;
  color?: string;
  ownerId?: string;
}

export interface ChannelCategory {
  id: string;
  label: string;
  channels: Channel[];
}

export interface Channel {
  id: string;
  name: string;
  label?: string;
  topic?: string;
  unread: boolean;
  lastReadMessageId: string | null;
  mention: number;
  type: 'TEXT' | 'VOICE' | 'DM';
  ownerOnly?: boolean;
  avatarUrl?: string | null;
  avatarColor?: string | null;
}

export interface Author extends Omit<PublicUser, 'homeserver'> {
  server: string;
  status?: 'ONLINE' | 'OFFLINE';
}

export interface Message {
  id: string;
  author: Author;
  content: string;
  timestamp: Date;
  edited: boolean;
  editedTime?: string;
  replyTo: string | null;
  pingedHandles: string[];
  attachments: Attachment[];
  embeds: Embed[];
  components: ActionRow[];
  // "<someone> used /command", on a bot's answer to a slash command
  interaction: { id: string; name: string; user: Author } | null;
  // only on this screen: a bot's answer only you can see, or a bot still thinking about it
  ephemeral?: boolean;
  thinking?: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  previewUrl: string;
  width?: number | null;
  height?: number | null;
}

export interface VoiceUser {
  username: string;
  server: string;
  avatarColor: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
}

export type ChatRoute =
  | { kind: 'home' }
  | { kind: 'dms'; channelId: string | null; messageId?: string | null }
  | {
      kind: 'guild';
      serverId: string | null;
      channelId: string | null;
      messageId: string | null;
    };
import type { PublicUser } from 'anchor/public-user';
