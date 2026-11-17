// Functional capability groups — maps a capability to the connector types
// that satisfy it, along with the OAuth/API scopes required.
//
// As of the unified-catalog refactor, CONNECTOR_CAPABILITIES is a PROJECTION
// over the CONNECTORS registry in ./connectors.ts. Each connector declares
// the capabilities it satisfies + scopes required in its own entry; the
// projection groups those bindings here so existing callers keep working
// without changes.
//
// DO NOT edit this map directly. To change which connectors satisfy a
// capability, edit the `capabilities` field on the connector entry in
// connectors.ts.
//
// One exception: capabilities without a working connector implementation
// (greenhouse, lever, pagerduty) are listed as `STATIC_ONLY_CAPABILITIES`
// below so they still appear in GetCapabilities responses. Once those
// connectors are added to the registry they will drop from this list.

import { ConnectorCapability as ProtoCapability } from '@liftoffos/proto-gen/liftoff/connector/v1/types_pb.js';
import { buildCapabilityMap } from './projections.js';

export interface CapabilityOption {
  connectorType: string;
  requiredScopes: string[];
}

/**
 * Capabilities whose connectors are declared (e.g. at the agent-template
 * level for routing) but whose client code isn't in the registry yet.
 * Entries that later gain registry definitions should be removed from
 * here — the projection will pick them up automatically.
 */
const STATIC_ONLY_CAPABILITIES: Record<string, CapabilityOption[]> = {
  ats: [
    { connectorType: 'greenhouse', requiredScopes: ['candidates:read', 'candidates:write', 'jobs:read', 'interviews:write'] },
    { connectorType: 'lever',      requiredScopes: ['read', 'write'] },
  ],
  incident_management: [
    { connectorType: 'pagerduty', requiredScopes: ['incidents.read', 'incidents.write', 'services.read'] },
  ],
};

/**
 * capability → connector options. Derived at module init from the
 * connector registry; static-only entries merged on top.
 */
export const CONNECTOR_CAPABILITIES: Record<string, CapabilityOption[]> = (() => {
  const derived = buildCapabilityMap();
  const merged: Record<string, CapabilityOption[]> = { ...derived };
  for (const [cap, options] of Object.entries(STATIC_ONLY_CAPABILITIES)) {
    merged[cap] = [...(merged[cap] ?? []), ...options];
  }
  return merged;
})();

/**
 * catalog capability key (snake_case) → proto enum value.
 *
 * DERIVED from the enum, not hand-listed. This map used to be ten hand-written
 * lines while the catalog declared thirty keys, and `getCapabilityGroups()`
 * drops an unmapped key with a bare `continue` — so the twenty missing ones
 * vanished from the GetCapabilities RPC in silence. No error, no log, no
 * failing test. `email_communication` (Gmail, Outlook, Zoho Mail),
 * `cloud_storage` (Drive, OneDrive, Dropbox, Box), `team_chat` (Slack, Teams,
 * Discord), `documents`, `data_table` and fifteen more were invisible to every
 * caller of that RPC for as long as the map was short.
 *
 * Deriving it removes the drift class rather than refilling it once: a proto
 * enum value is UPPER_SNAKE of its catalog key (EMAIL_COMMUNICATION ↔
 * email_communication), so lowercasing every enum member reproduces the map
 * exactly and a newly added enum value maps itself.
 *
 * The remaining direction — a catalog key with no enum value — cannot be fixed
 * here, because the enum lives in liftoff-proto. That is what
 * `__tests__/capability-proto-parity.test.ts` fails on.
 */
export const ProtoCapabilityByKey: Record<string, ProtoCapability> = Object.fromEntries(
  Object.entries(ProtoCapability)
    // The generated enum is bidirectional (name→value AND value→name); keep the
    // name→value half, and drop the zero/UNSPECIFIED sentinel.
    .filter(([name, value]) => typeof value === 'number' && name !== 'UNSPECIFIED')
    .map(([name, value]) => [name.toLowerCase(), value as ProtoCapability]),
);

/** Returns the connector types that satisfy a given capability. */
export function connectorTypesForCapability(capability: string): string[] {
  return (CONNECTOR_CAPABILITIES[capability] ?? []).map((o) => o.connectorType);
}

/** Returns the required scopes for a specific connector within a capability. */
export function scopesForConnector(capability: string, connectorType: string): string[] {
  const option = (CONNECTOR_CAPABILITIES[capability] ?? []).find(
    (o) => o.connectorType === connectorType,
  );
  return option?.requiredScopes ?? [];
}

/**
 * Source of truth for which connector types are currently functional
 * end-to-end. DERIVED from the CONNECTORS registry in ./connectors.ts —
 * a connector is "functional" iff its `status === 'available'`.
 *
 * To mark a connector available or coming-soon, edit its entry in
 * connectors.ts; this set updates automatically.
 */
export { FUNCTIONAL_CONNECTOR_TYPES } from './projections.js';
