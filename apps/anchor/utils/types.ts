export type RealtimeEvent =
  | {
      type: "guild.created";
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
      type: "channel.created";
      data: {
        id: string;
        name: string;
        position: number;
        type: 'TEXT' | 'VOICE';
        guildId: string;
      };
    };