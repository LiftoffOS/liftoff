// Service layer - delegates to repository (no custom rate limiting per BE-003)

import { AgentAuditLogsRepository } from './repository';
import { enqueueLifecycleEvent } from '../event-sources/outbound-webhooks';
import { frontendUrl } from '../infrastructure/frontend-url';
import { AgentAuditLog, InsertAgentAuditLogInput, AgentAuditLogFilters, PaginatedAuditLogs } from './types';
import { log } from '../infrastructure/logging';
import { enqueueNotification } from '../notifications';
import { getPool, withTenantScope } from '../infrastructure/database';

// Audit actions whose source modules fan out their own agent_activity
// notifications (with domain-specific, user-friendly summaries). The generic
// fanout here SKIPS these to prevent two notifications per submit.
//
// Adding a new explicit fanout in a domain module? Add its audit action here.
const DOMAIN_HANDLED_ACTIONS = new Set<string>([
  'hitl_late_feedback_submitted', // handled in src/hitl-late-feedback/service.ts
]);

// Inline event-summary formatter. Wraps after "<actor> " (e.g. "Sarah Chen ").
// Per plan §4: "existing helper or inline" — chosen inline because the only
// non-skipped audit action paths today (post DOMAIN_HANDLED_ACTIONS) don't yet
// merit a separate file. Add cases here as new human-triggered audit actions
// emerge that aren't already handled by their domain module.
function describeAuditAction(action: string, tenantName: string): string {
  const humanized = action.replace(/_/g, ' ');
  return `performed ${humanized} in ${tenantName}.`;
}

export class AgentAuditLogsService {
  private repository = new AgentAuditLogsRepository();

  async insertAuditLog(input: InsertAgentAuditLogInput): Promise<AgentAuditLog> {
    const auditLog = await this.repository.insert(input);

    log.info({
      event: 'agent_audit_log_created',
      tenantId: input.tenantId,
      action: input.action,
      outcome: input.outcome,
    });

    // Fan out agent_activity notifications for human-triggered actions only,
    // and only when no domain module has its own explicit fanout (see
    // DOMAIN_HANDLED_ACTIONS above). Fire-and-forget — audit log writes are
    // hot-path and must not wait on N notification rows.
    const triggeredByHuman =
      typeof input.triggeredBy === 'string' && input.triggeredBy.startsWith('human:');
    if (
      input.userId &&
      triggeredByHuman &&
      !DOMAIN_HANDLED_ACTIONS.has(input.action)
    ) {
      this.fanOutTeamActivity(auditLog, input.userId).catch((err) => {
        log.warn(
          { err: (err as Error).message, auditLogId: auditLog.id },
          'agent_activity enqueue failed',
        );
      });
    }

    // Outbound webhooks: this is the one place the control plane learns that a
    // run ended, so it is the one place a customer's own systems can be told.
    //
    // Fire-and-forget, and enqueue-only — it writes a queue row and returns, so
    // an audit write can never end up waiting on somebody else's HTTP server.
    // A run's outcome must be recorded whatever any external endpoint does.
    if (input.action === 'agent_execution' && input.outcome !== 'gated') {
      void enqueueLifecycleEvent({
        tenantId: input.tenantId,
        eventType: input.outcome === 'success' ? 'run.completed' : 'run.failed',
        payload: {
          auditLogId: auditLog.id,
          agentId: input.internalAgentId ?? null,
          invocationId: input.invocationId ?? null,
          threadId: input.threadId ?? null,
          outcome: input.outcome,
          triggeredBy: input.triggeredBy ?? null,
          errorCode: input.errorCode ?? null,
        },
      }).catch(() => undefined);
    }

    return auditLog;
  }

  private async fanOutTeamActivity(auditLog: AgentAuditLog, actorAccountId: string): Promise<void> {
    const pool = getPool();
    const recipientsResult = await withTenantScope(auditLog.tenantId, (client) => client.query<{ account_id: string }>(
      `SELECT account_id FROM tenant_members WHERE tenant_id = $1 AND account_id != $2`,
      [auditLog.tenantId, actorAccountId],
    ));
    if (recipientsResult.rows.length === 0) return;

    const [actorResult, tenantResult] = await Promise.all([
      pool.query<{ first_name: string; last_name: string }>(
        `SELECT first_name, last_name FROM accounts WHERE id = $1`,
        [actorAccountId],
      ),
      pool.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [auditLog.tenantId]),
    ]);

    const actorName = actorResult.rows[0]
      ? `${actorResult.rows[0].first_name} ${actorResult.rows[0].last_name}`.trim()
      : 'A workspace member';
    const tenantName = tenantResult.rows[0]?.name ?? 'your workspace';

    const eventSummary = describeAuditAction(auditLog.action, tenantName);
    const eventLink = `${frontendUrl()}/dashboard/activity#${auditLog.id}`;

    for (const r of recipientsResult.rows) {
      enqueueNotification({
        accountId: r.account_id,
        tenantId: auditLog.tenantId,
        type: 'agent_activity',
        payload: { actorName, eventSummary, eventLink },
      }).catch((err) => {
        log.warn(
          { err: (err as Error).message, auditLogId: auditLog.id, recipient: r.account_id },
          'agent_activity enqueue failed',
        );
      });
    }
  }

  async getAuditLog(tenantId: string, id: string): Promise<AgentAuditLog | null> {
    return this.repository.findById(tenantId, id);
  }

  async listAuditLogs(
    tenantId: string,
    filters: AgentAuditLogFilters,
    limit: number = 50,
    cursor?: string
  ): Promise<PaginatedAuditLogs> {
    return this.repository.list(tenantId, filters, limit, cursor);
  }
}

export const agentAuditLogsService = new AgentAuditLogsService();
