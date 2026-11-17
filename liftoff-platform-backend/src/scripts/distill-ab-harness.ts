// distill-ab-harness — the single-vs-waved comparison, run on dev.
//
// Replays one corpus through both production strategies and reports the metrics
// the split plan's acceptance gates are written against
// (liftoff-react docs/distill-split-plan.md, sections 7 and 8).
//
// BOTH ARMS FROM ONE PROCESS, deliberately. The plan is explicit that a
// comparison whose arms come from different deploys measures the deploys as
// much as the change, and the differences here are tens of seconds. So the arm
// is a per-call parameter and the corpus is fixed: for each input, both arms run
// back to back against the same build, the same catalog and the same tenant.
//
// SPENDS REAL MONEY. Every input is two full distillations, roughly $0.27 each
// at the measured token profile, so a 60-input corpus is about $32 before
// re-runs. It refuses to run outside dev for that reason as much as for safety.
//
// Quality is where this passes or fails, not latency — the latency answer was
// never in doubt, only its size. Four checks, all from the plan: the graph
// emit/omit verdict must agree across arms, skills must not restate steps (the
// regression the v5 and v7 prompt rewrites were both about), instructionsMd must
// not repeat identity text it is told to assume, and a BLINDED PAIRWISE JUDGE
// reads both artifacts for the same input without being told which arm produced
// which.
//
// The judge is blinded by shuffling which artifact is presented as A, and the
// shuffle is recorded so the verdict can be un-blinded afterwards. Unblinded
// judging is close to worthless here: told which one is the new approach, a
// model will find reasons for it.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { distillInternalAgentWithProgress, type DistillInput, type DistillOutput } from '../internal-agents/distill-service';
import { computeRowCost } from '../llm/pricing';
import { initDatabase, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { judgePair, type JudgeVerdict } from '../internal-agents/distill-comparison-judge';
import {
  graphDecisionAgrees,
  contradictoryThresholdRate,
  identityLeakageRate,
  skillsRestateStepsRate,
  triggerTypeAgrees,
} from '../internal-agents/distill-comparison-metrics';

/** One corpus entry: the distill input plus the stratum it was chosen for. */
interface CorpusEntry {
  id: string;
  /** Which row of the plan's stratification table this covers. */
  stratum: string;
  input: Omit<DistillInput, 'tenantId' | 'strategy'>;
}

interface ArmOutcome {
  strategy: 'single' | 'waved';
  ok: boolean;
  error?: string;
  /** Wall clock for the whole distillation, client-side. Per-branch timing is
   *  in distill_runs; this is the number a person would have waited. */
  totalMs: number;
  /** Time to the summary. Equal to totalMs for the single arm, which is the
   *  entire point of the comparison. */
  timeToSummaryMs: number;
  output?: DistillOutput;
}

interface EntryResult {
  entry: CorpusEntry;
  single: ArmOutcome;
  waved: ArmOutcome;
}

/** Per-branch latency, retry and cost aggregates, read from distill_runs. */
interface BranchAggregate {
  strategy: string;
  branch: string;
  calls: number;
  p50Ms: number | null;
  p90Ms: number | null;
  firstAttemptOkRate: number | null;
  costUsd: number;
}

/**
 * Aggregate the telemetry the run just wrote.
 *
 * Read back from distill_runs rather than accumulated in this process on
 * purpose: the acceptance gates are read from that table, and a second set of
 * numbers computed a different way is a second set of numbers to disagree with.
 */
async function aggregateRuns(since: Date, tenantId: string): Promise<BranchAggregate[]> {
  const { rows } = await withAdminScope(
    { caller: 'distill-ab-harness', reason: 'cross-tenant read of distill_runs to aggregate the A/B window' },
    (client) => client.query<{
      strategy: string;
      branch: string;
      calls: string;
      p50: string | null;
      p90: string | null;
      first_ok: string;
      first_total: string;
      provider: string | null;
      model: string | null;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read: string | null;
      cache_write: string | null;
    }>(
      `SELECT strategy, branch,
              count(*)                                                      AS calls,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)      AS p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms)      AS p90,
              sum(CASE WHEN attempt = 1 AND outcome = 'ok' THEN 1 ELSE 0 END) AS first_ok,
              sum(CASE WHEN attempt = 1 THEN 1 ELSE 0 END)                  AS first_total,
              min(provider)                                                 AS provider,
              min(model)                                                    AS model,
              sum(input_tokens)                                             AS input_tokens,
              sum(output_tokens)                                            AS output_tokens,
              sum(cache_read_tokens)                                        AS cache_read,
              sum(cache_creation_tokens)                                    AS cache_write
         FROM distill_runs
        WHERE started_at >= $1 AND tenant_id = $2
        GROUP BY strategy, branch
        ORDER BY strategy, branch`,
      [since, tenantId],
    ),
  );

  return rows.map((r) => ({
    strategy: r.strategy,
    branch: r.branch,
    calls: Number(r.calls),
    p50Ms: r.p50 === null ? null : Math.round(Number(r.p50)),
    p90Ms: r.p90 === null ? null : Math.round(Number(r.p90)),
    firstAttemptOkRate: Number(r.first_total) > 0 ? Number(r.first_ok) / Number(r.first_total) : null,
    costUsd: computeRowCost(
      r.provider ?? 'anthropic',
      r.model ?? 'claude-opus-5',
      Number(r.input_tokens ?? 0),
      Number(r.output_tokens ?? 0),
      Number(r.cache_write ?? 0),
      Number(r.cache_read ?? 0),
      new Date(),
    ),
  }));
}

/**
 * Is this graph a workflow, or a description of thinking?
 *
 * Steps that are all `llm_reason` with no `tool_call` and no branching dispatch
 * nothing deterministic — the runtime gains sequencing machinery and the agent
 * gains nothing. Measured for BOTH arms: the proven pipeline produces these
 * too, and calling that out is the point.
 */
function degenerateGraph(o: DistillOutput | undefined): boolean | null {
  const steps = o?.workflowSteps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const hasToolCall = steps.some((s) => (s as { type?: string }).type === 'tool_call');
  const hasBranching = steps.some((s) => {
    const step = s as { condition?: unknown; onSuccess?: unknown; onFailure?: unknown };
    return step.condition !== undefined || step.onSuccess !== undefined || step.onFailure !== undefined;
  });
  return !hasToolCall && !hasBranching;
}

async function runArm(
  entry: CorpusEntry,
  tenantId: string,
  strategy: 'single' | 'waved',
): Promise<ArmOutcome> {
  const startedAt = Date.now();
  let summaryAt: number | null = null;
  try {
    const output = await distillInternalAgentWithProgress(
      { ...entry.input, tenantId, strategy },
      undefined,
      (branch) => {
        if (branch === 'summary' && summaryAt === null) summaryAt = Date.now();
      },
    );
    const endedAt = Date.now();
    return {
      strategy,
      ok: true,
      totalMs: endedAt - startedAt,
      // The single arm never reports a summary early, so its time-to-summary IS
      // its total. Recording it that way rather than as null keeps the two arms
      // comparable on the metric that matters most.
      timeToSummaryMs: (summaryAt ?? endedAt) - startedAt,
      output,
    };
  } catch (error) {
    return {
      strategy,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      totalMs: Date.now() - startedAt,
      timeToSummaryMs: Date.now() - startedAt,
    };
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export async function runDistillAbHarness(corpusPath: string, tenantId: string): Promise<EntryResult[]> {
  // The pool is opened by the service at startup; a standalone script has to do
  // it itself. Without this every query fails with "Database not initialized"
  // and the run reports two failed arms in milliseconds, which looks like a
  // result rather than a missing connection.
  await initDatabase();
  const environment = process.env.ENVIRONMENT ?? 'dev';
  if (environment === 'prod') {
    throw new Error('distill-ab-harness refuses to run in prod: it issues real distillations against real tenants');
  }

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusEntry[];

  // SINGLE-ARM MODE. Runs only the control and lets shadow mode produce the
  // challenger behind it.
  //
  // Necessary whenever the shadow flag is on, because otherwise this script
  // triples the work rather than doubling it: its own single arm ALSO spawns a
  // shadow, so each entry becomes single + shadow + explicit waved. Running one
  // arm here costs two distillations per entry instead of three, and — the part
  // that matters more — the comparison lands in distill_shadow_comparisons,
  // which is the same table real production traffic will fill.
  const singleArmOnly = process.argv.includes('--single-arm');

  // Where the ARTIFACTS go.
  //
  // Without this a run leaves nothing but aggregates, and aggregates do not
  // measure quality — they measure divergence and proxies. "67% graph
  // agreement" cannot tell you whether an artifact is any good, and a judge
  // verdict is one bit with no record of what it read. Quality is a property of
  // an individual output, so the outputs have to survive the run or nobody can
  // assess it afterwards.
  //
  // The shadow path already keeps both artifacts for this reason. The harness
  // discarding them was an inconsistency, not a decision.
  const outIndex = process.argv.indexOf('--out-dir');
  const outDir = outIndex > -1 ? process.argv[outIndex + 1] : null;
  if (outDir) mkdirSync(outDir, { recursive: true });
  log.info({ entries: corpus.length, tenantId, environment, singleArmOnly }, 'distill A/B harness starting');

  // The window the telemetry aggregation reads back. Taken before the first
  // call so nothing this run writes falls outside it.
  const startedAt = new Date();
  const results: EntryResult[] = [];
  for (const entry of corpus) {
    // Sequential, not concurrent. Both arms of one entry must see the same
    // cache state, and running entries in parallel would put six-way branch
    // fan-out from several distillations on the wire at once — the sharp
    // concurrency increase the plan warns triggers acceleration limits.
    const single = await runArm(entry, tenantId, 'single');
    const waved = singleArmOnly
      // Not run here. Shadow mode fires behind the call above and writes the
      // pair itself; a placeholder keeps the result shape uniform so the report
      // below does not have to branch.
      ? { strategy: 'waved' as const, ok: false, totalMs: 0, timeToSummaryMs: 0, error: 'not run (single-arm mode; shadow supplies this side)' }
      : await runArm(entry, tenantId, 'waved');
    results.push({ entry, single, waved });

    if (outDir) {
      // One file per entry holding BOTH artifacts and the input that produced
      // them, so a pair can be read and diffed without re-deriving anything.
      writeFileSync(
        join(outDir, `${entry.id}.json`),
        JSON.stringify({
          id: entry.id,
          stratum: entry.stratum,
          input: entry.input,
          single: { ok: single.ok, totalMs: single.totalMs, error: single.error, output: single.output ?? null },
          waved: {
            ok: waved.ok,
            totalMs: waved.totalMs,
            timeToSummaryMs: waved.timeToSummaryMs,
            error: waved.error,
            output: waved.output ?? null,
          },
        }, null, 2),
      );
    }
    log.info({
      id: entry.id,
      stratum: entry.stratum,
      singleMs: single.totalMs,
      wavedTotalMs: waved.totalMs,
      wavedSummaryMs: waved.timeToSummaryMs,
      singleOk: single.ok,
      wavedOk: waved.ok,
      // Surfaced per entry, not just counted. A run that reports "0 succeeded"
      // with no reason is not a diagnostic, and both arms failing in
      // milliseconds is the shape of a setup problem rather than a result.
      singleError: single.error,
      wavedError: waved.error,
      // Per-entry agreement, not just the aggregate.
      //
      // Reported only in the summary, these numbers say "67% agreed" and
      // nothing about WHICH inputs disagreed — so a disagreement concentrated
      // entirely in one input shape is indistinguishable from one spread evenly,
      // and those call for opposite responses. The stratum is on the row for the
      // same reason: the whole point of stratifying the corpus is to slice by it
      // afterwards. (`stratum` is already on this row above.)
      graphDecisionAgrees: graphDecisionAgrees(single.output, waved.output),
      triggerTypeAgrees: triggerTypeAgrees(single.output, waved.output),
      singleEmittedGraph: single.output
        ? Array.isArray(single.output.workflowSteps) && single.output.workflowSteps.length > 0
        : null,
      wavedEmittedGraph: waved.output
        ? Array.isArray(waved.output.workflowSteps) && waved.output.workflowSteps.length > 0
        : null,
      singleSkillsRestate: skillsRestateStepsRate(single.output),
      wavedSkillsRestate: skillsRestateStepsRate(waved.output),
      // The layer table's measure. Per entry as well as in the aggregate,
      // because one input contradicting itself is the thing to go and read;
      // the mean only says how often it happens.
      singleContradictoryThresholds: contradictoryThresholdRate(single.output),
      wavedContradictoryThresholds: contradictoryThresholdRate(waved.output),
      // Whether each arm's graph is DEGENERATE, recorded alongside whether the
      // arms agreed — because agreement alone scored the split's correct
      // behaviour as a failure.
      //
      // On a short conversational role the single call can emit three
      // llm_reason steps reading "plan it", "execute the plan", "write the
      // brief": a description of thinking wearing a graph's clothes, for work
      // the prompt explicitly says to omit a graph for. When the split omits
      // it, agreement alone counts that disagreement against the split.
      //
      // A graph with no tool_call step and no branching is not a workflow, and
      // emitting one is worse than emitting none: it adds runtime machinery
      // around work that has no procedure.
      singleGraphDegenerate: degenerateGraph(single.output),
      wavedGraphDegenerate: degenerateGraph(waved.output),
      singleCapabilityTier: single.output?.capabilityTier ?? null,
      wavedCapabilityTier: waved.output?.capabilityTier ?? null,
    }, 'distill A/B entry complete');
  }

  // Judged after every arm has run, so a slow judge cannot distort the latency
  // numbers by sharing a rate limit with the distillations being measured.
  const verdicts: JudgeVerdict[] = [];
  for (const r of results) {
    // In single-arm mode there is no in-process challenger to judge against;
    // the pairs live in distill_shadow_comparisons and are judged by
    // distill-shadow-judge.ts instead.
    if (singleArmOnly) break;
    if (!r.single.output || !r.waved.output) continue;
    const verdict = await judgePair(
      r.entry.id,
      r.entry.input.role,
      r.entry.input.responsibilities,
      r.single.output,
      r.waved.output,
      tenantId,
    );
    if (verdict) {
      verdicts.push(verdict);
      log.info({
        id: r.entry.id,
        stratum: r.entry.stratum,
        winner: verdict.winner,
        shownWavedFirst: verdict.firstWasWaved,
        reasoning: verdict.reasoning,
      }, 'distill A/B judge verdict');
    }
  }

  const branches = await aggregateRuns(startedAt, tenantId);

  report(results, verdicts, branches);
  return results;
}

function report(results: EntryResult[], verdicts: JudgeVerdict[], branches: BranchAggregate[]): void {
  const singleOk = results.filter((r) => r.single.ok);
  const wavedOk = results.filter((r) => r.waved.ok);

  const summary = {
    entries: results.length,
    // Distinct failure reasons, so a systematic problem is visible at a glance
    // instead of having to be reconstructed from the per-entry log lines.
    failures: [...new Set(
      results.flatMap((r) => [r.single.error, r.waved.error]).filter(Boolean) as string[],
    )].slice(0, 5),
    single: {
      succeeded: singleOk.length,
      totalMsP50: percentile(singleOk.map((r) => r.single.totalMs), 50),
      totalMsP90: percentile(singleOk.map((r) => r.single.totalMs), 90),
      skillsRestateSteps: mean(singleOk.map((r) => skillsRestateStepsRate(r.single.output))),
      identityLeakage: mean(singleOk.map((r) => identityLeakageRate(r.single.output))),
      contradictoryThresholds: mean(singleOk.map((r) => contradictoryThresholdRate(r.single.output))),
    },
    waved: {
      succeeded: wavedOk.length,
      // The gate the plan sets at < 6s.
      timeToSummaryMsP50: percentile(wavedOk.map((r) => r.waved.timeToSummaryMs), 50),
      timeToSummaryMsP90: percentile(wavedOk.map((r) => r.waved.timeToSummaryMs), 90),
      totalMsP50: percentile(wavedOk.map((r) => r.waved.totalMs), 50),
      totalMsP90: percentile(wavedOk.map((r) => r.waved.totalMs), 90),
      skillsRestateSteps: mean(wavedOk.map((r) => skillsRestateStepsRate(r.waved.output))),
      identityLeakage: mean(wavedOk.map((r) => identityLeakageRate(r.waved.output))),
      contradictoryThresholds: mean(wavedOk.map((r) => contradictoryThresholdRate(r.waved.output))),
    },
    agreement: {
      graphDecision: mean(results.map((r) => {
        const agrees = graphDecisionAgrees(r.single.output, r.waved.output);
        return agrees === null ? null : agrees ? 1 : 0;
      })),
      triggerType: mean(results.map((r) => {
        const agrees = triggerTypeAgrees(r.single.output, r.waved.output);
        return agrees === null ? null : agrees ? 1 : 0;
      })),
    },
    // Blinded pairwise judging. The gate is that the control is not
    // SIGNIFICANTLY preferred, so both the split and the sample size matter.
    byStratum: Object.entries(
      results.reduce<Record<string, EntryResult[]>>((acc, r) => {
        (acc[r.entry.stratum] ??= []).push(r);
        return acc;
      }, {}),
    ).map(([stratum, rs]) => ({
      stratum,
      entries: rs.length,
      wavedSucceeded: rs.filter((r) => r.waved.ok).length,
      graphAgreement: mean(rs.map((r) => {
        const a = graphDecisionAgrees(r.single.output, r.waved.output);
        return a === null ? null : a ? 1 : 0;
      })),
      singleMeanMs: mean(rs.filter((r) => r.single.ok).map((r) => r.single.totalMs)),
      wavedMeanMs: mean(rs.filter((r) => r.waved.ok).map((r) => r.waved.totalMs)),
    })),
    judge: {
      judged: verdicts.length,
      preferredWaved: verdicts.filter((v) => v.winner === 'waved').length,
      preferredSingle: verdicts.filter((v) => v.winner === 'single').length,
      tie: verdicts.filter((v) => v.winner === 'tie').length,
      // A sanity check on the blinding itself: across enough entries the coin
      // flip should be near even, and a lopsided one means the shuffle is
      // broken and every verdict above is suspect.
      shownWavedFirst: verdicts.filter((v) => v.firstWasWaved).length,
    },
    // Per-branch latency, retry and cost, read back from distill_runs so these
    // are the same numbers the acceptance gates are read from rather than a
    // second set computed a different way.
    branches,
    costUsd: {
      single: branches.filter((b) => b.strategy === 'single').reduce((a, b) => a + b.costUsd, 0),
      waved: branches.filter((b) => b.strategy === 'waved').reduce((a, b) => a + b.costUsd, 0),
    },
  };

  log.info({ summary }, 'distill A/B harness complete');
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  const corpusPath = process.argv[2];
  const tenantId = process.argv[3];
  if (!corpusPath || !tenantId) {
    console.error('usage: distill-ab-harness <corpus.json> <tenantId> [--single-arm] [--out-dir DIR]');
    process.exit(1);
  }
  runDistillAbHarness(corpusPath, tenantId).then(
    () => process.exit(0),
    (err) => {
      log.error({ error: (err as Error).message }, 'distill A/B harness failed');
      process.exit(1);
    },
  );
}
