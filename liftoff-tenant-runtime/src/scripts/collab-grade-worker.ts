// Durable, in-tenant collab deliverable grader — runs as a tenant Cloud Run Job (no request
// timeout), so execution-heavy agentic grades (rubric generation + two sandbox-backed judges
// that ACTUALLY run the deliverable) complete past the 300s `/harvest` request cap that
// agent-service imposes.
//
// STATELESS worker (control-plane / worker split). The control orchestrator
// (`agent-diagnostics --collab-grade`) owns cross-tenant visibility: it lists the ungraded
// runs and fans out one execution of this job per run, passing the exact work items in a
// base64 per-execution env override (COLLAB_GRADE_WORKLIST_B64). This worker is TOLD its work
// — it never lists the shared `diagnostics/` namespace — so tenant isolation holds by
// construction (the tenant-runtime SA is walled to its own object prefix).
//
// For each item it drives the grade IN-PROCESS via `harvestOne` (reconstruct → evaluate →
// agentic judges → one-shot fallback). Because the job is tenant-local (DB pool +
// getToolGatewayDispatcher()'s HTTP client to tool-gateway-service + the sandbox are all
// reachable via SERVICE_TYPE=agent) and unbounded by a request timeout, the full sandbox
// verification runs to completion. The FK fix + fallback hardening (evaluate.ts) apply
// unchanged. Grades/rubrics are sunk to diagnostics/grades|rubrics/ (objectCreator).
//
// Robustness: incremental per-item sink (a completed grade persists even if a later item
// hangs to the task-timeout) + a per-grade wall-clock cap (rubric generation is unbounded and
// has been observed to hang; the cap keeps one poison-pill item from consuming the execution).

import { logger as log } from '../infrastructure/logging';
import { harvestOne, type PassiveTarget, type PassiveOptions, type PassiveRunResult } from '../diagnostics/driver/passive';
import { sinkRubrics, sinkGrades } from '../diagnostics/report/sink';

interface WorkItem { tenantId: string; agentId: string; sessionId: string }

/** Per-grade wall-clock ceiling (ms). Generous enough for a heavy grade (rubric + two sandbox
 *  judges each bounded at GRADER_TIMEOUT_MS ≈ 200s + provisioning); default 15m. */
const GRADE_TIMEOUT_MS = Math.max(60_000, Number(process.env.DIAGNOSTICS_GRADE_TIMEOUT_MS ?? '900000'));

/** Decode the base64-JSON worklist the control plane passed via the execution override. */
function parseWorklist(): WorkItem[] {
  const b64 = process.env.COLLAB_GRADE_WORKLIST_B64;
  if (!b64) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'collab-grade-worker: COLLAB_GRADE_WORKLIST_B64 is not valid base64-JSON');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((w): w is WorkItem =>
    !!w && typeof (w as WorkItem).tenantId === 'string' && typeof (w as WorkItem).agentId === 'string' && typeof (w as WorkItem).sessionId === 'string');
}

/** Race harvestOne against GRADE_TIMEOUT_MS. Returns the harvest result, or `null` on timeout.
 *  harvestOne has no cancellation seam, so on timeout the underlying work is abandoned and
 *  reaped by process.exit at the end; the worker moves on to the next item. */
async function gradeBounded(target: PassiveTarget, sessionId: string, opts: PassiveOptions): Promise<PassiveRunResult | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), GRADE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([harvestOne(target, sessionId, opts), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // 'agentic' = sandbox-backed judge; anything else (incl. unset) = one-shot. This is the
  // whole reason the job exists, so DIAGNOSTICS_GRADER_MODE=agentic is expected.
  const graderMode = process.env.DIAGNOSTICS_GRADER_MODE === 'agentic' ? 'agentic' : 'oneshot';

  const work = parseWorklist();
  if (!work.length) {
    log.info({ message: 'collab-grade-worker: empty worklist (COLLAB_GRADE_WORKLIST_B64)' });
    return;
  }

  let graded = 0;
  let failed = 0;
  for (const w of work) {
    const target: PassiveTarget = { agentKind: 'user-created', tenantId: w.tenantId, agentId: w.agentId };
    const opts: PassiveOptions = {
      limit: 1,
      runJudges: false,
      runRca: false,
      runGrader: true,
      graderJudges: process.env.DIAGNOSTICS_GRADER_JUDGES,
      rubricModel: process.env.DIAGNOSTICS_RUBRIC_MODEL,
      graderMode,
    };
    // harvestOne reconstructs the run (needs the correct agentId), reads its artifact manifest
    // (own-tenant prefix — covered by the conditional objectViewer), and evaluates in-process.
    // It never throws — a reconstruct/evaluate failure is `{ ref, error }`; a hang is `null`.
    const out = await gradeBounded(target, w.sessionId, opts);
    const evaluated = out?.evaluated;
    if (!evaluated?.grade) {
      failed += 1;
      log.warn({ message: 'collab-grade-worker: run did not grade', sessionId: w.sessionId, agentId: w.agentId, error: out?.error ?? `timeout > ${GRADE_TIMEOUT_MS}ms` });
      continue;
    }
    // Sink INCREMENTALLY (per item) so completed grades persist even if a later item hangs to
    // the task-timeout. sinkGrades/sinkRubrics key one GCS object per session_id (via _batch
    // grouping), so a single-element array is exactly one object.
    try {
      if (evaluated.rubric) await sinkRubrics([evaluated.rubric as unknown as Record<string, unknown>]);
      await sinkGrades([evaluated.grade as unknown as Record<string, unknown>]);
      graded += 1;
    } catch (err) {
      failed += 1;
      log.warn({ message: 'collab-grade-worker: sink failed', sessionId: w.sessionId, err: (err as Error).message });
    }
  }

  log.info({ message: 'collab-grade-worker complete', requested: work.length, graded, failed });
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err: (err as Error).message }, 'collab-grade-worker: fatal');
      process.exit(1);
    });
}
