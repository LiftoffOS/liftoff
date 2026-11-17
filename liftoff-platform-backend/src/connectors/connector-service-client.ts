// Connector Service Client (Connect-RPC) — platform-backend side.
//
// Thin wrapper over @connectrpc/connect's `createClient` targeting the
// proto-defined ConnectorService. The transport layer is a
// Connect-RPC-over-HTTP/1.1 fetch client (HTTP/2 via undici-dispatched
// `fetch` works equally well and is used in prod by Cloud Run's proxy).
//
// Auth: every request carries
//   - Authorization: Bearer <OIDC id token>     (Cloud Run IAM)
//   - X-Service-Auth: <CONNECTOR_SERVICE_TOKEN> (constant-time compare
//     on the callee side via @liftoffos/service-client/verifyServiceAuth)
//
// Feature flag: CONNECTOR_SERVICE_ENABLED = off | shadow | on
//   off    — client not called
//   shadow — client called in parallel with the legacy in-process path,
//            responses compared, legacy wins
//   on     — client is the authoritative source; legacy dormant
//
// Tests: see connector-service-client.test.ts

import {
  createClient,
  ConnectError,
  Code,
  type Interceptor,
  type Client,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../infrastructure/logging';
import { ConnectorService } from '@liftoffos/proto-gen';
import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';

// ── Feature flag ────────────────────────────────────────────────────────

export type ConnectorServiceMode = 'off' | 'shadow' | 'on';

export function getConnectorServiceMode(): ConnectorServiceMode {
  const raw = (process.env.CONNECTOR_SERVICE_ENABLED ?? 'off').toLowerCase();
  if (raw === 'shadow' || raw === 'on') return raw;
  return 'off';
}

export function isConnectorServiceEnabled(): boolean {
  return getConnectorServiceMode() !== 'off';
}

export function isShadowMode(): boolean {
  return getConnectorServiceMode() === 'shadow';
}

// ── Errors surfaced to callers ──────────────────────────────────────────

/** Re-exported so callers can differentiate connector-service failures
 *  from generic exceptions without importing @connectrpc/connect. */
export { ConnectError, Code };

// ── Client factory ──────────────────────────────────────────────────────

export interface ConnectorServiceClientOptions {
  /** Override the base URL. Default: process.env.CONNECTOR_SERVICE_URL. */
  baseUrl?: string;
  /** Additional interceptors appended after the default auth interceptor. */
  extraInterceptors?: Interceptor[];
}

function resolveBaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.CONNECTOR_SERVICE_URL;
  if (!url) {
    throw new Error('CONNECTOR_SERVICE_URL is not set (or pass options.baseUrl)');
  }
  return url;
}

/**
 * Builds the default Connect-RPC interceptor chain for outbound calls to
 * connector-service:
 *   1. attach X-Service-Auth from CONNECTOR_SERVICE_TOKEN
 *   2. attach Authorization: Bearer <OIDC id token> for the target URL
 *
 * Header names are constants so they're easy to inspect in tests.
 */
function defaultAuthInterceptor(baseUrl: string): Interceptor {
  return (next) => async (req) => {
    const token = process.env.CONNECTOR_SERVICE_TOKEN;
    if (token) req.header.set('X-Service-Auth', token);
    try {
      const oidc = await buildOidcAuthHeader(baseUrl);
      for (const [k, v] of Object.entries(oidc)) {
        req.header.set(k, v);
      }
    } catch {
      // In local dev (no metadata server) OIDC fetch fails silently.
      // Service-to-service calls on Cloud Run always succeed here.
    }
    return next(req);
  };
}

/**
 * Returns a typed Connect-RPC client for the ConnectorService. Callers
 * invoke methods directly:
 *   const client = getConnectorServiceClient();
 *   const res = await client.warm({ tenantContext: { tenantId }, connectorTypes: ['slack'] });
 *
 * A shared singleton is returned on subsequent calls in the same process.
 */
let sharedClient: Client<typeof ConnectorService> | null = null;

export function createConnectorServiceClient(
  opts: ConnectorServiceClientOptions = {},
): Client<typeof ConnectorService> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const interceptors: Interceptor[] = [
    defaultAuthInterceptor(baseUrl),
    ...(opts.extraInterceptors ?? []),
  ];
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    interceptors,
  });
  return createClient(ConnectorService, transport);
}

export function getConnectorServiceClient(): Client<typeof ConnectorService> {
  if (!sharedClient) sharedClient = createConnectorServiceClient();
  return sharedClient;
}

/** Reset the shared client (primarily for tests + hot-reload scenarios). */
export function resetSharedConnectorServiceClient(): void {
  sharedClient = null;
}

// Re-export the service descriptor + common proto types so downstream
// modules don't need direct dependencies on @liftoffos/proto-gen. We
// route everything through the package's namespace exports
// (`connectorService` / `connector`) to stay compatible with TypeScript's
// classic "node" module resolution.
import * as connectorServiceNs from '@liftoffos/proto-gen/dist/liftoff/connector/v1/connector_service_pb';
import * as connectorTypesNs from '@liftoffos/proto-gen/dist/liftoff/connector/v1/types_pb';

export { ConnectorService } from '@liftoffos/proto-gen';
export type ExecuteRequest = connectorServiceNs.ExecuteRequest;
export type ExecuteResponse = connectorServiceNs.ExecuteResponse;
export type ExecuteBatchRequest = connectorServiceNs.ExecuteBatchRequest;
export type ExecuteBatchResponse = connectorServiceNs.ExecuteBatchResponse;
export type WarmRequest = connectorServiceNs.WarmRequest;
export type WarmResponse = connectorServiceNs.WarmResponse;
export type WarmFailure = connectorServiceNs.WarmFailure;
export type GetCredentialsRequest = connectorServiceNs.GetCredentialsRequest;
export type GetCredentialsResponse = connectorServiceNs.GetCredentialsResponse;
export type GetFunctionalTypesRequest = connectorServiceNs.GetFunctionalTypesRequest;
export type GetFunctionalTypesResponse = connectorServiceNs.GetFunctionalTypesResponse;
export type GetCapabilitiesRequest = connectorServiceNs.GetCapabilitiesRequest;
export type GetCapabilitiesResponse = connectorServiceNs.GetCapabilitiesResponse;

export const AuthFlowKind = connectorTypesNs.AuthFlowKind;
export const ConnectorCapabilityEnum = connectorTypesNs.ConnectorCapability;

// ── Catalog fetch (REST, not RPC) ─────────────────────────────────────────

let _catalogPromise: Promise<ConnectorCatalogResponse> | null = null;
/** Last value that actually arrived, kept so a failed refresh degrades to stale
 *  rather than to nothing. */
let _catalogValue: ConnectorCatalogResponse | null = null;
let _catalogFetchedAt = 0;

/**
 * How long a fetched catalog stays authoritative.
 *
 * WHY THERE IS A CACHE AT ALL. This is a REST call with a 3s timeout, read on
 * the distillation path and by several other consumers. Fetching per call would
 * put a network dependency — and that timeout — on every use of connector
 * metadata that changes a few times a week.
 *
 * WHY IT EXPIRES. Cached for the PROCESS LIFETIME, Cloud Run instances live for
 * hours under steady traffic, so a capability added in connector-service would
 * reach platform-backend only when its own instances happened to restart, for
 * reasons unrelated to the change.
 *
 * Example: connector-service gains `nativeEventDelivery` on the GitHub
 * connector while a serving revision still holds the catalog it fetched hours
 * earlier. A redistill in that window sees GitHub as unable to deliver events,
 * so `deliversEvents` is false, EVENT TOPICS come up empty, and the distiller
 * correctly converts reactive responsibilities into cron polling. The agent is
 * rebuilt onto the design reactive events replaced, and nothing reports an
 * error — the output looks like a reasonable decision, which is why it takes a
 * full trace to find.
 *
 * A TTL rather than cross-service invalidation: there is no deploy signal from
 * connector-service to here, and inventing one makes two services that must be
 * released together. Five minutes bounds the disagreement without coordination,
 * and it is self-healing — which invalidation is not, if the signal is missed.
 */
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * Fetches the connector catalog from connector-service.
 *
 * Cached for CATALOG_TTL_MS. A refresh that fails serves the last good value:
 * a distillation running on a five-minute-old catalog is a far better outcome
 * than one that throws, and the previous behaviour (throw, clear, retry on the
 * next call) put connector-service's availability directly on the distill path.
 */
export async function getCatalog(): Promise<ConnectorCatalogResponse> {
  const fresh = _catalogValue !== null && Date.now() - _catalogFetchedAt < CATALOG_TTL_MS;
  if (fresh) return _catalogValue as ConnectorCatalogResponse;

  if (!_catalogPromise) {
    _catalogPromise = _fetchCatalog()
      .then((value) => {
        _catalogValue = value;
        _catalogFetchedAt = Date.now();
        _catalogPromise = null;
        return value;
      })
      .catch((err) => {
        _catalogPromise = null;
        if (_catalogValue !== null) {
          log.warn(
            { err: (err as Error).message, ageMs: Date.now() - _catalogFetchedAt },
            'connector catalog refresh failed — serving the last good copy',
          );
          return _catalogValue as ConnectorCatalogResponse;
        }
        throw err;
      });
  }
  return _catalogPromise;
}

/** Test-only. Underscore-prefixed per the reachability contract: it has no
 *  production caller and must not acquire one — a live path clearing this
 *  cache would reintroduce the unbounded refetching the TTL exists to bound. */
export function _resetCatalogCache(): void {
  _catalogPromise = null;
  _catalogValue = null;
  _catalogFetchedAt = 0;
}


async function _fetchCatalog(): Promise<ConnectorCatalogResponse> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/catalog`;
  const headers: Record<string, string> = {};
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  if (token) headers['X-Service-Auth'] = token;
  try {
    const oidc = await buildOidcAuthHeader(baseUrl);
    Object.assign(headers, oidc);
  } catch {
    // OIDC unavailable in local dev — service token alone is sufficient in dev
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`connector catalog fetch failed: ${res.status}`);
  return res.json() as Promise<ConnectorCatalogResponse>;
}

// ── The x402 signer wallet (REST) ─────────────────────────────────────────
// Connector-service spends from the x402 wallet; this control plane watches
// it by the address in X402_WALLET_ADDRESS. The two custodians the signer
// can be built on hold different addresses, so the treasury checks read the
// live signer's address back and compare — a switch that changed only one
// side would otherwise guard a wallet nobody spends from.

export interface X402SignerWallet {
  provider: 'cdp' | 'circle' | null;
  configured: boolean;
  address?: string;
  error?: string;
}

export async function fetchX402SignerWallet(): Promise<X402SignerWallet> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/internal/x402/wallet`;
  const headers: Record<string, string> = {};
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  if (token) headers['X-Service-Auth'] = token;
  try {
    const oidc = await buildOidcAuthHeader(baseUrl);
    Object.assign(headers, oidc);
  } catch {
    // OIDC unavailable in local dev — service token alone is sufficient in dev
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`x402 signer wallet read failed: ${res.status}`);
  return res.json() as Promise<X402SignerWallet>;
}

/** Buy prepaid vendor credit from the x402 wallet. The wallet signs in
 *  connector-service, so the purchase happens there; what comes back is the
 *  vendor's token for this side to hold. 409 is the wallet or the vendor
 *  refusing (the spend guard's cap or ceiling, no wallet configured, the
 *  vendor would not sell) and carries a reason; anything else throws. */
/** Whose money bought a prepaid token: the x402 wallet's USDC, or the
 *  platform's card-funded Locus credits (the fallback for an unfunded wallet). */
export type X402PrepaidTokenFunder = 'x402_wallet' | 'locus';

export interface X402PrepaidTokenPurchase {
  vendor: string;
  token: string;
  balanceUsd: number;
  expiresAt: string;
  paidUsd: number;
  transaction?: string;
  fundedBy?: X402PrepaidTokenFunder;
}

export type X402PrepaidTokenOutcome =
  | { purchased: true; purchase: X402PrepaidTokenPurchase }
  | { purchased: false; reason: string };

export async function purchaseX402PrepaidToken(input: { vendor: string; amountUsd: number; funding?: X402PrepaidTokenFunder }): Promise<X402PrepaidTokenOutcome> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/internal/x402/prepaid-tokens`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  if (token) headers['X-Service-Auth'] = token;
  try {
    const oidc = await buildOidcAuthHeader(baseUrl);
    Object.assign(headers, oidc);
  } catch {
    // OIDC unavailable in local dev — service token alone is sufficient in dev
  }
  // A purchase is one x402 round trip (challenge, sign, settle, answer); the
  // facilitator's settlement is the slow part, tens of seconds at worst.
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(90_000) });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { reason?: string } | null;
    return { purchased: false, reason: body?.reason ?? 'refused' };
  }
  if (!res.ok) throw new Error(`x402 prepaid token purchase failed: ${res.status}`);
  const purchase = (await res.json()) as X402PrepaidTokenPurchase;
  return { purchased: true, purchase };
}

// ── Tenant-scoped CRUD helpers (REST, not RPC) ───────────────────────────
// Used by AccountService.cascadeDelete to enumerate and revoke a tenant's
// connectors as part of the account-deletion cascade. Mirrors the headers
// the proxy adds for inbound requests: X-Service-Auth + OIDC + x-account-id
// (the connector-service requires x-account-id even for tenant-scoped CRUD).

/** The same headers WITHOUT an `x-account-id`: this service's own identity, for
 *  a read that belongs to a workspace rather than to a person. Passing a
 *  tenant id in the account header instead would put a value in a field that
 *  means something else, and attribution elsewhere would quietly read it. */
async function buildServiceOnlyHeaders(baseUrl: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  if (token) headers['X-Service-Auth'] = token;
  try {
    const oidc = await buildOidcAuthHeader(baseUrl);
    Object.assign(headers, oidc);
  } catch {
    // OIDC unavailable in local dev — service token alone is sufficient in dev
  }
  return headers;
}

async function buildConnectorServiceHeaders(baseUrl: string, accountId: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'x-account-id': accountId };
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  if (token) headers['X-Service-Auth'] = token;
  try {
    const oidc = await buildOidcAuthHeader(baseUrl);
    Object.assign(headers, oidc);
  } catch {
    // OIDC unavailable in local dev — service token alone is sufficient in dev
  }
  return headers;
}

/** A connector row as this client projects it: the identity, its state, and
 *  two fields the workspace export reads. `installState` is
 *  `config.installState` and nothing else of `config`, which holds install ids
 *  and account labels that must not be serialized; `createdAt` is the row's
 *  `created_at`, so an export cutoff can exclude a connector created after it. */
export interface TenantConnectorSummary {
  id: string;
  type?: string;
  name?: string;
  status?: string;
  installState: string | null;
  createdAt: string | null;
}

export async function listConnectorsForTenant(
  tenantId: string,
  accountId: string,
): Promise<TenantConnectorSummary[]> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors?tenantId=${encodeURIComponent(tenantId)}`;
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`listConnectorsForTenant failed: ${res.status}`);
  }
  // The service returns whole connector rows; the narrower type here used to
  // hide `status`, which is the field a caller needs to know whether an
  // imported placeholder has actually been reconnected.
  type Row = {
    id: string; type?: string; name?: string; status?: string;
    config?: { installState?: unknown } | null;
    created_at?: unknown; createdAt?: unknown;
  };
  const body = (await res.json()) as { connectors?: Row[] } | Row[];
  const rows = Array.isArray(body) ? body : (body.connectors ?? []);
  return rows.map((row) => {
    const installState = row.config && typeof row.config === 'object' && typeof row.config.installState === 'string'
      ? row.config.installState
      : null;
    const created = row.created_at ?? row.createdAt;
    return {
      id: row.id,
      ...(row.type !== undefined ? { type: row.type } : {}),
      ...(row.name !== undefined ? { name: row.name } : {}),
      ...(row.status !== undefined ? { status: row.status } : {}),
      installState,
      createdAt: typeof created === 'string' ? created : created instanceof Date ? created.toISOString() : null,
    };
  });
}

/**
 * Bulk-resolve connector ids to their canonical type for a tenant.
 *
 * Calls connector-service's `POST /api/connectors/_resolve` which queries
 * the connectors table (including disconnected rows) so callers can map
 * historical ids back to their type. Used by the internal-agent event
 * publish path (integration-enrichment) — connectors live in connector-
 * service, not in platform-backend's DB, so the resolver must consult the
 * service to translate a submitted UUID into the connector_type the
 * tenant runtime needs.
 *
 * Service-to-service call: only requires service auth (X-Service-Auth +
 * OIDC). The `x-account-id` header is sent for audit attribution; the
 * route does not enforce it.
 *
 * Returns missing ids as absent from the response — callers detect
 * orphans by diffing returned ids against their input.
 */
export async function resolveConnectorTypes(
  tenantId: string,
  ids: string[],
): Promise<Array<{
  id: string;
  type: string;
  status: string;
  // Team-provisioning binding contract (connector-service returns these; absent on older
  // deployments → default empty/null, which team-provisioning treats as fail-closed).
  scopes?: string[];
  botLogin?: string | null;
  authorizedRepos?: string[] | null;
}>> {
  if (ids.length === 0) return [];
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/_resolve`;
  const headers = await buildConnectorServiceHeaders(baseUrl, 'service:platform-backend');
  headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, ids }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`resolveConnectorTypes failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as {
    connectors?: Array<{ id: string; type: string; status: string; scopes?: string[]; botLogin?: string | null; authorizedRepos?: string[] | null }>;
  };
  return json.connectors ?? [];
}

export async function deleteConnectorForTenant(connectorId: string, accountId: string): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/${encodeURIComponent(connectorId)}`;
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  const res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteConnectorForTenant failed: ${res.status}`);
  }
}

// Create a connector row in connector-service's DB. Used by custom-mcp-servers
// (and any other future non-OAuth connector flow that runs on platform-backend
// but needs the connector to show up in the unified /api/connectors listing
// the frontend reads). Mirrors the POST / handler in
// liftoff-connector-service/src/crud/router.ts.
//
// `initialStatus` defaults to 'pending', matching connector-service's old
// behavior; OAuth callers leave it and let the callback flip to 'active'.
// Non-OAuth callers (custom_mcp_server, anything else where the row is
// immediately usable) MUST pass 'active' — otherwise the row stays
// 'pending' and is hidden from the Connections UI (which filters on
// status === 'active' | 'error').
export async function createConnectorForTenant(
  tenantId: string,
  type: string,
  name: string,
  config: Record<string, unknown>,
  accountId: string,
  initialStatus: 'pending' | 'active' = 'pending',
): Promise<{ id: string; type: string; name: string; status: string }> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors`;
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, type, name, config, status: initialStatus }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`createConnectorForTenant failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<{ id: string; type: string; name: string; status: string }>;
}

// ── Cross-tenant lookups ─────────────────────────────────────────────────────
//
// Both of these answer questions this repo used to answer from its own
// `connectors` table. That table stopped receiving rows at the Phase 2a
// cutover (INV-PB-012 / ADR-049), so it holds a shrinking historical subset
// and — the dangerous part — reports "no such connector" rather than an error
// for everything created since. connector-service owns the data; ask it.

/**
 * The tenant that owns a connector.
 *
 * For callers with an id and no tenant context: a webhook, a Pub/Sub message,
 * a harvest callback. Returns null when the connector genuinely does not
 * exist, and throws when the lookup itself failed — the distinction matters,
 * because "not found" is a routing decision and an unreachable service is not.
 */
/** How long to wait before the single retry below.
 *
 *  Short enough that a caller waiting on this is not made to wait meaningfully
 *  longer, long enough that a busy instant has passed. The failure this exists
 *  for lasted milliseconds — a request contending with connector-service's
 *  polling loop, which runs on the same instances that serve this lookup. */
const OWNER_LOOKUP_RETRY_DELAY_MS = 250;

/**
 * ONE RETRY, and only for a failure that could plausibly differ next time.
 *
 * This lookup can time out at 5s while connector-service is mid-poll. A GET is
 * idempotent and a transient timeout is exactly what a retry is for, so this
 * converts a momentary contention into a success without caching anything.
 *
 * WHAT IS DELIBERATELY NOT RETRIED. A 404 is an ANSWER — the connector does not
 * exist — and this function's contract already distinguishes it from a failed
 * lookup ("not found is a routing decision and an unreachable service is not").
 * Retrying it would turn a fast, correct null into a slow one. Any other 4xx is
 * a request this service will refuse identically a second time; retrying is
 * latency spent to reach the same answer.
 *
 * WHAT THIS IS NOT. It is not a fix for connector-service being busy. Polling
 * and serving share instances there, and if this recurs the answer is to stop
 * them competing, not to ask twice more patiently. One retry is the cheap,
 * correct response to ONE observation; treating it as the remedy for a
 * structural contention problem would be the mistake.
 */
export async function getConnectorOwner(
  connectorId: string,
): Promise<{ tenantId: string; connectorType: string; status: string } | null> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/internal/admin/connectors/${encodeURIComponent(connectorId)}/tenant`;

  const attempt = async (): Promise<
    { tenantId: string; connectorType: string; status: string } | null
  > => {
    // Headers are rebuilt per attempt on purpose: they carry a signed identity
    // that a retry seconds later must not be reusing from a stale build.
    const headers = await buildConnectorServiceHeaders(baseUrl, 'system');
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`getConnectorOwner failed: ${res.status} ${body}`);
      // Carried so the retry decision reads the status rather than the prose.
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return res.json() as Promise<{ tenantId: string; connectorType: string; status: string }>;
  };

  try {
    return await attempt();
  } catch (err) {
    if (!isWorthRetrying(err)) throw err;
    await new Promise((r) => setTimeout(r, OWNER_LOOKUP_RETRY_DELAY_MS));
    return attempt();
  }
}

/** Could a second identical request plausibly succeed?
 *
 *  True for a timeout or a transport failure (the service was busy or the
 *  connection dropped) and for a 5xx (the service failed on its side). False
 *  for any 4xx: the request itself is what was refused, and refusing it again
 *  is the only thing a retry would achieve. */
function isWorthRetrying(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  if (typeof status === 'number') return status >= 500;
  // No status means the request never got an answer at all — an AbortSignal
  // timeout, a DNS failure, a reset. Those are the retryable ones.
  return true;
}

export interface ConnectorHealthSummary {
  totalConnectors: number;
  activeCount: number;
  errorCount: number;
  disconnectedCount: number;
  pendingCount: number;
  connectorsWithSyncErrorsLast24h: number;
  connectorsByType: Record<string, number>;
  recentSyncFailures: Array<{
    connectorId: string;
    tenantId: string;
    connectorType: string;
    errorMessage: string | null;
    failedAt: string | null;
  }>;
}

/**
 * Estate-wide connector health for the operator dashboard.
 *
 * Throws on failure rather than returning an empty shape. The panel this
 * feeds used to swallow every error into zeros, so a broken query and a
 * perfectly healthy estate rendered identically.
 */
export async function getConnectorHealthSummary(): Promise<ConnectorHealthSummary> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/internal/admin/health/summary`;
  const headers = await buildConnectorServiceHeaders(baseUrl, 'system');
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`getConnectorHealthSummary failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<ConnectorHealthSummary>;
}

/**
 * Report a binding as unusable so the product can say so.
 *
 * Flips the connector to `status='error'`, which is the signal the
 * Connections page renders as a Reconnect card and the Teams page badges on
 * every agent bound to it. Accepts a Composio connected-account id because
 * the caller here is a webhook: it knows a vendor account and nothing else,
 * and connector-service resolves it.
 *
 * Best-effort by contract. The caller is an inbound webhook whose own job
 * (acknowledging the vendor) must not fail because our status write did —
 * a 5xx would send Composio into a retry loop over a bookkeeping error.
 * Returns how many connectors were flipped, or 0 on any failure.
 */
export async function reportReconnectRequired(args: {
  connectorId?: string;
  composioConnectedAccountId?: string;
  reason: string;
  accountId?: string;
}): Promise<number> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/internal/admin/connectors/reconnect-required`;
  try {
    const headers = await buildConnectorServiceHeaders(baseUrl, args.accountId ?? 'system');
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(args.connectorId ? { connectorId: args.connectorId } : {}),
        ...(args.composioConnectedAccountId
          ? { composioConnectedAccountId: args.composioConnectedAccountId }
          : {}),
        reason: args.reason,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status, reason: args.reason },
        'reportReconnectRequired: connector-service rejected the report',
      );
      return 0;
    }
    const body = (await res.json()) as { updated?: number };
    return body.updated ?? 0;
  } catch (err) {
    log.warn(
      { err: (err as Error).message, reason: args.reason },
      'reportReconnectRequired failed',
    );
    return 0;
  }
}

// ── Liftoff Switch: import placeholders ──────────────────────────────────────
//
// Creates credential-less `error` placeholders for an imported installation's
// integrations. Goes through connector-service's narrowly scoped internal
// import route rather than the public create endpoint, which deliberately
// accepts only `pending` and `active`: `error` carries a product meaning on the
// Connections page (Needs Reconnect, whose action heals THAT row) and should
// not be assertable by any caller.
//
// Idempotent on (tenant, migrationId, sourceRef): a re-run adopts the existing
// placeholder rather than creating a second one for the same source integration.

export interface ImportPlaceholderRequirement {
  type: string;
  name: string;
  /** Stable reference within the source installation. */
  sourceRef: string;
  /** Non-secret label only, when the source exposes one safely. */
  externalAccountLabel?: string;
  /** Non-secret endpoint config for an imported custom MCP server. */
  endpointUrl?: string;
}

export interface ImportPlaceholderResult {
  sourceRef: string;
  connectorId: string;
  type: string;
  /** True when an existing placeholder was adopted instead of created. */
  adopted: boolean;
}

export async function createImportPlaceholders(
  tenantId: string,
  migrationId: string,
  importSource: string,
  requirements: ImportPlaceholderRequirement[],
  /** The marker stamped on `config.disconnect_reason`. Sent rather than
   *  hardcoded in connector-service so the caller that KNOWS what kind of
   *  import this is names it, and so the two services cannot drift into
   *  disagreeing about the value that reconnection adoption keys on. */
  disconnectReason: string,
): Promise<ImportPlaceholderResult[]> {
  if (requirements.length === 0) return [];

  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/internal/connectors/import-requirements`;
  const headers = await buildConnectorServiceHeaders(baseUrl, 'service:platform-backend');
  headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, migrationId, importSource, disconnectReason, requirements }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`createImportPlaceholders failed: ${res.status} ${body}`);
  }

  const parsed = (await res.json()) as { placeholders?: ImportPlaceholderResult[] };
  return parsed.placeholders ?? [];
}

// ── Connect flows on a person's behalf ───────────────────────────────────
// The assistants start a connection the way the Connections page does: the
// same connector-service routes, called with the person's account id (which
// connector-service reads as the canonical account id) and the dashboard's
// /oauth/callback as the return URL, so the vendor's own consent screen is
// handed to the person as a link and completes without an opener.

export async function startOAuthConnect(
  tenantId: string,
  accountId: string,
  connectorType: string,
  opts: { returnUrl: string; dynamicUrlParams?: Record<string, string>; connectorId?: string },
): Promise<{ authUrl: string; state: string }> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/oauth/${encodeURIComponent(connectorType)}/start?tenantId=${encodeURIComponent(tenantId)}`;
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      returnUrl: opts.returnUrl,
      ...(opts.dynamicUrlParams ? { dynamicUrlParams: opts.dynamicUrlParams } : {}),
      ...(opts.connectorId ? { connectorId: opts.connectorId } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`startOAuthConnect failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<{ authUrl: string; state: string }>;
}

export interface GitHubInstallTarget {
  login: string;
  id: number;
  type: 'User' | 'Organization';
  installable?: boolean;
}

export async function listGithubInstallTargets(tenantId: string, accountId: string): Promise<GitHubInstallTarget[]> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/github-app/install-targets?tenantId=${encodeURIComponent(tenantId)}`;
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`listGithubInstallTargets failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { targets?: GitHubInstallTarget[] };
  return json.targets ?? [];
}

export async function startGithubInstall(
  tenantId: string,
  accountId: string,
  body: { redirectUri: string; targetLogin: string; targetId?: number },
): Promise<{ installUrl: string }> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/github-app/install-start`;
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, accountId, ...body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`startGithubInstall failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<{ installUrl: string }>;
}

/** The tenant's connector health, as the Connections page reads it. */
export async function getConnectorHealthStats(tenantId: string, accountId: string): Promise<{
  totalConnectors: number;
  healthyConnectors: number;
  degradedConnectors: number;
  errorConnectors: number;
  activeIncidents: number;
  avgSyncSuccessRate: number;
}> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/health/stats?tenantId=${encodeURIComponent(tenantId)}`;
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`getConnectorHealthStats failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<{ totalConnectors: number; healthyConnectors: number; degradedConnectors: number; errorConnectors: number; activeIncidents: number; avgSyncSuccessRate: number }>;
}

/** One connector row with its config, for the GitHub App caveat on
 *  disconnect (installationId lives in config). */
export async function getConnectorForTenant(
  tenantId: string,
  accountId: string,
  connectorId: string,
): Promise<{ id: string; type?: string; name?: string; status?: string; config?: Record<string, unknown> } | null> {
  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/connectors/${encodeURIComponent(connectorId)}?tenantId=${encodeURIComponent(tenantId)}`;
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getConnectorForTenant failed: ${res.status}`);
  return res.json() as Promise<{ id: string; type?: string; name?: string; status?: string; config?: Record<string, unknown> }>;
}

/** The IAM-grant connect (BigQuery today): provision the per-tenant service
 *  account and return the grant instructions; verify once the grant is made. */
export async function startIamGrantConnect(
  tenantId: string,
  accountId: string,
  route: string,
  fields: { projectId?: string; dataset?: string },
): Promise<{ connectorId: string; serviceAccountEmail: string; grantInstructions: string; status: 'active' | 'pending_grant'; detail?: string }> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${route}/connect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, projectId: fields.projectId, dataset: fields.dataset }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`startIamGrantConnect failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<{ connectorId: string; serviceAccountEmail: string; grantInstructions: string; status: 'active' | 'pending_grant'; detail?: string }>;
}

export async function verifyIamGrantConnect(
  tenantId: string,
  accountId: string,
  route: string,
  connectorId: string,
): Promise<{ connectorId: string; status: 'active' | 'pending_grant'; detail?: string }> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${route}/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId, connectorId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`verifyIamGrantConnect failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<{ connectorId: string; status: 'active' | 'pending_grant'; detail?: string }>;
}

// ── Custom API connections ────────────────────────────────────────────────
//
// Connector-service owns the metadata table, the credential write, the
// verification call, the generated operations and the executor. This repo owns
// the conversation half and calls the endpoints below to register or reconnect
// an instance. The CREDENTIAL passes through this client once, on its way from
// the capture page to Secret Manager, and is never held anywhere here.

/** The declared connection description, as connector-service takes it. The
 *  shape is pinned in src/custom-api-connectors/types.ts; it travels as JSON so
 *  this client does not re-declare it field by field. */
export interface CustomApiRegisterInput {
  tenantId: string;
  accountId: string;
  attemptId: string;
  spec: Record<string, unknown>;
  credential: string;
  reconnectConnectorId?: string;
}

export interface CustomApiRegisterResult {
  connectorId: string;
  status: 'active' | 'error';
  operationCount: number;
  externalAccountLabel?: string;
  verification?: { ok: boolean; layer?: string; message?: string; httpStatus?: number };
  reused: boolean;
}

/** A refusal connector-service names rather than a failure it throws: an
 *  unsupported specification, a host outside the ones consented to, more
 *  operations than a connection carries. */
export interface CustomApiRefusalResponse {
  refused: string;
  message: string;
  operations?: string[];
}

export function isCustomApiRefusal(
  value: CustomApiRegisterResult | CustomApiRefusalResponse,
): value is CustomApiRefusalResponse {
  return 'refused' in value;
}

export async function registerCustomApiConnection(
  input: CustomApiRegisterInput,
): Promise<CustomApiRegisterResult | CustomApiRefusalResponse> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, input.accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/connectors/custom-api/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tenantId: input.tenantId,
      attemptId: input.attemptId,
      spec: input.spec,
      credential: input.credential,
      ...(input.reconnectConnectorId ? { reconnectConnectorId: input.reconnectConnectorId } : {}),
    }),
    // Registration fetches the specification, classifies every operation and
    // runs the verification call, so it is not a fast request. The capture
    // page waits on it deliberately: the person who just entered a key is the
    // person who should be told whether it works.
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 422) {
    return (await res.json()) as CustomApiRefusalResponse;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`registerCustomApiConnection failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as CustomApiRegisterResult;
}

/** One workspace's custom API connections, as connector-service projects them:
 *  the description and the counts, never the operation schemas and never a
 *  credential. */
export interface CustomApiConnectionSummary {
  connectorId: string;
  name: string;
  providerSlug: string;
  baseUrl: string;
  apiHosts: string[];
  auth: { scheme: string; name?: string; prefix?: string };
  verification: { method: string; path: string; accountIdentityField?: string };
  operationCount: number;
  /** The operation names, listed the way a custom MCP server's tools are. */
  operations: string[];
  /** The provider's specification is no longer the one this connection was
   *  built from. Detected by a sweep; acting on it is a person's call. */
  specDrifted: boolean;
  specDriftCheckedAt: string | null;
  specSourceUrl: string | null;
  specHash: string;
  specFetchedAt: string | null;
  verifiedAt: string | null;
  completedByAccountId: string | null;
  updatedAt: string;
  version: string;
}

export async function listCustomApiConnections(
  tenantId: string,
  accountId: string,
): Promise<CustomApiConnectionSummary[]> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, accountId);
  const url = `${baseUrl}/api/connectors/custom-api?tenantId=${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`listCustomApiConnections failed: ${res.status}`);
  const body = (await res.json()) as { connections?: CustomApiConnectionSummary[] };
  return body.connections ?? [];
}

export interface CustomApiDescribeResult {
  operationCount: number;
  specHash: string;
  sampleOperations: string[];
  /** Operations the connection will NOT carry, because they are shapes the
   *  dispatcher does not send. A provider is not its worst endpoint, so these
   *  are left out rather than refusing the whole API — and said BEFORE a
   *  person decides, rather than discovered when a tool is not there. */
  skippedCount?: number;
  skippedOperations?: string[];
  skippedReasons?: string[];
}

/** Read the provider's specification and say what connecting it would give,
 *  without creating anything. What the confirmation preview's operation count
 *  comes from — and what makes an unsupported specification a refusal BEFORE a
 *  person is handed a link for a connection that could never be registered. */
export async function describeCustomApiSpec(args: {
  tenantId: string;
  accountId: string;
  spec: Record<string, unknown>;
}): Promise<CustomApiDescribeResult | CustomApiRefusalResponse> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, args.accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api/connectors/custom-api/describe`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId: args.tenantId, spec: args.spec }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 422) return (await res.json()) as CustomApiRefusalResponse;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`describeCustomApiSpec failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as CustomApiDescribeResult;
}

/** One generated operation, as connector-service serves it per instance. */
export interface CustomApiToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  entityType: string;
  /** The MERGED classification: the effect tokens the runtime reads and the
   *  sensitivity names the Sensitive Work settings match literally, in one
   *  array. Neither half may be filtered on the way through. */
  categories: string[];
}

export interface CustomApiToolsResponse {
  connectorId: string;
  name: string;
  status: string;
  tools: CustomApiToolSchema[];
  version: string;
}

/** The per-instance tool schemas for one custom API connection.
 *
 *  Keyed by CONNECTOR ID, because `custom_api_connector` is one shared type and
 *  two workspaces' connections under it have nothing to do with each other —
 *  which is exactly why these cannot travel through ListTools, whose payload is
 *  aggregated per connector TYPE from a static registry with no database read. */
export async function getCustomApiTools(
  tenantId: string,
  connectorId: string,
  /** The person whose read this is, where there is one. A distillation runs
   *  for a workspace and not for a person, so it passes none and the call goes
   *  with this service's identity alone — the endpoint reads the tenant from
   *  the query and never the header. */
  accountId?: string,
): Promise<CustomApiToolsResponse | null> {
  const baseUrl = resolveBaseUrl();
  const headers = accountId
    ? await buildConnectorServiceHeaders(baseUrl, accountId)
    : await buildServiceOnlyHeaders(baseUrl);
  const url = `${baseUrl}/api/connectors/custom-api/${encodeURIComponent(connectorId)}/tools`
    + `?tenantId=${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getCustomApiTools failed: ${res.status}`);
  return (await res.json()) as CustomApiToolsResponse;
}

// ── Custom API connections: repair and removal ────────────────────────────
//
// Four separate controls, and none of them implies another. Removing the
// connection is the ORDINARY connector delete (`deleteConnectorForTenant`);
// the three below are the ones this family needs of its own.

/** Re-run the declared verification with the credential already in custody. */
export async function reverifyCustomApiConnection(args: {
  tenantId: string;
  accountId: string;
  connectorId: string;
}): Promise<{ ok: boolean; layer?: string; message?: string; httpStatus?: number; externalAccountLabel?: string }> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, args.accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(
    `${baseUrl}/api/connectors/custom-api/${encodeURIComponent(args.connectorId)}/verify`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenantId: args.tenantId }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`reverifyCustomApiConnection failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<{ ok: boolean; layer?: string; message?: string; httpStatus?: number }>;
}

export interface CustomApiConnectionChanges {
  name?: string;
  baseUrl?: string;
  apiHosts?: string[];
  auth?: { scheme: string; name?: string; prefix?: string };
  verification?: { method: 'GET' | 'HEAD'; path: string; query?: Record<string, string>; accountIdentityField?: string };
}

/** Edit hosts, placement and verification IN PLACE, keeping the connector id
 *  every bound agent holds, and prove the result. */
export async function updateCustomApiConnection(args: {
  tenantId: string;
  accountId: string;
  connectorId: string;
  changes: CustomApiConnectionChanges;
}): Promise<
  | { connection: CustomApiConnectionSummary; verification: { ok: boolean; layer?: string; message?: string } }
  | CustomApiRefusalResponse
  | null
> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, args.accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(
    `${baseUrl}/api/connectors/custom-api/${encodeURIComponent(args.connectorId)}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ tenantId: args.tenantId, ...args.changes }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (res.status === 404) return null;
  if (res.status === 422) return (await res.json()) as CustomApiRefusalResponse;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`updateCustomApiConnection failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as {
    connection: CustomApiConnectionSummary;
    verification: { ok: boolean; layer?: string; message?: string };
  };
}


/** One connection, as a person managing it sees it. */
export interface CustomApiSpecRefresh {
  changed: boolean;
  applied: boolean;
  specHash: string;
  previousSpecHash: string;
  added: string[];
  removed: string[];
  operationCount: number;
}

/** Read the provider's specification again. `apply: false` reports what
 *  changed and writes nothing, because applying can remove an operation an AI
 *  team is bound to. */
export async function refreshCustomApiSpec(args: {
  tenantId: string;
  accountId: string;
  connectorId: string;
  apply: boolean;
}): Promise<CustomApiSpecRefresh | { refused: string; message: string } | null> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, args.accountId);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(
    `${baseUrl}/api/connectors/custom-api/${encodeURIComponent(args.connectorId)}/spec-refresh`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenantId: args.tenantId, apply: args.apply }),
      // A specification is fetched and, when applied, every operation is
      // classified, so this is not a ten-second call.
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (res.status === 404) return null;
  if (res.status === 422) return (await res.json()) as { refused: string; message: string };
  if (!res.ok) throw new Error(`refreshCustomApiSpec failed: ${res.status}`);
  return (await res.json()) as CustomApiSpecRefresh;
}

export async function getCustomApiConnection(args: {
  tenantId: string;
  accountId: string;
  connectorId: string;
}): Promise<CustomApiConnectionSummary | null> {
  const baseUrl = resolveBaseUrl();
  const headers = await buildConnectorServiceHeaders(baseUrl, args.accountId);
  const url = `${baseUrl}/api/connectors/custom-api/${encodeURIComponent(args.connectorId)}`
    + `?tenantId=${encodeURIComponent(args.tenantId)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getCustomApiConnection failed: ${res.status}`);
  const body = (await res.json()) as { connection: CustomApiConnectionSummary };
  return body.connection;
}
