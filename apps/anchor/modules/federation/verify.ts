import crypto from 'node:crypto';
import { discoverRemoteAnchor } from '../../utils/discovery';
import { isNonceUsed, storeNonce, verifyMessage } from '../../utils/keys';
import { getConfig } from '../../utils/config';

// the remote homeserver as we discovered it (name, base url and public key)
export type FederationOrigin = Awaited<ReturnType<typeof discoverRemoteAnchor>>;

type Failure = { ok: false; status: 400 | 401 | 404; error: string };
const fail = (status: Failure['status'], error: string): Failure => ({ ok: false, status, error });

const signedHeaderNames = [
  'X-Novarum-Homeserver',
  'X-Novarum-Key-Id',
  'X-Novarum-Date',
  'X-Novarum-Nonce',
  'X-Novarum-Body-SHA256',
  'X-Novarum-Signature',
] as const;

// WebSockets can't carry custom headers from every client, so the realtime routes receive the
// signed headers as query parameters and rebuild a plain request from them.
export function requestFromSignedQuery(url: string, query: Record<string, string | undefined>) {
  const headers = new Headers();
  for (const name of signedHeaderNames) {
    const value = query[name];
    if (value) headers.set(name, value);
  }
  return new Request(url, { method: 'GET', headers });
}

/**
 * Checks that a request really comes from the homeserver it claims to be from:
 * the headers are present, the date is fresh, the nonce was never seen, the body matches its
 * hash and the signature verifies against the key published by that homeserver.
 *
 * `signedPath` is only needed for WebSockets, where the signed path differs from the request url.
 */
export async function verifyFederationRequest(
  request: Request,
  body: string,
  signedPath?: string
): Promise<{ ok: true; origin: FederationOrigin } | Failure> {
  const homeserver = request.headers.get('X-Novarum-Homeserver');
  if (!homeserver) return fail(400, 'Missing X-Novarum-Homeserver header');

  const keyId = request.headers.get('X-Novarum-Key-Id');
  const date = request.headers.get('X-Novarum-Date');
  const nonce = request.headers.get('X-Novarum-Nonce');
  const signature = request.headers.get('X-Novarum-Signature');
  const bodyHash = request.headers.get('X-Novarum-Body-SHA256');
  if (!keyId || !date || !nonce || !signature || !bodyHash) {
    return fail(400, 'Missing required federation headers');
  }
  if (isStaleDate(date)) return fail(401, 'Stale federation request');
  // a cheap early check; the nonce is only stored once the signature is known to be valid,
  // so an attacker can't burn nonces of other homeservers with forged requests
  if (await isNonceUsed(nonce, homeserver)) return fail(401, 'Federation nonce already used');
  if (sha256Base64(body) !== bodyHash) return fail(401, 'Invalid federation body hash');

  const origin = await discoverKey(homeserver, keyId);
  if (!origin.ok) return origin;

  const url = new URL(request.url);
  const signingString = [
    'v1',
    request.method.toUpperCase(),
    signedPath ?? `${url.pathname}${url.search}`,
    url.host,
    homeserver,
    date,
    nonce,
    bodyHash,
  ].join('\n');
  if (!verifyMessage(signingString, signature, origin.value.publicKey.key)) {
    return fail(401, 'Invalid signature');
  }

  // two requests with the same nonce can both pass the early check above; the unique index
  // behind storeNonce decides which one wins
  if (!(await storeNonce(nonce, homeserver))) return fail(401, 'Federation nonce already used');

  return { ok: true, origin: origin.value };
}

// finds the remote's public key. If the key id is unknown the remote may have rotated its keys
// since we cached it, so we look once more without the cache before giving up.
async function discoverKey(homeserver: string, keyId: string) {
  const discover = (refresh?: boolean) =>
    discoverRemoteAnchor(homeserver, { refresh }).catch(() => null);

  let origin = await discover();
  if (origin && origin.publicKey.id !== keyId) origin = await discover(true);
  if (!origin) return fail(400, 'Could not discover remote anchor');
  if (origin.publicKey.id !== keyId) return fail(401, 'Unknown federation key');
  return { ok: true as const, value: origin };
}

/** Same as `verifyFederationRequest` for a JSON body: returns the parsed body too. */
export async function verifiedFederationJsonBody(
  request: Request
): Promise<{ ok: true; origin: FederationOrigin; body: unknown } | Failure> {
  // the signature covers the exact bytes we received, so it has to be checked before parsing
  const rawBody = await request.text();
  const verification = await verifyFederationRequest(request, rawBody);
  if (!verification.ok) return verification;

  try {
    return { ok: true, origin: verification.origin, body: JSON.parse(rawBody) as unknown };
  } catch {
    return fail(400, 'Invalid federation JSON body');
  }
}

function isStaleDate(date: string) {
  const timestamp = new Date(date).getTime();
  if (Number.isNaN(timestamp)) return true;

  const maxAgeMs = getConfig().federation.nonce_max_age_seconds * 1000;
  return Math.abs(Date.now() - timestamp) > maxAgeMs;
}

function sha256Base64(body: string) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('base64');
}
