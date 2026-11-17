// Assignments: which agents and collaborators each person in the workspace
// is assigned to. The read is the People page's; the write replaces one
// person's whole assignment list, the way that page's save does. Owner/admin
// (assignments:manage).

import { personAssignmentsService } from '../person-assignments/service';
import type { AgentOrigin } from '../person-assignments/types';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

export interface AssignmentRequest {
  agentId: string;
  agentType: AgentOrigin;
}

export type AssignmentsRefusal = { refused: 'not_found' | 'validation'; message: string };

export async function listAssignments(actor: Actor) {
  const people = await personAssignmentsService.listPersonnelWithAssignments(actor.tenantId);
  return people.map((p) => ({
    accountId: p.accountId,
    name: [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email,
    email: p.email,
    joinedAt: p.joinedAt,
    isAssignable: p.isAssignable,
    assignments: p.assignments.map((a) => ({ agentId: a.agentId, agentType: a.agentType, name: a.agentName })),
  }));
}

/** Replace one person's assignments. The service validates that the person
 *  is a member and that every id names a live team or collaborator (404 /
 *  400 as the People page's route reports them). */
export async function setAssignments(
  actor: Actor,
  accountId: string,
  assignments: AssignmentRequest[],
): Promise<{ accountId: string; added: number; removed: number } | AssignmentsRefusal> {
  requirePermission(actor, 'assignments:manage');
  try {
    const result = await personAssignmentsService.updateAssignmentsForPerson(
      actor.tenantId,
      accountId,
      assignments,
      actor.accountId,
    );
    writeAudit(actor, 'person_assignment.updated', {
      accountId,
      assignmentsCount: assignments.length,
      added: result.added,
      removed: result.removed,
    });
    return { accountId, ...result };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    if (e.statusCode === 404) return { refused: 'not_found', message: e.message };
    if (e.statusCode === 400) return { refused: 'validation', message: e.message };
    throw err;
  }
}
