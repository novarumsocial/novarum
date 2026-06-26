function anchorUrlFromHomeserver(homeserver: string) {
	const clean = homeserver.trim().replace(/\/+$/, '');

	if (clean.startsWith('http://') || clean.startsWith('https://')) {
		return clean;
	}

	return `https://${clean}`;
}

export async function discoverRemoteAnchor(homeserver: string) {
	const clean = homeserver.trim().replace(/\/+$/, '');
	const discoveryUrl = `${anchorUrlFromHomeserver(clean)}/.well-known/anchor/info`;

	try {
		const response = await fetch(discoveryUrl, {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch discovery info from ${discoveryUrl}: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as AnchorInfo;
		if (data.homeserver !== clean) {
			throw new Error(`Homeserver mismatch: expected ${clean}, got ${data.homeserver}`);
		}

		return {
			homeserver: data.homeserver,
			baseUrl: data.baseUrl.replace(/\/+$/, ''),
			version: data.version,
		}
	} catch (error) {
		console.error(`Error discovering remote anchor at ${discoveryUrl}:`, error);
		throw error;
	}
}

interface AnchorInfo {
	homeserver: string;
	baseUrl: string;
	version: string;
}