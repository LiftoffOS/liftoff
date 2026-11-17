// SSRF guard for every tenant-influenced outbound URL (E1).
//
// The control plane accepts URLs from tenants in several places — a browser
// pane navigation, a custom MCP server registration, an external agent
// endpoint, a tunnel upstream — and, critically, it EMITS the tenant allowlist
// the tenant runtime trusts. So an unvalidated URL registered here does not
// just get fetched here; it gets blessed for the runtime too.
//
// Before this module the only guard in the repo was module-private inside
// src/oauth/cimd.ts. This lifts that same logic (which was already correct) to
// a shared, exported surface and applies it at every site.
//
// What it stops, in order of severity:
//   * cloud metadata (169.254.169.254, metadata.google.internal) — the address
//     that hands out service-account tokens. Always blocked, no exceptions, no
//     config that can turn it off.
//   * loopback and private ranges — reaching sibling services that assume they
//     are unreachable from outside.
//   * non-http(s) schemes — file://, gopher://, and friends.
//
// Two known limits, both deliberate:
//   * DNS rebinding (TOCTOU). We resolve, check, then hand the URL to a fetch
//     that resolves again. Closing that needs connect-time pinning per client;
//     this guard is the necessary first layer, not the complete one.
//   * Redirects. Callers that follow redirects must re-validate each hop; the
//     helpers here take a `redirect: 'error'`-shaped posture where they can.

import dns from 'dns/promises';
import net from 'net';
import { log } from '../infrastructure/logging';

/** Hostnames that are never legitimate targets, whatever they resolve to.
 *  Checked by NAME as well as by address, because a DNS answer can be made to
 *  look public while the name itself is the cloud metadata service. */
const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

export class BlockedUrlError extends Error {
  constructor(
    message: string,
    readonly reason: 'scheme' | 'hostname' | 'address' | 'unresolvable' | 'malformed',
  ) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

export function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed → fail closed
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;          // this-network, private, loopback
  if (a === 169 && b === 254) return true;                    // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;           // private
  if (a === 192 && b === 168) return true;                    // private
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  if (a >= 224) return true;                                  // multicast + reserved
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return ipv4Blocked(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;        // loopback / unspecified
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Blocked(mapped[1]);                // IPv4-mapped
    const firstHextet = parseInt(lower.split(':')[0] || '', 16);
    if (!Number.isNaN(firstHextet)) {
      const highByte = firstHextet >> 8;
      if (highByte === 0xfc || highByte === 0xfd) return true; // ULA fc00::/7
      if ((firstHextet & 0xffc0) === 0xfe80) return true;      // link-local fe80::/10
    }
    return false;
  }
  return true; // not a valid IP literal → fail closed
}

/**
 * Reject a host that is, or resolves to, a private / loopback / link-local
 * address. Throws BlockedUrlError so the caller aborts.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  // URL.hostname keeps the brackets on IPv6 literals ("[::1]"); strip them so
  // net.isIP recognises the literal and the IPv6 range checks apply.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();

  if (ALWAYS_BLOCKED_HOSTNAMES.has(host)) {
    throw new BlockedUrlError(`host ${host} is a cloud metadata endpoint`, 'hostname');
  }

  let addresses: string[];
  try {
    addresses = net.isIP(host)
      ? [host]
      : (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch (err) {
    throw new BlockedUrlError(`host ${host} did not resolve: ${(err as Error).message}`, 'unresolvable');
  }

  if (addresses.length === 0) {
    throw new BlockedUrlError(`host ${host} did not resolve`, 'unresolvable');
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new BlockedUrlError(`host ${host} resolves to a blocked address (${addr})`, 'address');
    }
  }
}

export interface AssertPublicUrlOptions {
  /** Allow plain http. Off by default: a tenant-supplied endpoint should be
   *  https, and http is only tolerated where an existing surface already
   *  accepted it. Never relaxes the address checks. */
  allowHttp?: boolean;
  /** Surface name for the structured block log. */
  context?: string;
}

/**
 * Validate a tenant-supplied URL before it is fetched, stored, or published to
 * the runtime allowlist. Throws BlockedUrlError when it must not be used.
 */
export async function assertPublicUrl(
  rawUrl: string,
  options: AssertPublicUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError('URL could not be parsed', 'malformed');
  }

  const allowed = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) {
    throw new BlockedUrlError(`scheme ${url.protocol} is not allowed`, 'scheme');
  }

  try {
    await assertPublicHost(url.hostname);
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      log.warn(
        {
          event: 'ssrf_block',
          context: options.context ?? 'unknown',
          host: url.hostname,
          reason: err.reason,
          error: err.message,
        },
        'Blocked a request to a private or metadata address',
      );
    }
    throw err;
  }

  return url;
}

/**
 * Non-throwing form, for filtering a list where one bad entry must not fail the
 * whole operation (the allowlist emit).
 */
export async function isPublicUrl(rawUrl: string, options: AssertPublicUrlOptions = {}): Promise<boolean> {
  try {
    await assertPublicUrl(rawUrl, options);
    return true;
  } catch {
    return false;
  }
}
