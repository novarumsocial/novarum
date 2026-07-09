import { treaty } from '@elysia/eden';
import type { Treaty } from '@elysia/eden';
import { z } from 'zod';
import type { App } from 'anchor';

type AnchorRoutes = App['~Routes'];

const anchorInfoSchema = z.object({
  app: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  homeserver: z.string(),
  baseUrl: z.string().url(),
  version: z.string().optional(),
});

export function normalizeHomeServer(homeServerUrl: string) {
  const url = homeServerUrl.trim().replace(/\/+$/, '');

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return new URL(url).host;
  }

  return url;
}

export function anchorUrlFromHomeServer(homeServerUrl: string) {
  const url = homeServerUrl.trim().replace(/\/+$/, '');

  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('localhost') || url.startsWith('127.0.0.1') || url.startsWith('[::1]')) {
    return `http://${url}`;
  }

  return `https://${url}`;
}

export async function discoverAnchor(homeServerUrl: string) {
  const homeServer = normalizeHomeServer(homeServerUrl);
  const discoveryUrl = `${anchorUrlFromHomeServer(homeServerUrl)}/.well-known/anchor/info`;
  let response: Response;

  try {
    response = await fetch(discoveryUrl);
  } catch {
    throw new Error(`Could not reach ${homeServer}. Check the server address and try again.`);
  }

  if (!response.ok) {
    throw new Error(
      `${homeServer} returned ${response.status} while looking for its Anchor server information.`
    );
  }

  const infoResult = anchorInfoSchema.safeParse(await response.json().catch(() => null));
  if (!infoResult.success) {
    throw new Error(`${homeServer} returned invalid Anchor server information.`);
  }

  const info = infoResult.data;
  if (info.homeserver !== homeServer) {
    throw new Error(
      `The server identified itself as ${info.homeserver}, not ${homeServer}. Check the server address.`
    );
  }

  return info.baseUrl.replace(/\/+$/, '');
}

export function createAnchorClient(baseUrl: string) {
  return treaty(baseUrl, {
    fetch: {
      credentials: 'include',
    },
  }) as unknown as Treaty.Sign<AnchorRoutes>;
}

export type AnchorClient = ReturnType<typeof createAnchorClient>;
