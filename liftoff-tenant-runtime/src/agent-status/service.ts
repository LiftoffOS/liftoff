import { agentRunStateService } from '../agent-execution/run-state/service';
import { getPoolForService } from '../infrastructure/database';
import type { AgentStatusResponse, AgentStatusEvent } from './types';
import type { AgentRunItem } from '../agent-execution/run-state/types';

const RECENT_EVENTS_LIMIT = 10;
const STATUS_CACHE_TTL_MS = 1000;

// Lightweight in-process cache to absorb watch-style polling.
const cache = new Map<string, { at: number; value: AgentStatusResponse }>();

export class AgentStatusService {
  /**
   * @param invocationId  globally unique invocation
   * @param expectedTenantId  if provided, return null when invocation doesn't belong to this tenant (defense in depth)
   */
  async getStatus(invocationId: string, expectedTenantId?: string): Promise<AgentStatusResponse | null> {
    const cacheKey = expectedTenantId ? `${expectedTenantId}:${invocationId}` : invocationId;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < STATUS_CACHE_TTL_MS) return cached.value;

    const pool = getPoolForService('default');
    const invRow = await pool.query(
      `SELECT i.id, i.tenant_id, i.agent_id, i.thread_id, i.started_at, i.completed_at,
              i.outcome, i.error_message, a.name AS agent_name
         FROM invocations i
         LEFT JOIN agents a ON a.id = i.agent_id
        WHERE i.id = $1`,
      [invocationId],
    );
    if (invRow.rows.length === 0) return null;
    const inv = invRow.rows[0];
    if (expectedTenantId && inv.tenant_id !== expectedTenantId) return null;

    const runState = await agentRunStateService.load(invocationId);
    const pendingApprovalId = runState?.interruption?.approvalRequestId ?? null;

    const status: AgentStatusResponse['status'] = runState
      ? runState.status
      : (inv.outcome === 'success' ? 'complete'
        : inv.outcome === 'error' ? 'failed'
        : 'pending');

    const recentEvents = this.extractRecentEvents(runState?.items ?? []);
    const currentTool = this.extractCurrentTool(runState?.items ?? []);
    const startedAt = inv.started_at ? new Date(inv.started_at).toISOString() : null;
    const elapsedMs = inv.started_at
      ? (inv.completed_at ? new Date(inv.completed_at).getTime() : Date.now()) - new Date(inv.started_at).getTime()
      : null;

    const isTerminal = status === 'complete' || status === 'failed';
    const result: AgentStatusResponse = {
      invocationId: inv.id,
      tenantId: inv.tenant_id,
      agentId: inv.agent_id,
      agentName: inv.agent_name ?? null,
      status,
      currentTurn: runState?.currentTurn ?? 0,
      maxTurns: runState?.maxTurns ?? null,
      phase: this.derivePhase(status, !!pendingApprovalId),
      startedAt,
      elapsedMs,
      isTerminal,
      currentTool,
      recentEvents,
      pendingApprovalId,
      lastError: inv.error_message ? truncate(inv.error_message, 200) : null,
    };

    cache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  }

  private derivePhase(
    status: AgentStatusResponse['status'],
    hasPendingApproval: boolean,
  ): AgentStatusResponse['phase'] {
    if (hasPendingApproval) return 'awaiting_approval';
    if (status === 'complete') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'running' || status === 'pending') return 'executing';
    return 'unknown';
  }

  private extractCurrentTool(items: AgentRunItem[]): string | null {
    // Walk backwards. If we find a tool_call without a matching tool_result, that's "current".
    const resultCallIds = new Set(
      items.filter((i): i is Extract<AgentRunItem, { type: 'tool_result' }> => i.type === 'tool_result')
           .map(i => i.callId),
    );
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.type === 'tool_call' && !resultCallIds.has(item.callId)) {
        return item.toolName;
      }
    }
    return null;
  }

  private extractRecentEvents(items: AgentRunItem[]): AgentStatusEvent[] {
    const tail = items.slice(-RECENT_EVENTS_LIMIT);
    return tail.map((item): AgentStatusEvent => {
      switch (item.type) {
        case 'tool_call':
          return { type: 'tool_call', toolName: item.toolName, callId: item.callId, at: item.timestamp };
        case 'tool_result':
          // Sanitize before truncating: tool errors regularly contain secrets/tokens.
          return {
            type: 'tool_result',
            callId: item.callId,
            errorPreview: item.error ? sanitizeAndTruncate(String(item.error), 120) : undefined,
            at: item.timestamp,
          };
        case 'message_output':
          return {
            type: 'message_output',
            contentPreview: sanitizeAndTruncate(item.content, 120),
            at: item.timestamp,
          };
        case 'hitl_approval':
          return { type: 'hitl_approval', toolName: item.toolName, callId: item.callId, at: item.timestamp };
        case 'handoff':
          return { type: 'handoff', at: item.timestamp };
      }
    });
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Run text through the same redaction logic as audit logs (password/token/secret/key/credential
 * patterns) before truncating. sanitizeArgs is designed for objects, so we wrap the string in
 * a synthetic object and extract the redacted form.
 */
function sanitizeAndTruncate(s: string, n: number): string {
  // Regex-based redaction for free-text. Mirrors audit/service.ts:17 SENSITIVE_KEYS set.
  const redacted = s.replace(
    /(password|token|secret|api[_-]?key|credential)["':=\s]+([A-Za-z0-9_\-./+=]{6,})/gi,
    '$1=[REDACTED]',
  );
  return truncate(redacted, n);
}

export const agentStatusService = new AgentStatusService();
