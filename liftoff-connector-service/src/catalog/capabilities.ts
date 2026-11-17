// Capability + functional-types registry for the connector-service.
//
// Two shapes are surfaced to callers:
//
// - ConnectorCapabilityEntry — per-connector-type metadata (OAuth provider,
//   scopes, MCP config presence, available functions). Used internally for
//   admin tools and returned by listConnectorCapabilities().
//
// - GetCapabilities RPC — per-capability-group (email_marketing, hris, etc)
//   with the providers that satisfy it. Built from CONNECTOR_CAPABILITIES.
//
// "Functional" = has a working OAuth/auth flow AND an MCP config that
// resolves (vendor-hosted, OR self-hosted with MCP_SIDECAR_URL set). The
// list is the canonical answer for GetFunctionalTypes — platform-backend
// drops its static copy after Fix 6.

import {
  CONNECTOR_DISPLAY_NAMES,
  getOAuthProvider,
  getConnectorScopes,
  type ConnectorType,
} from '../types.js';
import {
  getMCPConnectorTypes,
  getFullRegistryEntry,
} from './mcp-server-registry.js';
import {
  getConnectorFunctions,
  getRegisteredConnectorTypes,
} from './connector-functions-registry.js';
import {
  CONNECTOR_CAPABILITIES,
  FUNCTIONAL_CONNECTOR_TYPES,
  ProtoCapabilityByKey,
  type CapabilityOption,
} from './connector-capabilities.js';
import { ConnectorCapability as ProtoCapability } from '@liftoffos/proto-gen/liftoff/connector/v1/types_pb.js';

export interface ConnectorCapabilityEntry {
  connectorType: ConnectorType;
  displayName: string;
  oauthProvider: string | null;
  scopes: string[];
  hasMcpConfig: boolean;
  isVendorHostedMcp: boolean;
  functionNames: string[];
}

export function getConnectorCapability(
  connectorType: string,
): ConnectorCapabilityEntry | null {
  if (!(connectorType in CONNECTOR_DISPLAY_NAMES)) return null;
  const ct = connectorType as ConnectorType;
  const registryEntry = getFullRegistryEntry(ct);
  const functions = getConnectorFunctions(ct);
  return {
    connectorType: ct,
    displayName: CONNECTOR_DISPLAY_NAMES[ct],
    oauthProvider: getOAuthProvider(ct),
    scopes: getConnectorScopes(ct),
    hasMcpConfig: registryEntry !== null,
    isVendorHostedMcp: registryEntry?.isVendorHosted ?? false,
    functionNames: functions.map((f) => f.name),
  };
}

export function listConnectorCapabilities(): ConnectorCapabilityEntry[] {
  const seen = new Set<string>([
    ...Object.keys(CONNECTOR_DISPLAY_NAMES),
    ...getMCPConnectorTypes(),
    ...getRegisteredConnectorTypes(),
  ]);
  const out: ConnectorCapabilityEntry[] = [];
  for (const t of seen) {
    const cap = getConnectorCapability(t);
    if (cap) out.push(cap);
  }
  return out;
}

/**
 * Canonical list of connector types that are functional end-to-end today —
 * this is what the GetFunctionalTypes RPC returns. Platform-backend reads
 * this via RPC; its static copy is dead code after Fix 6.
 */
export function getFunctionalConnectorTypes(): string[] {
  return Array.from(FUNCTIONAL_CONNECTOR_TYPES).sort();
}

/**
 * Returned shape for the GetCapabilities RPC: one entry per capability
 * group (email_marketing, crm, hris, …) with the providers that satisfy it.
 */
export interface CapabilityGroupEntry {
  capability: ProtoCapability;
  capabilityKey: string; // snake_case string — convenience for JSON-aware callers
  providers: Array<{ connectorType: string; requiredScopes: string[] }>;
}

export function getCapabilityGroups(): CapabilityGroupEntry[] {
  const out: CapabilityGroupEntry[] = [];
  for (const [key, options] of Object.entries(CONNECTOR_CAPABILITIES)) {
    const proto = ProtoCapabilityByKey[key];
    if (proto === undefined) continue; // capability key not in proto enum
    out.push({
      capability: proto,
      capabilityKey: key,
      providers: options.map((o: CapabilityOption) => ({
        connectorType: o.connectorType,
        requiredScopes: o.requiredScopes,
      })),
    });
  }
  return out;
}
