import { BlockList, isIP } from 'node:net';
import type { Server } from 'bun';
import { getConfig } from './config';

let trusted: BlockList | undefined;
function trustedProxies() {
  if (trusted) return trusted;
  trusted = new BlockList();
  for (const entry of getConfig().server.trusted_proxies) {
    const [address, prefix] = entry.split('/') as [string, string?];
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix) trusted.addSubnet(address, Number(prefix), type);
    else trusted.addAddress(address, type);
  }
  return trusted;
}

const normalize = (address: string) => address.trim().replace(/^::ffff:(?=\d+\.)/, '');
const isTrusted = (address: string) => {
  const version = isIP(address);
  return version !== 0 && trustedProxies().check(address, version === 6 ? 'ipv6' : 'ipv4');
};

export function clientIp(request: Request, server: Server<unknown> | null) {
  const socket = server?.requestIP(request)?.address;
  if (!socket) return '';
  const forwarded = request.headers.get('x-forwarded-for')?.split(',') ?? [];
  let address = normalize(socket);
  while (isTrusted(address) && forwarded.length) address = normalize(forwarded.pop()!);
  return address;
}
