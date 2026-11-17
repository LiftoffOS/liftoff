// Transport-level SSRF guard (E1).
//
// Every fetch in this package targets an endpoint that ultimately came from a
// tenant — a custom MCP server they registered, or an external agent they
// pointed us at. The control plane validates those at registration, but this
// package is the last line before a socket is opened, and it is reachable from
// callers that were not part of that flow.
//
// Self-contained on purpose: this package is published and consumed on its own,
// so it cannot reach into the control plane's src/common. The logic mirrors
// src/common/url-guard.ts; keep the two in step.

import dns from 'dns/promises';
import net from 'net';

const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return ipv4Blocked(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Blocked(mapped[1]);
    const firstHextet = parseInt(lower.split(':')[0] || '', 16);
    if (!Number.isNaN(firstHextet)) {
      const highByte = firstHextet >> 8;
      if (highByte === 0xfc || highByte === 0xfd) return true;
      if ((firstHextet & 0xffc0) === 0xfe80) return true;
    }
    return false;
  }
  return true;
}

/**
 * Throw when an endpoint must not be dialled. Called once at transport
 * construction, which covers every fetch the transport goes on to make.
 */
export async function assertEndpointAllowed(endpointUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw new Error('MCP endpoint URL could not be parsed');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`MCP endpoint scheme ${url.protocol} is not allowed`);
  }

  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (ALWAYS_BLOCKED_HOSTNAMES.has(host)) {
    throw new Error('MCP endpoint points at a cloud metadata endpoint');
  }

  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch (err) {
    throw new Error(`MCP endpoint host did not resolve: ${(err as Error).message}`, { cause: err });
  }
  if (addresses.length === 0) throw new Error('MCP endpoint host did not resolve');
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new Error(`MCP endpoint resolves to a blocked address (${addr})`);
    }
  }
}
