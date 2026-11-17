// SSRF (Server-Side Request Forgery) guard for fetch-style tool inputs.
//
// When an agent's trigger is `untrusted_inbound` (i.e. a public webhook),
// any tool input that contains a URL must be validated to ensure the LLM
// can't be coerced into hitting private / metadata-server endpoints on
// behalf of the platform.
//
// Reuses the same private-IP detection as the MCP URL guard so we have one
// canonical "is this address sensitive" implementation. Hostname → IP
// resolution is intentionally NOT performed here — DNS rebinding mitigation
// belongs in the fetch layer (with `lookup` overrides), not at policy
// declaration time. This helper rejects literal IP addresses in the
// dangerous ranges and the well-known metadata hostnames.

import ipaddr from 'ipaddr.js';

export type SsrfRejectionReason =
  | 'malformed_url'
  | 'non_http_scheme'
  | 'private_or_reserved_ip'
  | 'metadata_hostname';

export class SsrfTargetRejected extends Error {
  public readonly reason: SsrfRejectionReason;
  public readonly target: string;
  constructor(reason: SsrfRejectionReason, target: string, detail?: string) {
    super(`SSRF target rejected [${reason}]: ${target}${detail ? ` — ${detail}` : ''}`);
    this.name = 'SsrfTargetRejected';
    this.reason = reason;
    this.target = target;
  }
}

// Hostnames hard-blocked because they resolve to instance-metadata services
// on the cloud providers we care about. DNS rebinding mitigations would
// otherwise have to handle each provider's metadata endpoint individually.
const BLOCKED_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata',                      // shorthand used inside GCE VMs
  'instance-data.ec2.internal',
  'metadata.azure.com',
]);

function isPrivateOrReservedIp(hostname: string): boolean {
  // IPv4 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    try {
      const addr = ipaddr.parse(hostname);
      if (addr.kind() !== 'ipv4') return false;
      const range = (addr as ipaddr.IPv4).range();
      // Allow only globally-routable unicast addresses.
      return range !== 'unicast';
    } catch {
      return true; // unparseable IP literal → treat as unsafe
    }
  }
  // IPv6 literal (URL.hostname strips brackets, so this catches the bare form)
  if (hostname.includes(':')) {
    try {
      const addr = ipaddr.parse(hostname);
      if (addr.kind() !== 'ipv6') return false;
      const range = (addr as ipaddr.IPv6).range();
      return range !== 'unicast';
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Throws SsrfTargetRejected when `url` points at a private / loopback /
 * link-local / metadata-server endpoint. Returns the parsed URL on success.
 *
 * Use from any tool implementation that takes a URL parameter when the
 * invocation's trust level is `untrusted_inbound`. Trusted invocations
 * (cron, human-initiated, internal agent → agent) are not gated by this
 * function — the caller is responsible for matching the gate to the trust
 * level.
 */
export function assertNotSsrfTarget(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfTargetRejected('malformed_url', rawUrl);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfTargetRejected('non_http_scheme', rawUrl, parsed.protocol);
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTNAMES.has(host)) {
    throw new SsrfTargetRejected('metadata_hostname', rawUrl, host);
  }
  if (isPrivateOrReservedIp(host)) {
    throw new SsrfTargetRejected('private_or_reserved_ip', rawUrl, host);
  }
  return parsed;
}

/** Boolean wrapper for call sites that prefer no-throw. */
export function isSafeFetchTarget(rawUrl: string): boolean {
  try {
    assertNotSsrfTarget(rawUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks an arbitrary tool-input payload and validates any field that looks
 * like a URL when the invocation is `untrusted_inbound`. Returns the list of
 * rejected URLs (with reasons) — empty array means clean. The caller decides
 * what to do with the list; the typical pattern is to short-circuit the tool
 * call with an error when the list is non-empty.
 *
 * URL detection is conservative: only string values whose first chars are
 * http:// or https://. Tools that hide URLs inside opaque tokens (e.g.,
 * encrypted ids) aren't covered — those are out of scope for this gate.
 */
export interface RejectedUrl {
  reason: SsrfRejectionReason;
  target: string;
}

export function scanPayloadForUnsafeUrls(payload: unknown): RejectedUrl[] {
  const rejected: RejectedUrl[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (v.startsWith('http://') || v.startsWith('https://')) {
        try {
          assertNotSsrfTarget(v);
        } catch (err) {
          if (err instanceof SsrfTargetRejected) {
            rejected.push({ reason: err.reason, target: err.target });
          }
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === 'object') {
      for (const value of Object.values(v as Record<string, unknown>)) visit(value);
    }
  };
  visit(payload);
  return rejected;
}
