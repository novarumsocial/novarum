import { anchor } from './anchor.svelte';
import { chat } from './chat-state.svelte';

type GuildCreatedEvent = {
	type: 'guild.created';
	data: {
		id: string;
		name: string;
		ownerId: string;
		channels: {
			id: string;
			name: string;
			position: number;
			type: string;
			guildId: string;
		}[];
	};
};

type ChannelCreatedEvent = {
	type: 'channel.created';
	data: {
		id: string;
		name: string;
		position: number;
		type: 'TEXT' | 'VOICE';
		guildId: string;
	};
};

type RealtimeEvent = GuildCreatedEvent | ChannelCreatedEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
	if (!isRecord(value)) {
		return false;
	}

	if (value.type === 'guild.created') {
		if (!isRecord(value.data)) {
			return false;
		}

		return (
			typeof value.data.id === 'string' &&
			typeof value.data.name === 'string' &&
			typeof value.data.ownerId === 'string'
		);
	}

	if (value.type === 'channel.created') {
		if (!isRecord(value.data)) {
			return false;
		}

		return (
			typeof value.data.id === 'string' &&
			typeof value.data.name === 'string' &&
			typeof value.data.position === 'number' &&
			(typeof value.data.type === 'string' && (value.data.type === 'TEXT' || value.data.type === 'VOICE')) &&
			typeof value.data.guildId === 'string'
		);
	}

	return false;
}

class RealtimeState {
	connected = $state(false);

	connect() {
		const socket = anchor.client.realtime.subscribe();

		socket.on('open', () => {
			this.connected = true;
		});

		socket.on('close', () => {
			this.connected = false;
		});

		socket.subscribe(({ data }) => {
			if (!isRealtimeEvent(data)) return;

			if (data.type === 'guild.created') {
				chat.addGuild(data.data);
				data.data.channels.forEach((channel) => {
					chat.addChannel(channel);
				});
			}
			if (data.type === 'channel.created') {
				chat.addChannel(data.data);
			}
		});

		return () => socket.close();
	}
}

export const realtime = new RealtimeState();
