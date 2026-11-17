// Adapter: USER-CREATED agents (tenant-runtime hybrid loop).
//
// Reconstruction strategy (per plan "Reconstruction → one canonical shape"):
//   1. PRIMARY — the shipped CanonicalTrajectory: read the `agent_trajectories`
//      index row, fetch the JSONL from GCS (`gcs_path`), parse it. This is the
//      lossless designed shape (text/thinking/tool_use/tool_result + full
//      designed `tools` array). REUSE, do not rebuild.
//   2. RAW-TABLE FALLBACK — the quality filter skips the GCS write for runs
//      with no reasoning blocks (`gcs_path IS NULL`, migration 293). For those,
//      synthesize a minimal CanonicalTrajectory from `invocations.tool_calls` +
//      `messages` so non-reasoning runs are still evaluable.
//
// Raw engine evidence (invocations / agent_run_states / live pause rows /
// child invocations / audit_logs) is always loaded for the hybrid-loop
// invariants, independent of which reconstruction path produced the trajectory.

import { Storage } from '@google-cloud/storage';
import { getPoolForService } from '../../infrastructure/database';
import { logger as log } from '../../infrastructure/logging';
import type { CanonicalTrajectory, CanonicalMessage, CanonicalContentBlock } from '../../trajectories/types';
import type { ExecutionEngineId } from '../../agent-execution/adapter/types';
import type { InvocationOutcome } from '../../invocations/types';
import type {
  RuntimeAdapter,
  RunRef,
  ReconstructedRun,
  RawEngineEvidence,
  InvocationRow,
  PausedRunRow,
  AuditRow,
  AgentSpec,
  AgentKind,
} from '../reconstruct/trace-model';

const POOL = 'default' as const;

function gcsClient(): Storage {
  return new Storage();
}

/** Parse a `gs://bucket/object` path into its parts. */
function parseGcsPath(p: string): { bucket: string; object: string } | null {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(p);
  if (!m) return null;
  return { bucket: m[1], object: m[2] };
}

export class TenantRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = 'tenant-runtime' as const;

  async listRecent(opts: {
    tenantId: string;
    agentId: string;
    agentKind: AgentKind;
    limit: number;
    sinceIso?: string;
  }): Promise<RunRef[]> {
    const pool = getPoolForService(POOL);
    const params: unknown[] = [opts.tenantId, opts.agentId, opts.limit];
    let sinceClause = '';
    if (opts.sinceIso) {
      sinceClause = ' AND started_at >= $4';
      params.push(opts.sinceIso);
    }
    // Discover from `invocations` — the SOURCE OF TRUTH for run history (what the
    // /activity page reads) — NOT the `agent_trajectories` sink index. The sink
    // is quality-filtered (reasoning runs only) and only populated while
    // TRAJECTORY_SINK_ENABLED, so it captures a tiny, frequently-stale subset
    // (observed: 21 rows vs 20k invocations). reconstruct() already bridges both:
    // it serves the GCS trajectory when the sink captured one, else synthesizes a
    // raw-table fallback from invocations.tool_calls. Top-level runs only —
    // delegated children are evaluated within the parent's delegation invariant.
    const res = await pool.query(
      `SELECT id AS invocation_id
         FROM invocations
        WHERE tenant_id = $1::uuid AND agent_id = $2::uuid
          AND parent_invocation_id IS NULL${sinceClause}
        ORDER BY started_at DESC
        LIMIT $3`,
      params,
    );
    return res.rows.map((r: { invocation_id: string }) => ({
      agentKind: 'user-created' as const,
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      key: r.invocation_id,
    }));
  }

  /** Discover the tenant's ACTIVE user-created agents from the invocations
   *  source of truth — every agent with recent top-level runs, ranked by volume.
   *  Lets the harvest evaluate ALL active agents on the tenant instead of a
   *  single configured DIAGNOSTICS_USER_AGENT_ID. Zero side effects. */
  async listActiveAgents(opts: { tenantId: string; limit: number; sinceIso?: string }): Promise<string[]> {
    const pool = getPoolForService(POOL);
    const params: unknown[] = [opts.tenantId, opts.limit];
    let sinceClause = '';
    if (opts.sinceIso) {
      sinceClause = ' AND started_at >= $3';
      params.push(opts.sinceIso);
    }
    const res = await pool.query(
      `SELECT agent_id, COUNT(*) AS n
         FROM invocations
        WHERE tenant_id = $1::uuid AND agent_id IS NOT NULL
          AND parent_invocation_id IS NULL${sinceClause}
        GROUP BY agent_id
        ORDER BY n DESC
        LIMIT $2`,
      params,
    );
    return res.rows.map((r: { agent_id: string }) => r.agent_id);
  }

  async reconstruct(ref: RunRef): Promise<ReconstructedRun | null> {
    const invocationId = ref.key;
    // Load the spec FIRST so the raw-table fallback can synthesize a judge-
    // readable objective from it when the run has no persisted chat text.
    const spec = await this.loadSpec(ref.tenantId, ref.agentId);
    const [trajectory, raw] = await Promise.all([
      this.loadTrajectory(ref.tenantId, ref.agentId, invocationId, spec),
      this.loadRawEvidence(ref.tenantId, invocationId),
    ]);
    if (!trajectory) {
      log.warn({ message: 'tenant-runtime adapter: could not reconstruct trajectory', invocationId });
      return null;
    }
    return { ref, runtime: this.runtime, trajectory, raw, spec };
  }

  /** PRIMARY then FALLBACK reconstruction of the CanonicalTrajectory. */
  private async loadTrajectory(
    tenantId: string,
    agentId: string,
    invocationId: string,
    spec?: AgentSpec,
  ): Promise<CanonicalTrajectory | null> {
    const pool = getPoolForService(POOL);
    const idx = await pool.query(
      `SELECT gcs_path, completed, provider, model FROM agent_trajectories
        WHERE tenant_id = $1::uuid AND invocation_id = $2::uuid`,
      [tenantId, invocationId],
    );
    const row = idx.rows[0] as { gcs_path: string | null } | undefined;

    if (row?.gcs_path) {
      const parsed = parseGcsPath(row.gcs_path);
      if (parsed) {
        try {
          const [buf] = await gcsClient().bucket(parsed.bucket).file(parsed.object).download();
          // Stored as a single JSONL line; take the first line.
          const firstLine = buf.toString('utf8').split('\n').find((l) => l.trim().length > 0);
          if (firstLine) return JSON.parse(firstLine) as CanonicalTrajectory;
        } catch (err) {
          log.warn({ message: 'tenant-runtime adapter: GCS trajectory fetch failed, falling back', invocationId, err: (err as Error).message });
        }
      }
    }
    // RAW-TABLE FALLBACK.
    return this.buildFallbackTrajectory(tenantId, agentId, invocationId, spec);
  }

  /** Minimal CanonicalTrajectory from invocations + messages for non-reasoning
   *  runs. Lossy (no thinking blocks, designed `tools` array unavailable from
   *  persisted state — see plan caveat) but evaluable for tool/outcome dims. */
  private async buildFallbackTrajectory(
    tenantId: string,
    agentId: string,
    invocationId: string,
    spec?: AgentSpec,
  ): Promise<CanonicalTrajectory | null> {
    const pool = getPoolForService(POOL);
    const invRes = await pool.query(
      `SELECT id, thread_id, model_id, provider, execution_engine, input_tokens, output_tokens, tool_calls,
              outcome, started_at, completed_at
         FROM invocations WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [invocationId, tenantId],
    );
    const inv = invRes.rows[0] as
      | {
          thread_id: string | null;
          model_id: string | null;
          provider: string | null;
          execution_engine: string | null;
          tool_calls: Array<{ id?: string; name?: string; input?: unknown; output?: unknown; error?: string }> | null;
          outcome: InvocationOutcome | null;
          started_at: string;
        }
      | undefined;
    if (!inv) return null;

    const messages: CanonicalMessage[] = [];
    // Replay the persisted thread messages as user/assistant turns.
    if (inv.thread_id) {
      const msgRes = await pool.query(
        `SELECT role, content, tool_calls FROM messages
          WHERE thread_id = $1::uuid AND tenant_id = $2::uuid
          ORDER BY created_at ASC`,
        [inv.thread_id, tenantId],
      );
      for (const m of msgRes.rows as Array<{ role: string; content: string; tool_calls: unknown }>) {
        if (m.role === 'user') {
          messages.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
        } else if (m.role === 'assistant') {
          const blocks: CanonicalContentBlock[] = m.content ? [{ type: 'text', text: m.content }] : [];
          messages.push({ role: 'assistant', content: blocks });
        }
      }
    }
    // Append executed tool calls (the only durable record for non-reasoning
    // runs) as tool_use / tool_result pairs.
    const assistantTools: CanonicalContentBlock[] = [];
    const toolResults: CanonicalContentBlock[] = [];
    for (const [i, tc] of (inv.tool_calls ?? []).entries()) {
      const id = tc.id ?? `fallback_${i}`;
      assistantTools.push({ type: 'tool_use', id, name: tc.name ?? 'unknown', input: (tc.input as Record<string, unknown>) ?? {} });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output ?? null),
        ...(tc.error ? { is_error: true } : {}),
      });
    }
    if (assistantTools.length > 0) {
      messages.push({ role: 'assistant', content: assistantTools });
      messages.push({ role: 'user', content: toolResults });
    }

    // Input-reliability signal for the loop / idempotency detectors. The raw
    // `invocations.tool_calls` path historically persisted empty `{}` inputs for
    // SDK-executed tools (the adapter tool_call_started→finished correlation
    // dropped the args), so the (name,input) signature collapses to name-only
    // and every same-name call false-fires as a loop. Treat the run as reliable
    // only when a meaningful fraction of tool calls actually carry inputs —
    // recorder-sourced rows (post-fix) and genuinely arg-bearing runs pass;
    // all-empty lossy rows are flagged so hybrid-loop.ts skips the signature
    // detectors. (toolCallSignature is in trajectory-util; here we just measure.)
    const toolUseCount = assistantTools.length;
    const withInput = assistantTools.filter((b) => {
      const inp = (b as { input?: Record<string, unknown> }).input;
      return inp != null && Object.keys(inp).length > 0;
    }).length;
    const inputsReliable = toolUseCount === 0 || withInput / toolUseCount >= 0.5;

    // Synthesize a judge-readable objective + outcome when the run carried no
    // persisted chat text. These runs DO have a thread_id, but the `messages`
    // table is empty for them (only tool_calls + outcome survive on the
    // invocation — the conversation itself was never persisted), so the
    // goal/conformance judges, which read OBJECTIVE (first user text) + FINAL
    // ANSWER (last assistant text), would score 0 on empty text. Derive the
    // objective from the agent's spec and the outcome summary from the run's
    // outcome + tools — so the judges grade the real run, not absent text.
    // (Mirrors the HRBP saga reconstruction.)
    const hasChatText = messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text?: string }).text));
    if (!hasChatText) {
      const role = spec?.role ? `${spec.role}. ` : '';
      const responsibilities = spec?.text ? spec.text.slice(0, 700) : '';
      const objectiveText =
        `Automated (non-interactive) run of this agent — evaluate whether it accomplished its designed purpose. ` +
        `Agent: ${role}${responsibilities}`.trim();
      const toolNames = Array.from(
        new Set(assistantTools.map((b) => (b as { name?: string }).name).filter((n): n is string => !!n)),
      );
      const erroredTools = toolResults.filter((b) => (b as { is_error?: boolean }).is_error).length;
      const summaryText = [
        `Run ${inv.outcome ?? 'completed'}.`,
        toolNames.length ? `Called ${assistantTools.length} tool(s) across ${toolNames.length} distinct: ${toolNames.slice(0, 10).join(', ')}.` : 'No tools called.',
        erroredTools ? `${erroredTools} tool call(s) returned an error.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      messages.unshift({ role: 'user', content: [{ type: 'text', text: objectiveText }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: summaryText }] });
    }
    const synthesizedObjective = !hasChatText;

    return {
      schema_version: '1.1',
      trajectory_meta: {
        tenant_id: tenantId,
        agent_id: agentId,
        invocation_id: invocationId,
        // The real provider from the invocation row (invocations.provider is NOT
        // NULL). Previously hardcoded 'anthropic', which was inconsistent with a
        // non-anthropic execution_engine on the same reconstructed trajectory.
        provider: (inv.provider as CanonicalTrajectory['trajectory_meta']['provider']) ?? 'anthropic',
        // The concrete engine that actually ran, read from the
        // invocation row (migration 321) rather than re-derived from a provider.
        // Omitted for pre-321 invocations (NULL), so diagnostics can still group
        // reconstructed failures by engine.
          ...(inv.execution_engine ? { execution_engine: inv.execution_engine as ExecutionEngineId } : {}),
        model: inv.model_id ?? 'unknown',
        started_at: new Date(inv.started_at).toISOString(),
        completed: inv.outcome != null,
        tool_call_count: assistantTools.length,
        outcome: inv.outcome ?? 'error',
        // No persisted conversation → objective/outcome were synthesized; the
        // judges score from the recorded outcome rather than the LLM (see
        // judgeGoalSuccess / judgeSpecConformance).
        ...(synthesizedObjective ? { synthesized_objective: true } : {}),
        // Whether the reconstructed tool-call inputs are trustworthy enough to
        // run the signature-based loop / idempotency detectors (hybrid-loop.ts).
        inputs_reliable: inputsReliable,
      },
      system: [],
      messages,
      // The designed/available toolset is NOT persisted (plan caveat) — empty
      // here; the toolset loader reconstructs it separately for conformance.
      tools: [],
    };
  }

  private async loadRawEvidence(tenantId: string, invocationId: string): Promise<RawEngineEvidence> {
    const pool = getPoolForService(POOL);
    const [invRes, runStateRes, sessionRes, childRes, auditRes] = await Promise.all([
      pool.query(
        `SELECT id, tenant_id, agent_id, parent_invocation_id, triggered_by, outcome,
                failure_class, error_message, input_tokens, output_tokens,
                -- cost_usd was dropped (migration 048); cost is now derived from
                -- token counts × per-invocation price snapshots. Mirrors the
                -- in-app formula (invocations.getCostStats / performance-tracker).
                (COALESCE(input_tokens, 0) * COALESCE(input_price_per_million, 0)
                 + COALESCE(output_tokens, 0) * COALESCE(output_price_per_million, 0)) / 1000000.0 AS cost_usd,
                tool_calls, started_at, completed_at
           FROM invocations WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [invocationId, tenantId],
      ),
      pool.query(
        `SELECT schema_version, state FROM agent_run_states WHERE invocation_id = $1`,
        [invocationId],
      ),
      pool.query(
        // Live pause/resume rows: agent_scheduled_invocations carrying a
        // HybridResumeState workflow_resume_payload, keyed by the invocation
        // that paused. (Superseded the never-written engine_sessions table.)
        `SELECT scheduled_by_invocation_id, status, fires_at, fired_at, created_at,
                workflow_resume_payload->>'pauseReason' AS pause_reason,
                workflow_resume_payload->'hitlContext'->>'approvalId' AS approval_id
           FROM agent_scheduled_invocations
          WHERE scheduled_by_invocation_id = $1
            AND workflow_resume_payload IS NOT NULL
            AND workflow_resume_payload->>'pauseReason' IS NOT NULL
          ORDER BY created_at ASC`,
        [invocationId],
      ),
      pool.query(
        `SELECT id, tenant_id, agent_id, parent_invocation_id, triggered_by, outcome,
                failure_class, error_message, input_tokens, output_tokens,
                -- cost_usd was dropped (migration 048); cost is now derived from
                -- token counts × per-invocation price snapshots. Mirrors the
                -- in-app formula (invocations.getCostStats / performance-tracker).
                (COALESCE(input_tokens, 0) * COALESCE(input_price_per_million, 0)
                 + COALESCE(output_tokens, 0) * COALESCE(output_price_per_million, 0)) / 1000000.0 AS cost_usd,
                tool_calls, started_at, completed_at
           FROM invocations WHERE parent_invocation_id = $1::uuid`,
        [invocationId],
      ),
      pool.query(
        `SELECT id, action, outcome, error_code, input_args, triggered_by, created_at
           FROM audit_logs WHERE invocation_id = $1::uuid ORDER BY created_at ASC`,
        [invocationId],
      ),
    ]);

    const mapInv = (r: Record<string, unknown>): InvocationRow => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      agentId: r.agent_id as string,
      parentInvocationId: (r.parent_invocation_id as string | null) ?? null,
      triggeredBy: r.triggered_by as string,
      outcome: (r.outcome as InvocationRow['outcome']) ?? null,
      failureClass: (r.failure_class as InvocationRow['failureClass']) ?? null,
      errorMessage: (r.error_message as string | null) ?? null,
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      costUsd: r.cost_usd != null ? Number(r.cost_usd) : null,
      toolCalls: (r.tool_calls as InvocationRow['toolCalls']) ?? [],
      startedAt: new Date(r.started_at as string).toISOString(),
      completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
    });

    const evidence: RawEngineEvidence = {
      auditLogs: (auditRes.rows as Array<Record<string, unknown>>).map(
        (r): AuditRow => ({
          id: r.id as string,
          action: r.action as string,
          outcome: r.outcome as AuditRow['outcome'],
          errorCode: (r.error_code as string | null) ?? null,
          inputArgs: r.input_args,
          triggeredBy: r.triggered_by as string,
          createdAt: new Date(r.created_at as string).toISOString(),
        }),
      ),
      livePauses: (sessionRes.rows as Array<Record<string, unknown>>).map(
        (r): PausedRunRow => ({
          invocationId: r.scheduled_by_invocation_id as string,
          pauseReason: (r.pause_reason as string) ?? 'unknown',
          approvalId: (r.approval_id as string | null) ?? null,
          status: r.status as string,
          firedAt: r.fired_at ? new Date(r.fired_at as string).toISOString() : null,
          createdAt: new Date(r.created_at as string).toISOString(),
          expiresAt: new Date(r.fires_at as string).toISOString(),
        }),
      ),
      childInvocations: (childRes.rows as Array<Record<string, unknown>>).map(mapInv),
    };
    if (invRes.rows[0]) evidence.invocation = mapInv(invRes.rows[0] as Record<string, unknown>);
    if (runStateRes.rows[0]) {
      const rs = runStateRes.rows[0] as { schema_version: string; state: unknown };
      evidence.runState = { schemaVersion: rs.schema_version, state: rs.state };
    }
    return evidence;
  }

  /** Spec source for user-created agents: compiled_instructions (latest
   *  active version). role/responsibilities/additionalContext are fields of
   *  the compiled instruction JSON. */
  private async loadSpec(tenantId: string, agentId: string): Promise<AgentSpec> {
    const pool = getPoolForService(POOL);
    const res = await pool.query(
      `SELECT instruction FROM compiled_instructions
        WHERE tenant_id = $1 AND agent_id = $2
        ORDER BY version DESC LIMIT 1`,
      [tenantId, agentId],
    );
    const raw = res.rows[0]?.instruction;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
    } catch {
      parsed = {};
    }
    const role = (parsed.role as string) ?? '';
    const responsibilities = (parsed.responsibilities as string) ?? '';
    const additionalContext = (parsed.additionalContext as string) ?? '';
    return {
      agentKind: 'user-created',
      role,
      responsibilities,
      additionalContext,
      text: [role && `Role: ${role}`, responsibilities && `Responsibilities: ${responsibilities}`, additionalContext && `Context: ${additionalContext}`]
        .filter(Boolean)
        .join('\n\n'),
    };
  }
}
