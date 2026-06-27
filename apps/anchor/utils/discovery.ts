import crypto from 'node:crypto';
import { randomString } from './randomString';
import { getKeys, signMessage } from './keys';

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
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch discovery info from ${discoveryUrl}: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as AnchorInfo;
    if (data.homeserver !== clean) {
      throw new Error(`Homeserver mismatch: expected ${clean}, got ${data.homeserver}`);
    }

    return {
      homeserver: data.homeserver,
      baseUrl: data.baseUrl.replace(/\/+$/, ''),
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
