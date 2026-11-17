// Operator Dashboard Service
// Per Section 17: Control-plane visibility for operators

import {
  TenantHealthStatus,
  SystemHealthStatus,
  ComponentHealth,
  SystemMetrics,
  WorkflowHealthSummary,
  ConnectorHealthSummary,
  UsageSummary,
  AuditLogEntry,
  OperatorDashboardSummary,
  Alert,
  Incident,
} from './types';
import { getPool, withAdminScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { getConnectorHealthSummary } from '../connectors/connector-service-client';

export class OperatorDashboardService {
  // Get complete dashboard summary
  async getDashboardSummary(): Promise<OperatorDashboardSummary> {
    const [
      systemHealth,
      workflowHealth,
      connectorHealth,
      usage,
      tenantHealth,
      recentAuditLogs,
    ] = await Promise.all([
      this.getSystemHealth(),
      this.getWorkflowHealth(),
      this.getConnectorHealth(),
      this.getUsageSummary(),
      this.getTenantHealthList(10),
      this.getRecentAuditLogs(20),
    ]);

    return {
      systemHealth,
      workflowHealth,
      connectorHealth,
      usage,
      tenantHealth,
      recentAuditLogs,
    };
  }

  // Get system-wide health status
  async getSystemHealth(): Promise<SystemHealthStatus> {
    const components = await this.checkComponentHealth();
    const recentIncidents = await this.getRecentIncidents();
    const metrics = await this.getSystemMetrics();

    // Determine overall health based on component statuses
    let overall: 'healthy' | 'degraded' | 'critical' = 'healthy';
    const criticalComponents = components.filter((c) => c.status === 'down');
    const degradedComponents = components.filter((c) => c.status === 'degraded');

    if (criticalComponents.length > 0) {
      overall = 'critical';
    } else if (degradedComponents.length > 0) {
      overall = 'degraded';
    }

    return {
      overall,
      components,
      recentIncidents,
      metrics,
    };
  }

  // Check health of individual components
  private async checkComponentHealth(): Promise<ComponentHealth[]> {
    const pool = getPool();
    const components: ComponentHealth[] = [];
    const now = new Date();

    // Database health
    try {
      const dbStart = Date.now();
      await pool.query('SELECT 1');
      const dbLatency = Date.now() - dbStart;

      components.push({
        name: 'database',
        status: dbLatency < 100 ? 'healthy' : dbLatency < 500 ? 'degraded' : 'down',
        latencyMs: dbLatency,
        errorRate: 0,
        lastCheckedAt: now,
      });
    } catch (error) {
      components.push({
        name: 'database',
        status: 'down',
        latencyMs: 0,
        errorRate: 100,
        lastCheckedAt: now,
        details: (error as Error).message,
      });
    }

    // Check component error rates from metrics table
    const metricsQuery = await pool.query(`
      SELECT
        component,
        AVG(latency_ms) as avg_latency,
        SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100 as error_rate
      FROM component_metrics
      WHERE timestamp > NOW() - INTERVAL '5 minutes'
      GROUP BY component
    `).catch(() => ({ rows: [] }));

    // 'instruction-compiler' was removed: the Tenant Runtime service behind it
    // is gone (liftoff-tenant-runtime), so it can never report metrics and
    // would sit here permanently as 'unknown'. A component that is always
    // unknown trains people to ignore this panel.
    const componentNames = ['coordinator', 'tool-gateway', 'action-ledger'];
    for (const name of componentNames) {
      const metrics = metricsQuery.rows.find((r: any) => r.component === name);

      if (metrics) {
        const errorRate = parseFloat(metrics.error_rate) || 0;
        const latency = parseFloat(metrics.avg_latency) || 0;

        components.push({
          name,
          status: errorRate > 10 ? 'down' : errorRate > 1 ? 'degraded' : 'healthy',
          latencyMs: Math.round(latency),
          errorRate: Math.round(errorRate * 100) / 100,
          lastCheckedAt: now,
        });
      } else {
        components.push({
          name,
          status: 'unknown',
          latencyMs: 0,
          errorRate: 0,
          lastCheckedAt: now,
          details: 'No recent metrics',
        });
      }
    }

    return components;
  }

  // Get system-wide metrics
  private async getSystemMetrics(): Promise<SystemMetrics> {
    const pool = getPool();

    // Get various counts
    const [
      workflowStats,
      actionStats,
      tenantCount,
      agentCount,
      queueStats,
    ] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('running', 'pending')) as active,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h
        FROM workflows
      `).catch(() => ({ rows: [{ active: 0, last_24h: 0 }] })),

      pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM actions
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `).catch(() => ({ rows: [{ total: 0, failed: 0 }] })),

      pool.query('SELECT COUNT(*) as count FROM tenants').catch(() => ({ rows: [{ count: 0 }] })),

      pool.query(
        `SELECT COUNT(*) as count FROM agents WHERE status = 'active'`
      ).catch(() => ({ rows: [{ count: 0 }] })),

      withAdminScope(
        { caller: 'operator-dashboard.getSystemMetrics', reason: 'cross-tenant operator aggregation of workflow_tasks queue depth' },
        (client) => client.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_latency
        FROM workflow_tasks
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `),
      ).catch(() => ({ rows: [{ pending: 0, p95_latency: 0 }] })),
    ]);

    const wfStats = workflowStats.rows[0];
    const actStats = actionStats.rows[0];
    const qStats = queueStats.rows[0];

    const totalActions = parseInt(actStats.total) || 0;
    const failedActions = parseInt(actStats.failed) || 0;
    const errorRate = totalActions > 0 ? (failedActions / totalActions) * 100 : 0;

    return {
      activeWorkflows: parseInt(wfStats.active) || 0,
      workflowsLast24h: parseInt(wfStats.last_24h) || 0,
      actionsLast24h: totalActions,
      errorRateLast24h: Math.round(errorRate * 100) / 100,
      p95LatencyMs: Math.round(parseFloat(qStats.p95_latency) || 0),
      tenantCount: parseInt(tenantCount.rows[0].count) || 0,
      activeAgentCount: parseInt(agentCount.rows[0].count) || 0,
      pendingTasksCount: parseInt(qStats.pending) || 0,
      queueDepth: parseInt(qStats.pending) || 0,
    };
  }

  // Get workflow health summary
  async getWorkflowHealth(): Promise<WorkflowHealthSummary> {
    const pool = getPool();

    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('running', 'pending')) as total_active,
        COUNT(*) FILTER (WHERE status = 'running') as running,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (
          WHERE status = 'failed'
          AND updated_at > NOW() - INTERVAL '24 hours'
        ) as failed_24h,
        COUNT(*) FILTER (
          WHERE status = 'running'
          AND updated_at < NOW() - INTERVAL '1 hour'
        ) as stuck,
        AVG(
          EXTRACT(EPOCH FROM (
            CASE WHEN completed_at IS NOT NULL
            THEN completed_at - started_at
            ELSE NOW() - started_at
            END
          )) * 1000
        ) FILTER (WHERE started_at IS NOT NULL) as avg_duration
      FROM workflows
    `).catch(() => ({ rows: [{}] }));

    const longestRunning = await pool.query(`
      SELECT id, tenant_id, objective,
        EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 as duration_ms
      FROM workflows
      WHERE status = 'running' AND started_at IS NOT NULL
      ORDER BY started_at ASC
      LIMIT 1
    `).catch(() => ({ rows: [] }));

    const s = stats.rows[0];

    return {
      totalActive: parseInt(s.total_active) || 0,
      runningCount: parseInt(s.running) || 0,
      pendingCount: parseInt(s.pending) || 0,
      failedLast24h: parseInt(s.failed_24h) || 0,
      stuckCount: parseInt(s.stuck) || 0,
      avgDurationMs: Math.round(parseFloat(s.avg_duration) || 0),
      longestRunningWorkflow: longestRunning.rows[0]
        ? {
            id: longestRunning.rows[0].id,
            tenantId: longestRunning.rows[0].tenant_id,
            durationMs: Math.round(parseFloat(longestRunning.rows[0].duration_ms) || 0),
            objective: longestRunning.rows[0].objective,
          }
        : null,
    };
  }

  // Get connector health summary
  //
  // Reads connector-service, which owns connector rows and their sync stats.
  // This panel used to query the local `connectors` table and a
  // `connector_sync_logs` table that does not exist in this database at all,
  // with every query wrapped in `.catch(() => ({ rows: [] }))`. All three
  // failed on every call — the local table has no `connector_type` column
  // (it is `type`) and never had the logs table — so the operator was shown
  // zero connectors, zero failures and an empty failure list, which is
  // indistinguishable from a healthy estate. It reported a clean bill of
  // health for two months while the queries behind it could not run.
  //
  // Errors now propagate. The router turns them into a failed panel, which is
  // the honest answer to "how is the estate doing" when we cannot tell.
  async getConnectorHealth(): Promise<ConnectorHealthSummary> {
    const summary = await getConnectorHealthSummary();

    return {
      totalConnectors: summary.totalConnectors,
      healthyCount: summary.activeCount,
      // `error` is the status a connector lands in when its OAuth refresh
      // fails; the old query filtered for 'failed', which is not a status any
      // connector has ever held, so this counter could only ever be zero.
      failedCount: summary.errorCount,
      syncErrorsLast24h: summary.connectorsWithSyncErrorsLast24h,
      connectorsByType: summary.connectorsByType,
      recentSyncFailures: summary.recentSyncFailures.map((f) => ({
        connectorId: f.connectorId,
        tenantId: f.tenantId,
        connectorType: f.connectorType,
        errorMessage: f.errorMessage ?? '',
        failedAt: f.failedAt ? new Date(f.failedAt) : new Date(0),
      })),
    };
  }

  // Get usage summary
  async getUsageSummary(): Promise<UsageSummary> {
    // Get current billing period (assuming monthly)
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const usageStats = await withAdminScope(
      { caller: 'operator-dashboard.getUsageSummary.usageStats', reason: 'cross-tenant operator aggregation of entitlement credit usage' },
      (client) => client.query(`
      SELECT
        SUM(credits_used) as total_used,
        SUM(credits_allocated) as total_allocated
      FROM (
        SELECT
          e.remaining_included_credits as credits_allocated,
          e.included_monthly_credits - e.remaining_included_credits as credits_used
        FROM entitlements e
      ) sub
    `),
    ).catch(() => ({ rows: [{ total_used: 0, total_allocated: 0 }] }));

    const topTenants = await withAdminScope(
      { caller: 'operator-dashboard.getUsageSummary.topTenants', reason: 'cross-tenant operator ranking of tenants by credit usage' },
      (client) => client.query(`
      SELECT
        t.id as tenant_id,
        t.name as tenant_name,
        e.included_monthly_credits - e.remaining_included_credits as credits_used,
        CASE
          WHEN e.included_monthly_credits > 0
          THEN ((e.included_monthly_credits - e.remaining_included_credits)::float / e.included_monthly_credits) * 100
          ELSE 0
        END as utilization_percent
      FROM tenants t
      JOIN entitlements e ON t.id = e.tenant_id
      ORDER BY credits_used DESC
      LIMIT 5
    `),
    ).catch(() => ({ rows: [] }));

    // usage_records schema (migration 012): timestamp + value columns
    const usageByDay = await withAdminScope(
      { caller: 'operator-dashboard.getUsageSummary.usageByDay', reason: 'cross-tenant operator aggregation of daily usage_records' },
      (client) => client.query(`
      SELECT
        DATE(timestamp) as date,
        SUM(value) as credits
      FROM usage_records
      WHERE timestamp > NOW() - INTERVAL '30 days'
      GROUP BY DATE(timestamp)
      ORDER BY date
    `),
    ).catch(() => ({ rows: [] }));

    const totalUsed = parseFloat(usageStats.rows[0].total_used) || 0;
    const totalAllocated = parseFloat(usageStats.rows[0].total_allocated) || 0;

    return {
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      totalCreditsUsed: totalUsed,
      totalCreditsAllocated: totalAllocated,
      utilizationPercent: totalAllocated > 0 ? (totalUsed / totalAllocated) * 100 : 0,
      topTenants: topTenants.rows.map((r: any) => ({
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        creditsUsed: parseFloat(r.credits_used) || 0,
        utilizationPercent: parseFloat(r.utilization_percent) || 0,
      })),
      usageByDay: usageByDay.rows.map((r: any) => ({
        date: r.date,
        credits: parseFloat(r.credits) || 0,
      })),
    };
  }

  // Get tenant health list
  async getTenantHealthList(limit = 50): Promise<TenantHealthStatus[]> {
    const tenants = await withAdminScope(
      { caller: 'operator-dashboard.getTenantHealthList', reason: 'cross-tenant operator health list across all tenants' },
      (client) => client.query(`
      SELECT
        t.id as tenant_id,
        t.name as tenant_name,
        e.tenant_operational_status as operational_status,
        e.remaining_included_credits,
        e.included_monthly_credits,
        (SELECT MAX(created_at) FROM workflows w WHERE w.tenant_id = t.id) as last_activity_at,
        (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id AND a.status = 'active') as active_agents,
        (SELECT COUNT(*) FROM workflows w WHERE w.tenant_id = t.id AND w.status IN ('running', 'pending')) as active_workflows,
        (
          SELECT COUNT(*)::float / NULLIF(COUNT(*), 0) * 100
          FROM actions act
          WHERE act.tenant_id = t.id
          AND act.status = 'failed'
          AND act.created_at > NOW() - INTERVAL '24 hours'
        ) as error_rate_24h
      FROM tenants t
      JOIN entitlements e ON t.id = e.tenant_id
      ORDER BY t.name
      LIMIT $1
    `, [limit]),
    ).catch(() => ({ rows: [] }));

    return tenants.rows.map((r: any) => {
      const usageCredits = (parseFloat(r.included_monthly_credits) || 0) -
                          (parseFloat(r.remaining_included_credits) || 0);
      const errorRate = parseFloat(r.error_rate_24h) || 0;

      // Determine overall health
      let overallHealth: 'healthy' | 'degraded' | 'critical' | 'unknown' = 'healthy';
      if (r.operational_status === 'suspended') {
        overallHealth = 'critical';
      } else if (errorRate > 10) {
        overallHealth = 'critical';
      } else if (errorRate > 1) {
        overallHealth = 'degraded';
      }

      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        overallHealth,
        lastActivityAt: r.last_activity_at,
        activeAgents: parseInt(r.active_agents) || 0,
        activeWorkflows: parseInt(r.active_workflows) || 0,
        errorRate24h: Math.round(errorRate * 100) / 100,
        usageCredits: Math.round(usageCredits * 100) / 100,
        remainingCredits: parseFloat(r.remaining_included_credits) || 0,
        operationalStatus: r.operational_status,
        alerts: [], // Would be populated from alerts table
      };
    });
  }

  // Get tenant health by ID
  async getTenantHealth(tenantId: string): Promise<TenantHealthStatus | null> {
    const result = await withAdminScope(
      { caller: 'operator-dashboard.getTenantHealth', reason: 'operator single-tenant health read (invoked outside a tenant request scope)' },
      (client) => client.query(`
      SELECT
        t.id as tenant_id,
        t.name as tenant_name,
        e.tenant_operational_status as operational_status,
        e.remaining_included_credits,
        e.included_monthly_credits,
        (SELECT MAX(created_at) FROM workflows w WHERE w.tenant_id = t.id) as last_activity_at,
        (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id AND a.status = 'active') as active_agents,
        (SELECT COUNT(*) FROM workflows w WHERE w.tenant_id = t.id AND w.status IN ('running', 'pending')) as active_workflows
      FROM tenants t
      JOIN entitlements e ON t.id = e.tenant_id
      WHERE t.id = $1
    `, [tenantId]),
    );

    if (result.rows.length === 0) {
      return null;
    }

    const r = result.rows[0];
    const usageCredits = (parseFloat(r.included_monthly_credits) || 0) -
                        (parseFloat(r.remaining_included_credits) || 0);

    // Get alerts for this tenant
    const alerts = await this.getTenantAlerts(tenantId);

    return {
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      overallHealth: r.operational_status === 'suspended' ? 'critical' : 'healthy',
      lastActivityAt: r.last_activity_at,
      activeAgents: parseInt(r.active_agents) || 0,
      activeWorkflows: parseInt(r.active_workflows) || 0,
      errorRate24h: 0,
      usageCredits: Math.round(usageCredits * 100) / 100,
      remainingCredits: parseFloat(r.remaining_included_credits) || 0,
      operationalStatus: r.operational_status,
      alerts,
    };
  }

  // Get alerts for a tenant. alerts is RLS-on (migration 200); the
  // operator-dashboard service aggregates across tenants by design, so admin
  // scope is the correct primitive. Query is naturally bound by tenant_id =
  // $1 so admin bypass exposes no cross-tenant data.
  private async getTenantAlerts(tenantId: string): Promise<Alert[]> {
    const result = await withAdminScope(
      {
        caller: 'operator-dashboard.getTenantAlerts',
        reason: 'cross-tenant operator dashboard aggregation',
      },
      (client) =>
        client.query(
          `SELECT id, severity, type, message, created_at as timestamp, acknowledged, acknowledged_by, acknowledged_at
           FROM alerts
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [tenantId],
        ),
    ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));

    return result.rows.map((r: any) => ({
      id: r.id,
      severity: r.severity,
      type: r.type,
      message: r.message,
      timestamp: r.timestamp,
      acknowledged: r.acknowledged,
      acknowledgedBy: r.acknowledged_by,
      acknowledgedAt: r.acknowledged_at,
    }));
  }

  // Get recent incidents
  private async getRecentIncidents(): Promise<Incident[]> {
    const pool = getPool();

    const result = await pool.query(`
      SELECT
        id, title, severity, status, started_at, resolved_at,
        affected_components, affected_tenants, updates
      FROM incidents
      WHERE started_at > NOW() - INTERVAL '7 days'
      ORDER BY started_at DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    return result.rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      status: r.status,
      startedAt: r.started_at,
      resolvedAt: r.resolved_at,
      affectedComponents: r.affected_components || [],
      affectedTenants: r.affected_tenants || [],
      updates: r.updates || [],
    }));
  }

  // Get recent audit logs
  async getRecentAuditLogs(limit = 50): Promise<AuditLogEntry[]> {
    const result = await withAdminScope(
      { caller: 'operator-dashboard.getRecentAuditLogs', reason: 'cross-tenant operator view of recent audit_log entries' },
      (client) => client.query(`
      SELECT id, timestamp, user_id, action, resource_type, resource_id, tenant_id, metadata, ip_address
      FROM audit_log
      WHERE deleted_at IS NULL
      ORDER BY timestamp DESC
      LIMIT $1
    `, [limit]),
    ).catch(() => ({ rows: [] }));

    return result.rows.map((r: any) => ({
      id: r.id,
      timestamp: r.timestamp,
      actor: r.user_id,           // was: r.actor
      action: r.action,
      entityType: r.resource_type, // was: r.entity_type
      entityId: r.resource_id,     // was: r.entity_id
      tenantId: r.tenant_id,
      details: r.metadata || {},   // was: r.details
      ipAddress: r.ip_address,
    }));
  }

  // Acknowledge an alert
  async acknowledgeAlert(alertId: string, acknowledgedBy: string): Promise<void> {
    // alerts is RLS-enabled; operator acknowledges by alert PK with no tenant
    // scope → withAdminScope. Authorization is enforced upstream in the
    // operator router (platform-admin only).
    await withAdminScope(
      { caller: 'operator-dashboard.acknowledgeAlert', reason: 'operator by-PK alert acknowledgement (no tenant scope)' },
      (client) => client.query(`
      UPDATE alerts
      SET acknowledged = true, acknowledged_by = $2, acknowledged_at = NOW()
      WHERE id = $1
    `, [alertId, acknowledgedBy]),
    );

    logger.info('Alert acknowledged', { alertId, acknowledgedBy });
  }
}
