// Connector capabilities — thin re-export from the connector-service cache.
//
// Before Phase 1c this file owned the capability → (connector types + scopes)
// registry. After Phase 1c the authoritative source is the connector-service's
// GetCapabilities RPC. This module preserves the original exports so existing
// callers (`from-template-router.ts`, `distill-service.ts`, `validator.ts`,
// `loader.ts`) keep compiling unchanged.
//
// See `../connectors/connector-service-cache.ts` for the cache lifecycle.
//
// KEEP THIS FILE LEAN — no capability data lives here anymore. The static
// fallback is in `../connectors/connector-service-cache.static.ts` and is
// covered by a drift test against the connector-service source.

export type { CapabilityOption } from '../connectors/connector-service-cache';
export {
  connectorTypesForCapability,
  scopesForConnector,
  getAllCapabilities,
} from '../connectors/connector-service-cache';

import { getAllCapabilities, connectorTypesForCapability } from '../connectors/connector-service-cache';

/** The capability groups a requirement accepts, as a list however it was
 *  written. A `capability` requirement is a one-entry list; `capabilities` is
 *  already one; a `connectorType` requirement names no capability at all. */
export function capabilitiesForRequirement(
  req: { capability?: string; capabilities?: string[] },
): string[] {
  if (req.capabilities?.length) return req.capabilities;
  return req.capability ? [req.capability] : [];
}

/** Every connector type that satisfies a requirement.
 *
 *  The one place that turns a requirement into types, so a requirement naming
 *  two capabilities is answered by the union of both. Reading `req.capability`
 *  directly is what made a second capability invisible to a caller: the field
 *  is absent on a list requirement, so the lookup silently returned nothing and
 *  the requirement read as satisfiable by no connector at all. */
export function connectorTypesForRequirement(
  req: { connectorType?: string; capability?: string; capabilities?: string[] },
): string[] {
  if (req.connectorType) return [req.connectorType];
  const types = new Set<string>();
  for (const cap of capabilitiesForRequirement(req)) {
    for (const t of connectorTypesForCapability(cap)) types.add(t);
  }
  return [...types];
}

/**
 * Live proxy onto the cache. Callers doing
 *   `CONNECTOR_CAPABILITIES[capability]`
 * get the current value; callers doing
 *   `Object.keys(CONNECTOR_CAPABILITIES)`
 * get the current keys — the Proxy forwards both ops.
 */
export const CONNECTOR_CAPABILITIES: Readonly<
  Record<string, ReadonlyArray<{ connectorType: string; requiredScopes: string[] }>>
> = new Proxy(
  {} as Record<string, ReadonlyArray<{ connectorType: string; requiredScopes: string[] }>>,
  {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      return getAllCapabilities()[prop as string];
    },
    has(_t, prop) {
      if (typeof prop === 'symbol') return false;
      return (prop as string) in getAllCapabilities();
    },
    ownKeys() {
      return Object.keys(getAllCapabilities());
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      const caps = getAllCapabilities();
      if (!(prop in caps)) return undefined;
      return {
        enumerable: true,
        configurable: true,
        value: caps[prop as string],
      };
    },
  },
);
