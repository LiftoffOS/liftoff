// Adapter: CAIO + HRBP (workforce-service runPlatformAgent loop).
//
// Neither agent sinks a CanonicalTrajectory today, so this adapter MAPS their
// native tables into the same canonical shape (per plan, "two adapters map
// their runs into the same CanonicalTrajectory shape"):
//   - CAIO   → reconstruct by thread_id from team_plan_messages (text turns) +
//              PB agent_audit_logs (`*.tool_called` → tool_use sequence).
//   - HRBP   → reconstruct by run_id from hrbp_provisioning_runs/events
//              (the designed distill→create→record/update sequence) +
//              hrbp_compensation_log; terminator from run.status.
//
// Reads two DBs: the workforce-service DB (team_plan_*, hrbp_*, workforce_plans)
// and the platform-backend DB (agent_audit_logs) via getCrossServicePool.

import { getCrossServicePool } from './cross-db';
import { logger as log } from '../../infrastructure/logging';
import type { CanonicalTrajectory, CanonicalMessage, CanonicalContentBlock } from '../../trajectories/types';
import type {
  RuntimeAdapter,
  RunRef,
  ReconstructedRun,
  RawEngineEvidence,
  AuditRow,
  HrbpEvidence,
  AgentSpec,
  AgentKind,
} from '../reconstruct/trace-model';

// Seeded system-agent identities (internal_agents UUIDs …0001 / …0002 per the
// plan's Spec sources). Env-overridable so the real seeded UUIDs can be wired
// without a code change. NOTE: confirm the exact seeded UUIDs during P2.
const CAIO_AGENT_ID = process.env.DIAGNOSTICS_CAIO_AGENT_ID ?? '00000000-0000-0000-0000-000000000001';
const HRBP_AGENT_ID = process.env.DIAGNOSTICS_HRBP_AGENT_ID ?? '00000000-0000-0000-0000-000000000002';

/** events.step → designed HRBP tool name. The provisioning saga records each
 *  designed step; map the persisted step token onto the HRBP_TOOLS catalog so
 *  the tool-conformance + sequence checks operate on canonical names.
 *
 *  The AUTHORITATIVE persisted enum (provisioning__record_event input_schema in
 *  liftoff-workforce-service) is `distill | create_agent | update_agent |
 *  attribute_session`. Every step token MUST map onto HRBP_TOOLS — an unmapped
 *  token falls through raw (`create_agent`, …) and then (a) trips a false
 *  conformance.out_of_set finding, (b) tanks toolCorrectness, AND (c) makes the
 *  spec-conformance judge read an out-of-spec tool name in the sequence and score
 *  the run non-conformant. distill→build→record keeps the designed sequence
 *  monotonic. */
const HRBP_STEP_TO_TOOL: Record<string, string> = {
  distill: 'teambuilder__distill',
  teambuilder__distill: 'teambuilder__distill',
  create: 'teambuilder__create',
  create_agent: 'teambuilder__create',
  update_agent: 'teambuilder__create',
  attribute_session: 'provisioning__record_event',
  teambuilder__create: 'teambuilder__create',
  record_event: 'provisioning__record_event',
  provisioning__record_event: 'provisioning__record_event',
  update_spec_status: 'provisioning__update_spec_status',
  provisioning__update_spec_status: 'provisioning__update_spec_status',
  compensate: 'provisioning__compensate',
  provisioning__compensate: 'provisioning__compensate',
  transition_to_blocker: 'provisioning__transition_to_blocker',
  provisioning__transition_to_blocker: 'provisioning__transition_to_blocker',
};

export class WorkforceAdapter implements RuntimeAdapter {
  readonly runtime = 'workforce-service' as const;

  async listRecent(opts: {
    tenantId: string;
    agentId: string;
    agentKind: AgentKind;
    limit: number;
    sinceIso?: string;
  }): Promise<RunRef[]> {
    const pool = getCrossServicePool('workforce');
    if (!pool) return [];
    if (opts.agentKind === 'caio') {
      const params: unknown[] = [opts.tenantId, opts.limit];
      let since = '';
      if (opts.sinceIso) {
        since = ' AND updated_at >= $3';
        params.push(opts.sinceIso);
      }
      const res = await pool.query(
        `SELECT id FROM team_plan_threads
          WHERE tenant_id = $1 AND deleted_at IS NULL${since}
          ORDER BY updated_at DESC LIMIT $2`,
        params,
      );
      return res.rows.map((r: { id: string }) => ({ agentKind: 'caio' as const, tenantId: opts.tenantId, agentId: CAIO_AGENT_ID, key: r.id }));
    }
    // HRBP
    const params: unknown[] = [opts.tenantId, opts.limit];
    let since = '';
    if (opts.sinceIso) {
      since = ' AND created_at >= $3';
      params.push(opts.sinceIso);
    }
    const res = await pool.query(
      `SELECT id FROM hrbp_provisioning_runs
        WHERE tenant_id = $1${since}
        ORDER BY created_at DESC LIMIT $2`,
      params,
    );
    return res.rows.map((r: { id: string }) => ({ agentKind: 'hrbp' as const, tenantId: opts.tenantId, agentId: HRBP_AGENT_ID, key: r.id }));
  }

  async reconstruct(ref: RunRef): Promise<ReconstructedRun | null> {
    if (ref.agentKind === 'caio') return this.reconstructCaio(ref);
    if (ref.agentKind === 'hrbp') return this.reconstructHrbp(ref);
    return null;
  }

  // -------------------------------------------------------------------------
  // CAIO — interactive chat thread.
  // -------------------------------------------------------------------------
  private async reconstructCaio(ref: RunRef): Promise<ReconstructedRun | null> {
    const wf = getCrossServicePool('workforce');
    const pb = getCrossServicePool('insights'); // PB DB hosts agent_audit_logs
    if (!wf) return null;

    const msgRes = await wf.query(
      `SELECT role, content, visualization_blocks, input_tokens, output_tokens, created_at
         FROM team_plan_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
      [ref.key],
    );
    if (msgRes.rowCount === 0) {
      log.warn({ message: 'workforce adapter: no CAIO messages for thread', threadId: ref.key });
      return null;
    }

    // Tool calls recorded by runPlatformAgent → PB agent_audit_logs.
    const audit = pb ? await this.loadPbAuditByThread(pb, ref.tenantId, ref.key) : [];
    const toolBlocks = this.toolUseBlocksFromAudit(audit);

    const messages: CanonicalMessage[] = [];
    let cumIn = 0;
    let cumOut = 0;
    for (const m of msgRes.rows as Array<{ role: string; content: string; input_tokens: number; output_tokens: number }>) {
      cumIn += Number(m.input_tokens ?? 0);
      cumOut += Number(m.output_tokens ?? 0);
      if (m.role === 'user') messages.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      else messages.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] });
    }
    // Append the reconstructed tool_use/tool_result sequence as a trailing
    // assistant/user pair (precise per-turn interleaving isn't recoverable from
    // separate stores — sequence + names are, which is what conformance needs).
    if (toolBlocks.uses.length > 0) {
      messages.push({ role: 'assistant', content: toolBlocks.uses });
      messages.push({ role: 'user', content: toolBlocks.results });
    }

    const trajectory: CanonicalTrajectory = {
      schema_version: '1.0',
      trajectory_meta: {
        tenant_id: ref.tenantId,
        agent_id: CAIO_AGENT_ID,
        invocation_id: ref.key,
        provider: 'anthropic',
        model: 'platform-agent',
        started_at: new Date().toISOString(),
        completed: true,
        tool_call_count: toolBlocks.uses.length,
        outcome: 'success',
      },
      system: [],
      messages,
      tools: [],
    };
    const raw: RawEngineEvidence = {
      auditLogs: audit,
      loopMeta: {
        iterations: toolBlocks.uses.length,
        maxIterations: 10,
        cumulativeInputTokens: cumIn,
        cumulativeOutputTokens: cumOut,
        terminator: 'normal',
      },
    };
    return { ref, runtime: this.runtime, trajectory, raw, spec: await this.loadSpec('caio') };
  }

  // -------------------------------------------------------------------------
  // HRBP — autonomous provisioning saga.
  // -------------------------------------------------------------------------
  private async reconstructHrbp(ref: RunRef): Promise<ReconstructedRun | null> {
    const wf = getCrossServicePool('workforce');
    const pb = getCrossServicePool('insights'); // PB DB hosts agent_audit_logs
    if (!wf) return null;

    const [runRes, evRes, compRes] = await Promise.all([
      wf.query(`SELECT id, plan_id, status, spec_count FROM hrbp_provisioning_runs WHERE id = $1 AND tenant_id = $2`, [ref.key, ref.tenantId]),
      wf.query(
        `SELECT spec_id, step, status, internal_agent_id, idempotency_key, error_message, created_at
           FROM hrbp_provisioning_events WHERE run_id = $1 ORDER BY created_at ASC`,
        [ref.key],
      ),
      wf.query(
        `SELECT spec_id, action, status, error_message FROM hrbp_compensation_log WHERE run_id = $1 ORDER BY created_at ASC`,
        [ref.key],
      ),
    ]);
    const runRow = runRes.rows[0] as { id: string; plan_id: string; status: string; spec_count: number } | undefined;
    if (!runRow) {
      log.warn({ message: 'workforce adapter: no HRBP run', runId: ref.key });
      return null;
    }

    const events = evRes.rows as Array<{
      spec_id: string;
      step: string;
      status: string;
      internal_agent_id: string | null;
      idempotency_key: string | null;
      error_message: string | null;
      created_at: string;
    }>;

    // Prefer REAL tool args from agent_audit_logs. The shared platform-agent loop
    // writes each HRBP tool call to PB agent_audit_logs
    // (`hrbp.provision_spec.tool_called`, {tool,input}) correlated by
    // thread_id = run_id (hrbp-task-handler passes threadId: runId). When present,
    // those carry the real arguments → the arg-validity critic + judge can score
    // them. Fall back to the provisioning ledger (synthetic {specId} input) for
    // pre-correlation runs; that path marks inputs UNRELIABLE so the arg critic +
    // judge null out (no false findings), while sequence/outcome checks still run.
    const audit = pb ? await this.loadPbAuditByThread(pb, ref.tenantId, ref.key) : [];
    const realTool = this.toolUseBlocksFromAudit(audit);

    let uses: CanonicalContentBlock[];
    let results: CanonicalContentBlock[];
    let inputsReliable: boolean;
    if (realTool.uses.length > 0) {
      uses = realTool.uses;
      results = realTool.results;
      inputsReliable = true;
    } else {
      uses = [];
      results = [];
      for (const [i, ev] of events.entries()) {
        const tool = HRBP_STEP_TO_TOOL[ev.step] ?? ev.step;
        const id = `hrbp_${i}`;
        uses.push({ type: 'tool_use', id, name: tool, input: { specId: ev.spec_id } });
        results.push({
          type: 'tool_result',
          tool_use_id: id,
          content: JSON.stringify({ status: ev.status, internalAgentId: ev.internal_agent_id, error: ev.error_message }),
          ...(ev.status !== 'success' && ev.error_message ? { is_error: true } : {}),
        });
      }
      inputsReliable = false;
    }

    const hrbp: HrbpEvidence = {
      run: { id: runRow.id, planId: runRow.plan_id, status: runRow.status, specCount: Number(runRow.spec_count ?? 0) },
      events: events.map((e) => ({
        specId: e.spec_id,
        step: e.step,
        status: e.status,
        internalAgentId: e.internal_agent_id,
        idempotencyKey: e.idempotency_key,
        errorMessage: e.error_message,
        createdAt: new Date(e.created_at).toISOString(),
      })),
      compensations: (compRes.rows as Array<{ spec_id: string; action: string; status: string; error_message: string | null }>).map((c) => ({
        specId: c.spec_id,
        action: c.action,
        status: c.status,
        errorMessage: c.error_message,
      })),
    };

    const terminator = runRow.status === 'completed' ? 'normal' : runRow.status === 'failed' ? 'error' : 'max_iterations';

    // HRBP is a backend provisioning saga with NO chat turns — so unlike CAIO it
    // has no user-objective and no assistant "final answer". The goal/conformance
    // judges read exactly those (objective + final assistant text), so without a
    // synthesized objective + outcome summary EVERY HRBP run grades as fail
    // (empty objective + empty answer), regardless of whether it actually
    // provisioned. Synthesize both from the provisioning ledger so the judges
    // grade the real outcome.
    const createdAgentIds = Array.from(new Set(events.filter((e) => e.internal_agent_id).map((e) => e.internal_agent_id)));
    const failedSteps = events.filter((e) => e.status === 'failed');
    const objectiveText =
      `Provision the approved workforce plan ${runRow.plan_id} — ${runRow.spec_count} agent spec(s). ` +
      `For each spec: distill the role, create the internal agent, and record the provisioning status.`;
    const summaryText = [
      `Provisioning ${runRow.status}.`,
      `${createdAgentIds.length}/${runRow.spec_count} agent(s) created.`,
      failedSteps.length ? `${failedSteps.length} provisioning step(s) failed.` : '',
      hrbp.compensations.length ? `${hrbp.compensations.length} compensation(s) run.` : '',
      failedSteps.length ? `Errors: ${failedSteps.map((e) => e.error_message).filter(Boolean).slice(0, 3).join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const messages: CanonicalMessage[] = [{ role: 'user', content: [{ type: 'text', text: objectiveText }] }];
    if (uses.length > 0) {
      messages.push({ role: 'assistant', content: uses }, { role: 'user', content: results });
    }
    messages.push({ role: 'assistant', content: [{ type: 'text', text: summaryText }] });

    const trajectory: CanonicalTrajectory = {
      schema_version: '1.0',
      trajectory_meta: {
        tenant_id: ref.tenantId,
        agent_id: HRBP_AGENT_ID,
        invocation_id: ref.key,
        provider: 'anthropic',
        model: 'platform-agent',
        started_at: events[0] ? new Date(events[0].created_at).toISOString() : new Date().toISOString(),
        completed: runRow.status === 'completed' || runRow.status === 'failed',
        tool_call_count: uses.length,
        outcome: runRow.status === 'completed' ? 'success' : 'error',
        // Synthetic {specId} fallback → mark inputs unreliable so arg-validity /
        // arg-appropriateness null out (they never fabricate on synthetic args).
        ...(inputsReliable ? {} : { inputs_reliable: false }),
      },
      system: [],
      messages,
      tools: [],
    };
    const raw: RawEngineEvidence = { hrbp, ...(inputsReliable && audit.length > 0 ? { auditLogs: audit } : {}), loopMeta: { iterations: events.length, maxIterations: 10, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, terminator } };
    return { ref, runtime: this.runtime, trajectory, raw, spec: await this.loadSpec('hrbp') };
  }

  private async loadPbAuditByThread(pb: import('pg').Pool, tenantId: string, threadId: string): Promise<AuditRow[]> {
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
      log.warn({ message: 'workforce adapter: PB agent_audit_logs read failed', err: (err as Error).message });
      return [];
    }
  }

  /** Build tool_use/tool_result blocks from `*.tool_called` audit rows whose
   *  input_args carry `{tool, input}` (written by runPlatformAgent). */
  private toolUseBlocksFromAudit(audit: AuditRow[]): { uses: CanonicalContentBlock[]; results: CanonicalContentBlock[] } {
    const uses: CanonicalContentBlock[] = [];
    const results: CanonicalContentBlock[] = [];
    let i = 0;
    for (const row of audit) {
      if (!row.action.endsWith('.tool_called')) continue;
      const args = (row.inputArgs ?? {}) as { tool?: string; input?: Record<string, unknown> };
      if (!args.tool) continue;
      const id = `caio_${i++}`;
      uses.push({ type: 'tool_use', id, name: args.tool, input: args.input ?? {} });
      results.push({ type: 'tool_result', tool_use_id: id, content: row.outcome, ...(row.outcome === 'error' ? { is_error: true } : {}) });
    }
    return { uses, results };
  }

  /** Spec source: seeded system agents in PB internal_agents (system_prompt +
   *  responsibilities). Columns not schema-verified — defensive try/catch with
   *  a static fallback so reconstruction never fails on a spec read. */
  private async loadSpec(kind: 'caio' | 'hrbp'): Promise<AgentSpec> {
    const pb = getCrossServicePool('insights');
    const id = kind === 'caio' ? CAIO_AGENT_ID : HRBP_AGENT_ID;
    const fallback =
      kind === 'caio'
        ? 'CAIO (Chief AI Officer): gather org structure, draft a workforce plan, commit it, and shepherd it to approval. Mutating workforce_plan tools are owner/admin only.'
        : 'HRBP (HR Business Partner): for each approved spec, distill then create the internal agent, recording provisioning events; compensate on rollback and transition to blocker on unrecoverable error.';
    if (pb) {
      try {
        const res = await pb.query(`SELECT system_prompt, responsibilities, role FROM internal_agents WHERE id = $1::uuid`, [id]);
        const row = res.rows[0] as { system_prompt?: string; responsibilities?: string; role?: string } | undefined;
        if (row) {
          return {
            agentKind: kind,
            role: row.role,
            responsibilities: row.responsibilities,
            text: [row.role && `Role: ${row.role}`, row.system_prompt, row.responsibilities && `Responsibilities: ${row.responsibilities}`].filter(Boolean).join('\n\n') || fallback,
          };
        }
      } catch (err) {
        log.warn({ message: 'workforce adapter: internal_agents spec read failed, using fallback', kind, err: (err as Error).message });
      }
    }
    return { agentKind: kind, text: fallback };
  }
}
