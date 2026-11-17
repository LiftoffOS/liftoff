// Activity Logs Service
// Fetches agent audit logs from the backend

import { api } from './api'

export type AuditOutcome = 'success' | 'error' | 'gated'

export interface AgentAuditLog {
  id: string
  tenantId: string
  internalAgentId: string | null
  userId: string | null
  threadId: string | null
  invocationId: string | null
  externalAgentId: string | null
  action: string
  inputArgs: Record<string, unknown>
  outputSummary: string | null
  outcome: AuditOutcome
  errorCode: string | null
  triggeredBy: string
  durationMs: number | null
  createdAt: string
  agentName: string | null
  triggeredByAgentName: string | null
  proxyKeyId: string | null
  preActionSnapshot: Record<string, unknown> | null
  postActionSnapshot: Record<string, unknown> | null
  externalResponse: Record<string, unknown> | null
  snapshotStatus: string | null
}

export interface PaginatedActivityLogsResponse {
  items: AgentAuditLog[]
  cursor: string | null
  hasMore: boolean
  total: number
}

export interface ActivityLogFilters {
  internalAgentId?: string
  threadId?: string
  invocationId?: string
  externalAgentId?: string
  action?: string
  outcome?: AuditOutcome
  startDate?: string
  endDate?: string
  /** Free-text search — sent to the backend `q` query parameter so the
   *  predicate runs over the full matching set instead of just the
   *  client-fetched window. Searches across agent name (role/external name),
   *  action, input args, and output summary on the server side. */
  q?: string
}

// List activity logs with pagination and filters
export async function listActivityLogs(
  tenantId: string,
  options?: {
    cursor?: string
    limit?: number
    filters?: ActivityLogFilters
  }
): Promise<PaginatedActivityLogsResponse> {
  const params = new URLSearchParams({ tenantId })

  if (options?.cursor) {
    params.append('cursor', options.cursor)
  }
  if (options?.limit) {
    params.append('limit', options.limit.toString())
  }
  if (options?.filters?.internalAgentId) {
    params.append('internalAgentId', options.filters.internalAgentId)
  }
  if (options?.filters?.threadId) {
    params.append('threadId', options.filters.threadId)
  }
  if (options?.filters?.invocationId) {
    params.append('invocationId', options.filters.invocationId)
  }
  if (options?.filters?.externalAgentId) {
    params.append('externalAgentId', options.filters.externalAgentId)
  }
  if (options?.filters?.action) {
    params.append('action', options.filters.action)
  }
  if (options?.filters?.outcome) {
    params.append('outcome', options.filters.outcome)
  }
  if (options?.filters?.startDate) {
    params.append('startDate', options.filters.startDate)
  }
  if (options?.filters?.endDate) {
    params.append('endDate', options.filters.endDate)
  }
  if (options?.filters?.q && options.filters.q.trim().length > 0) {
    params.append('q', options.filters.q.trim())
  }

  return await api.get<PaginatedActivityLogsResponse>(`/api/agent-audit-logs?${params.toString()}`)
}

// Get a single activity log by ID
export async function getActivityLog(
  tenantId: string,
  logId: string
): Promise<AgentAuditLog> {
  return await api.get<AgentAuditLog>(`/api/agent-audit-logs/${logId}?tenantId=${tenantId}`)
}

// ADR-030: "Run again" — re-run a failed autonomous run. Proxies through the
// platform backend to the tenant runtime, which validates re-runnability and
// enqueues a fresh execution.
export async function rerunActivityRun(
  tenantId: string,
  internalAgentId: string,
  invocationId: string
): Promise<{ accepted: boolean }> {
  return await api.post<{ accepted: boolean }>(
    `/api/internal-agents/${internalAgentId}/runs/${invocationId}/rerun?tenantId=${tenantId}`
  )
}

/** An escalated run, told apart from the other two things audit outcome
 *  'gated' can mean.
 *
 *  That outcome is written by three different terminal states: escalated,
 *  gated, and paused. Only the first has ENDED. The other two are live runs
 *  waiting on an approval, and they resume on their own once a person decides,
 *  so offering "Run again" on one would duplicate the work rather than retry
 *  it. The runtime stamps this marker on the terminal audit row precisely so
 *  this side can separate them, since the outcome vocabulary cannot. */
const ESCALATED_MARKER = 'escalated'

/** Whether a run ENDED, and so could be run again.
 *
 *  'error' is a run that failed. 'gated' plus the escalation marker is a run
 *  that stopped to ask a person for something. Both are over, and both leave
 *  work a person may want retried once they have dealt with it. An escalation
 *  is in fact the case where retrying is most obviously wanted: the team asked
 *  for something to be fixed, and running again is the whole point of the ask.
 */
function runEnded(log: AgentAuditLog): boolean {
  return log.outcome === 'error'
    || (log.outcome === 'gated' && log.errorCode === ESCALATED_MARKER)
}

// ADR-030 gate: which Activity rows may show "Run again". Only a top-level
// autonomous run row (action 'agent_execution') that ended, belongs to one of
// our agents, and was triggered by a schedule (cron) or an event (event:*).
// Chat (human:*), delegated sub-runs / self-scheduled (agent), and non-run rows
// are excluded. The runtime re-checks all of this; this only decides whether to
// offer the button.
export function canRerunActivityLog(log: AgentAuditLog): boolean {
  return (
    log.action === 'agent_execution' &&
    runEnded(log) &&
    !!log.internalAgentId &&
    !!log.invocationId &&
    (log.triggeredBy === 'cron' || log.triggeredBy.startsWith('event:'))
  )
}
