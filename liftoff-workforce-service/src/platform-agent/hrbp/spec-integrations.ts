// Resolve a plan spec's connector types into real integration bindings.
//
// WorkforcePlanAgentSpec.connectors is a list of connector TYPE names. Its
// contract says connected ones are auto-assigned at provisioning and
// unconnected ones are stored as pending integrations on the created agent;
// this module is that partition.
//
// The spec is the authoritative input, not the model's tool arguments. A model
// cannot know connection ids, so integrations it supplies carry no usable
// `type` — and platform-backend reads an empty type set as "no filter", which
// on a large workspace means every manifest in the tenant.

import { listTenantConnectors } from '../../workforce-plans/tenant-connectors.js';
import { log } from '../../infrastructure/logging.js';
import type { WorkforcePlanAgentSpec } from '../../workforce-plans/types.js';

/** An integration binding as platform-backend's distill expects it. */
export interface ResolvedIntegration {
  id: string;
  type: string;
  name: string;
  /** Object-level scoping. Empty means full access to the connector, which is
   *  what a plan spec asks for — it names connector types, never objects.
   *
   *  Required, not optional: platform-backend's IntegrationInfo declares it
   *  required and dereferences it without a guard. */
  selectedObjects: string[];
}

export interface SpecIntegrations {
  /** Connector types that are connected — bound to the agent now. */
  integrations: ResolvedIntegration[];
  /** Connector types the spec asked for that the workspace has not connected. */
  pendingConnectorTypes: string[];
  /** False when the connector roster could not be read at all. Callers must not
   *  treat this as "the workspace has nothing connected". */
  lookupSucceeded: boolean;
}

/**
 * Partition `spec.connectors` into connected bindings and pending types.
 *
 * A failed connector lookup returns `lookupSucceeded: false` with everything
 * listed as pending, so a provisioning run degrades to "bind nothing yet"
 * instead of silently claiming the workspace is empty.
 */
export async function resolveSpecIntegrations(
  tenantId: string,
  spec: WorkforcePlanAgentSpec,
): Promise<SpecIntegrations> {
  const requested = (spec.connectors ?? []).filter(c => typeof c === 'string' && c.length > 0);
  if (requested.length === 0) {
    return { integrations: [], pendingConnectorTypes: [], lookupSucceeded: true };
  }

  const result = await listTenantConnectors(tenantId);
  if (!result.ok) {
    log.warn(
      { tenantId, specId: spec.specId, requested, reason: result.reason },
      'HRBP: connector lookup failed — provisioning with no bindings rather than assuming none are connected',
    );
    return {
      integrations: [],
      pendingConnectorTypes: requested,
      lookupSucceeded: false,
    };
  }

  // One binding per requested type. A workspace can hold several connections of
  // the same type; take the first active one deterministically rather than
  // binding all of them, which would widen the agent's reach beyond the spec.
  const byType = new Map<string, { id: string; type: string; name: string; displayName: string }>();
  for (const c of result.connectors) {
    if (!byType.has(c.type)) byType.set(c.type, c);
  }

  const integrations: ResolvedIntegration[] = [];
  const pendingConnectorTypes: string[] = [];
  for (const type of requested) {
    const match = byType.get(type);
    if (match) {
      integrations.push({
        id: match.id,
        type: match.type,
        name: match.displayName || match.name || match.type,
        selectedObjects: [],
      });
    } else {
      pendingConnectorTypes.push(type);
    }
  }

  return { integrations, pendingConnectorTypes, lookupSucceeded: true };
}
