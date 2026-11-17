// Turn what a person asked to bind into the integrations an agent stores.
//
// An assistant hears "bind Gmail to the marketing team" or "let the support
// team work with the billing collaborator". Neither names a connection id,
// which is what internal_agents.integrations holds, so the request is resolved
// here: a connector TYPE becomes the workspace's first active connection of
// that type (the rule workforce's plan provisioning applies), or is recorded as
// pending when nothing of that type is connected; a collaborator or a peer
// team becomes the peer entry the runtime resolves at dispatch. The result is
// validated the same way the dashboard's PUT validates its `integrations`.

import { listConnectorsForTenant } from '../connectors/connector-service-client';
import { externalAgentService } from '../external-agents/service';
import { internalAgentService } from '../internal-agents/service';
import { validateIntegrationsArray } from '../internal-agents/integration-validator';
import type { IntegrationPermission } from '../internal-agents/types';

export type BindingRequest =
  | {
      kind: 'connector';
      type: string;
      /** A specific connection of that type: the one the team already holds
       *  (a re-binding keeps it) or the one the person picked. Absent means
       *  the workspace's first active connection of the type. */
      connectorId?: string;
      selectedObjects?: string[];
    }
  | { kind: 'collaborator'; id: string }
  | { kind: 'team'; id: string };

export interface ResolvedBindings {
  integrations: IntegrationPermission[];
  /** Connector types asked for that the workspace has not connected. */
  pendingIntegrations: string[];
  /** Collaborator or team ids that name nothing in this workspace (or the team
   *  itself). */
  unresolved: string[];
}

/**
 * Resolve binding requests for an agent. `accountId` is the acting person: the
 * connector listing is read on their behalf, as the connections page reads it.
 */
export async function resolveBindings(
  tenantId: string,
  agentId: string,
  requested: BindingRequest[],
  accountId: string,
): Promise<ResolvedBindings> {
  const integrations: IntegrationPermission[] = [];
  const pendingIntegrations: string[] = [];
  const unresolved: string[] = [];

  const connectorRequests = requested.filter((r): r is Extract<BindingRequest, { kind: 'connector' }> => r.kind === 'connector');
  if (connectorRequests.length > 0) {
    const connectors = await listConnectorsForTenant(tenantId, accountId);
    // A request that names a connection keeps THAT connection while the
    // workspace still has it, whatever its status: the dashboard keeps a
    // binding to a connection that needs a reconnect, and a re-binding must
    // not swap a team onto another connection of the same type. A request
    // that names only a type takes the workspace's first active connection of
    // it, deterministically, rather than every one (which would widen the
    // team's reach beyond what was asked); nothing active means pending.
    const byId = new Map(connectors.map((c) => [c.id, c]));
    const firstActiveByType = new Map<string, { id: string; type: string }>();
    for (const c of connectors) {
      if (!c.type || c.status !== 'active') continue;
      if (!firstActiveByType.has(c.type)) firstActiveByType.set(c.type, { id: c.id, type: c.type });
    }
    for (const request of connectorRequests) {
      const named = request.connectorId ? byId.get(request.connectorId) : undefined;
      const match = named && (named.type ?? request.type) === request.type
        ? { id: named.id, type: request.type }
        : firstActiveByType.get(request.type);
      if (match) {
        integrations.push({ id: match.id, type: match.type, selectedObjects: request.selectedObjects ?? [] });
      } else {
        pendingIntegrations.push(request.type);
      }
    }
  }

  for (const request of requested) {
    if (request.kind === 'collaborator') {
      const collaborator = await externalAgentService.get(request.id, tenantId);
      if (!collaborator) {
        unresolved.push(request.id);
        continue;
      }
      // Peer entries carry no connector id: the runtime resolves them at
      // dispatch (integration-validator exempts these two types).
      integrations.push({ id: collaborator.id, type: 'external_agent', selectedObjects: [] });
    } else if (request.kind === 'team') {
      if (request.id === agentId) {
        unresolved.push(request.id);
        continue;
      }
      const team = await internalAgentService.getById(request.id, tenantId);
      if (!team) {
        unresolved.push(request.id);
        continue;
      }
      integrations.push({ id: team.id, type: 'internal_agent', selectedObjects: [] });
    }
  }

  const validated = integrations.length > 0
    ? await validateIntegrationsArray(integrations, { tenantId, agentId })
    : [];

  return { integrations: validated as IntegrationPermission[], pendingIntegrations, unresolved };
}
