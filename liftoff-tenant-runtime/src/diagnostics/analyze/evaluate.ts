// Evaluation orchestrator — runs the full analysis pipeline over ONE
// reconstructed run and returns a unified EvaluatedRun. Shared by both drivers
// (passive harvest + active synthetic) so they score runs identically.
//
// Pipeline (per the four first-class dimensions):
//   1. DETERMINISTIC invariants — per-runtime engine auditor (hybrid-loop for
//      user-created; platform-agent for CAIO/HRBP/Insights) + tool-conformance.
//      These produce the GATING signal.
//   2. DETERMINISTIC metrics — ToolCorrectness / StepEfficiency / loop / cost /
//      latency + per-step attribution, plus arg-validity vs each tool's input_schema.
//   3. SEMANTIC judges (advisory) — goal-success + spec-conformance +
//      argument-appropriateness on Vertex.
//   4. Agentic RCA (advisory) — only when there is a gating failure.

import type { Finding, ReconstructedRun } from '../reconstruct/trace-model';
import { isGatingFailure } from '../reconstruct/trace-model';
import { logger } from '../../infrastructure/logging';
import { auditHybridLoop } from './invariants/hybrid-loop';
import { auditPlatformAgent } from './invariants/platform-agent';
import { auditToolConformance, type ConformanceContext } from './invariants/tool-conformance';
import { capturedToolset } from '../toolset';
import { computeMetrics, type TrajectoryMetrics } from './metrics';
import { scoreArgValidity, argValidityFindings, type ArgValidityResult } from './critics/schema-validity';
import { judgeGoalSuccess } from './judge/goal';
import { judgeSpecConformance } from './judge/conformance';
import { judgeArgumentAppropriateness } from './judge/arguments';
import { investigate, type RcaResult } from './rca-agent';
import type { JudgeResult } from './judge/llm-judge';

export interface EvaluateOptions extends ConformanceContext {
  /** Run the advisory Vertex judges. Off for the deterministic-only canary
   *  gate; on for passive eval + on-demand. */
  runJudges: boolean;
  /** Run agentic RCA on gating failures. */
  runRca: boolean;
  /** Run the deliverable grader (user-created agents only). */
  runGrader?: boolean;
  /** Comma-separated provider:tier judge specs for the grader. */
  graderJudges?: string;
  /** provider:tier for rubric generation. */
  rubricModel?: string;
  /** Grader judging mode: 'agentic' runs each judge as a sandbox-backed agent;
   *  anything else (default) is the one-shot text judge. Agentic falls back to
   *  one-shot on error/pause/timeout. */
  graderMode?: 'oneshot' | 'agentic';
  /** gs:// URIs of admitted deliverable artifacts (from the session manifest). */
  artifactUris?: string[];
}

export interface EvaluatedRun {
  ref: ReconstructedRun['ref'];
  runtime: ReconstructedRun['runtime'];
  findings: Finding[];
  metrics: TrajectoryMetrics;
  /** True iff any deterministic finding is error/critical — the gate. */
  gating: boolean;
  goal?: JudgeResult;
  conformanceJudge?: JudgeResult;
  /** Deterministic per-argument validity vs each tool's captured input_schema. */
  argValidity?: ArgValidityResult;
  /** Advisory LLM judgment of whether the argument VALUES fit the request. */
  argJudge?: JudgeResult;
  rca?: RcaResult;
  /** Deliverable grader output (present only when runGrader + a rubric was made). */
  grade?: import('./grader/score').GradeResult;
  rubric?: import('./grader/rubric').StoredRubric;
}

export async function evaluateRun(run: ReconstructedRun, opts: EvaluateOptions): Promise<EvaluatedRun> {
  // Resolve the user-created designed catalog. PREFER the runtime-captured
  // toolset on the trajectory itself (the ground truth — see loadDesignedToolset);
  // only fall back to the heavy tool-gateway reconstruction when the trajectory
  // captured no toolset (raw-table / synthetic runs). Skipping it when the
  // trajectory self-describes avoids both a lossy re-derivation AND the
  // createToolGatewayMcpServer graph build.
  let reconstructedCatalog = opts.reconstructedCatalog;
  if (run.ref.agentKind === 'user-created' && !reconstructedCatalog && capturedToolset(run).size === 0) {
    // Lazy-load: the catalog reconstruction pulls the heavy tool-gateway graph.
    const { reconstructUserDesignedCatalog } = await import('../reconstruct/user-catalog');
    reconstructedCatalog = (await reconstructUserDesignedCatalog(run.ref)) ?? undefined;
  }
  const conformanceCtx = { ...opts, reconstructedCatalog };

  // 1. Deterministic invariants — per-runtime auditor + tool-conformance.
  const findings: Finding[] = [];
  if (run.ref.agentKind === 'user-created') findings.push(...auditHybridLoop(run));
  else findings.push(...auditPlatformAgent(run));
  findings.push(...auditToolConformance(run, conformanceCtx));

  // 2. Deterministic metrics.
  const metrics = computeMetrics(run, reconstructedCatalog);

  // 2b. Deterministic argument validity vs each tool's input_schema. Emits only
  //     advisory warn/info findings (never error/critical), so it never gates —
  //     same posture as the trajectory metrics.
  const argValidity = scoreArgValidity(run);
  findings.push(...argValidityFindings(argValidity));

  const gating = isGatingFailure(findings);
  const result: EvaluatedRun = { ref: run.ref, runtime: run.runtime, findings, metrics, gating, argValidity };

  // 3. Semantic judges (advisory).
  if (opts.runJudges) {
    const [goal, conformanceJudge, argJudge] = await Promise.all([
      judgeGoalSuccess(run),
      judgeSpecConformance(run),
      judgeArgumentAppropriateness(run),
    ]);
    result.goal = goal;
    result.conformanceJudge = conformanceJudge;
    result.argJudge = argJudge;
  }

  // 4. Deliverable grader (advisory; user-created agents only). The grader is
  // advisory — a rubric/serialize/adapter/sandbox failure must NEVER throw out of
  // evaluateRun (harvestOne would swallow it into `{ref, error}` and the session
  // would be silently dropped as "did not grade"). The whole block is wrapped, and
  // every no-grade branch logs its reason so a silent drop is impossible.
  if (opts.runGrader && run.ref.agentKind === 'user-created') {
    try {
      const { generateRubric } = await import('./grader/rubric');
      const { scoreAgainstRubric, parseJudgeSpec } = await import('./grader/score');
      const artifactUris = opts.artifactUris ?? [];
      const rubric = await generateRubric(run, artifactUris, opts.rubricModel);
      if (!rubric) {
        logger.warn({ session: run.ref.key }, 'grader: rubric generation returned null — no grade for this run');
      } else {
        result.rubric = rubric;
        const judges = parseJudgeSpec(opts.graderJudges);
        let grade = null;
        // Agentic mode: run each judge as a sandbox-backed agent; fall back to the
        // one-shot text judge on null OR any thrown error.
        if (opts.graderMode === 'agentic') {
          try {
            const { scoreAgainstRubricAgentic } = await import('./grader/agentic-judge');
            grade = await scoreAgainstRubricAgentic(run, artifactUris, rubric, judges);
            if (!grade) logger.warn({ session: run.ref.key }, 'agentic grader returned null — falling back to one-shot');
          } catch (err) {
            logger.warn({ session: run.ref.key, err: (err as Error).message }, 'agentic grader threw — falling back to one-shot');
            grade = null;
          }
        }
        if (!grade) {
          // One-shot fallback must also be resilient — a throw here previously
          // escaped to harvestOne and silently dropped the session.
          try {
            grade = await scoreAgainstRubric(run, artifactUris, rubric, judges);
            if (!grade) logger.warn({ session: run.ref.key }, 'one-shot grader returned null — no grade for this run');
          } catch (err) {
            logger.warn({ session: run.ref.key, err: (err as Error).message }, 'one-shot grader threw — no grade for this run');
            grade = null;
          }
        }
        if (grade) result.grade = grade;
      }
    } catch (err) {
      logger.warn({ session: run.ref.key, err: (err as Error).message }, 'grader block failed unexpectedly — skipping grade for this run');
    }
  }

  // 5. Agentic RCA on any gating failure (advisory).
  if (opts.runRca && (gating || (result.goal && !result.goal.pass))) {
    result.rca = await investigate(run, findings);
  }

  return result;
}
