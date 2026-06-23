export interface Server {
  id: string;
  name: string;
  initials: string;
  color?: string;
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
  mention: number;
  type: 'TEXT' | 'VOICE';
}

export interface Author {
  username: string;
  server: string;
  displayName: string;
  avatarColor: string;
  isBot: boolean;
}

export interface Message {
  id: string;
  author: Author;
  content: string;
  timestamp: Date;
  edited: boolean;
  fromFederated: boolean;
  replies: number;
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
  | { kind: 'guild'; serverId: string | null; channelId: string | null };