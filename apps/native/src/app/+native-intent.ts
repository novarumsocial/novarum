// Native-only: launch URLs that aren't app routes (dev client `.../expo-development-client/?url=...`, a bare
// `novarum://`) would otherwise open the "Unmatched Route" screen; `novarum://guilds/x` keeps `guilds` as the host
// (plain string handling: React Native's `URL` doesn't implement `hostname`/`pathname`)
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (path.includes('expo-development-client')) return '/';

  return path.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:app\.novarum\.me)?/i, '/').replace(/\/{2,}/g, '/');
}
