import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { getConfig } from './config';
import { allowLocalFederationTargets, assertSafeFederationUrl, isPrivateIp } from './discovery';

export function guardedLookup(allowLocal: boolean) {
  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: (...args: any[]) => void
  ) =>
    dns.lookup(hostname, options, (error, result, family) => {
      const addresses = Array.isArray(result) ? result.map((item) => item.address) : [result];
      if (!error && !allowLocal && addresses.some((address) => isPrivateIp(address))) {
        return callback(new Error('Resolves to a local or private address'), result, family);
      }
      callback(error, result, family);
    });
}

export async function safePost(url: string, headers: Record<string, string>, body: Uint8Array<ArrayBuffer>, timeoutMs: number) {
  const target = new URL(url);
  // literal ips and local names never reach the lookup, so they are refused up front
  await assertSafeFederationUrl(target);

  // behind an egress proxy the proxy resolves the name, so it is the one that enforces what is reachable
  const proxy = getConfig().network.proxy_url;
  if (proxy) {
    const response = await fetch(target, {
      method: 'POST',
      headers,
      body,
      proxy,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    void response.body?.cancel();
    return { status: response.status };
  }

  return new Promise<{ status: number }>((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).request(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(body.length) },
        lookup: guardedLookup(allowLocalFederationTargets()),
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      }
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Push request timed out')));
    request.end(body);
  });
}
