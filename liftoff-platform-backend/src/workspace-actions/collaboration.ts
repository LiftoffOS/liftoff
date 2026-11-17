// Wire a team and a collaborator together, or apart.
//
// A working collaboration has two halves in two rows: the team's
// integrations name the collaborator (a peer binding, distilled into the
// team's prompts), and the collaborator's allowed_internal_agent_ids names
// the team, with a request rule for it. The runtime honours the INTERSECTION
// (external-agents/service.ts getForInternalAgent), so a half-state grants
// nothing — which is what lets this be a reconciler over two service
// transactions rather than one that needs both.
//
// Order: collaborator side first (a cheap, idempotent set-add), team side
// second (a distil plus an update). If the team side fails, the collaborator
// side is compensated (a set-remove, idempotent); if the compensation fails
// too, the result says so and a re-run converges, because step 1 skips the
// side that already holds the desired state. Unwiring mirrors it with the
// team side first: the capability comes off before the permission.

import { externalAgentService } from '../external-agents/service';
import type { ExternalAgent, InternalAgentRequestRule, RequestPermission, RequestType } from '../external-agents/types';
import { internalAgentService } from '../internal-agents/service';
import type { InternalAgent } from '../internal-agents/types';
import { log } from '../infrastructure/logging';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';
import type { BindingRequest } from './bindings';
import { WIZARD_DEFAULT_PERMISSIONS } from './collaborator';
import { applyTeamUpdate, isTeamUpdateRefusal } from './team-update';

export type WireResult =
  | { wired: true; alreadyWired?: true }
  | { unwired: true; alreadyUnwired?: true }
  | { refused: 'not_found' | 'team_update_failed'; message: string }
  /** The collaborator side holds the grant and the team side does not: a
   *  state in which nothing is granted. Run it again to converge. */
  | { partial: 'collaborator_side_only'; retry: true; message: string };

/** The team's current bindings as binding requests, so a re-distil keeps
 *  every connector, peer and collaborator it already has: each connector
 *  binding names its connection id, so the team stays on the connection it
 *  holds rather than the workspace's first of that type. */
export function currentBindings(team: InternalAgent): BindingRequest[] {
  return team.integrations.map((i): BindingRequest | null => {
    const type = i.type ?? i.integrationId;
    if (type === 'external_agent') return { kind: 'collaborator', id: i.id };
    if (type === 'internal_agent') return { kind: 'team', id: i.id };
    if (type) return { kind: 'connector', type, connectorId: i.id, selectedObjects: i.selectedObjects };
    return null;
  }).filter((b): b is BindingRequest => b !== null);
}

function teamBindsCollaborator(team: InternalAgent, collaboratorId: string): boolean {
  return team.integrations.some((i) => i.id === collaboratorId);
}

function collaboratorAllowsTeam(collaborator: ExternalAgent, teamId: string): boolean {
  return collaborator.allowedInternalAgentIds.includes(teamId)
    && collaborator.requestRules.some((r) => r.internalAgentId === teamId);
}

async function setCollaboratorSide(
  tenantId: string,
  collaborator: ExternalAgent,
  team: InternalAgent,
  allow: boolean,
  rules: Record<RequestType, RequestPermission> | undefined,
): Promise<void> {
  const others = collaborator.requestRules.filter((r) => r.internalAgentId !== team.id);
  const requestRules: InternalAgentRequestRule[] = allow
    ? [...others, { internalAgentId: team.id, internalAgentName: team.role, permissions: rules ?? WIZARD_DEFAULT_PERMISSIONS }]
    : others;
  const allowedInternalAgentIds = allow
    ? Array.from(new Set([...collaborator.allowedInternalAgentIds, team.id]))
    : collaborator.allowedInternalAgentIds.filter((id) => id !== team.id);
  await externalAgentService.update(collaborator.id, tenantId, { allowedInternalAgentIds, requestRules });
}

export async function wireCollaboration(
  actor: Actor,
  teamId: string,
  collaboratorId: string,
  rules?: Record<RequestType, RequestPermission>,
): Promise<WireResult> {
  requirePermission(actor, 'collaborators:update');
  requirePermission(actor, 'teams:update');
  const { tenantId } = actor;

  // 1. Desired state on both sides; skip what already holds.
  const [team, collaborator] = await Promise.all([
    internalAgentService.getById(teamId, tenantId),
    externalAgentService.get(collaboratorId, tenantId),
  ]);
  if (!team) return { refused: 'not_found', message: 'agent not found' };
  if (!collaborator) return { refused: 'not_found', message: 'External agent not found' };
  const teamHolds = teamBindsCollaborator(team, collaboratorId);
  const collaboratorHolds = collaboratorAllowsTeam(collaborator, teamId);
  if (teamHolds && collaboratorHolds) return { wired: true, alreadyWired: true };

  // 2. Collaborator side first.
  if (!collaboratorHolds) {
    await setCollaboratorSide(tenantId, collaborator, team, true, rules);
  }

  // 3. Team side second: a distil plus an update.
  if (!teamHolds) {
    let failure: string | null = null;
    try {
      const result = await applyTeamUpdate(actor, teamId, {
        bindings: [...currentBindings(team), { kind: 'collaborator', id: collaboratorId }],
      }, { distill: 'server' });
      if (isTeamUpdateRefusal(result)) failure = result.message;
    } catch (err) {
      failure = (err as Error).message;
    }
    if (failure !== null) {
      // 4. Compensate the collaborator side (a set-remove, idempotent).
      if (!collaboratorHolds) {
        try {
          const fresh = await externalAgentService.get(collaboratorId, tenantId);
          if (fresh) await setCollaboratorSide(tenantId, fresh, team, false, undefined);
        } catch (err) {
          log.error({ tenantId, teamId, collaboratorId, error: (err as Error).message }, 'wireCollaboration: compensation failed; collaborator side only');
          return {
            partial: 'collaborator_side_only',
            retry: true,
            message: `The team could not be updated (${failure}) and the collaborator's permission could not be withdrawn. Nothing is granted in this state; running the same request again finishes it.`,
          };
        }
      }
      return { refused: 'team_update_failed', message: failure };
    }
  }

  writeAudit(actor, 'collaboration.wired', { internalAgentId: teamId, externalAgentId: collaboratorId });
  return { wired: true };
}

export async function unwireCollaboration(
  actor: Actor,
  teamId: string,
  collaboratorId: string,
): Promise<WireResult> {
  requirePermission(actor, 'collaborators:update');
  requirePermission(actor, 'teams:update');
  const { tenantId } = actor;

  const [team, collaborator] = await Promise.all([
    internalAgentService.getById(teamId, tenantId),
    externalAgentService.get(collaboratorId, tenantId),
  ]);
  if (!team) return { refused: 'not_found', message: 'agent not found' };
  if (!collaborator) return { refused: 'not_found', message: 'External agent not found' };
  const teamHolds = teamBindsCollaborator(team, collaboratorId);
  const collaboratorHolds = collaboratorAllowsTeam(collaborator, teamId);
  if (!teamHolds && !collaboratorHolds) return { unwired: true, alreadyUnwired: true };

  // Team side first: the capability comes off before the permission.
  if (teamHolds) {
    let failure: string | null = null;
    try {
      const result = await applyTeamUpdate(actor, teamId, {
        bindings: currentBindings(team).filter((b) => !(b.kind === 'collaborator' && b.id === collaboratorId)),
      }, { distill: 'server' });
      if (isTeamUpdateRefusal(result)) failure = result.message;
    } catch (err) {
      failure = (err as Error).message;
    }
    if (failure !== null) return { refused: 'team_update_failed', message: failure };
  }

  if (collaboratorHolds) {
    await setCollaboratorSide(tenantId, collaborator, team, false, undefined);
  }

  writeAudit(actor, 'collaboration.unwired', { internalAgentId: teamId, externalAgentId: collaboratorId });
  return { unwired: true };
}
