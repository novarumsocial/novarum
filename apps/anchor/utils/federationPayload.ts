export function federationUserPayload(session: {
  user: {
    username: string;
    homeserver: string;
    displayName: string | null;
    avatarUrl: string | null;
    isBot: boolean;
  };
}) {
  return {
    username: session.user.username,
    homeserver: session.user.homeserver,
    displayName: session.user.displayName,
    avatarUrl: session.user.avatarUrl,
    isBot: session.user.isBot,
  };
}
