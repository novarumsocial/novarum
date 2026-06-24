export type RealtimeEvent =
  | {
      type: 'guild.created';
      data: {
        id: string;
        name: string;
        ownerId: string;
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
        content: string;
        nonce: string;
        createdAt: string;
        author: {
          id: string;
          username: string;
          avatar: string | null;
        };
      };
    }
  | {
      type: 'user.status.changed';
      data: {
        userId: string;
        status: 'ONLINE' | 'OFFLINE';
      };
    };
