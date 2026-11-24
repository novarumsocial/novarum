import { Capacitor } from '@capacitor/core';
import { goto } from '$app/navigation';
import { anchor } from '$lib/anchor.svelte';
import { getAnchorInfo, type AnchorAuthInfo } from '$lib/api';
import { getErrorMessage } from '$lib/session.svelte';

const storageKey = 'novarum:sso';

// the capacitor webview can't follow a sign-on through the provider's pages and back
export const signOnSupported = typeof window !== 'undefined' && !Capacitor.isNativePlatform();

/**
 * Sends the user to the provider. The verifier stays in this tab's sessionStorage: only this app
 * can redeem what the provider sends back to /sso. Returns an error message, or null when leaving.
 */
export async function startSignOn(
  provider: string,
  options: { link?: boolean; redirect?: string } = {}
) {
  try {
    const { data, error } = await anchor.client.auth.sso.authorize.post({
      provider,
      redirectUri: new URL('/sso', location.href).href,
      link: options.link,
    });
    if (error) return getErrorMessage(error.value, 'Could not start signing in.');

    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ verifier: data.verifier, redirect: options.redirect ?? null })
    );
    if (window.electron) {
      const back = await window.electron.signOn(data.url);
      if (back) await goto(new URL(back).pathname + new URL(back).search);
      return null;
    }
    location.href = data.url;
    return null;
  } catch (error) {
    return getErrorMessage(error, 'Could not start signing in.');
  }
}

export function pendingSignOn(): { verifier: string; redirect: string | null } | null {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
  } catch {
    return null;
  }
}

export const clearSignOn = () => sessionStorage.removeItem(storageKey);

/** the sign-up rules and providers of whatever home server is typed in, refetched as it changes */
export function serverAuth(homeServer: () => string) {
  const state = $state<{ info: AnchorAuthInfo | null }>({ info: null });
  $effect(() => {
    const server = homeServer();
    const timer = setTimeout(() => {
      getAnchorInfo(server)
        .then((info) => homeServer() === server && (state.info = info.auth))
        .catch(() => homeServer() === server && (state.info = null));
    }, 400);
    return () => clearTimeout(timer);
  });
  return state;
}
