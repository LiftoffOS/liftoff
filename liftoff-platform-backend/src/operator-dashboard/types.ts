// Operator Dashboard Types
// Per Section 17: Control-plane visibility for operators

export interface TenantHealthStatus {
  tenantId: string;
  tenantName: string;
  overallHealth: 'healthy' | 'degraded' | 'critical' | 'unknown';
  lastActivityAt: Date | null;
  activeAgents: number;
  activeWorkflows: number;
  errorRate24h: number;
  usageCredits: number;
  remainingCredits: number;
  operationalStatus: 'active' | 'suspended' | 'pending';
  alerts: Alert[];
}

export interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  type: string;
  message: string;
  timestamp: Date;
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
}

export interface SystemHealthStatus {
  overall: 'healthy' | 'degraded' | 'critical';
  components: ComponentHealth[];
  recentIncidents: Incident[];
  metrics: SystemMetrics;
}

export interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  latencyMs: number;
  errorRate: number;
  lastCheckedAt: Date;
  details?: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: 'minor' | 'major' | 'critical';
  status: 'open' | 'investigating' | 'resolved';
  startedAt: Date;
  resolvedAt?: Date;
  affectedComponents: string[];
  affectedTenants: string[];
  updates: IncidentUpdate[];
}

export interface IncidentUpdate {
  timestamp: Date;
  message: string;
  author: string;
}

export interface SystemMetrics {
  activeWorkflows: number;
  workflowsLast24h: number;
  actionsLast24h: number;
  errorRateLast24h: number;
  p95LatencyMs: number;
  tenantCount: number;
  activeAgentCount: number;
  pendingTasksCount: number;
  queueDepth: number;
}

export interface WorkflowHealthSummary {
  totalActive: number;
  runningCount: number;
  pendingCount: number;
  failedLast24h: number;
  stuckCount: number;
  avgDurationMs: number;
  longestRunningWorkflow: {
    id: string;
    tenantId: string;
    durationMs: number;
    objective: string;
  } | null;
}

export interface ConnectorHealthSummary {
  totalConnectors: number;
  healthyCount: number;
  failedCount: number;
  syncErrorsLast24h: number;
  connectorsByType: Record<string, number>;
  recentSyncFailures: {
    connectorId: string;
    tenantId: string;
    connectorType: string;
    errorMessage: string;
    failedAt: Date;
  }[];
}

export interface UsageSummary {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  totalCreditsUsed: number;
  totalCreditsAllocated: number;
  utilizationPercent: number;
  topTenants: {
    tenantId: string;
    tenantName: string;
    creditsUsed: number;
    utilizationPercent: number;
  }[];
  usageByDay: {
    date: string;
    credits: number;
  }[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  tenantId?: string;
  details: Record<string, unknown>;
  ipAddress?: string;
}

export interface OperatorDashboardSummary {
  systemHealth: SystemHealthStatus;
  workflowHealth: WorkflowHealthSummary;
  connectorHealth: ConnectorHealthSummary;
  usage: UsageSummary;
  tenantHealth: TenantHealthStatus[];
  recentAuditLogs: AuditLogEntry[];
}
