// Projections over the unified CONNECTORS registry.
//
// Every derived view that callers already use (FUNCTIONAL_CONNECTOR_TYPES,
// CONNECTOR_DISPLAY_NAMES, display-only subsets, etc.) is computed here
// lazily. Hand-written copies of these sets/maps must not exist elsewhere —
// they're fixed-at-boot projections of src/catalog/connectors.ts.

import type { ConnectorDef } from '@liftoffos/connector-types';
import { CONNECTORS, type LocalConnectorDef } from './connectors.js';
import { composioAuthConfigId, composioMcpServerId } from './composio-resources';

// ── Availability ─────────────────────────────────────────────────────

/**
 * True when a catalog entry is fully wired up for end-user connection.
 *
 * Static check (`status === 'available'`) is necessary but not sufficient:
 * Composio-managed entries can be statically 'available' while their
 * `authConfigIds`/`mcpServerIds` are still bootstrap placeholders
 * (`<from-phase-0>`) — the OAuth `/start` would 503. Showing 'available' in
 * the UI then causes a connect-then-fail loop, so this downgrades to "not
 * functional yet" until the bootstrap resources are in place.
 */
// Accepts LocalConnectorDef (the catalog's own wider type — its `auth` union
// includes the locally-added 'iam_grant' kind). ConnectorDef is still
// assignable to it, so external callers passing a plain ConnectorDef also work.
// Only reads status/mcp/type — never `auth` — so the widening is irrelevant here.
export function isConnectorFunctional(c: LocalConnectorDef): boolean {
  if (c.status !== 'available') return false;
  if (c.mcp?.kind === 'composio_managed') {
    const env = (process.env.ENVIRONMENT ?? 'dev') as 'dev' | 'prod';
    const env2: 'dev' | 'prod' = env === 'prod' ? 'prod' : 'dev';
    const auth = composioAuthConfigId(c.mcp.toolkitSlug, c.mcp.authConfigIds, env2);
    const mcp = composioMcpServerId(c.mcp.toolkitSlug, c.mcp.mcpServerIds, env2);
    if (!auth || auth.startsWith('<')) return false;
    if (!mcp || mcp.startsWith('<')) return false;
  }
  return true;
}

/**
 * Connector types whose `status === 'available'` AND (for Composio-managed
 * entries) whose Composio resources are provisioned. This is the canonical
 * answer to "can a user pick this from the connector picker today?" and
 * replaces the hand-maintained FUNCTIONAL_CONNECTOR_TYPES set in
 * src/catalog/connector-capabilities.ts (which is now re-exported as a
 * derivation of this computed set).
 */
export const FUNCTIONAL_CONNECTOR_TYPES: Set<string> = new Set(
  Object.values(CONNECTORS)
    .filter((c) => isConnectorFunctional(c))
    .map((c) => c.type),
);

/**
 * Display names keyed by connector type. Replaces the hand-maintained
 * CONNECTOR_DISPLAY_NAMES map in src/types.ts.
 */
export const CONNECTOR_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(CONNECTORS).map((c) => [c.type, c.displayName]),
);

// ── Capability map ───────────────────────────────────────────────────

/**
 * capability → connectors that satisfy it, keyed by capability name.
 * Each entry includes the required scopes so agent-template bindings
 * can pick a connector that grants what they need.
 */
export function buildCapabilityMap(): Record<
  string,
  Array<{ connectorType: string; requiredScopes: string[] }>
> {
  const map: Record<string, Array<{ connectorType: string; requiredScopes: string[] }>> = {};
  for (const connector of Object.values(CONNECTORS)) {
    if (!connector.capabilities) continue;
    // Filter on effective status — a Composio-managed entry with placeholder
    // IDs is statically 'available' but functionally not connectable yet.
    if (!isConnectorFunctional(connector)) continue;
    for (const binding of connector.capabilities) {
      const bucket = (map[binding.capability] ??= []);
      bucket.push({
        connectorType: connector.type,
        requiredScopes: binding.requiredScopes,
      });
    }
  }
  return map;
}

// ── Full catalog serializable response ───────────────────────────────

/**
 * Serializable array of all known connectors, sorted alphabetically by
 * type for deterministic output. Used by GET /api/connectors/catalog and
 * by platform-backend's fallback sync script.
 *
 * Applies the same effective-status downgrade as FUNCTIONAL_CONNECTOR_TYPES:
 * Composio-managed entries with placeholder resource IDs are exposed as
 * 'coming_soon' (with a statusReason naming the bootstrap script) so the
 * frontend doesn't render a "Connect" button that would 503 immediately.
 * Once an operator runs the bootstrap and pastes real IDs into the catalog,
 * the response auto-upgrades.
 */
export function getConnectorCatalog(): ConnectorDef[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CONNECTOR_ENTITY_SCHEMAS } = require('./connector-entity-schemas.js') as {
    CONNECTOR_ENTITY_SCHEMAS: Record<string, Record<string, unknown>>;
  };
  return Object.values(CONNECTORS)
    .map((c): ConnectorDef => {
      // Augment each connector with its declared entity schemas
      // (empty object when undeclared). This is the data the platform-backend
      // distill prompt + reactive-subscription validator consume.
      const entitySchemas = CONNECTOR_ENTITY_SCHEMAS[c.type] ?? {};
      if (c.status === 'available' && c.mcp?.kind === 'composio_managed' && !isConnectorFunctional(c)) {
        return {
          ...c,
          status: 'coming_soon',
          statusReason:
            `Composio resources for '${c.mcp.toolkitSlug}' not yet provisioned ` +
            `(operator must run npm run composio:bootstrap-toolkit -- --slug=${c.mcp.toolkitSlug})`,
          entitySchemas,
        } as ConnectorDef;
      }
      return { ...c, entitySchemas } as ConnectorDef;
    })
    .sort((a, b) => a.type.localeCompare(b.type));
}
