// Port of apps/frontend/src/lib/safeRedirect.ts
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { z } from 'zod';
export function safeRedirect(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/guilds';

  return value;
}

// native-only: the search params every auth screen reads (`add` comes from "Add account")
const paramsSchema = z.object({
  redirect: z.string().optional().catch(undefined),
  add: z.string().optional().catch(undefined),
});
export const useRedirectParam = () => paramsSchema.parse(useLocalSearchParams()).redirect;

export function useAuthParams() {
  const { redirect, add } = paramsSchema.parse(useLocalSearchParams());
  const path = safeRedirect(redirect);
  const query = [redirect && `redirect=${encodeURIComponent(path)}`, add && 'add=1']
    .filter(Boolean)
    .join('&');

  return {
    redirect,
    add,
    // what the next auth screen needs to know
    query: query && `?${query}`,
    // "Add account" opens the auth screens on top of the app: go back to that one (it boots again for the
    // new account) instead of stacking a second app on top
    done: () => (add ? router.dismissTo(path as Href) : router.replace(path as Href)),
  };
}
