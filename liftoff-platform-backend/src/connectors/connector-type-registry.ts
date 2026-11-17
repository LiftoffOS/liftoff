// WS-5.2 — authoritative connector-type registry, cached client.
//
// Calls `GET /api/v1/connector-types` on connector-service and caches the
// result for 60s. PB's binding validators (WS-5.1) consume this to reject
// unknown connectorType strings at the API boundary.

import { buildOidcAuthHeader } from '@liftoffos/service-client';

export interface ConnectorTypeMeta {
  connectorType: string;
  category: string;
  functionNames: string[];
  listImplemented?: boolean;
  /** Function name → USD one call costs the platform, for the types the
   *  platform pays for (connector-service assembles it from its dispatch
   *  tables; a free source's functions are zero). Absent for a BYO card. */
  functionPrices?: Record<string, number>;
  /** Function name → the END brand a person knows the data by, the category
   *  it sits under and the call's label, for Insights Manager's data source rates. Never an
   *  intermediary's name. A function with no entry is not listed there. Absent
   *  until connector-service publishes it. */
  functionBrands?: Record<string, { brand: string; category: string; label: string }>;
}

let cached: { at: number; map: Map<string, ConnectorTypeMeta> } | null = null;
const TTL_MS = 60_000;

export async function fetchRegistry(): Promise<Map<string, ConnectorTypeMeta>> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.map;
  const base = process.env.CONNECTOR_SERVICE_URL;
  if (!base) {
    // No connector-service URL configured — return empty registry. Callers
    // treat empty as "no known types" so all validations fail closed.
    cached = { at: Date.now(), map: new Map() };
    return cached.map;
  }
  // Mounted at /api/connectors/catalog/connector-types on connector-service.
  // The plan's nominal `/api/v1/connector-types` path describes the contract;
  // the literal URL follows the existing /api/connectors/catalog mount.
  //
  // Auth MUST match getCatalog's: connector-service authenticates the service
  // token via the X-Service-Auth header (not Authorization: Bearer) and its
  // Cloud Run ingress needs an OIDC id token. An `Authorization: Bearer
  // <token>` 401s ("Missing X-Service-Auth header"), so this registry would
  // come back EMPTY and — because empty is a valid return — silently: no
  // connector would surface in capability discovery, and binding validators
  // would fail closed.
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers['X-Service-Auth'] = token;
  try {
    Object.assign(headers, await buildOidcAuthHeader(base));
  } catch {
    // OIDC unavailable in local dev — the service token alone suffices there.
  }
  const resp = await fetch(`${base}/api/connectors/catalog/connector-types`, {
    method: 'GET',
    headers,
  });
  if (!resp.ok) {
    throw new Error(`fetchRegistry HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as { types: ConnectorTypeMeta[] };
  cached = {
    at: Date.now(),
    map: new Map(body.types.map((t) => [t.connectorType, t])),
  };
  return cached.map;
}

/** One natively implemented function of a connector, as its author wrote it. */
export interface ConnectorFunctionMeta {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /**
   * What the SOURCE will actually accept, when that is narrower than what the
   * model is offered. Absent on almost every function; present where a
   * reseller enforces a constraint the vendor behind it does not — a Parse
   * scraper's TEST INPUTS, published as a domain and turned into a hard enum
   * by the reseller, while Parse itself takes free text.
   *
   * MODEL-FACING SURFACES MUST NOT READ THIS. It is for the one question
   * "would this source refuse these arguments", asked before a call is spent;
   * the args hint and every tool definition come from `inputSchema`, because
   * the strict list is not the truth about what may be asked for.
   */
  routingSchema?: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** The author's own account of the call's effect: 'read', 'write',
   *  'destructive', 'outbound', 'sensitive'. */
  categories: string[];
  draftVariant?: string;
}

const functionsCache = new Map<string, { at: number; functions: ConnectorFunctionMeta[] }>();

/** What a connector's functions take and do, from the same registry the
 *  names above come from, fetched one connector at a time when a caller is
 *  about to run, classify or describe one. Empty when the connector has
 *  nothing native, and — so a caller degrades rather than dies — when the
 *  service cannot be reached. Cached per connector for the same TTL. */
export async function fetchConnectorFunctions(connectorType: string): Promise<ConnectorFunctionMeta[]> {
  const hit = functionsCache.get(connectorType);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.functions;
  const base = process.env.CONNECTOR_SERVICE_URL;
  if (!base) return [];
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers['X-Service-Auth'] = token;
  try {
    Object.assign(headers, await buildOidcAuthHeader(base));
  } catch {
    // Same posture as fetchRegistry: the shared-secret header alone may do.
  }
  try {
    const resp = await fetch(
      `${base}/api/connectors/catalog/connector-types/${encodeURIComponent(connectorType)}/functions`,
      { method: 'GET', headers },
    );
    if (!resp.ok) return [];
    const body = (await resp.json()) as { functions?: ConnectorFunctionMeta[] };
    const functions = Array.isArray(body.functions) ? body.functions : [];
    functionsCache.set(connectorType, { at: Date.now(), functions });
    return functions;
  } catch {
    return [];
  }
}

export function _resetConnectorFunctionsCache(): void {
  functionsCache.clear();
}
