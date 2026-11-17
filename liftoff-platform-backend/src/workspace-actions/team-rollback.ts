// Restore a previous version: of a team (POST /:id/rollback's body) or of a
// collaborator (POST /api/external-agents/:id/rollback's). Both write a new
// version rather than rewinding history, so the restore is itself undoable.

import { internalAgentService } from '../internal-agents/service';
import { externalAgentService } from '../external-agents/service';
import type { InternalAgent } from '../internal-agents/types';
import type { ExternalAgent } from '../external-agents/types';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

export async function rollbackTeam(actor: Actor, agentId: string, version: number): Promise<{ agent: InternalAgent } | { refused: 'not_found'; message: string }> {
  requirePermission(actor, 'teams:update');
  const agent = await internalAgentService.rollbackToVersion(agentId, actor.tenantId, version, actor.accountId);
  if (!agent) return { refused: 'not_found', message: 'agent or version not found' };
  writeAudit(actor, 'internal_agent.rollback', {
    internalAgentId: agent.id,
    tenantId: actor.tenantId,
    targetVersion: version,
    newVersion: agent.currentVersion,
  });
  return { agent };
}

export async function rollbackCollaborator(actor: Actor, collaboratorId: string, version: number): Promise<{ collaborator: ExternalAgent } | { refused: 'not_found'; message: string }> {
  requirePermission(actor, 'collaborators:update');
  const collaborator = await externalAgentService.rollback(collaboratorId, actor.tenantId, version);
  if (!collaborator) return { refused: 'not_found', message: 'External agent or version not found' };
  writeAudit(actor, 'external_agent.rollback', {
    resourceType: 'external_agent',
    resourceId: collaboratorId,
    newState: { rolledBackToVersion: version },
  });
  return { collaborator };
}
