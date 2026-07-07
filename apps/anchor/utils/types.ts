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
    }
  | {
      type: 'member.joined';
      data: {
        guildId: string;
        user: {
          userId: string;
          username: string;
          displayName: string | null;
          homeserver: string;
          isBot: boolean;
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
    };

export type VoicePresence = {
  guildId: string;
  channelId: string;
  userId: string;
  name: string | null;
};
