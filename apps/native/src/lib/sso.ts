// Port of apps/frontend/src/lib/sso.svelte.ts
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { anchor } from './anchor';
import { getAnchorInfo, type AnchorAuthInfo } from './api';
import { getErrorMessage } from './session';

const redirectUri = 'novarum://sso';

// the verifier never leaves the app: only this app can redeem what the provider sends back
let pending: { verifier: string; redirect: string | null } | null = null;
const claimed = new Set<string>();

/** Opens the provider in an auth session. Returns an error message, or null. */
export async function startSignOn(
  provider: string,
  options: { link?: boolean; redirect?: string } = {}
) {
  try {
    const { data, error } = await anchor().client.auth.sso.authorize.post({
      provider,
      redirectUri,
      link: options.link,
    });
    if (error) return getErrorMessage(error.value, 'Could not start signing in.');

    pending = { verifier: data.verifier, redirect: options.redirect ?? null };
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectUri);
    // on Android the router may already have opened the same deep link; the sso screen dedupes it
    if (result.type === 'success') router.push(`/sso?${result.url.split('?')[1] ?? ''}` as Href);
    return null;
  } catch (error) {
    return getErrorMessage(error, 'Could not start signing in.');
  }
}

export const pendingSignOn = () => pending;
export const clearSignOn = () => void (pending = null);
/** true only the first time a code is seen, so a deep link handled twice is redeemed once */
export const claimSignOnCode = (code: string) => !claimed.has(code) && !!claimed.add(code);

/** the sign-up rules and providers of whatever home server is typed in, refetched as it changes */
export function useServerAuth(homeServer: string) {
  const [info, setInfo] = useState<AnchorAuthInfo | null>(null);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      getAnchorInfo(homeServer)
        .then((result) => current && setInfo(result.auth))
        .catch(() => current && setInfo(null));
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [homeServer]);
  return info;
}
