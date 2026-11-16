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

// told about every channel whose callers changed, so DM calls can be logged (modules/dm/calls.ts)
let onPresenceChange: (channelId: string) => void = () => {};
export const watchVoicePresence = (listener: typeof onPresenceChange) => {
  onPresenceChange = listener;
};

export function setVoicePresence(state: VoicePresence) {
  const previous = voicePresenceByUser.get(state.userId);
  voicePresenceByUser.set(state.userId, state);
  if (previous && previous.channelId !== state.channelId) onPresenceChange(previous.channelId);
  onPresenceChange(state.channelId);
}

export function getVoicePresence(userId: string) {
  return voicePresenceByUser.get(userId);
}

export function removeVoicePresence(userId: string) {
  const state = voicePresenceByUser.get(userId) ?? null;
  voicePresenceByUser.delete(userId);
  if (state) onPresenceChange(state.channelId);

  return state;
}

export function voicePresenceForGuilds(guildIds: string[]) {
  const allowedGuilds = new Set(guildIds);

  return [...voicePresenceByUser.values()].filter(
    (state) => state.guildId && allowedGuilds.has(state.guildId)
  );
}

export function voicePresenceForChannels(channelIds: string[]) {
  const allowedChannels = new Set(channelIds);

  return [...voicePresenceByUser.values()].filter((state) => allowedChannels.has(state.channelId));
}
