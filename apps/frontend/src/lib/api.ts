import { treaty } from '@elysia/eden';
import type { Treaty } from '@elysia/eden';
import type { App } from 'anchor';

type AnchorRoutes = App['~Routes'];

type AnchorInfo = {
	app?: {
		name?: string;
		description?: string;
	};
	homeserver: string;
	baseUrl: string;
	version?: string;
};

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
	const response = await fetch(discoveryUrl);

	if (!response.ok) throw new Error('Homeserver discovery failed.');

	const info = (await response.json()) as AnchorInfo;
	if (info.homeserver !== homeServer) {
		throw new Error('Homeserver identity mismatch.');
	}

	return info.baseUrl.replace(/\/+$/, '');
}

export function createAnchorClient(baseUrl: string) {
	return treaty(baseUrl, {
		fetch: {
			credentials: 'include'
		}
	}) as unknown as Treaty.Sign<AnchorRoutes>;
}

export type AnchorClient = ReturnType<typeof createAnchorClient>;
