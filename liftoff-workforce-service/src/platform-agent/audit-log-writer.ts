// Writes audit-log rows to platform-backend's POST /api/agent-audit-logs.
// Uses the service-auth path. The endpoint at platform-backend's
// agent-audit-logs/router.ts:94 timing-safe-compares the x-service-auth
// header against TENANT_RUNTIME_SERVICE_TOKEN OR WORKFORCE_SERVICE_TOKEN
// (per PB PR #5). Workforce-service mounts the workforce-service-token
// Secret Manager secret as WORKFORCE_SERVICE_TOKEN on Cloud Run via
// cloudbuild's --update-secrets step.
//
// Writes are fire-and-forget so they never block or fail the agent loop.

import { loadConfig } from '../infrastructure/config.js';
import { log } from '../infrastructure/logging.js';

export interface AgentAuditLogInput {
  tenantId: string;
  internalAgentId: string;
  threadId?: string;
  invocationId?: string;
  action: string;
  inputArgs: Record<string, unknown>;
  outputSummary?: string;
  outcome: 'success' | 'error' | 'gated';
  errorCode?: string;
  triggeredBy: string;
  durationMs?: number;
}

function getServiceToken(): string {
  // Cloud Run mounts the workforce-service-token secret under this name via
  // cloudbuild's --update-secrets. PB's audit-log endpoint accepts it
  // (PR #5 widened it from TENANT_RUNTIME_SERVICE_TOKEN-only).
  return process.env['WORKFORCE_SERVICE_TOKEN'] ?? '';
}

export async function writeAgentAuditLog(input: AgentAuditLogInput): Promise<void> {
  const url = `${loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '')}/api/agent-audit-logs`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-auth': getServiceToken(),
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status, action: input.action },
        'agent_audit_logs write failed; continuing',
      );
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message, action: input.action },
      'agent_audit_logs write threw; continuing',
    );
  }
}
