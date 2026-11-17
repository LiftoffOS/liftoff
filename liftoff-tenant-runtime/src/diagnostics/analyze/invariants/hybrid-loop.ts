// RICH engine invariants for the tenant-runtime hybrid loop —
// USER-CREATED AGENTS ONLY (runAgentHybridLoop, service.ts).
//
// These are the deterministic gating backbone for the most complex runtime:
// tool_call↔tool_result integrity; run-state ↔ live-pause coherence; HITL
// pause/resume safety; delegation/child-task lifecycle; idempotency;
// stuck/looping/recovery-cap. Each violation → Finding{invariant, severity,
// component, evidence}. No LLM — purely structural over the canonical
// trajectory + raw engine evidence.

import type { Finding, ReconstructedRun } from '../../reconstruct/trace-model';
import { collectToolUses, collectToolResults, toolCallSignature } from '../trajectory-util';

/** Exact-repeat loop threshold: the same (tool,input) signature this many times
 *  is a loop, not legitimate retry. */
const LOOP_REPEAT_THRESHOLD = 3;
/** Recovery cap: total tool calls beyond this on a single run is "runaway". */
const RUNAWAY_TOOL_CALL_CAP = 50;

export function auditHybridLoop(run: ReconstructedRun): Finding[] {
  if (run.ref.agentKind !== 'user-created') return [];
  const findings: Finding[] = [];
  const uses = collectToolUses(run.trajectory);
  const results = collectToolResults(run.trajectory);

  // 1. tool_call ↔ tool_result integrity.
  for (const u of uses) {
    if (!results.has(u.id)) {
      findings.push({
        invariant: 'hybrid.toolcall_result_integrity',
        severity: 'error',
        component: 'tool-execution',
        message: `tool_use ${u.name} (${u.id}) has no matching tool_result`,
        evidence: { toolUseId: u.id, name: u.name, order: u.order },
        failureMode: 'TRAIL.tool_result_missing',
      });
    }
  }
  const useIds = new Set(uses.map((u) => u.id));
  for (const [resultId] of results) {
    if (!useIds.has(resultId)) {
      findings.push({
        invariant: 'hybrid.orphan_tool_result',
        severity: 'error',
        component: 'tool-execution',
        message: `tool_result references unknown tool_use_id ${resultId}`,
        evidence: { toolUseId: resultId },
        failureMode: 'TRAIL.orphan_tool_result',
      });
    }
  }

  // 2. run-state ↔ pause coherence. A persisted pause (a scheduled resume row
  //    carrying a HybridResumeState) MUST have a typed run-state document to
  //    resume against.
  const pauses = run.raw.livePauses ?? [];
  if (pauses.length > 0 && !run.raw.runState) {
    findings.push({
      invariant: 'hybrid.runstate_session_coherence',
      severity: 'critical',
      component: 'session-persistence',
      message: `${pauses.length} live pause row(s) exist but no agent_run_states document — resume would lose typed state`,
      evidence: { sessionCount: pauses.length, invocationId: run.ref.key },
      failureMode: 'MAST.state_loss',
    });
  }

  // 3. HITL pause/resume safety — stuck-pending: a HITL pause that is past its
  //    fire deadline yet still `pending` (the 24h expiry never finalized it)
  //    while the invocation has no terminal outcome. This is the structural
  //    signature of the stuck-in-WAITING_FOR_HUMAN pile-up; a pause that is
  //    legitimately still waiting (not past deadline, or already fired) is NOT
  //    flagged.
  const inv = run.raw.invocation;
  const now = Date.now();
  for (const p of pauses) {
    const pastDeadline = new Date(p.expiresAt).getTime() < now;
    const isHitl = /hitl|approval/i.test(p.pauseReason);
    if (isHitl && pastDeadline && p.status === 'pending' && inv && inv.outcome == null) {
      findings.push({
        invariant: 'hybrid.hitl_stuck_pending',
        severity: 'error',
        component: 'resume',
        message: `HITL pause (${p.pauseReason}) past its fire deadline but still pending with no terminal outcome — expiry never finalized; agent stuck pending`,
        evidence: { pauseReason: p.pauseReason, approvalId: p.approvalId, status: p.status, expiresAt: p.expiresAt },
        failureMode: 'MAST.stuck_pending',
      });
    }
  }

  // 3c. Timer/delay resume safety — a paused-on-timer/delay row past its fire
  //     deadline but still `pending` with no terminal outcome means the
  //     scheduled Cloud Tasks re-entry never fired or failed silently.
  for (const p of pauses) {
    const isTimer = /timer|delay|schedule|sleep|followup/i.test(p.pauseReason);
    const pastDeadline = new Date(p.expiresAt).getTime() < now;
    if (isTimer && pastDeadline && p.status === 'pending' && inv && inv.outcome == null) {
      findings.push({
        invariant: 'hybrid.timer_resume_lost',
        severity: 'error',
        component: 'resume',
        message: `timer/delay pause (${p.pauseReason}) past its fire deadline but still pending with no terminal outcome — scheduled resume lost`,
        evidence: { pauseReason: p.pauseReason, status: p.status, expiresAt: p.expiresAt, invocationId: run.ref.key },
        failureMode: 'MAST.timer_resume_lost',
      });
    }
  }

  // 3b. HITL double-exec: a gated audit row for an action followed by a success
  //     row for the SAME action with identical args (executed despite the gate
  //     without an approval in between) — a bypassHitlCheck-style leak.
  const audit = run.raw.auditLogs ?? [];
  const gatedThenSuccess = detectGatedThenSuccess(audit);
  for (const a of gatedThenSuccess) {
    findings.push({
      invariant: 'hybrid.hitl_double_exec',
      severity: 'critical',
      component: 'oversight-gate',
      message: `action ${a.action} was gated then executed successfully with identical args without an intervening approval — possible HITL bypass`,
      evidence: { action: a.action },
      failureMode: 'MAST.oversight_bypass',
    });
  }

  // 4. Delegation / child-task lifecycle.
  const children = run.raw.childInvocations ?? [];
  if (inv && inv.outcome === 'success') {
    for (const c of children) {
      if (c.outcome == null) {
        findings.push({
          invariant: 'hybrid.delegation_orphan',
          severity: 'error',
          component: 'delegation',
          message: `parent invocation succeeded but child ${c.id} has no terminal outcome — orphaned delegation`,
          evidence: { parentId: run.ref.key, childId: c.id },
          failureMode: 'MAST.delegation_orphan',
        });
      }
    }
  }
  // Double-spawn: two children with identical (agent, started_at-bucket) is a
  // duplicate fan-out. Approximated by identical trigger_ref where present.
  const seenChildKey = new Map<string, string>();
  for (const c of children) {
    const key = `${c.agentId}`;
    // Only flag when more than one child targets the same agent within the run
    // AND both are still active (a legitimate re-delegation completes the first).
    const prev = seenChildKey.get(key);
    if (prev && c.outcome == null) {
      findings.push({
        invariant: 'hybrid.delegation_double_spawn',
        severity: 'warn',
        component: 'delegation',
        message: `multiple concurrent child invocations target agent ${c.agentId} — possible double-spawn`,
        evidence: { firstChild: prev, secondChild: c.id, agentId: c.agentId },
        failureMode: 'MAST.double_spawn',
      });
    }
    seenChildKey.set(key, c.id);
  }

  // 5 & 6. Idempotency double-execution + stuck/looping detection. BOTH key off
  //    the (tool,input) signature, so they are only sound when the tool INPUTS
  //    were reliably captured. Raw-table reconstructions of pre-fix runs persist
  //    empty `{}` inputs (the lossy `invocations.tool_calls` path dropped args
  //    for SDK-executed tools), which collapses the signature to name-only and
  //    makes every same-name call look identical — a false MAST-1.3 loop on any
  //    high-frequency tool. Skip both when inputs are flagged unreliable; emit a
  //    single non-gating info note so the gap is visible, not silently dropped.
  const inputsReliable = run.trajectory.trajectory_meta.inputs_reliable !== false;
  if (!inputsReliable) {
    findings.push({
      invariant: 'hybrid.loop_detection_skipped_unreliable_inputs',
      severity: 'info',
      component: 'tool-execution',
      message:
        'loop / idempotency detection skipped — tool-call inputs were not reliably ' +
        'captured for this run (raw-table reconstruction), so identical-signature ' +
        'detection would false-positive',
      evidence: { toolUseCount: uses.length },
      failureMode: 'TRAIL.repetitive_actions',
    });
  } else {
    // 5. Idempotency double-execution — the same (tool,input) signature produced
    //    two NON-error results (a retry that re-ran a side-effecting tool).
    const sigSuccessCount = new Map<string, number>();
    for (const u of uses) {
      const r = results.get(u.id);
      if (r && !r.isError) {
        const sig = toolCallSignature(u.name, u.input);
        sigSuccessCount.set(sig, (sigSuccessCount.get(sig) ?? 0) + 1);
      }
    }
    for (const [sig, count] of sigSuccessCount) {
      if (count > 1) {
        findings.push({
          invariant: 'hybrid.idempotency_double_exec',
          severity: 'error',
          component: 'tool-execution',
          message: `identical tool call executed successfully ${count} times — idempotency violation`,
          evidence: { signature: sig, count },
          failureMode: 'MAST.idempotency_double_exec',
        });
      }
    }

    // 6. Stuck / looping / recovery-cap.
    const sigAll = new Map<string, number>();
    for (const u of uses) {
      const sig = toolCallSignature(u.name, u.input);
      sigAll.set(sig, (sigAll.get(sig) ?? 0) + 1);
    }
    for (const [sig, count] of sigAll) {
      if (count >= LOOP_REPEAT_THRESHOLD) {
        findings.push({
          invariant: 'hybrid.loop_detected',
          severity: 'error',
          component: 'planning',
          message: `tool call repeated ${count}× with identical args — loop`,
          evidence: { signature: sig, count, threshold: LOOP_REPEAT_THRESHOLD },
          failureMode: 'TRAIL.repetitive_actions',
        });
      }
    }
  }
  if (uses.length > RUNAWAY_TOOL_CALL_CAP) {
    findings.push({
      invariant: 'hybrid.runaway_recovery_cap',
      severity: 'warn',
      component: 'planning',
      message: `${uses.length} tool calls in one run exceeds recovery cap ${RUNAWAY_TOOL_CALL_CAP}`,
      evidence: { toolCallCount: uses.length, cap: RUNAWAY_TOOL_CALL_CAP },
      failureMode: 'TRAIL.runaway',
    });
  }

  return findings;
}

/** Find actions that were `gated` then later `success` with identical input
 *  args, with no `gated`→approval marker between them. Conservative: only flags
 *  exact action+args repeats. */
function detectGatedThenSuccess(
  audit: Array<{ action: string; outcome: string; inputArgs: unknown }>,
): Array<{ action: string }> {
  const out: Array<{ action: string }> = [];
  const gatedArgs = new Map<string, string>();
  for (const row of audit) {
    let argKey: string;
    try {
      argKey = JSON.stringify(row.inputArgs ?? {});
    } catch {
      argKey = '<x>';
    }
    const key = `${row.action}::${argKey}`;
    if (row.outcome === 'gated') gatedArgs.set(key, row.action);
    else if (row.outcome === 'success' && gatedArgs.has(key)) {
      out.push({ action: row.action });
      gatedArgs.delete(key);
    }
  }
  return out;
}
