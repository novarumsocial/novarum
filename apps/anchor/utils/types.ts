import type { PublicUser } from './publicUser';

export type RealtimeEvent =
  | {
      type: 'guild.created';
      data: {
        id: string;
        name: string;
        ownerId: string;
        avatarUrl: string | null;
        description: string | null;
        channels: {
          id: string;
          name: string;
          position: number;
          type: 'TEXT' | 'VOICE';
          guildId: string;
        }[];
      };
    }
  | {
      type: 'channel.created';
      data: {
        id: string;
        name: string;
        position: number;
        type: 'TEXT' | 'VOICE';
        guildId: string;
      };
    }
  | {
      type: 'message.created';
      data: {
        id: string;
        channelId: string;
        guildId: string;
        content: string | null;
        nonce: string;
        replyTo: string | null;
        pingedHandles: string[];
        attachments: AttachmentPayload[];
        createdAt: string;
        author: PublicUser;
      };
    }
  | {
      type: 'message.deleted';
      data: {
        id: string;
        channelId: string;
        guildId: string;
      };
    }
  | {
      type: 'user.status.changed';
      data: {
        userId: string;
        status: 'ONLINE' | 'OFFLINE';
      };
    }
  | {
      type: 'member.joined';
      data: {
        guildId: string;
        user: PublicUser & {
          status: 'ONLINE' | 'OFFLINE';
        };
      };
    }
  | {
      type: 'voice.states.snapshot';
      data: {
        guildIds: string[];
        states: VoicePresence[];
      };
    }
  | {
      type: 'voice.state.changed';
      data: VoicePresence & {
        connected: boolean;
      };
    }
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
  | {
      type: 'guild.channels.reordered';
      data: {
        guildId: string;
        channelIds: string[];
      };
    }
  | {
      type: 'friends.changed';
      data: Record<string, never>;
    }
  | {
      type: 'user.updated';
      data: {
        user: PublicUser;
      };
    };

export type AttachmentPayload = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
};

export type VoicePresence = {
  guildId: string;
  channelId: string;
  userId: string;
  name: string | null;
};
