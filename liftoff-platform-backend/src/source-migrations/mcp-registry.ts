// Liftoff Switch — the official MCP Registry, read-only.
//
// An imported stdio MCP server is a local wrapper: a program on someone's
// laptop that forwards to an API. We cannot run their laptop, and the question
// worth asking is not how to emulate it but WHICH capability it is and where
// that capability lives on our side.
//
// The registry answers exactly that. Every entry declares its `packages` (the
// exact npm / pypi / oci identity, so matching is equality rather than a guess
// at a command line) and its `remotes` (an endpoint the vendor hosts). Reading
// it live is what keeps this from being a hand-written compatibility table that
// is a stale snapshot of a moving ecosystem the day it ships.
//
// Everything here is INCONCLUSIVE on failure. A registry that cannot be reached
// knows nothing about the server, so the import degrades to what it did before
// this module existed — a Requires hosting card — and never blocks on it.
//
// Registry data is external input and is validated at the edge with zod, the
// same discipline the uploaded bundle gets.

import { z } from 'zod';
import { log } from '../infrastructure/logging';
import type { McpPackageIdentity, McpPackageRegistryType } from './types';

export type { McpPackageIdentity, McpPackageRegistryType };

const DEFAULT_REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';

/** Cache TTL for a registry answer. Short: the registry is the authority and a
 *  server gains a hosted endpoint without telling us. Long enough that one
 *  import with twenty stdio servers does not make twenty round trips for the
 *  same package. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-request ceiling. A registry that has become slow must not hold a bundle
 *  upload open: the answer is optional, the upload is not. */
const REQUEST_TIMEOUT_MS = 4_000;

/** How many hits to consider per search. The registry's `search` is a substring
 *  match on the server NAME — verified against its own OpenAPI description,
 *  which offers no package filter — so the exact package comparison below is
 *  what actually decides. This only bounds how much we read per term. */
const SEARCH_LIMIT = 50;

/** How many derived search terms to try before giving up.
 *
 *  A package identifier and a registry server name are different vocabularies
 *  (`@aaronsb/slack-mcp` lives at `io.github.aaronsb/slack-mcp`), so the
 *  identifier is reduced to progressively broader terms. Bounded hard: a miss
 *  is an accepted outcome that costs the user nothing, and an unbounded search
 *  would spend a bundle upload's latency proving a negative. */
const MAX_SEARCH_TERMS = 4;

/** What a resolution can find. `remotes` is the half that changes an import:
 *  an endpoint the vendor hosts is reachable from Liftoff, the customer's
 *  laptop copy is not. */
export interface RegistryServerMatch {
  /** Reverse-DNS registry identity, e.g. `io.github.acme/mcp-server`. */
  serverName: string;
  remotes: Array<{ type: string; url: string }>;
  /** Every package the matched server declares, comparison-normalized. Lets a
   *  caller recognise a server by a DIFFERENT package than the one that was
   *  looked up — the same server published to npm and to a container registry
   *  is one capability, not two. */
  packages: McpPackageIdentity[];
}

/** Compare two package identifiers.
 *
 *  OCI identifiers carry their version in the string (`ghcr.io/acme/x:1.0.3`),
 *  so comparing them literally asks whether the user pinned the same TAG we
 *  did, which is not the question. npm and pypi keep the version in a separate
 *  field and are compared as written. */
export function normalizePackageName(
  registryType: McpPackageRegistryType,
  name: string,
): string {
  if (registryType !== 'oci') return name.trim();
  const withoutDigest = name.trim().split('@')[0];
  const lastSegment = withoutDigest.split('/').pop() ?? withoutDigest;
  // Only strip a trailing `:tag`; a registry host may carry a `:port`, which
  // lives in an earlier segment and must survive.
  const tagIndex = lastSegment.lastIndexOf(':');
  if (tagIndex <= 0) return withoutDigest;
  return withoutDigest.slice(0, withoutDigest.length - (lastSegment.length - tagIndex));
}

// ── response schemas ───────────────────────────────────────────────────

/** Deliberately loose about fields we do not read: the registry adds fields
 *  over time and a strict schema would turn every addition into an outage of
 *  this path. Strict about the two things we DO read. */
const packageSchema = z
  .object({
    registryType: z.string().optional(),
    identifier: z.string().optional(),
  })
  .passthrough();

const remoteSchema = z
  .object({
    type: z.string(),
    url: z.string().url(),
  })
  .passthrough();

const serverSchema = z
  .object({
    name: z.string(),
    version: z.string().optional(),
    packages: z.array(packageSchema).optional(),
    remotes: z.array(remoteSchema).optional(),
  })
  .passthrough();

const listResponseSchema = z
  .object({
    servers: z.array(
      z
        .object({
          server: serverSchema,
          _meta: z.unknown().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

// ── cache ──────────────────────────────────────────────────────────────

interface CacheEntry {
  value: RegistryServerMatch | null;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(identity: McpPackageIdentity): string {
  return `${identity.registryType}:${identity.name}`;
}

/** Test-only: a test must not inherit another test's cached answer. */
export function _clearMcpRegistryCache(): void {
  cache.clear();
}

function registryBaseUrl(): string {
  return process.env.MCP_REGISTRY_BASE_URL || DEFAULT_REGISTRY_BASE_URL;
}

// ── lookup ─────────────────────────────────────────────────────────────

/** Find the registry entry that declares this exact package.
 *
 *  Returns null for "no entry", "the entry declares no hosted endpoint" and
 *  "the registry could not be reached" alike, because all three lead to the
 *  same place: the requirement stays a hosting card. The caller distinguishes
 *  them for diagnostics only, from `lookupFailed`. */
export async function lookupServerByPackage(
  identity: McpPackageIdentity,
): Promise<{ match: RegistryServerMatch | null; lookupFailed: boolean }> {
  const key = cacheKey(identity);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return { match: hit.value, lookupFailed: false };
  }

  let match: RegistryServerMatch | null = null;
  for (const term of searchTerms(identity)) {
    const page = await searchByName(term, key);
    if (page === null) return { match: null, lookupFailed: true };

    match = pickExactPackageMatch(page, identity);
    if (match) break;
  }

  cache.set(key, { value: match, cachedAt: Date.now() });
  return { match, lookupFailed: false };
}

/** One search request. Returns null when the registry could not answer, which
 *  the caller must treat as inconclusive rather than as "no such server". */
async function searchByName(
  term: string,
  logKey: string,
): Promise<Array<z.infer<typeof serverSchema>> | null> {
  let payload: unknown;
  try {
    // `version=latest` because the registry returns every published version of
    // a server, and an older version's endpoint is not the current truth about
    // where that capability lives.
    const query = new URLSearchParams({
      search: term,
      version: 'latest',
      limit: String(SEARCH_LIMIT),
    });
    const response = await fetch(`${registryBaseUrl()}/v0/servers?${query.toString()}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status, package: logKey },
        'source-migrations: MCP registry lookup returned a non-OK status; treating as inconclusive',
      );
      return null;
    }
    payload = await response.json();
  } catch (err) {
    log.warn(
      { err: (err as Error).message, package: logKey },
      'source-migrations: MCP registry unreachable; treating as inconclusive',
    );
    return null;
  }

  const parsed = listResponseSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn(
      { package: logKey },
      'source-migrations: MCP registry response did not match the expected shape; treating as inconclusive',
    );
    return null;
  }

  return parsed.data.servers.map((s) => s.server);
}

/** Progressively broader name searches derived from a package identifier.
 *
 *  The registry indexes server NAMES, and a server name rarely contains the
 *  package identifier verbatim: `@aaronsb/slack-mcp` is published by
 *  `io.github.aaronsb/slack-mcp`, and `slack-workspace-mcp-server` by
 *  `com.pulsemcp/slack`. Each step drops another package-naming convention
 *  until what is left is the capability word the server is likely named for. */
export function searchTerms(identity: McpPackageIdentity): string[] {
  const terms: string[] = [];
  const add = (t: string): void => {
    const trimmed = t.trim();
    if (trimmed.length > 1 && !terms.includes(trimmed)) terms.push(trimmed);
  };

  const normalized = normalizePackageName(identity.registryType, identity.name);

  // The identifier as written, for a server named exactly after its package.
  if (identity.registryType !== 'oci') add(normalized);

  // Without the npm scope or the container registry path.
  const base = normalized.startsWith('@')
    ? normalized.slice(normalized.indexOf('/') + 1)
    : (normalized.split('/').pop() ?? normalized);
  add(base);

  // Without the MCP affixes almost every package in this ecosystem carries.
  let stripped = base;
  for (const prefix of ['mcp-server-', 'mcp-', 'server-']) {
    if (stripped.startsWith(prefix)) stripped = stripped.slice(prefix.length);
  }
  for (const suffix of ['-mcp-server', '-mcp', '-server']) {
    if (stripped.endsWith(suffix)) stripped = stripped.slice(0, -suffix.length);
  }
  add(stripped);

  // The leading word, which is what a vendor-named server is usually called.
  add(stripped.split('-')[0]);

  return terms.slice(0, MAX_SEARCH_TERMS);
}

/** Exact match on a declared package, never on the search ranking.
 *
 *  The search is a substring match over names, so its hits are routinely
 *  different servers that merely share a word. Only an entry that DECLARES
 *  this registry type and this package is this package. */
function pickExactPackageMatch(
  servers: Array<z.infer<typeof serverSchema>>,
  identity: McpPackageIdentity,
): RegistryServerMatch | null {
  const wanted = normalizePackageName(identity.registryType, identity.name);

  const candidates = servers.filter((server) =>
    declaredPackages(server).some(
      (pkg) => pkg.registryType === identity.registryType && pkg.name === wanted,
    ),
  );
  if (candidates.length === 0) return null;

  // Prefer a candidate that actually carries a hosted endpoint: the endpoint is
  // the only field this resolution can act on.
  const chosen = candidates.find((c) => (c.remotes ?? []).length > 0) ?? candidates[0];

  return {
    serverName: chosen.name,
    remotes: (chosen.remotes ?? []).map((r) => ({ type: r.type, url: r.url })),
    packages: declaredPackages(chosen),
  };
}

/** The server's packages, reduced to the identities this module compares. */
function declaredPackages(server: z.infer<typeof serverSchema>): McpPackageIdentity[] {
  const out: McpPackageIdentity[] = [];
  for (const pkg of server.packages ?? []) {
    if (typeof pkg.identifier !== 'string' || typeof pkg.registryType !== 'string') continue;
    const registryType = pkg.registryType.toLowerCase();
    if (registryType !== 'npm' && registryType !== 'pypi' && registryType !== 'oci') continue;
    out.push({ registryType, name: normalizePackageName(registryType, pkg.identifier) });
  }
  return out;
}
