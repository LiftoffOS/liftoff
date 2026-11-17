// External agents, for the assistants: read one, connect one (no
// credential — anything with a token is the page's, D5), update its settings,
// pause or resume it, rediscover what it serves, move its endpoint, archive
// it. Every write is owner/admin (collaborators:update) and is audited under
// the person and the surface.

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { externalAgentService } from '../external-agents/service';
import type {
  CollaborationMode,
  ExternalAgent,
  ExternalAgentStatus,
  InternalAgentRequestRule,
  RequestPermission,
  RequestType,
} from '../external-agents/types';
import { internalAgentService } from '../internal-agents/service';
import { discoverExternalAgentWithProgress } from '../external-agents/discover-adapter';
import type { DiscoverOutput } from '../mcp/types';
import { assertPublicUrl, BlockedUrlError } from '../common/url-guard';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

/** The request-rule permissions the connection wizard seeds for a team
 *  (RequestRulesStep.tsx). */
export const WIZARD_DEFAULT_PERMISSIONS: Record<RequestType, RequestPermission> = {
  read_summaries: 'allowed',
  run_analysis: 'allowed',
  draft_outputs: 'approval_required',
  propose_updates: 'approval_required',
};

export const requestRulePermissionsSchema = z.object({
  read_summaries: z.enum(['allowed', 'approval_required', 'blocked']),
  run_analysis: z.enum(['allowed', 'approval_required', 'blocked']),
  draft_outputs: z.enum(['allowed', 'approval_required', 'blocked']),
  propose_updates: z.enum(['allowed', 'approval_required', 'blocked']),
});

export const collaboratorRequestRuleSchema = z.object({
  internalAgentId: z.string().uuid(),
  permissions: requestRulePermissionsSchema,
});

export const collaborationModeSchema = z.enum(['request_help', 'receive_delegated', 'two_way', 'observe_only']);

export interface CollaboratorView {
  id: string;
  name: string;
  description: string | null;
  endpointHost: string;
  collaborationMode: CollaborationMode;
  status: ExternalAgentStatus;
  allowedInternalAgentIds: string[];
  requestRules: InternalAgentRequestRule[];
  costAmount: number | null;
  costType: 'per_task' | 'per_month' | null;
  summary: string | null;
  capabilities: string[];
  capabilityChanges: ExternalAgent['capabilityChanges'];
  currentVersion: number;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

export function collaboratorView(c: ExternalAgent): CollaboratorView {
  let endpointHost = '';
  try { endpointHost = new URL(c.endpointUrl).host; } catch { /* display only */ }
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    endpointHost,
    collaborationMode: c.collaborationMode,
    status: c.status,
    allowedInternalAgentIds: c.allowedInternalAgentIds,
    requestRules: c.requestRules,
    costAmount: c.costAmount,
    costType: c.costType,
    summary: c.summary,
    capabilities: (c.detectedCapabilities ?? []).map((cap) => cap.name),
    capabilityChanges: c.capabilityChanges,
    currentVersion: c.currentVersion,
    lastCheckedAt: c.lastCheckedAt,
    lastError: c.lastError,
  };
}

type NotFound = { refused: 'not_found'; message: string };
const notFound = (): NotFound => ({ refused: 'not_found', message: 'External agent not found' });

export async function getCollaborator(actor: Actor, id: string): Promise<{ collaborator: CollaboratorView } | NotFound> {
  const c = await externalAgentService.get(id, actor.tenantId);
  return c ? { collaborator: collaboratorView(c) } : notFound();
}

/** Fill each rule's internalAgentName from the team's role, and refuse ids
 *  that name no team in this workspace. */
async function completeRules(
  tenantId: string,
  rules: Array<{ internalAgentId: string; permissions: Record<RequestType, RequestPermission> }>,
): Promise<{ rules: InternalAgentRequestRule[] } | { unknown: string[] }> {
  const out: InternalAgentRequestRule[] = [];
  const unknown: string[] = [];
  for (const rule of rules) {
    const team = await internalAgentService.getById(rule.internalAgentId, tenantId);
    if (!team) { unknown.push(rule.internalAgentId); continue; }
    out.push({ internalAgentId: team.id, internalAgentName: team.role, permissions: rule.permissions });
  }
  return unknown.length > 0 ? { unknown } : { rules: out };
}

async function validateTeamIds(tenantId: string, ids: string[]): Promise<string[]> {
  const unknown: string[] = [];
  for (const id of ids) {
    if (!(await internalAgentService.getById(id, tenantId))) unknown.push(id);
  }
  return unknown;
}

/** The discovery the wizard runs, without a stream: the pipeline with a
 *  no-op progress callback. */
async function discover(input: { endpointUrl: string; name: string; description?: string; tenantId: string; agentId?: string }): Promise<DiscoverOutput> {
  // The same adapter the dashboard's rediscover uses, so an agent id supplies
  // the cached-classification lookup under the agent's own identity and a
  // first discovery classifies everything.
  return discoverExternalAgentWithProgress(
    { endpointUrl: input.endpointUrl, name: input.name, description: input.description, authType: 'none', tenantId: input.tenantId, agentId: input.agentId, correlationId: randomUUID() },
    () => undefined,
  );
}

export type ConnectCollaboratorInput = {
  name: string;
  endpointUrl: string;
  description?: string;
  allowedTeamIds: string[];
  collaborationMode: CollaborationMode;
  requestRules?: Array<{ internalAgentId: string; permissions: Record<RequestType, RequestPermission> }>;
};

export async function connectCollaborator(
  actor: Actor,
  input: ConnectCollaboratorInput,
): Promise<{ collaborator: CollaboratorView } | { refused: 'validation' | 'discovery_failed'; message: string; context?: unknown }> {
  requirePermission(actor, 'collaborators:update');
  const { tenantId } = actor;

  try {
    await assertPublicUrl(input.endpointUrl, { context: 'workspace-actions.collaborator.connect' });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return { refused: 'validation', message: 'Endpoint URL is not reachable from the platform', context: { reason: err.reason } };
    }
    throw err;
  }

  const unknownTeams = await validateTeamIds(tenantId, input.allowedTeamIds);
  if (unknownTeams.length > 0) {
    return { refused: 'validation', message: `These teams do not exist in this workspace: ${unknownTeams.join(', ')}`, context: { unknown: unknownTeams } };
  }
  const rulesInput = input.requestRules
    ?? input.allowedTeamIds.map((internalAgentId) => ({ internalAgentId, permissions: WIZARD_DEFAULT_PERMISSIONS }));
  const completed = await completeRules(tenantId, rulesInput);
  if ('unknown' in completed) {
    return { refused: 'validation', message: `These teams do not exist in this workspace: ${completed.unknown.join(', ')}`, context: { unknown: completed.unknown } };
  }

  let discovered: DiscoverOutput;
  try {
    discovered = await discover({ endpointUrl: input.endpointUrl, name: input.name, description: input.description, tenantId });
  } catch (err) {
    return { refused: 'discovery_failed', message: `The endpoint could not be read: ${(err as Error).message}` };
  }

  const created = await externalAgentService.create(tenantId, {
    name: input.name,
    endpointUrl: input.endpointUrl,
    transportType: discovered.transportType,
    description: input.description,
    connectionType: 'custom',
    authType: 'none',
    collaborationMode: input.collaborationMode,
    allowedInternalAgentIds: input.allowedTeamIds,
    requestRules: completed.rules,
    summary: discovered.summary,
    collaborationHints: discovered.collaborationHints,
    detectedCapabilities: discovered.capabilities,
    detectedResources: discovered.resources,
    toolClassifications: discovered.toolClassifications,
    toolEffectClasses: discovered.toolEffectClasses,
    toolClassificationVersions: discovered.toolClassificationVersions,
    rawMcpTools: discovered.rawMcpTools,
    rawMcpResources: discovered.rawMcpResources,
    capabilitySource: 'mcp_discovery',
    discoveryCorrelationId: discovered.correlationId,
  }, randomUUID());

  writeAudit(actor, 'external_agent.added', {
    resourceType: 'external_agent',
    resourceId: created.id,
    newState: { name: created.name, collaborationMode: created.collaborationMode, allowedInternalAgentIds: created.allowedInternalAgentIds },
  });
  return { collaborator: collaboratorView(created) };
}

export type UpdateCollaboratorInput = {
  name?: string;
  description?: string;
  collaborationMode?: CollaborationMode;
  allowedInternalAgentIds?: string[];
  requestRules?: Array<{ internalAgentId: string; permissions: Record<RequestType, RequestPermission> }>;
  costAmount?: number | null;
  costType?: 'per_task' | 'per_month' | null;
};

export async function updateCollaborator(
  actor: Actor,
  id: string,
  patch: UpdateCollaboratorInput,
): Promise<{ collaborator: CollaboratorView } | NotFound | { refused: 'validation'; message: string; context?: unknown }> {
  requirePermission(actor, 'collaborators:update');
  const { tenantId } = actor;
  if (patch.allowedInternalAgentIds) {
    const unknown = await validateTeamIds(tenantId, patch.allowedInternalAgentIds);
    if (unknown.length > 0) {
      return { refused: 'validation', message: `These teams do not exist in this workspace: ${unknown.join(', ')}`, context: { unknown } };
    }
  }
  let requestRules: InternalAgentRequestRule[] | undefined;
  if (patch.requestRules) {
    const completed = await completeRules(tenantId, patch.requestRules);
    if ('unknown' in completed) {
      return { refused: 'validation', message: `These teams do not exist in this workspace: ${completed.unknown.join(', ')}`, context: { unknown: completed.unknown } };
    }
    requestRules = completed.rules;
  }
  const updated = await externalAgentService.update(id, tenantId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.collaborationMode !== undefined ? { collaborationMode: patch.collaborationMode } : {}),
    ...(patch.allowedInternalAgentIds !== undefined ? { allowedInternalAgentIds: patch.allowedInternalAgentIds } : {}),
    ...(requestRules !== undefined ? { requestRules } : {}),
    ...(patch.costAmount !== undefined ? { costAmount: patch.costAmount } : {}),
    ...(patch.costType !== undefined ? { costType: patch.costType } : {}),
  });
  if (!updated) return notFound();
  writeAudit(actor, 'external_agent.updated', { resourceType: 'external_agent', resourceId: id, newState: { fields: Object.keys(patch) } });
  return { collaborator: collaboratorView(updated) };
}

export async function setCollaboratorStatus(
  actor: Actor,
  id: string,
  status: 'connected' | 'disconnected',
): Promise<{ collaborator: CollaboratorView } | NotFound> {
  requirePermission(actor, 'collaborators:update');
  const updated = await externalAgentService.updateStatus(id, actor.tenantId, status);
  if (!updated) return notFound();
  writeAudit(actor, 'external_agent.status_changed', { resourceType: 'external_agent', resourceId: id, newState: { status } });
  return { collaborator: collaboratorView(updated) };
}

export async function rediscoverCollaborator(
  actor: Actor,
  id: string,
): Promise<{ collaborator: CollaboratorView; changes: ExternalAgent['capabilityChanges']; requiresReview: boolean } | NotFound | { refused: 'discovery_failed'; message: string }> {
  requirePermission(actor, 'collaborators:update');
  const { tenantId } = actor;
  const existing = await externalAgentService.get(id, tenantId);
  if (!existing) return notFound();
  let discovered: DiscoverOutput;
  try {
    discovered = await discover({ endpointUrl: existing.endpointUrl, name: existing.name, description: existing.description ?? undefined, tenantId, agentId: id });
  } catch (err) {
    return { refused: 'discovery_failed', message: `The endpoint could not be read: ${(err as Error).message}` };
  }
  const result = await externalAgentService.rediscover(id, tenantId, {
    capabilities: discovered.capabilities,
    resources: discovered.resources,
    toolClassifications: discovered.toolClassifications,
    toolEffectClasses: discovered.toolEffectClasses,
    toolClassificationVersions: discovered.toolClassificationVersions,
    rawMcpTools: discovered.rawMcpTools,
    rawMcpResources: discovered.rawMcpResources,
    transportType: discovered.transportType,
    summary: discovered.summary,
    collaborationHints: discovered.collaborationHints,
  }, { reviewPolicy: 'gate' });
  writeAudit(actor, 'external_agent.rediscovered', {
    resourceType: 'external_agent', resourceId: id,
    newState: { changes: result.changes.length, requiresReview: result.requiresReview, status: result.agent.status },
  });
  return { collaborator: collaboratorView(result.agent), changes: result.changes, requiresReview: result.requiresReview };
}

export async function setCollaboratorEndpoint(
  actor: Actor,
  id: string,
  endpointUrl: string,
): Promise<{ collaborator: CollaboratorView; changes: ExternalAgent['capabilityChanges']; requiresReview: boolean } | NotFound | { refused: 'validation' | 'discovery_failed'; message: string; context?: unknown }> {
  requirePermission(actor, 'collaborators:update');
  try {
    await assertPublicUrl(endpointUrl, { context: 'workspace-actions.collaborator.setEndpoint' });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return { refused: 'validation', message: 'Endpoint URL is not reachable from the platform', context: { reason: err.reason } };
    }
    throw err;
  }
  const moved = await externalAgentService.updateEndpoint(id, actor.tenantId, endpointUrl);
  if (!moved) return notFound();
  writeAudit(actor, 'external_agent.endpoint_changed', { resourceType: 'external_agent', resourceId: id, newState: { endpointHost: collaboratorView(moved).endpointHost } });
  return rediscoverCollaborator(actor, id) as Promise<{ collaborator: CollaboratorView; changes: ExternalAgent['capabilityChanges']; requiresReview: boolean } | NotFound | { refused: 'discovery_failed'; message: string }>;
}

export async function archiveCollaborator(actor: Actor, id: string): Promise<{ archived: true } | NotFound> {
  requirePermission(actor, 'collaborators:update');
  const deleted = await externalAgentService.delete(id, actor.tenantId);
  if (!deleted) return notFound();
  writeAudit(actor, 'external_agent.removed', { resourceType: 'external_agent', resourceId: id });
  return { archived: true };
}
