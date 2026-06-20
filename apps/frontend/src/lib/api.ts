import { treaty } from '@elysia/eden';
import type { Treaty } from '@elysia/eden';
import type { App } from 'anchor';

type AnchorRoutes = App['~Routes'];

export function anchorUrlFromHomeServer(homeServerUrl: string) {
	const url = homeServerUrl.trim().replace(/\/+$/, '');

	if (url.startsWith('http://') || url.startsWith('https://')) return url;
	if (url.startsWith('localhost') || url.startsWith('127.0.0.1') || url.startsWith('[::1]')) {
		return `http://${url}`;
	}

	return `https://${url}`;
}

export function createAnchorClient(homeServerUrl: string) {
	return treaty(anchorUrlFromHomeServer(homeServerUrl), {
		fetch: {
			credentials: 'include'
		}
	}) as unknown as Treaty.Sign<AnchorRoutes>;
}

export type AnchorClient = ReturnType<typeof createAnchorClient>;
