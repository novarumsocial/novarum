// Port of apps/frontend/src/lib/anchor.svelte.ts
import { create } from 'zustand';
import {
  anchorUrlFromHomeServer,
  createAnchorClient,
  getAnchorInfo,
  normalizeHomeServer,
} from './api';
import { storage } from './storage';

const homeServerStorageKey = 'novarum:home-server';
const anchorBaseUrlStorageKey = 'novarum:anchor-base-url';

const homeServer = storage.getString(homeServerStorageKey) || 'novarum.me';
const baseUrl = storage.getString(anchorBaseUrlStorageKey) || anchorUrlFromHomeServer(homeServer);

type AnchorState = {
  homeServer: string;
  baseUrl: string;
  maxFileSize: number;
  client: ReturnType<typeof createAnchorClient>;
  setHomeServer: (homeServer: string) => Promise<void>;
  refreshInfo: () => Promise<void>;
};

export const useAnchor = create<AnchorState>((set, get) => ({
  homeServer,
  baseUrl,
  maxFileSize: 10,
  client: createAnchorClient(baseUrl),

  async setHomeServer(input) {
    const homeServer = normalizeHomeServer(input);
    const info = await getAnchorInfo(homeServer);
    const baseUrl = info.baseUrl.replace(/\/+$/, '');

    set({
      homeServer,
      baseUrl,
      maxFileSize: info.maxFileSize,
      client: createAnchorClient(baseUrl),
    });
    storage.set(homeServerStorageKey, homeServer);
    storage.set(anchorBaseUrlStorageKey, baseUrl);
  },

  async refreshInfo() {
    const current = get().homeServer;
    try {
      const info = await getAnchorInfo(current);
      // the user may have picked another homeserver while this was in flight
      if (get().homeServer !== current) return;
      const baseUrl = info.baseUrl.replace(/\/+$/, '');
      set({
        baseUrl,
        maxFileSize: info.maxFileSize,
        ...(baseUrl === get().baseUrl ? {} : { client: createAnchorClient(baseUrl) }),
      });
    } catch {
      // offline or unreachable — keep cached values
    }
  },
}));

// Same name as on the web, for code that runs outside React: `anchor().client.auth.me.get()`
export const anchor = useAnchor.getState;

// the web does this in the constructor: it picks up `maxFileSize` and a moved base URL
void anchor().refreshInfo();
