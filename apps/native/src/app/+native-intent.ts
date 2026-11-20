import { setCallLink } from '@/lib/call-link';

// Native-only: launch URLs that aren't app routes (dev client `.../expo-development-client/?url=...`, a bare
// `novarum://`) would otherwise open the "Unmatched Route" screen; `novarum://guilds/x` keeps `guilds` as the host
// (plain string handling: React Native's `URL` doesn't implement `hostname`/`pathname`)
// `novarum://call/<dm>[/answer]` comes from the ring notification (modules/incoming-call): it opens the DM, and
// the call screen or the call itself (components/call-ringing.tsx)
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (path.includes('expo-development-client')) return '/';

  const call = path.match(/^novarum:\/\/call\/([^/?#]+)(\/answer)?\/?$/i);
  if (call) {
    const channelId = decodeURIComponent(call[1]!);
    setCallLink({ channelId, answer: Boolean(call[2]) });
    return `/guilds/dms/${encodeURIComponent(channelId)}`;
  }

  return path.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:app\.novarum\.me)?/i, '/').replace(/\/{2,}/g, '/');
}
