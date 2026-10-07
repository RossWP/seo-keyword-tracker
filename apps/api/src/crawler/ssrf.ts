import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { CrawlError } from './errors.js';

// Everything a user-supplied URL must never reach: loopback, private and link-local ranges
// (incl. cloud metadata at 169.254.169.254), CGNAT, multicast and reserved/documentation ranges.
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged by its IPv4 part.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return isPublicAddress(mapped[1]);
  return !blocked.check(address, 'ipv6');
}

/**
 * DNS lookup for outgoing connections that refuses non-public addresses. Runs on every
 * connection, including each redirect hop, which also defeats DNS rebinding.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const rejected = addresses.find((entry) => !isPublicAddress(entry.address));
    if (rejected || addresses.length === 0) {
      callback(
        new CrawlError('blocked_host', `${hostname} resolves to a private or reserved address`),
        '',
        0,
      );
      return;
    }
    if (options.all) {
      callback(null, addresses, 0);
      return;
    }
    const [first] = addresses;
    callback(null, first?.address ?? '', first?.family ?? 0);
  });
};

/** IP-literal hosts skip DNS, so they are checked before connecting. */
export function assertPublicLiteral(hostname: string): void {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) && !isPublicAddress(bare)) {
    throw new CrawlError('blocked_host', `${hostname} is a private or reserved address`);
  }
}
