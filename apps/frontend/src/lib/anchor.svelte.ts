import { anchorUrlFromHomeServer, createAnchorClient, discoverAnchor, normalizeHomeServer } from '$lib/api';

const homeServerStorageKey = 'novarum:home-server';
const anchorBaseUrlStorageKey = 'novarum:anchor-base-url';

function getInitialHomeServer() {
	if (typeof localStorage === 'undefined') return 'novarum.social';

	return localStorage.getItem(homeServerStorageKey) || 'novarum.social';
}

function getInitialBaseUrl(homeServer: string) {
	if (typeof localStorage === 'undefined') return anchorUrlFromHomeServer(homeServer);

	return localStorage.getItem(anchorBaseUrlStorageKey) || anchorUrlFromHomeServer(homeServer);
}

class AnchorState {
	homeServer = $state(getInitialHomeServer());
	baseUrl = $state(getInitialBaseUrl(this.homeServer));
	client = $derived(createAnchorClient(this.baseUrl));

	async setHomeServer(homeServer: string) {
		const normalizedHomeServer = normalizeHomeServer(homeServer);
		const baseUrl = await discoverAnchor(normalizedHomeServer);

		this.homeServer = normalizedHomeServer;
		this.baseUrl = baseUrl;
		localStorage.setItem(homeServerStorageKey, normalizedHomeServer);
		localStorage.setItem(anchorBaseUrlStorageKey, baseUrl);
	}
}

export const anchor = new AnchorState();
