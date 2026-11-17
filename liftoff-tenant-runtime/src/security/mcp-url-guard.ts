// MCP URL Guard + Vendor Tool-Spec Sanitizer (Phase 4C)
//
// Defense-in-depth around vendor MCP servers. The attacker we're worried
// about is a vendor that returns a malicious tool manifest or URL, or an
// admin-registered URL that gets mutated to point somewhere it shouldn't —
// credentials get sent, destructive tools get executed, etc.
//
// This module provides:
//   1. A COMPILE-TIME-FROZEN allow-list of vendor MCP URLs with exact host
//      match (no wildcards for vendor-hosted; wildcards are permitted only
//      for self-hosted Cloud Run sidecars which we control).
//   2. TLS certificate pinning per vendor (SPKI hash allow-list). Callers
//      wire this into Node's `checkServerIdentity`.
//   3. URL validator that rejects: userinfo, non-https scheme, IP literals,
//      private CIDRs, IPv6 literals, redirects to non-allow-listed hosts.
//   4. Redirect policy: deny-by-default. Callers can pass `allowRedirects=false`
//      to node's fetch / got / axios.
//   5. Tool-spec sanitizer: caps size (32KB), validates JSON Schema
//      structure, strips descriptions containing suspicious injection
//      patterns.
//
// The existing `validateMCPUrl` in connectors/mcp-server-registry.ts
// delegates to this module going forward. Both exports remain valid so
// existing callers don't need a bulk rename.

import ipaddr from 'ipaddr.js';
import { logger } from '../infrastructure/logging';

/**
 * Compile-time-frozen vendor allow-list. Exact hostname match only — no
 * wildcards. Adding a vendor requires a code change AND review. The Map
 * keys to per-vendor metadata (TLS pins, etc.) so callers have one source
 * of truth.
 *
 * Self-hosted sidecars (*.run.app, localhost) are handled separately
 * below since their pinning story differs (GCP rotates Cloud Run certs).
 */
export interface VendorMcpPolicy {
  /** Exact hostname. Never wildcard. */
  hostname: string;
  /** Accepted scheme. Vendor MCP is always https. */
  scheme: 'https';
  /** SPKI SHA-256 hashes (base64) of acceptable leaf certificates for this
   *  vendor. `[]` means no pinning (allowed transitionally during rollout,
   *  but MUST be populated for production vendors before Phase 5). */
  spkiPinsSha256: string[];
  /** Whether redirects are allowed. Default: false. */
  allowRedirects?: boolean;
}

// SPKI pins extracted via: openssl s_client | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
// Wave 2 pins (linear, asana, calendly, paypal, datadog, sentry) extracted the same way.
// Re-run scripts/ops/extract-spki-pins.sh and update if vendor rotates their certificate.
const VENDOR_POLICIES: ReadonlyArray<VendorMcpPolicy> = Object.freeze([
  Object.freeze({ hostname: 'mcp.stripe.com',    scheme: 'https' as const, spkiPinsSha256: ['bjH7UE/zcOuWyzYg24GHmzht0/FekVM02SUGD77Ju7s='] }),
  Object.freeze({ hostname: 'mcp.hubspot.com',   scheme: 'https' as const, spkiPinsSha256: ['NCZ2UNGE9xDV+soIxPlhDvql8zvlFMuiVd30+qxmfXs='] }),
  Object.freeze({ hostname: 'api.github.com',    scheme: 'https' as const, spkiPinsSha256: ['tt9RksdSBGiieTiyWkU8g3MOmCrfMcvXDGC4ZALs9rg='] }),
  Object.freeze({ hostname: 'mcp.github.com',    scheme: 'https' as const, spkiPinsSha256: ['47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='] }),
  Object.freeze({ hostname: 'mcp.notion.com',    scheme: 'https' as const, spkiPinsSha256: ['91adLgkcAyDSP/X5YRaMNjOyYp+ks1JOofHh2AbKJbY='] }),
  Object.freeze({ hostname: 'mcp.intuit.com',    scheme: 'https' as const, spkiPinsSha256: ['upeZ3DohHiUvB6+NkEOjmwUOoarmDzLkL8Vfu1TVRv4='] }),
  Object.freeze({ hostname: 'mcp.xero.com',      scheme: 'https' as const, spkiPinsSha256: ['iaRdwBEArkaBWKR+B53H2+DhLNuPwgnYIdybgAgaCeg='] }),
  Object.freeze({ hostname: 'mcp.intercom.com',  scheme: 'https' as const, spkiPinsSha256: ['xONUp1kiIDTBPI4BN2Lpl173Jp/UCWkFrPcwzAXpcjw='] }),
  Object.freeze({ hostname: 'mcp.linear.app',    scheme: 'https' as const, spkiPinsSha256: ['uRi3Gvr0JVb5HRhkDEL1wmAiXZcc8ZiIImy392i8B5c='] }),
  Object.freeze({ hostname: 'mcp.asana.com',     scheme: 'https' as const, spkiPinsSha256: ['mTsaluyl3kIOtd9g3xTc/BOwFGqptxEXfITV7Tns29Q='] }),
  Object.freeze({ hostname: 'mcp.calendly.com',  scheme: 'https' as const, spkiPinsSha256: ['7tcCHgyxwKJiGmgPRqsJd4xZBxlM7N1EHNO/NKdua8M='] }),
  Object.freeze({ hostname: 'mcp.paypal.com',    scheme: 'https' as const, spkiPinsSha256: ['CLMTDuEXhqTGceln4WOWPLNnNh8nvjgXLlYEul4WElo='] }),
  Object.freeze({ hostname: 'mcp.datadoghq.com', scheme: 'https' as const, spkiPinsSha256: ['G8l8Z5d/Gkkv2JgOnxnxY1l266aT3Z/29GJQSGWRzV0='] }),
  Object.freeze({ hostname: 'mcp.sentry.dev',    scheme: 'https' as const, spkiPinsSha256: ['7xVXgohZlkp5r2Oletz7urRwMvDCPj+SGVBKFks/SgA='] }),
]);

/**
 * Self-hosted sidecar suffix allow-list. These are wildcarded because we
 * run one Cloud Run service per vendor and the host changes per region /
 * revision. localhost is for dev sidecars only — we additionally require
 * the loopback check below to succeed.
 */
const SELF_HOSTED_SUFFIXES = Object.freeze(['.run.app']);
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1']);

/**
 * Reasons a URL can be rejected. Stable string codes for tests and alerts.
 */
export type McpUrlRejectionReason =
  | 'malformed_url'
  | 'userinfo_not_allowed'
  | 'ipv6_literal'
  | 'ip_literal'
  | 'private_or_reserved_ip'
  | 'non_https'
  | 'host_not_allowed'
  | 'redirect_off_allowlist';

export class McpUrlRejected extends Error {
  public readonly reason: McpUrlRejectionReason;
  public readonly url: string;
  constructor(reason: McpUrlRejectionReason, url: string, detail?: string) {
    super(`MCP URL rejected [${reason}]: ${url}${detail ? ` — ${detail}` : ''}`);
    this.name = 'McpUrlRejected';
    this.reason = reason;
    this.url = url;
  }
}

/**
 * Get the policy for a host, or undefined if it's not vendor-hosted.
 * Exported so callers (e.g. TLS agent factories) can look up pinning info.
 */
export function getVendorPolicy(hostname: string): VendorMcpPolicy | undefined {
  return VENDOR_POLICIES.find((p) => p.hostname === hostname);
}

function isSelfHostedSidecar(hostname: string): boolean {
  if (LOOPBACK_HOSTS.includes(hostname)) return true;
  return SELF_HOSTED_SUFFIXES.some((s) => hostname.endsWith(s));
}

function isPrivateOrReservedIpV4(hostname: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  try {
    const addr = ipaddr.parse(hostname);
    if (addr.kind() !== 'ipv4') return false;
    const range = (addr as ipaddr.IPv4).range();
    // Reject anything that isn't unicast public.
    // `ipaddr.js` ranges: "private", "loopback", "linkLocal", "carrierGradeNat",
    // "broadcast", "reserved", "unspecified", "multicast", "unicast".
    return range !== 'unicast';
  } catch {
    return false;
  }
}

/**
 * Per-tenant snapshot of explicitly-registered MCP URLs.
 *
 * Sourced from platform-backend's internal allowlist endpoint
 * (custom_mcp_servers.endpoint_url, external_agents.endpoint_url, and
 * mcp_tunnel_routes.public_url). Refreshed on Pub/Sub event or 60s TTL by
 * src/security/tenant-allowlist-provider.ts.
 *
 * Matching is exact normalized URL — the entry must be present byte-for-byte
 * (case-insensitive scheme/host, trailing-slash normalized) for a URL to be
 * accepted via this path. Wildcards are intentionally not supported.
 */
export interface TenantAllowlistContext {
  tenantId: string;
  /** Allowed URLs, exact-match. */
  urls: ReadonlyArray<string>;
  /** Snapshot version tag (from the backend). Used for cache short-circuit. */
  version: string;
}

function normalizeForAllowlist(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Lowercase scheme + host; drop trailing slash on bare pathnames.
    const scheme = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase();
    const port = u.port ? `:${u.port}` : '';
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return `${scheme}//${host}${port}${pathname}${u.search}`;
  } catch {
    return rawUrl;
  }
}

function matchesTenantAllowlist(rawUrl: string, ctx: TenantAllowlistContext | undefined): boolean {
  if (!ctx) return false;
  // Defensive: an empty / malformed snapshot must NEVER accept a URL. The
  // provider always stamps tenantId; a missing or non-string value means the
  // call site constructed the context wrong (e.g. passed a placeholder or
  // unrelated object) — fail closed rather than admit URLs by accident.
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.length === 0) return false;
  if (!Array.isArray(ctx.urls)) return false;
  const target = normalizeForAllowlist(rawUrl);
  for (const entry of ctx.urls) {
    if (typeof entry !== 'string') continue;
    if (normalizeForAllowlist(entry) === target) return true;
  }
  return false;
}

/**
 * Caller-asserted cross-tenant safety. Throws if the snapshot's tenantId
 * doesn't match the caller's expected tenantId. Call from tool-gateway dispatch
 * paths immediately after fetching the snapshot:
 *
 *   const allow = await provider.get(tenantId);
 *   assertAllowlistMatchesTenant(allow, tenantId);
 *
 * This is structural defense-in-depth on top of the provider's per-tenant
 * keying — if a refactor ever lands a wrong snapshot in a wrong dispatch
 * path the assertion catches it before any URL is opened.
 */
export function assertAllowlistMatchesTenant(
  ctx: TenantAllowlistContext | undefined,
  expectedTenantId: string,
): void {
  if (!ctx) return; // No snapshot is fine — guard will fall through to vendor/sidecar paths only.
  if (ctx.tenantId !== expectedTenantId) {
    throw new Error(
      `tenant allowlist snapshot mismatch: snapshot is for ${ctx.tenantId}, caller expected ${expectedTenantId}`,
    );
  }
}

/**
 * Validate an MCP URL against the policy. Returns a parsed URL object on
 * success. Throws McpUrlRejected on failure.
 *
 * The vendor allowlist + self-hosted sidecar suffix list is compile-time
 * frozen (additive only via code review). The optional tenantAllowlist is
 * the per-tenant DB-backed layer that covers Custom MCP Servers, External
 * Collaborators, and the tunnel routes under TUNNEL_BASE_DOMAIN — each must be
 * an exact-match registered URL for that tenant.
 *
 * Callers in production path should ALWAYS go through this — never call
 * fetch() on a raw vendor URL.
 */
export function assertMcpUrlAllowed(
  rawUrl: string,
  tenantAllowlist?: TenantAllowlistContext,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new McpUrlRejected('malformed_url', rawUrl);
  }

  if (parsed.username || parsed.password) {
    throw new McpUrlRejected('userinfo_not_allowed', rawUrl);
  }

  const hostname = parsed.hostname;

  if (hostname.startsWith('[') || hostname.endsWith(']')) {
    throw new McpUrlRejected('ipv6_literal', rawUrl);
  }
  if (hostname.includes(':')) {
    throw new McpUrlRejected('ipv6_literal', rawUrl);
  }

  // IP literals — allow the loopback list ONLY if dev mode and self-hosted
  // sidecar. Anything else (including 0.0.0.0, 169.254.x.x metadata, 10.x,
  // 172.16-31.x, 192.168.x, 127.x non-loopback names, etc.) is rejected.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (LOOPBACK_HOSTS.includes(hostname)) {
      // fall through — allowed only if scheme check passes
    } else if (isPrivateOrReservedIpV4(hostname)) {
      throw new McpUrlRejected('private_or_reserved_ip', rawUrl, `${hostname} is private/reserved`);
    } else {
      // Public IPv4 literal — still reject, we only do hostnames.
      throw new McpUrlRejected('ip_literal', rawUrl);
    }
  }

  // Scheme check. Vendor is always https. Sidecars + tenant allowlist: https.
  // http tolerated for localhost dev only.
  if (parsed.protocol !== 'https:') {
    const isDevLoopback = LOOPBACK_HOSTS.includes(hostname) && parsed.protocol === 'http:';
    if (!isDevLoopback) {
      throw new McpUrlRejected('non_https', rawUrl);
    }
  }

  const isVendor = getVendorPolicy(hostname) !== undefined;
  const isSidecar = isSelfHostedSidecar(hostname);
  const isTenantAllowed = matchesTenantAllowlist(rawUrl, tenantAllowlist);

  if (!isVendor && !isSidecar && !isTenantAllowed) {
    throw new McpUrlRejected('host_not_allowed', rawUrl, hostname);
  }

  return parsed;
}

/**
 * Validate a redirect target. Same rules as the primary URL — no off-list
 * hosts, no downgrade to http, no IP literals. Deny-by-default.
 */
export function assertMcpRedirectAllowed(
  fromUrl: string,
  toUrl: string,
  tenantAllowlist?: TenantAllowlistContext,
): URL {
  try {
    return assertMcpUrlAllowed(toUrl, tenantAllowlist);
  } catch (err) {
    if (err instanceof McpUrlRejected) {
      throw new McpUrlRejected('redirect_off_allowlist', toUrl, `redirect from ${fromUrl}: ${err.reason}`);
    }
    throw err;
  }
}

/**
 * Boolean-returning wrapper for backwards compat with the existing
 * `validateMCPUrl(url): boolean` callers. Logs the rejection reason and
 * returns false instead of throwing.
 */
export function isMcpUrlAllowed(rawUrl: string, tenantAllowlist?: TenantAllowlistContext): boolean {
  try {
    assertMcpUrlAllowed(rawUrl, tenantAllowlist);
    return true;
  } catch (err) {
    if (err instanceof McpUrlRejected) {
      logger.warn('mcp_url_rejected', { url: rawUrl, reason: err.reason });
    }
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Vendor tool-spec sanitizer.
// ────────────────────────────────────────────────────────────────────────

/** Max size of a single tool spec we will accept. 32KB. */
export const MAX_TOOL_SPEC_BYTES = 32 * 1024;

/**
 * Patterns that trigger description stripping. These match common
 * indirect-prompt-injection payloads where a vendor tool description tries
 * to get the LLM to do something out-of-band. We err on the side of
 * aggressive redaction — the description is LLM-facing text, not a protocol
 * field, so losing information there is safe.
 */
const SUSPICIOUS_DESCRIPTION_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(the\s+)?system\s+prompt/i,
  /<\s*system\s*>/i,
  /\[\[\s*system\s*\]\]/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions?\s*:/i,
  /role\s*:\s*system/i,
  /```\s*(system|assistant)/i,
]);

export interface SanitizedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  warnings: string[];
}

export class VendorToolSpecRejected extends Error {
  public readonly reason:
    | 'oversized'
    | 'missing_name'
    | 'invalid_name'
    | 'missing_schema'
    | 'schema_not_object'
    | 'schema_too_complex';
  constructor(reason: VendorToolSpecRejected['reason'], message: string) {
    super(message);
    this.name = 'VendorToolSpecRejected';
    this.reason = reason;
  }
}

/**
 * Validate and sanitize a single tool spec returned by a vendor MCP server.
 * Treats the input as UNTRUSTED.
 *
 *   - Size cap (MAX_TOOL_SPEC_BYTES).
 *   - Name must exist and be alnum / underscore / hyphen, length <=64.
 *   - Description string patterns that look like prompt injections are
 *     replaced with a generic description and a warning is attached.
 *   - inputSchema must be a plain object. JSON Schema structural sanity
 *     check: `type` field is a string; `properties` is an object if present.
 *     No deep schema compilation here — that happens in the existing
 *     registry-validator path.
 */
export function sanitizeVendorTool(raw: unknown): SanitizedTool {
  const warnings: string[] = [];

  // Size gate — serialize to measure. JSON.stringify round-trips functions
  // to undefined, so there's no risk of a prototype-pollution path here.
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new VendorToolSpecRejected('schema_too_complex', 'tool spec not serialisable');
  }
  if (serialized.length > MAX_TOOL_SPEC_BYTES) {
    throw new VendorToolSpecRejected(
      'oversized',
      `tool spec exceeds ${MAX_TOOL_SPEC_BYTES} bytes (${serialized.length})`,
    );
  }

  if (!raw || typeof raw !== 'object') {
    throw new VendorToolSpecRejected('missing_schema', 'tool spec is not an object');
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== 'string') {
    throw new VendorToolSpecRejected('missing_name', 'tool name missing or not a string');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(obj.name)) {
    throw new VendorToolSpecRejected(
      'invalid_name',
      `tool name fails strict pattern: ${obj.name}`,
    );
  }

  const descRaw = typeof obj.description === 'string' ? obj.description : '';
  let description = descRaw;
  for (const pattern of SUSPICIOUS_DESCRIPTION_PATTERNS) {
    if (pattern.test(description)) {
      warnings.push(`description_matched_injection_pattern:${pattern.source}`);
      description = '[description stripped: matched prompt-injection heuristic]';
      break;
    }
  }
  // Also truncate very long descriptions — LLMs pay per token.
  const MAX_DESCRIPTION_CHARS = 2048;
  if (description.length > MAX_DESCRIPTION_CHARS) {
    warnings.push(`description_truncated_from_${description.length}`);
    description = description.slice(0, MAX_DESCRIPTION_CHARS);
  }

  const schema = obj.inputSchema ?? obj.input_schema;
  if (!schema || typeof schema !== 'object') {
    throw new VendorToolSpecRejected(
      'missing_schema',
      'tool spec missing inputSchema',
    );
  }
  if (Array.isArray(schema)) {
    throw new VendorToolSpecRejected(
      'schema_not_object',
      'tool spec inputSchema is an array, expected object',
    );
  }
  const schemaObj = schema as Record<string, unknown>;
  if (schemaObj.type !== undefined && typeof schemaObj.type !== 'string' && !Array.isArray(schemaObj.type)) {
    throw new VendorToolSpecRejected(
      'schema_not_object',
      'tool spec inputSchema.type is not a string or array of strings',
    );
  }
  if (schemaObj.properties !== undefined && (typeof schemaObj.properties !== 'object' || Array.isArray(schemaObj.properties))) {
    throw new VendorToolSpecRejected(
      'schema_not_object',
      'tool spec inputSchema.properties is not an object',
    );
  }

  return {
    name: obj.name,
    description,
    inputSchema: schemaObj,
    warnings,
  };
}

/**
 * Sanitize an array of tool specs. Rejected entries are dropped with a
 * warning logged; the manifest-level call site should refuse to register
 * a server that has too many rejected entries (policy decided upstream).
 */
export function sanitizeVendorTools(raw: unknown[]): SanitizedTool[] {
  const out: SanitizedTool[] = [];
  for (const entry of raw) {
    try {
      out.push(sanitizeVendorTool(entry));
    } catch (err) {
      if (err instanceof VendorToolSpecRejected) {
        logger.warn('vendor_tool_spec_rejected', {
          reason: err.reason,
          message: err.message,
        });
        continue;
      }
      throw err;
    }
  }
  return out;
}
