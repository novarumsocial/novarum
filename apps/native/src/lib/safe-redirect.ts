// Port of apps/frontend/src/lib/safeRedirect.ts
import { useLocalSearchParams } from 'expo-router';
import { z } from 'zod';
export function safeRedirect(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/guilds';

  return value;
}

// native-only: the `redirect` search param every auth screen reads
const paramsSchema = z.object({ redirect: z.string().optional().catch(undefined) });
export const useRedirectParam = () => paramsSchema.parse(useLocalSearchParams()).redirect;
