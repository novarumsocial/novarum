import { createAnchorClient } from '$lib/api';

const homeServerStorageKey = 'novarum:home-server';

function getInitialHomeServer() {
	if (typeof localStorage === 'undefined') return 'novarum.social';

	return localStorage.getItem(homeServerStorageKey) || 'novarum.social';
}

class AnchorState {
	homeServer = $state(getInitialHomeServer());
	client = $derived(createAnchorClient(this.homeServer));

	setHomeServer(homeServer: string) {
		const normalizedHomeServer = homeServer.trim();

		this.homeServer = normalizedHomeServer;
		localStorage.setItem(homeServerStorageKey, normalizedHomeServer);
	}
}

export const anchor = new AnchorState();
