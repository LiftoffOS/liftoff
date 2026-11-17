// §2.1 Audit — identity-fetcher coverage for multi-account labels/dedup.
//
// Maps connectorType -> getOAuthProvider(type) -> fetchersByProvider, and also
// checks COMPOSIO_WHOAMI_TOOLS + api-key-identity-fetchers, excluding
// finch_connect/stackone_connect (own dedup) and 'none'. Emits the true gap
// list (connectors with NO identity resolver) — these are still reconnect-safe
// via Phase 1; a fetcher just adds a label + Connect-button dedup.
//
// Run: ts-node --transpile-only --project scripts/tsconfig.json scripts/audit-fetcher-coverage.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONNECTORS } from '../src/catalog/connectors.js';
import { getOAuthProvider, type ConnectorType } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, '..', 'src', p), 'utf8');

// Provider keys registered in fetchersByProvider (OAuth) + COMPOSIO_WHOAMI_TOOLS.
const idf = src('oauth/identity-fetchers.ts');
const providerKeys = new Set(
  [...idf.slice(idf.indexOf('fetchersByProvider')).matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]),
);
const composioWhoami = new Set(
  [...idf.slice(idf.indexOf('COMPOSIO_WHOAMI_TOOLS')).matchAll(/^\s{2}([a-z_]+):/gm)].map(
    (m) => m[1],
  ),
);
let apiKeyFetchers = new Set<string>();
try {
  const ak = src('oauth/api-key-identity-fetchers.ts');
  apiKeyFetchers = new Set([...ak.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]));
} catch {
  /* file optional */
}

const covered: string[] = [];
const gap: string[] = [];
for (const [type, def] of Object.entries(CONNECTORS)) {
  const kind = def.auth.kind;
  if (kind === 'finch_connect' || kind === 'stackone_connect' || kind === 'none') continue;
  const provider = getOAuthProvider(type as ConnectorType);
  const hasFetcher =
    (provider && providerKeys.has(provider)) ||
    composioWhoami.has(type) ||
    apiKeyFetchers.has(type);
  (hasFetcher ? covered : gap).push(type);
}

console.log(`covered: ${covered.length}  |  GAP (no identity resolver): ${gap.length}\n`);
console.log('GAP (label-less multi-instance; still reconnect-safe):');
console.log(gap.sort().join(', '));
