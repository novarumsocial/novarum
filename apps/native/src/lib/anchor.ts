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
    try {
      const info = await getAnchorInfo(get().homeServer);
      const baseUrl = info.baseUrl.replace(/\/+$/, '');
      set({ baseUrl, maxFileSize: info.maxFileSize, client: createAnchorClient(baseUrl) });
    } catch {
      // offline or unreachable — keep cached values
    }
  },
}));

// Same name as on the web, for code that runs outside React: `anchor().client.auth.me.get()`
export const anchor = useAnchor.getState;
