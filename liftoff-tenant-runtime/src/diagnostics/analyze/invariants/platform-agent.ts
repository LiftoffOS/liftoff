// SIMPLE runPlatformAgent invariants — CAIO / HRBP / Insights.
//
// The workforce-service + platform-backend loops are far simpler than the
// hybrid loop: a bounded tool loop (≤10 iterations, token budget) with a
// terminator. The invariants here mirror that shape:
//   - loop stayed within max-iterations / token budget
//   - every tool_use has a tool_result
//   - no silent failure (HRBP terminator='normal' but a create step recorded
//     no internal_agent_id → real bug)
//   - blocked / compensation paths consistent
//   - HRBP per-spec idempotency (Cloud Tasks dedupe via idempotency_key)
//   - Insights ≤10-iter + ≤100K-token budget honored

import type { Finding, ReconstructedRun } from '../../reconstruct/trace-model';
import { collectToolUses, collectToolResults } from '../trajectory-util';

export function auditPlatformAgent(run: ReconstructedRun): Finding[] {
  const kind = run.ref.agentKind;
  if (kind !== 'caio' && kind !== 'hrbp' && kind !== 'insights') return [];
  const findings: Finding[] = [];

  // --- shared: tool_use ↔ tool_result integrity ---
  const uses = collectToolUses(run.trajectory);
  const results = collectToolResults(run.trajectory);
  for (const u of uses) {
    if (!results.has(u.id)) {
      findings.push({
        invariant: 'platform.toolcall_result_integrity',
        severity: 'error',
        component: 'tool-execution',
        message: `tool_use ${u.name} (${u.id}) has no matching tool_result`,
        evidence: { toolUseId: u.id, name: u.name },
        failureMode: 'TRAIL.tool_result_missing',
      });
    }
  }

  // --- shared: loop budget ---
  const loop = run.raw.loopMeta;
  if (loop) {
    if (loop.iterations > loop.maxIterations) {
      findings.push({
        invariant: 'platform.max_iterations_exceeded',
        severity: 'error',
        component: 'termination',
        message: `loop ran ${loop.iterations} iterations, exceeding the ${loop.maxIterations} cap`,
        evidence: { iterations: loop.iterations, maxIterations: loop.maxIterations },
        failureMode: 'MAST.no_termination',
      });
    }
    if (loop.maxCumulativeTokens != null) {
      const total = loop.cumulativeInputTokens + loop.cumulativeOutputTokens;
      if (total > loop.maxCumulativeTokens) {
        findings.push({
          invariant: 'platform.token_budget_exceeded',
          severity: 'error',
          component: 'termination',
          message: `cumulative tokens ${total} exceeded budget ${loop.maxCumulativeTokens}`,
          evidence: { total, budget: loop.maxCumulativeTokens },
          failureMode: 'MAST.budget_overrun',
        });
      }
    }
  }

  if (kind === 'hrbp') findings.push(...auditHrbp(run));
  return findings;
}

/** HRBP-specific: silent-failure, compensation consistency, per-spec
 *  idempotency, terminal-state correctness. */
function auditHrbp(run: ReconstructedRun): Finding[] {
  const findings: Finding[] = [];
  const hrbp = run.raw.hrbp;
  if (!hrbp) return findings;

  const terminator = run.raw.loopMeta?.terminator;

  // Silent failure: a successful `create` step that recorded no
  // internal_agent_id means the agent claimed success but nothing was created.
  for (const ev of hrbp.events) {
    const isCreate = ev.step.includes('create');
    if (isCreate && ev.status === 'success' && !ev.internalAgentId) {
      findings.push({
        invariant: 'hrbp.silent_failure_no_created_agent',
        severity: 'critical',
        component: 'output',
        message: `HRBP create step for spec ${ev.specId} reported success but recorded no internal_agent_id — silent failure`,
        evidence: { specId: ev.specId, step: ev.step, runStatus: hrbp.run.status, terminator },
        failureMode: 'MAST.silent_failure',
      });
    }
  }

  // Run-level silent failure: terminator normal + run completed but zero
  // internal agents created across all specs.
  const anyCreated = hrbp.events.some((e) => e.internalAgentId);
  if (terminator === 'normal' && hrbp.run.status === 'completed' && hrbp.run.specCount > 0 && !anyCreated) {
    findings.push({
      invariant: 'hrbp.silent_failure_run',
      severity: 'critical',
      component: 'output',
      message: `HRBP run completed normally with ${hrbp.run.specCount} spec(s) but created no internal agents`,
      evidence: { specCount: hrbp.run.specCount, status: hrbp.run.status },
      failureMode: 'MAST.silent_failure',
    });
  }

  // Compensation consistency: a failed compensation leaves an inconsistent
  // partial provisioning state.
  for (const c of hrbp.compensations) {
    if (c.status !== 'success') {
      findings.push({
        invariant: 'hrbp.compensation_inconsistent',
        severity: 'error',
        component: 'tool-execution',
        message: `compensation ${c.action} for spec ${c.specId} did not succeed (${c.status}) — inconsistent rollback`,
        evidence: { specId: c.specId, action: c.action, status: c.status, error: c.errorMessage },
        failureMode: 'MAST.partial_rollback',
      });
    }
  }

  // Per-spec idempotency (Cloud Tasks dedupe): the same (spec, step,
  // idempotency_key) appearing as two successful create events is a double
  // delivery that wasn't deduped.
  const seen = new Map<string, number>();
  for (const ev of hrbp.events) {
    if (ev.status !== 'success' || !ev.step.includes('create')) continue;
    const key = `${ev.specId}::${ev.step}::${ev.idempotencyKey ?? 'none'}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      findings.push({
        invariant: 'hrbp.idempotency_double_delivery',
        severity: 'error',
        component: 'tool-execution',
        message: `HRBP create step delivered ${count}× for the same spec/idempotency key — Cloud Tasks dedupe failed`,
        evidence: { key, count },
        failureMode: 'MAST.idempotency_double_exec',
      });
    }
  }

  return findings;
}
