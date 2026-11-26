import { isIPv6 } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';

/**
 * The client address for rate limits and report hashes: the proxy's own
 * header, else the socket. An IPv6 address counts as its /64, because one
 * client usually holds the whole /64.
 */
export function clientIp(request: FastifyRequest, cfg: Pick<AppConfig, 'clientIpHeader'>): string {
  const fromProxy = cfg.clientIpHeader ? request.headers[cfg.clientIpHeader] : undefined;
  const value = (Array.isArray(fromProxy) ? fromProxy[0] : fromProxy)?.trim() || request.socket.remoteAddress || 'unknown';
  return rateKey(value);
}

/** IPv4 (also IPv4-mapped IPv6) as is; IPv6 as its /64 prefix. */
export function rateKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  if (!isIPv6(address)) return address;
  const [head, tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
