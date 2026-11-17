// Fetching the provider's own OpenAPI document, and hashing what came back.
//
// The document is fetched HERE rather than carried through the conversation:
// it is often megabytes, a model must never be asked to relay it faithfully,
// and Phase 8's specification-change job refetches from the same URL and
// compares against the `spec_hash` this produces.
//
// The URL is a tenant-influenced outbound fetch, so it is guarded. Deliberately
// NOT through `oauth/discovery.ts`'s `isAllowedDiscoveryUrl`: that carries a
// compile-time allow-list of vendor domains, and this family exists precisely
// for a provider nobody has added to one.

import crypto from 'node:crypto';
import { logger } from '../infra/logging.js';

/** Hostnames that are never a provider's documentation, whatever they resolve
 *  to. The metadata address is the one that hands out service-account tokens. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

const SPEC_FETCH_TIMEOUT_MS = 20_000;
/** A specification larger than this is not one a connection can carry: the cap
 *  on operations is 200, and a document past this size is describing something
 *  else. */
const SPEC_MAX_BYTES = 8 * 1024 * 1024;

export class SpecFetchError extends Error {
  readonly reason: 'blocked_url' | 'unreachable' | 'too_large' | 'not_json';
  constructor(reason: SpecFetchError['reason'], message: string) {
    super(message);
    this.name = 'SpecFetchError';
    this.reason = reason;
  }
}

/** Is this a URL we are willing to fetch a specification from?
 *
 *  A literal-address check, not a resolving one: closing DNS rebinding needs
 *  connect-time pinning per client, which is not something this module can do
 *  on its own. This is the necessary first layer, stated as such. */
export function isFetchableSpecUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  // An IPv6 literal is never a documentation host and carries its own set of
  // private ranges; refuse the shape rather than enumerate them.
  if (hostname.startsWith('[')) return false;
  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (hostname.endsWith('.internal') || hostname.endsWith('.local')) return false;
  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

export interface FetchedSpec {
  /** The parsed document. */
  document: Record<string, unknown>;
  /** sha256 of the bytes as they arrived. Phase 8 compares against this. */
  hash: string;
}

export async function fetchOpenApiDocument(url: string): Promise<FetchedSpec> {
  if (!isFetchableSpecUrl(url)) {
    throw new SpecFetchError(
      'blocked_url',
      `The specification address ${url} is not one we will read: it must be an https address on a public host.`,
    );
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json, application/yaml;q=0.5, */*;q=0.1' },
      // A redirect can land somewhere the check above would have refused, and
      // re-validating each hop needs a client this module does not own.
      redirect: 'error',
      signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SpecFetchError('unreachable', `The specification at ${url} could not be read: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new SpecFetchError('unreachable', `The specification at ${url} answered ${response.status}.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > SPEC_MAX_BYTES) {
    throw new SpecFetchError('too_large', `The specification at ${url} is larger than a connection can carry.`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // Only JSON. A YAML document is a second parser and a second set of
    // failure modes, and every provider that publishes OpenAPI publishes JSON.
    throw new SpecFetchError('not_json', `The specification at ${url} is not JSON. Give the address of the JSON form of the document.`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new SpecFetchError('not_json', `The specification at ${url} is not an OpenAPI document.`);
  }
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  logger.info({ url, hash, bytes: Buffer.byteLength(text) }, 'custom_api_spec_fetched');
  return { document: document as Record<string, unknown>, hash };
}
