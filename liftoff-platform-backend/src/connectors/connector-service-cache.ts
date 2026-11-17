// Connector Service RPC cache — canonical source of truth for
// FUNCTIONAL_CONNECTOR_TYPES + CONNECTOR_CAPABILITIES in platform-backend.
//
// The static connector-availability.ts + connector-capabilities.ts files
// used to be duplicated between this repo and tenant-runtime/connector-
// service. After Phase 1c, they live authoritatively in the
// connector-service, and platform-backend calls the GetFunctionalTypes
// and GetCapabilities RPCs on startup + periodically.
//
// Lifecycle:
//   1. `initConnectorServiceCache()` — called by the server bootstrap
//      once. Fetches both RPCs in parallel, seeds the in-memory cache.
//      If CONNECTOR_SERVICE_ENABLED=off, or the RPC fails, falls back
//      to the ported static data (identical to the connector-service
//      source).
//   2. Sync getters (`getFunctionalConnectorTypes()`,
//      `getCapabilityOptions(capability)`, …) return the cached data.
//   3. A background refresh re-fetches every 5 minutes.
//
// Tests bypass the cache by calling `seedConnectorServiceCache({...})`
// directly.

import {
  getConnectorServiceClient,
  isConnectorServiceEnabled,
  isShadowMode,
  ConnectorCapabilityEnum,
  type GetFunctionalTypesResponse,
  type GetCapabilitiesResponse,
} from './connector-service-client';
import {
  STATIC_FUNCTIONAL_CONNECTOR_TYPES,
  STATIC_CONNECTOR_CAPABILITIES,
  type CapabilityOption,
} from './connector-service-cache.static';
import { log } from '../infrastructure/logging';

export type { CapabilityOption };

// ── Cache state ─────────────────────────────────────────────────────────

interface CacheState {
  functionalTypes: Set<string>;
  capabilities: Record<string, CapabilityOption[]>;
  lastUpdatedAt: number;
  source: 'rpc' | 'static-fallback' | 'seed';
}

let state: CacheState = {
  functionalTypes: STATIC_FUNCTIONAL_CONNECTOR_TYPES,
  capabilities: STATIC_CONNECTOR_CAPABILITIES,
  lastUpdatedAt: 0,
  source: 'static-fallback',
};

let refreshTimer: NodeJS.Timeout | null = null;

/** proto enum value → catalog capability key, DERIVED from the enum: the
 *  enum's member names are the catalog keys upper-cased (EMAIL_MARKETING ↔
 *  email_marketing), so every value the installed proto-gen knows maps, and
 *  a capability added to the proto reaches this cache with the version bump
 *  alone. This used to be nine hand-written rows while the enum carried
 *  thirty-five, and `fetchOnce` drops an unmapped value in silence, so every
 *  capability past the ninth was invisible to the RPC refresh and only the
 *  static fallback knew them. */
const PROTO_KEY_BY_ENUM = new Map<number, string>(
  Object.entries(ConnectorCapabilityEnum as unknown as Record<string, number | string>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[0] !== 'UNSPECIFIED')
    .map(([name, value]) => [value, name.toLowerCase()] as [number, string]),
);

// ── Fetch + refresh ─────────────────────────────────────────────────────

async function fetchOnce(): Promise<{
  functionalTypes: Set<string>;
  capabilities: Record<string, CapabilityOption[]>;
}> {
  const client = getConnectorServiceClient();
  const [functional, caps]: [GetFunctionalTypesResponse, GetCapabilitiesResponse] = await Promise.all([
    client.getFunctionalTypes({ tenantContext: { tenantId: 'platform-backend' } }),
    client.getCapabilities({ tenantContext: { tenantId: 'platform-backend' } }),
  ]);

  const functionalTypes = new Set<string>(functional.connectorTypes as string[]);
  const capabilities: Record<string, CapabilityOption[]> = {};
  for (const entry of caps.capabilities) {
    const key = PROTO_KEY_BY_ENUM.get(entry.capability);
    if (!key) continue;
    capabilities[key] = entry.providers.map((p: { connectorType: string; requiredScopes: string[] }) => ({
      connectorType: p.connectorType,
      requiredScopes: p.requiredScopes,
    }));
  }
  return { functionalTypes, capabilities };
}

/**
 * Initialise the cache. Call once at server startup BEFORE any code calls
 * the sync getters. Safe to call multiple times — idempotent.
 */
export async function initConnectorServiceCache(): Promise<void> {
  if (refreshTimer) return; // already initialized

  if (!isConnectorServiceEnabled()) {
    log.info({}, 'connector-service cache: flag=off, using static fallback');
    state = {
      functionalTypes: STATIC_FUNCTIONAL_CONNECTOR_TYPES,
      capabilities: STATIC_CONNECTOR_CAPABILITIES,
      lastUpdatedAt: Date.now(),
      source: 'static-fallback',
    };
    return;
  }

  try {
    const data = await fetchOnce();

    // In shadow mode, compare RPC data against the static fallback and
    // log mismatches. A diverging entry means the static file in
    // platform-backend has drifted from the connector-service's
    // capability registry — fix the static file (Fix 6 keeps it as a
    // fallback only).
    if (isShadowMode()) {
      compareAndLogDrift({
        rpcFunctional: data.functionalTypes,
        staticFunctional: STATIC_FUNCTIONAL_CONNECTOR_TYPES,
        rpcCapabilities: data.capabilities,
        staticCapabilities: STATIC_CONNECTOR_CAPABILITIES,
      });
    }

    state = { ...data, lastUpdatedAt: Date.now(), source: 'rpc' };
    log.info(
      { types: data.functionalTypes.size, capabilities: Object.keys(data.capabilities).length },
      'connector-service cache: seeded from RPC',
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'connector-service cache: RPC fetch failed; using static fallback',
    );
    state = {
      functionalTypes: STATIC_FUNCTIONAL_CONNECTOR_TYPES,
      capabilities: STATIC_CONNECTOR_CAPABILITIES,
      lastUpdatedAt: Date.now(),
      source: 'static-fallback',
    };
  }

  refreshTimer = setInterval(() => {
    void (async () => {
      try {
        const data = await fetchOnce();
        state = { ...data, lastUpdatedAt: Date.now(), source: 'rpc' };
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          'connector-service cache: refresh failed; serving stale data',
        );
      }
    })();
  }, 5 * 60 * 1000);
  // Don't keep the process alive just for the timer.
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

/** Stop the background refresh timer. Exposed for tests. */
export function stopConnectorServiceCache(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** Inject a deterministic cache state. Tests use this to bypass the RPC. */
export function seedConnectorServiceCache(data: {
  functionalTypes: Iterable<string>;
  capabilities: Record<string, CapabilityOption[]>;
}): void {
  state = {
    functionalTypes: new Set(data.functionalTypes),
    capabilities: data.capabilities,
    lastUpdatedAt: Date.now(),
    source: 'seed',
  };
}

// ── Sync getters (drop-in replacements for the old static exports) ──────

export function getFunctionalConnectorTypes(): Set<string> {
  return state.functionalTypes;
}

export function isFunctionalConnectorType(type: string): boolean {
  return state.functionalTypes.has(type);
}

export function connectorTypesForCapability(capability: string): string[] {
  return (state.capabilities[capability] ?? []).map((o) => o.connectorType);
}

export function scopesForConnector(capability: string, connectorType: string): string[] {
  const option = (state.capabilities[capability] ?? []).find(
    (o) => o.connectorType === connectorType,
  );
  return option?.requiredScopes ?? [];
}

export function getAllCapabilities(): Record<string, CapabilityOption[]> {
  return state.capabilities;
}

export function getCacheSource(): CacheState['source'] {
  return state.source;
}

// ── Shadow-mode drift detection ─────────────────────────────────────────
//
// When flag=shadow, the cache compares the RPC response to the static
// fallback and logs any delta. This is the dashboard that says "your
// local connector-availability.ts is out of sync with the connector-
// service's canonical registry."

export function compareAndLogDrift(args: {
  rpcFunctional: Set<string>;
  staticFunctional: Set<string>;
  rpcCapabilities: Record<string, CapabilityOption[]>;
  staticCapabilities: Record<string, CapabilityOption[]>;
}): void {
  const onlyInRpc = [...args.rpcFunctional].filter((t) => !args.staticFunctional.has(t));
  const onlyInStatic = [...args.staticFunctional].filter((t) => !args.rpcFunctional.has(t));
  if (onlyInRpc.length > 0 || onlyInStatic.length > 0) {
    log.warn(
      {
        event: 'connector_service_shadow_drift',
        scope: 'functional_types',
        onlyInRpc,
        onlyInStatic,
      },
      'connector-service shadow: FUNCTIONAL_CONNECTOR_TYPES drift (update the static fallback)',
    );
  }

  for (const key of new Set([
    ...Object.keys(args.rpcCapabilities),
    ...Object.keys(args.staticCapabilities),
  ])) {
    const rpcList = args.rpcCapabilities[key] ?? [];
    const staticList = args.staticCapabilities[key] ?? [];
    if (!sameCapability(rpcList, staticList)) {
      log.warn(
        {
          event: 'connector_service_shadow_drift',
          scope: 'capability',
          capability: key,
          rpc: rpcList,
          'static': staticList,
        },
        `connector-service shadow: capability "${key}" drift`,
      );
    }
  }
}

function sameCapability(a: CapabilityOption[], b: CapabilityOption[]): boolean {
  if (a.length !== b.length) return false;
  const toMap = (xs: CapabilityOption[]): Map<string, string[]> =>
    new Map(xs.map((o) => [o.connectorType, [...o.requiredScopes].sort()]));
  const ma = toMap(a);
  const mb = toMap(b);
  if (ma.size !== mb.size) return false;
  for (const [k, scopesA] of ma) {
    const scopesB = mb.get(k);
    if (!scopesB) return false;
    if (scopesA.length !== scopesB.length) return false;
    for (let i = 0; i < scopesA.length; i += 1) {
      if (scopesA[i] !== scopesB[i]) return false;
    }
  }
  return true;
}
