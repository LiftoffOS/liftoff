// Adapter: Insights agent (platform-backend chat-service loop, ≤10 iter /
// ≤100K cumulative tokens).
//
// Reconstruct by thread_id from insights_chat_messages (text + visualization
// blocks) + llm_usage_log (purpose LIKE 'insights_%' for the token budget) +
// agent_audit_logs (`*.tool_called` → tool_use sequence). All in the PB DB,
// reached via getCrossServicePool('insights').

import { getCrossServicePool } from './cross-db';
import { logger as log } from '../../infrastructure/logging';
import type { CanonicalTrajectory, CanonicalMessage, CanonicalContentBlock } from '../../trajectories/types';
import type {
  RuntimeAdapter,
  RunRef,
  ReconstructedRun,
  RawEngineEvidence,
  AuditRow,
  AgentSpec,
  AgentKind,
} from '../reconstruct/trace-model';

const INSIGHTS_AGENT_ID = process.env.DIAGNOSTICS_INSIGHTS_AGENT_ID ?? '00000000-0000-0000-0000-000000000003';
const MAX_ITERATIONS = 10;
const MAX_CUMULATIVE_TOKENS = 100_000;

export class InsightsAdapter implements RuntimeAdapter {
  readonly runtime = 'platform-backend' as const;

  async listRecent(opts: {
    tenantId: string;
    agentId: string;
    agentKind: AgentKind;
    limit: number;
    sinceIso?: string;
  }): Promise<RunRef[]> {
    const pb = getCrossServicePool('insights');
    if (!pb) return [];
    const params: unknown[] = [opts.tenantId, opts.limit];
    let since = '';
    if (opts.sinceIso) {
      since = ' AND updated_at >= $3';
      params.push(opts.sinceIso);
    }
    const res = await pb.query(
      `SELECT id FROM insights_chat_threads
        WHERE tenant_id = $1::uuid AND deleted_at IS NULL${since}
        ORDER BY updated_at DESC LIMIT $2`,
      params,
    );
    return res.rows.map((r: { id: string }) => ({ agentKind: 'insights' as const, tenantId: opts.tenantId, agentId: INSIGHTS_AGENT_ID, key: r.id }));
  }

  async reconstruct(ref: RunRef): Promise<ReconstructedRun | null> {
    const pb = getCrossServicePool('insights');
    if (!pb) return null;

    const msgRes = await pb.query(
      `SELECT role, content, visualization_blocks, input_tokens, output_tokens, created_at
         FROM insights_chat_messages WHERE thread_id = $1::uuid ORDER BY created_at ASC`,
      [ref.key],
    );
    if (msgRes.rowCount === 0) {
      log.warn({ message: 'insights adapter: no messages for thread', threadId: ref.key });
      return null;
    }

    const audit = await this.loadAuditByThread(pb, ref.tenantId, ref.key);
    const tool = this.toolUseBlocksFromAudit(audit);

    const messages: CanonicalMessage[] = [];
    let vizCount = 0;
    let cumIn = 0;
    let cumOut = 0;
    let firstTs: string | undefined;
    let lastTs: string | undefined;
    for (const m of msgRes.rows as Array<{ role: string; content: string; visualization_blocks: unknown[] | null; input_tokens: number; output_tokens: number; created_at: string }>) {
      cumIn += Number(m.input_tokens ?? 0);
      cumOut += Number(m.output_tokens ?? 0);
      firstTs ??= m.created_at;
      lastTs = m.created_at;
      if (Array.isArray(m.visualization_blocks)) vizCount += m.visualization_blocks.length;
      if (m.role === 'user') messages.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      else messages.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] });
    }
    if (tool.uses.length > 0) {
      messages.push({ role: 'assistant', content: tool.uses });
      messages.push({ role: 'user', content: tool.results });
    }

    // llm_usage_log captures tool sub-dispatch tokens the per-message totals
    // miss. It has no thread id, so bound the sum to THIS thread's time window
    // (first→last message, +1m slack) — the tightest run-scoping available —
    // rather than summing the tenant's entire insights history.
    let usageTokens = cumIn + cumOut;
    if (firstTs && lastTs) {
      try {
        const usageRes = await pb.query(
          `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
             FROM llm_usage_log
            WHERE tenant_id = $1 AND purpose LIKE 'insights_%'
              AND timestamp BETWEEN $2::timestamptz - interval '1 minute'
                                AND $3::timestamptz + interval '1 minute'`,
          [ref.tenantId, firstTs, lastTs],
        );
        const t = Number((usageRes.rows[0] as { total: number } | undefined)?.total ?? 0);
        if (t > 0) usageTokens = t;
      } catch (err) {
        log.warn({ message: 'insights adapter: llm_usage_log read failed', err: (err as Error).message });
      }
    }

    const trajectory: CanonicalTrajectory = {
      schema_version: '1.0',
      trajectory_meta: {
        tenant_id: ref.tenantId,
        agent_id: INSIGHTS_AGENT_ID,
        invocation_id: ref.key,
        provider: 'anthropic',
        model: 'insights-chat',
        started_at: new Date().toISOString(),
        completed: true,
        tool_call_count: tool.uses.length,
        outcome: 'success',
      },
      system: [],
      messages,
      tools: [],
    };
    const raw: RawEngineEvidence = {
      auditLogs: audit,
      visualizationBlockCount: vizCount,
      loopMeta: {
        iterations: tool.uses.length,
        maxIterations: MAX_ITERATIONS,
        cumulativeInputTokens: cumIn,
        cumulativeOutputTokens: cumOut,
        maxCumulativeTokens: MAX_CUMULATIVE_TOKENS,
        terminator: usageTokens > MAX_CUMULATIVE_TOKENS ? 'token_budget' : 'normal',
      },
    };
    return { ref, runtime: this.runtime, trajectory, raw, spec: await this.loadSpec() };
  }

  private async loadAuditByThread(pb: import('pg').Pool, tenantId: string, threadId: string): Promise<AuditRow[]> {
    try {
      const res = await pb.query(
        `SELECT id, action, outcome, error_code, input_args, triggered_by, created_at
           FROM agent_audit_logs WHERE tenant_id = $1::uuid AND thread_id = $2::uuid
          ORDER BY created_at ASC`,
        [tenantId, threadId],
      );
      return (res.rows as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        action: r.action as string,
        outcome: r.outcome as AuditRow['outcome'],
        errorCode: (r.error_code as string | null) ?? null,
        inputArgs: r.input_args,
        triggeredBy: r.triggered_by as string,
        createdAt: new Date(r.created_at as string).toISOString(),
      }));
    } catch (err) {
      log.warn({ message: 'insights adapter: agent_audit_logs read failed', err: (err as Error).message });
      return [];
    }
  }

  private toolUseBlocksFromAudit(audit: AuditRow[]): { uses: CanonicalContentBlock[]; results: CanonicalContentBlock[] } {
    const uses: CanonicalContentBlock[] = [];
    const results: CanonicalContentBlock[] = [];
    let i = 0;
    for (const row of audit) {
      if (!row.action.endsWith('.tool_called')) continue;
      const args = (row.inputArgs ?? {}) as { tool?: string; input?: Record<string, unknown> };
      if (!args.tool) continue;
      const id = `ins_${i++}`;
      uses.push({ type: 'tool_use', id, name: args.tool, input: args.input ?? {} });
      results.push({ type: 'tool_result', tool_use_id: id, content: row.outcome, ...(row.outcome === 'error' ? { is_error: true } : {}) });
    }
    return { uses, results };
  }

  /** Spec source: dynamic system prompt (buildInsightsSystemPrompt). We can't
   *  import PB code from tenant-runtime, so we describe the designed contract
   *  the conformance judge reasons against. */
  private async loadSpec(): Promise<AgentSpec> {
    return {
      agentKind: 'insights',
      text:
        'Insights agent: answer the operator\'s question about their workforce using ONLY the 9 read-only insights tools ' +
        '(get_agent_performance, get_cost_breakdown, get_human_activity, get_payroll_summary, get_benefits_summary, ' +
        'get_oversight_config, get_workforce_composition, get_execution_trends, get_connector_health). Payroll/benefits are ' +
        'owner/admin only. Render results as visualization blocks (metric_card/bar_chart/trend_chart/table/observation). ' +
        'Stay within 10 iterations and 100K cumulative tokens.',
    };
  }
}
