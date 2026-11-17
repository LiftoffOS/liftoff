// Agentic RCA — on any failure / Finding, an LLM agent investigates the
// CanonicalTrajectory + the deterministic findings + raw engine evidence and
// attributes the root cause to a per-runtime STAGE, with a MAST/TRAIL label and
// a fix suggestion. Runs on the configured judge model. PROMINENT but ADVISORY:
// it never gates (plan: "judges/RCA advisory") and is calibrated before trusted.
//
// "Agentic" here = a single investigative pass with the full evidence bundle.
// A future enhancement can let it pull additional cross-service evidence
// (logs by trace_id, connector-service RPC, governance decisions) on demand;
// the evidence bundle below is the seed.

import type { Finding, ReconstructedRun, Stage } from '../reconstruct/trace-model';
import { runStructuredJudge, serializeForJudge } from './judge/llm-judge';

export interface RcaResult {
  /** Per-runtime stage the root cause attributes to. */
  stage: Stage | 'unknown';
  rootCause: string;
  /** MAST/TRAIL failure-mode label for clustering. */
  failureMode: string;
  fixSuggestion: string;
  confidence: number; // 0..1
  unavailable?: boolean;
}

const VALID_STAGES: Stage[] = [
  'input',
  'planning',
  'tool-selection',
  'tool-execution',
  'oversight-gate',
  'delegation',
  'session-persistence',
  'resume',
  'termination',
  'output',
  'engine',
];

const EVIDENCE_MENU = ['child_runs', 'hrbp_events', 'audit_errors', 'tool_inputs', 'run_state'] as const;
type EvidenceKey = (typeof EVIDENCE_MENU)[number];

const SYSTEM = `You are a root-cause-analysis agent for AI-agent run failures. You are given a run
(objective, tool sequence, outcome, final answer), the deterministic INVARIANT FINDINGS that fired,
and a summary of the raw engine evidence.

You may FIRST request more evidence before concluding. Available evidence keys: ${EVIDENCE_MENU.join(', ')}.
If you need more, respond with ONLY: {"need": ["<key>", ...]}.
Otherwise, attribute the PRIMARY root cause to exactly one engine STAGE from this set:
${VALID_STAGES.join(', ')}. Use the MAST/TRAIL agent-failure taxonomy for the failureMode label, and
propose one concrete fix. Respond with ONLY:
{"stage": "<one stage>", "rootCause": "<one or two sentences>", "failureMode": "<MAST/TRAIL label>",
 "fixSuggestion": "<one sentence>", "confidence": <0.0-1.0>}`;

/** Serve a bounded slice of additional evidence the RCA agent asked for. This
 *  is the "agentic" affordance: the agent pulls only what it needs. Everything
 *  here is already in-boundary; cross-service log/RPC fetches can extend this
 *  menu later. */
function gatherEvidence(run: ReconstructedRun, keys: EvidenceKey[]): string {
  const r = run.raw;
  const out: string[] = [];
  for (const key of keys) {
    switch (key) {
      case 'child_runs':
        out.push(`child_runs: ${JSON.stringify((r.childInvocations ?? []).map((c) => ({ id: c.id, outcome: c.outcome, failureClass: c.failureClass, err: c.errorMessage })))}`);
        break;
      case 'hrbp_events':
        out.push(`hrbp_events: ${JSON.stringify(r.hrbp?.events ?? [])}`);
        break;
      case 'audit_errors':
        out.push(`audit_errors: ${JSON.stringify((r.auditLogs ?? []).filter((a) => a.outcome !== 'success').map((a) => ({ action: a.action, outcome: a.outcome, code: a.errorCode })))}`);
        break;
      case 'tool_inputs':
        out.push(`tool_inputs: ${JSON.stringify((r.invocation?.toolCalls ?? []).map((t) => ({ name: t.name, input: t.input, error: t.error })).slice(0, 20))}`);
        break;
      case 'run_state':
        out.push(`run_state: ${JSON.stringify(r.runState ?? null).slice(0, 2000)}`);
        break;
    }
  }
  return out.join('\n') || '(no additional evidence available)';
}

/** Summarize raw evidence compactly so the RCA prompt stays small. */
function evidenceSummary(run: ReconstructedRun): string {
  const r = run.raw;
  const parts: string[] = [];
  if (r.invocation) parts.push(`invocation.outcome=${r.invocation.outcome} failure_class=${r.invocation.failureClass ?? 'n/a'} error=${r.invocation.errorMessage ?? 'none'} cost=${r.invocation.costUsd ?? 'n/a'}`);
  if (r.livePauses?.length) parts.push(`live_pauses=${r.livePauses.length} pauseReasons=[${r.livePauses.map((s) => s.pauseReason).join(',')}]`);
  if (r.runState) parts.push(`run_state schema=${r.runState.schemaVersion}`);
  if (r.childInvocations?.length) parts.push(`children=${r.childInvocations.length} unterminated=${r.childInvocations.filter((c) => c.outcome == null).length}`);
  if (r.hrbp) parts.push(`hrbp status=${r.hrbp.run.status} specs=${r.hrbp.run.specCount} createdAgents=${r.hrbp.events.filter((e) => e.internalAgentId).length} comps=${r.hrbp.compensations.length}`);
  if (r.loopMeta) parts.push(`loop iter=${r.loopMeta.iterations}/${r.loopMeta.maxIterations} terminator=${r.loopMeta.terminator ?? 'n/a'}`);
  if (r.auditLogs?.length) parts.push(`audit_rows=${r.auditLogs.length} errors=${r.auditLogs.filter((a) => a.outcome === 'error').length} gated=${r.auditLogs.filter((a) => a.outcome === 'gated').length}`);
  return parts.join('; ') || '(no raw evidence)';
}

export async function investigate(run: ReconstructedRun, findings: Finding[]): Promise<RcaResult> {
  const findingsText = findings.length
    ? findings.map((f) => `- [${f.severity}] ${f.invariant} @${f.component}: ${f.message}`).join('\n')
    : '(no deterministic findings — investigate the semantic failure)';

  let user = [
    `RUNTIME: ${run.runtime}  AGENT: ${run.ref.agentKind}`,
    `RUN:\n${serializeForJudge(run.trajectory)}`,
    `INVARIANT FINDINGS:\n${findingsText}`,
    `RAW EVIDENCE: ${evidenceSummary(run)}`,
  ].join('\n\n');

  // Up to 2 rounds: the agent may request more evidence once before concluding.
  for (let round = 0; round < 2; round++) {
    const o = await runStructuredJudge<Partial<RcaResult> & { need?: string[] }>({
      system: SYSTEM,
      user,
      tenantId: run.ref.tenantId,
      purpose: 'diagnostics_rca',
    });
    if (!o) {
      return { stage: 'unknown', rootCause: 'RCA unavailable', failureMode: 'unknown', fixSuggestion: '', confidence: 0, unavailable: true };
    }
    if (Array.isArray(o.need) && o.need.length > 0 && round === 0) {
      const keys = o.need.filter((k): k is EvidenceKey => (EVIDENCE_MENU as readonly string[]).includes(k));
      user += `\n\nADDITIONAL EVIDENCE:\n${gatherEvidence(run, keys)}\n\nNow give your final verdict JSON.`;
      continue;
    }
    const stage = (VALID_STAGES as string[]).includes(o.stage as string) ? (o.stage as Stage) : 'unknown';
    return {
      stage,
      rootCause: o.rootCause ?? '',
      failureMode: o.failureMode ?? 'unknown',
      fixSuggestion: o.fixSuggestion ?? '',
      confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
    };
  }
  return { stage: 'unknown', rootCause: 'RCA did not converge', failureMode: 'unknown', fixSuggestion: '', confidence: 0 };
}
