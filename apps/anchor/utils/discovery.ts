import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { randomString } from './randomString';
import { getKeys, signMessage } from './keys';
import { getConfig } from './config';
import { db } from '../prisma/db';

const homeserverPattern = /^[a-zA-Z0-9.-]+$/;

function anchorUrlFromHomeserver(homeserver: string) {
  const clean = normalizeFederationHomeserver(homeserver);

  const protocol =
    allowLocalFederationTargets() && (isLocalHostname(clean) || isPrivateIp(clean))
      ? 'http'
      : 'https';
  return `${protocol}://${clean}`;
}

function normalizeFederationHomeserver(homeserver: string) {
  const clean = homeserver.trim().replace(/\/+$/, '').toLowerCase();
  if (
    !clean ||
    clean.includes('://') ||
    clean.includes('/') ||
    clean.includes('\\') ||
    clean.includes('@') ||
    clean.includes(':') ||
    clean.startsWith('.') ||
    clean.endsWith('.') ||
    clean.includes('..') ||
    !homeserverPattern.test(clean)
  ) {
    throw new Error('Invalid homeserver name');
  }

  return clean;
}

export async function discoverRemoteAnchor(homeserver: string) {
  const clean = normalizeFederationHomeserver(homeserver);
  const discoveryUrl = new URL('/.well-known/anchor/info', anchorUrlFromHomeserver(clean));

  try {
    await assertSafeFederationUrl(discoveryUrl);

    const response = await fetch(discoveryUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      await markHomeserverGuildStatus(clean, false);
      console.log(
        `failed to fetch discovery info from ${homeserver} (probably down?): ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as AnchorInfo;
    const discoveredHomeserver = normalizeFederationHomeserver(data.homeserver);
    if (discoveredHomeserver !== clean) {
      throw new Error(`Homeserver mismatch: expected ${clean}, got ${data.homeserver}`);
    }

    if (data.publicKey?.algorithm !== 'ed25519' || !data.publicKey.id || !data.publicKey.key) {
      throw new Error(`Invalid discovery public key for ${clean}`);
    }

    const baseUrl = new URL(data.baseUrl);
    if (baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password) {
      throw new Error(`Invalid discovery base URL for ${clean}`);
    }
    await assertSafeFederationUrl(baseUrl);

    await markHomeserverGuildStatus(clean, true);

    return {
      homeserver: discoveredHomeserver,
      baseUrl: baseUrl.toString().replace(/\/+$/, ''),
      version: data.version,
      publicKey: data.publicKey,
    };
  } catch (error) {
    console.error(`Error discovering remote anchor at ${discoveryUrl}:`, error);
    throw error;
  }
}

export async function signFederationRequest(data: SignedRequestData) {
  const { id: keyId } = await getKeys();

  const bodyHash = crypto.createHash('sha256').update(data.body, 'utf8').digest('base64');
  const date = new Date().toISOString();
  const nonce = randomString();

  const signingString = [
    'v1',
    data.method.toUpperCase(),
    data.path,
    data.host,
    data.homeserver,
    date,
    nonce,
    bodyHash,
  ].join('\n');

  const signature = await signMessage(signingString);

  return {
    signingString,
    headers: {
      'X-Novarum-Homeserver': data.homeserver,
      'X-Novarum-Key-Id': keyId,
      'X-Novarum-Date': date,
      'X-Novarum-Nonce': nonce,
      'X-Novarum-Body-SHA256': bodyHash,
      'X-Novarum-Signature': signature,
    },
  };
}

export async function postSignedFederationJson(homeserver: string, path: string, body: unknown) {
  const remote = await discoverRemoteAnchor(homeserver);
  const url = new URL(path, remote.baseUrl);
  await assertSafeFederationUrl(url);

  const requestBody = JSON.stringify(body);
  const { headers } = await signFederationRequest({
    method: 'POST',
    path,
    host: url.host,
    homeserver: getConfig().server.homeserver,
    body: requestBody,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: requestBody,
  });

  const data = await response.json().catch(() => null);
  return { data, remote, response };
}

async function assertSafeFederationUrl(url: URL) {
  const allowLocal = allowLocalFederationTargets();
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) {
    throw new Error('Federation URL must use HTTPS');
  }

  const hostname = url.hostname.toLowerCase();
  const localOrIpPrivate = isLocalHostname(hostname) || isPrivateIp(hostname);
  if (localOrIpPrivate) {
    if (!allowLocal) throw new Error('Federation URL cannot target local or private addresses');
    return;
  }

  if (net.isIP(hostname)) return;

  const addresses = await dns.lookup(hostname, { all: true });
  if (!allowLocal && addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('Federation URL resolves to a local or private address');
  }
}

function allowLocalFederationTargets() {
  try {
    const baseUrl = new URL(getConfig().server.baseUrl);
    return isLocalHostname(baseUrl.hostname) || isPrivateIp(baseUrl.hostname);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname: string) {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function isPrivateIp(address: string) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;

    const [a, b] = parts as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }

  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice('::ffff:'.length));

    const first = Number.parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }

  return false;
}

async function markHomeserverGuildStatus(homeserver: string, up = true) {
  await db.orm.public.Guild.where((guild) =>
    guild.id.like(`fed:guild:${encodeURIComponent(homeserver)}:%`)
  ).update({
    extAnchorDown: !up,
  });
}

interface SignedRequestData {
  method: string;
  path: string; // path + query only, e.g. /federation/invites/abc/accept?thisquery=doesntexist
  host: string; // recipient host, e.g. novarum.social
  homeserver: string; // sender homeserver
  body: string;
}

interface AnchorInfo {
  homeserver: string;
  baseUrl: string;
  version: string;
  publicKey: {
    id: string;
    algorithm: string;
    key: string;
  };
}
