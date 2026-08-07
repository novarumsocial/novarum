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
  type: 'TEXT' | 'VOICE';
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
  replyTo: string | null;
  pingedHandles: string[];
  attachments: Attachment[];
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
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
  | { kind: 'dms'; userId: string | null }
  | {
      kind: 'guild';
      serverId: string | null;
      channelId: string | null;
      messageId: string | null;
    };
import type { PublicUser } from 'anchor/public-user';
