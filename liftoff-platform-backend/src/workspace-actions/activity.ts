// The Activity feed and its item actions, as the assistants use them: what a
// team did (agent_audit_logs), one item in full, whether it can be corrected
// and correcting it, the correction history, and running a failed autonomous
// run again. Every write goes through the same service the page calls, so
// the eligibility and permission rules are the page's.

import { agentAuditLogsService } from '../agent-audit-logs/service';
import type { AgentAuditLog, AgentAuditLogFilters } from '../agent-audit-logs/types';
import { correctionService } from '../corrections/service';
import type { CorrectionHistoryEntry, CorrectionOptions, CorrectionRequestResult, BulkCorrectionResponse } from '../corrections/types';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';
import { findTeamByName, listAiWorkforce } from './teams';

export interface ActivityFilters {
  team?: string;
  internalAgentId?: string;
  threadId?: string;
  invocationId?: string;
  externalAgentId?: string;
  action?: string;
  outcome?: 'success' | 'error' | 'gated';
  startDate?: string;
  endDate?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export type ActivityListResult =
  | { items: AgentAuditLog[]; nextCursor: string | null; total: number }
  | { refused: 'unknown_team'; message: string };

export async function listActivity(actor: Actor, filters: ActivityFilters): Promise<ActivityListResult> {
  const { tenantId } = actor;
  let internalAgentId = filters.internalAgentId;
  if (!internalAgentId && filters.team) {
    const { teams } = await listAiWorkforce(tenantId);
    const team = findTeamByName(teams, filters.team);
    if (!team) return { refused: 'unknown_team', message: `No team named "${filters.team}" in this workspace.` };
    internalAgentId = team.id;
  }
  const repoFilters: AgentAuditLogFilters = {
    ...(internalAgentId ? { internalAgentId } : {}),
    ...(filters.threadId ? { threadId: filters.threadId } : {}),
    ...(filters.invocationId ? { invocationId: filters.invocationId } : {}),
    ...(filters.externalAgentId ? { externalAgentId: filters.externalAgentId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
    ...(filters.startDate ? { startDate: new Date(filters.startDate) } : {}),
    ...(filters.endDate ? { endDate: new Date(filters.endDate) } : {}),
    ...(filters.q ? { q: filters.q } : {}),
  };
  const limit = Math.min(Math.max(1, filters.limit ?? 20), 100);
  const page = await agentAuditLogsService.listAuditLogs(tenantId, repoFilters, limit, filters.cursor);
  return { items: page.items, nextCursor: page.hasMore ? page.cursor : null, total: page.total };
}

export async function getActivity(actor: Actor, id: string): Promise<AgentAuditLog | null> {
  return agentAuditLogsService.getAuditLog(actor.tenantId, id);
}

export async function correctionOptions(actor: Actor, id: string): Promise<CorrectionOptions> {
  return correctionService.getCorrectionOptions(actor.tenantId, id);
}

/** Correct one item or many (≤50). The service runs the permission and
 *  eligibility checks; `gated` means a review was opened and the assistant
 *  names review_list. */
export async function correct(
  actor: Actor,
  ids: string[],
  reason?: string,
): Promise<{ single: CorrectionRequestResult } | { bulk: BulkCorrectionResponse }> {
  requirePermission(actor, 'teams:update');
  if (ids.length === 1) {
    const single = await correctionService.requestCorrection({
      tenantId: actor.tenantId,
      auditLogId: ids[0],
      reason,
      requestedBy: actor.accountId,
    });
    writeAudit(actor, 'correction.requested', { auditLogId: ids[0], status: single.status, reason });
    return { single };
  }
  const bulk = await correctionService.requestBulkCorrection(actor.tenantId, actor.accountId, { auditLogIds: ids, reason });
  writeAudit(actor, 'correction.bulk_requested', { auditLogIds: ids, summary: bulk.summary, reason });
  return { bulk };
}

export async function correctionHistory(actor: Actor, id: string): Promise<CorrectionHistoryEntry[]> {
  return correctionService.getCorrectionHistory(actor.tenantId, id);
}

const ESCALATED_MARKER = 'escalated';

function runEnded(log: AgentAuditLog): boolean {
  return log.outcome === 'error' || (log.outcome === 'gated' && log.errorCode === ESCALATED_MARKER);
}

/** The Activity page's rule for offering "Run again": a top-level autonomous
 *  run row that ended, belonging to one of our teams, triggered by a schedule
 *  or an event. The runtime re-checks all of it. */
export function canRerunActivityLog(log: AgentAuditLog): boolean {
  return (
    log.action === 'agent_execution'
    && runEnded(log)
    && !!log.internalAgentId
    && !!log.invocationId
    && (log.triggeredBy === 'cron' || log.triggeredBy.startsWith('event:'))
  );
}

export type RunAgainResult =
  | { requested: true; status: number; body: unknown }
  | { refused: 'not_found' | 'ineligible' | 'runtime_refused'; message: string; status?: number; body?: unknown };

export async function runAgain(actor: Actor, logId: string): Promise<RunAgainResult> {
  requirePermission(actor, 'teams:update');
  const log = await agentAuditLogsService.getAuditLog(actor.tenantId, logId);
  if (!log) return { refused: 'not_found', message: 'No activity item with that id.' };
  if (!canRerunActivityLog(log)) {
    return {
      refused: 'ineligible',
      message: 'Only a scheduled or event-triggered run that ended can be run again; this item is not one.',
    };
  }
  const { status, body } = await tenantRuntimeClient.rerunFailedRun(
    actor.tenantId,
    log.internalAgentId as string,
    log.invocationId as string,
    actor.accountId,
  );
  if (status >= 200 && status < 300) {
    writeAudit(actor, 'agent_run.rerun_requested', { auditLogId: logId, internalAgentId: log.internalAgentId, invocationId: log.invocationId });
    return { requested: true, status, body };
  }
  return { refused: 'runtime_refused', message: 'The runtime did not accept the rerun.', status, body };
}
