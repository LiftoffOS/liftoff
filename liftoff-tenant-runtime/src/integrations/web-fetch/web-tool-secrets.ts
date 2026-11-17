// Web-tool vendor API keys live in YOUR_GCP_PROJECT, NOT in
// each tenant project. These keys are Liftoff-owned (one key per vendor per
// env, billed to a single Liftoff account); they aren't tenant-scoped like
// connector OAuth credentials are, so copying them into every tenant project
// at provisioning time creates N× drift surface for zero isolation benefit.
//
// All vendor clients (webclaw, firecrawl, perplexity, anchor, browserbase)
// and the quota pollers read through `getWebToolSecret(name)`, which builds
// the fully-qualified cross-project Secret Manager resource path and
// delegates to the shared `getSecret()` helper (which already supports
// `projects/…` paths — see infrastructure/secrets.ts:42).
//
// IAM: each tenant-runtime SA receives `secretAccessor` on these 6 source
// secrets via the cross-project IAM grants in the tenant-runtime-template
// Terraform module.

import { getSecret } from '../../infrastructure/secrets';
import {
  cooldownReason,
  selectCredential,
  type PooledCredential,
} from './credential-pool';
import { getConnectorServiceClient } from '../../connectors/connector-service-client';
import { logger } from '../../infrastructure/logging';
import type { CredentialScope } from './credential-scope';

const ENV = process.env.ENVIRONMENT || 'dev';
const PLATFORM_CONTROL_PROJECT = `YOUR_GCP_PROJECT`;

export type WebToolSecretName =
  | 'webclaw-api-key'
  | 'firecrawl-api-key'
  | 'perplexity-api-key'
  | 'anchor-api-key'
  | 'browserbase-api-key'
  | 'browserbase-project-id'
  | 'tavily-api-key'
  | 'exa-api-key'
  | 'openai-api-key'
  | 'google-api-key'
  | 'browser-use-api-key'
  | 'xai-api-key'
  | 'steel-api-key'
  // The Jev classifier's vendor key (src/typesafe/): the same cross-project
  // read steel-api-key takes; the runtime calls the vendor directly.
  | 'typesafe-api-key';

export function getWebToolSecret(name: WebToolSecretName): Promise<string> {
  return getSecret(`projects/${PLATFORM_CONTROL_PROJECT}/secrets/${name}`);
}

// ──────────────────────────────────────────────────────────────────────
// Per-tenant credential resolver for the six BYOK web-tool vendors.
//
// Every tenant brings their own API key for these vendors via a connector
// on /connections. The resolver returns the credential + the connector id
// so the strict clients can carry it into `BYOKVendorError` — the byok-
// error-handler flips the connector to status='error' on classified
// insufficient_funds / invalid_key responses.
//
// Platform-managed vendors (perplexity, openai, google, xai) DO NOT use this
// path — their keys live in YOUR_GCP_PROJECT Secret Manager
// and are read via `getWebToolSecret` above.
// ──────────────────────────────────────────────────────────────────────

export type WebToolVendor =
  | 'firecrawl' | 'anchor_browser' | 'browserbase'
  | 'tavily' | 'exa' | 'webclaw' | 'browser_use' | 'steel'
  // Not a browser or a fetch backend: the 1Password service-account token
  // the saved-login fill reads the shared vault with (integrations/
  // onepassword/). Listed here for the credential pool, the 60 s cache and
  // the BYOK error path; nothing routes a web call to it.
  | 'onepassword';

export const STRICT_WEB_TOOL_VENDORS: readonly WebToolVendor[] = [
  'firecrawl', 'anchor_browser', 'browserbase', 'tavily', 'exa', 'webclaw',
  'browser_use', 'steel', 'onepassword',
];

/** The strict vendors a web call can be routed to: every one but the login
 *  source, which serves the browsers rather than pages. The connected set
 *  feeds the tool palette, the vendor chain and the session vendor choice,
 *  and each of those reads a connected vendor the team is not bound to as
 *  one excluded by the binding (vendor-scope.ts) and says so per call; a
 *  vendor no call can route to must not be counted there. */
export const WEB_ROUTABLE_VENDORS: readonly WebToolVendor[] = STRICT_WEB_TOOL_VENDORS.filter((v) => v !== 'onepassword');

export interface WebToolCredential {
  /** Vendor API key (every BYOK vendor uses this). */
  apiKey: string;
  /** Connector row id (required so BYOKVendorError can carry it to the
   *  byok-error-handler when classified vendor responses fire). */
  connectorId: string;
  /** Extra fields beyond apiKey. Today: browserbase { projectId }. */
  extra: Record<string, string>;
}

export class VendorNotConnected extends Error {
  constructor(public readonly vendor: WebToolVendor) {
    super(`No connected ${vendor} connector for tenant`);
    this.name = 'VendorNotConnected';
  }
}

export class VendorConnectorErrored extends Error {
  constructor(
    public readonly vendor: WebToolVendor,
    public readonly errorCode: string,
  ) {
    super(`${vendor} connector in error state: ${errorCode}`);
    this.name = 'VendorConnectorErrored';
  }
}

interface CacheEntry { value: PooledCredential[]; expiresAt: number; }
const CACHE_TTL_MS = 60_000;
const credentialCache = new Map<string, CacheEntry>();
const credentialCacheKey = (tenantId: string, vendor: WebToolVendor) =>
  `${tenantId}::${vendor}`;

/**
 * Resolve the credential for (tenant, vendor). Strict policy — never falls
 * back to a platform key:
 *   1. Tenant has a connected connector → return credential.
 *   2. Tenant has an errored connector → throw VendorConnectorErrored.
 *   3. Tenant has no connector → throw VendorNotConnected.
 *
 * `scope` says which of the workspace's connectors may serve (credential-
 * scope.ts): the ids the team's binding names, or ANY_CONNECTOR for a path
 * that runs as the workspace. A workspace with two Exa accounts, one of them
 * bound to this team, serves this team from that one; a scope that names ids
 * none of which is usable is VendorNotConnected, exactly as no connector at
 * all is, so the chain moves on rather than borrowing another account.
 *
 * VendorNotConnected should not reach end users in practice — the tool
 * wouldn't have been exposed to the LLM (see expose-tools) unless the
 * vendor was connected at session start. This guards against the connector
 * being disconnected mid-session.
 */
export async function getWebToolCredential(
  tenantId: string,
  vendor: WebToolVendor,
  scope: CredentialScope,
): Promise<WebToolCredential> {
  const pooled = await getWebToolCredentials(tenantId, vendor);
  const allowed = scope.connectorIds;
  const all = allowed ? pooled.filter((c) => allowed.has(c.connectorId)) : pooled;
  if (all.length === 0) {
    logger.info(
      { tenantId, vendor, pooled: pooled.length, allowed: allowed ? [...allowed] : null },
      'web tool credential: no usable connector of this type within the team binding',
    );
    throw new VendorNotConnected(vendor);
  }
  const chosen = selectCredential(all);
  if (!chosen) {
    // Every key this tenant has for this vendor is cooling. The caller raises
    // the same BYOK error it always did, so the person still hears "your
    // account is out of credit" — the pool changed WHEN they hear it, not
    // whether. The reason comes from the first key so the message names a real
    // cause rather than a generic one.
    const reason = cooldownReason(all[0].connectorId);
    logger.warn(
      { tenantId, vendor, keys: all.length, reason },
      'every BYOK key for this vendor is in cooldown',
    );
    throw new VendorConnectorErrored(
      vendor,
      reason === 'exhausted' ? 'byok_insufficient_funds'
        : reason === 'invalid_key' ? 'byok_invalid_key'
          : 'byok_rate_limited',
    );
  }
  return chosen.credential;
}

/**
 * Every usable credential this tenant has for a vendor, in the order the tenant
 * sees them.
 *
 * A tenant that connected two accounts for the same vendor told us something we
 * used to ignore: the resolver took the first connector it found and stayed on
 * it, so when that key hit its limit every run stopped with the second key
 * sitting there, connected and unused.
 *
 * Ordered by creation so "which key gets used" is stable and explicable, rather
 * than whichever happened to be least recently tried.
 */
export async function getWebToolCredentials(
  tenantId: string,
  vendor: WebToolVendor,
): Promise<PooledCredential[]> {
  const k = credentialCacheKey(tenantId, vendor);
  const hit = credentialCache.get(k);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const client = getConnectorServiceClient();
  let list;
  try {
    list = await client.listTenantConnectors({
      tenantContext: { tenantId },
      connectorTypes: [vendor],
      // The connectors table enum is 'pending' | 'active' | 'error' |
      // 'disabled' | 'disconnected'. 'active' is the only state that means
      // "connected and usable"; 'connected' is accepted as a forward-compat
      // alias. 'error' rows are deliberately absent — a key the platform
      // already marked broken should not be tried again by the pool.
      statuses: ['active', 'connected'],
    });
  } catch (err) {
    logger.warn(
      { tenantId, vendor, error: (err as Error).message },
      'getWebToolCredential: connector lookup failed',
    );
    throw new VendorNotConnected(vendor);
  }

  const rows = (list.connectors ?? []).filter((c) => c.connectorType === vendor);
  if (rows.length === 0) throw new VendorNotConnected(vendor);

  const credentials: PooledCredential[] = [];
  for (const row of rows) {
    const cred = await client.getCredentials({
      tenantContext: { tenantId },
      connectorId: row.id,
    }).catch((err: Error) => {
      // One unreadable credential must not cost the tenant the keys that do
      // work — which is the entire point of having more than one.
      logger.warn(
        { tenantId, vendor, connectorId: row.id, error: err.message },
        'getWebToolCredential: could not read one credential; continuing with the rest',
      );
      return null;
    });
    const apiKey = cred?.apiKey?.apiKey;
    if (!apiKey) continue;

    // proto-gen renders google.protobuf.Struct as a plain JsonObject, not a
    // Struct with a .fields wrapper — read the top-level map directly.
    const extra: Record<string, string> = {};
    for (const [field, v] of Object.entries(cred?.apiKey?.extra ?? {})) {
      if (typeof v === 'string') extra[field] = v;
    }
    credentials.push({ apiKey, connectorId: row.id, extra });
  }

  if (credentials.length === 0) throw new VendorNotConnected(vendor);
  credentialCache.set(k, { value: credentials, expiresAt: Date.now() + CACHE_TTL_MS });
  return credentials;
}

/** Returns the set of strict-policy vendors the tenant has connected
 *  (status='connected') that a web call can route to. Perplexity / OpenAI /
 *  Google are NOT in this set — they are platform-managed and always-on —
 *  and neither is the login source (WEB_ROUTABLE_VENDORS). */
export async function getTenantConnectedWebVendors(
  tenantId: string,
): Promise<Set<WebToolVendor>> {
  const client = getConnectorServiceClient();
  const list = await client.listTenantConnectors({
    tenantContext: { tenantId },
    connectorTypes: [...WEB_ROUTABLE_VENDORS],
    // 'active' is the canonical "connected and usable" state in the
    // connectors table; 'connected' is accepted as a forward-compat alias.
    statuses: ['active', 'connected'],
  });
  const out = new Set<WebToolVendor>();
  for (const c of list.connectors ?? []) {
    out.add(c.connectorType as WebToolVendor);
  }
  return out;
}

/** Listeners told when a (tenant, vendor) credential is invalidated, so a
 *  cache built ON a credential (the 1Password client) drops with it. */
const invalidationListeners = new Set<(tenantId: string, vendor: WebToolVendor) => void>();

export function onWebToolCredentialInvalidated(
  listener: (tenantId: string, vendor: WebToolVendor) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

export function invalidateWebToolCredentialCache(
  tenantId: string,
  vendor: WebToolVendor,
): void {
  credentialCache.delete(credentialCacheKey(tenantId, vendor));
  for (const listener of invalidationListeners) {
    try { listener(tenantId, vendor); } catch { /* a listener's failure is its own */ }
  }
}
