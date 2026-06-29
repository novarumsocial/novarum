const federatedPrefix = 'fed';

export function makeFederatedGuildId(homeserver: string, guildId: string) {
  return `${federatedPrefix}:guild:${encodeURIComponent(homeserver)}:${encodeURIComponent(guildId)}`;
}

export function makeFederatedChannelId(homeserver: string, channelId: string) {
  return `${federatedPrefix}:channel:${encodeURIComponent(homeserver)}:${encodeURIComponent(channelId)}`;
}

export function parseFederatedGuildId(id: string) {
  return parseFederatedId(id, 'guild');
}

export function parseFederatedChannelId(id: string) {
  return parseFederatedId(id, 'channel');
}

function parseFederatedId(id: string, kind: 'guild' | 'channel') {
  const parts = id.split(':');
  if (parts.length !== 4 || parts[0] !== federatedPrefix || parts[1] !== kind) return null;

  try {
    return {
      homeserver: decodeURIComponent(parts[2]!),
      id: decodeURIComponent(parts[3]!),
    };
  } catch {
    return null;
  }
}
