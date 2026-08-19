import {
  anchorUrlFromHomeServer,
  createAnchorClient,
  getAnchorInfo,
  normalizeHomeServer,
} from '$lib/api';

const homeServerStorageKey = 'novarum:home-server';
const anchorBaseUrlStorageKey = 'novarum:anchor-base-url';

function getInitialHomeServer() {
  if (typeof localStorage === 'undefined') return 'novarum.me';

  return localStorage.getItem(homeServerStorageKey) || 'novarum.me';
}

function getInitialBaseUrl(homeServer: string) {
  if (typeof localStorage === 'undefined') return anchorUrlFromHomeServer(homeServer);

  return localStorage.getItem(anchorBaseUrlStorageKey) || anchorUrlFromHomeServer(homeServer);
}

class AnchorState {
  homeServer = $state(getInitialHomeServer());
  baseUrl = $state(getInitialBaseUrl(this.homeServer));
  maxFileSize = $state(10);
  client = $derived(createAnchorClient(this.baseUrl));

  constructor() {
    void this.refreshInfo();
  }

  async setHomeServer(homeServer: string) {
    const normalizedHomeServer = normalizeHomeServer(homeServer);
    const info = await getAnchorInfo(normalizedHomeServer);

    this.homeServer = normalizedHomeServer;
    this.baseUrl = info.baseUrl.replace(/\/+$/, '');
    this.maxFileSize = info.maxFileSize;
    localStorage.setItem(homeServerStorageKey, normalizedHomeServer);
    localStorage.setItem(anchorBaseUrlStorageKey, this.baseUrl);
  }

  private async refreshInfo() {
    try {
      const info = await getAnchorInfo(this.homeServer);
      this.baseUrl = info.baseUrl.replace(/\/+$/, '');
      this.maxFileSize = info.maxFileSize;
    } catch {
      // offline or unreachable — keep cached values
    }
  }
}

export const anchor = new AnchorState();
