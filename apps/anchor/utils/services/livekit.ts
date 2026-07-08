import { RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { getConfig } from '../config';
import type { VoicePresence } from '../types';

export const livekitServiceClient = new RoomServiceClient(
  getConfig().voice.livekit_url,
  getConfig().voice.livekit_key,
  getConfig().voice.livekit_secret
);

export const livekitWebhookReceiver = new WebhookReceiver(
  getConfig().voice.livekit_key,
  getConfig().voice.livekit_secret
);

const voicePresenceByUser = new Map<string, VoicePresence>();

export function setVoicePresence(state: VoicePresence) {
  voicePresenceByUser.set(state.userId, state);
}

export function removeVoicePresence(userId: string) {
  const state = voicePresenceByUser.get(userId) ?? null;
  voicePresenceByUser.delete(userId);

  return state;
}

export function voicePresenceForGuilds(guildIds: string[]) {
  const allowedGuilds = new Set(guildIds);

  return [...voicePresenceByUser.values()].filter((state) => allowedGuilds.has(state.guildId));
}
