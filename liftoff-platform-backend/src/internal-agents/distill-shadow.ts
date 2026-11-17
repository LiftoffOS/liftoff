/**
 * Shadow mode: run the waved strategy alongside a real distillation, discard it,
 * and record the pair.
 *
 * WHY THIS EXISTS. The dev A/B harness replays a fixed corpus, so its two arms
 * are perfectly comparable to each other and not comparable to production: 65
 * curated templates against a dev tenant is a different population from what
 * customers type against their own connectors. Comparing harness-waved numbers
 * against prod-single numbers would measure the corpus. Shadow mode gives the
 * same input, the same tenant, the same catalog and the same connectors to both
 * strategies, which is the only way the comparison is fair.
 *
 * THE FOUR RULES THIS CODE EXISTS TO KEEP.
 *
 * 1. It never delays anyone. The shadow starts only after the real distillation
 *    has already returned to its caller. It is not awaited by anything on the
 *    request path.
 * 2. It never fails anything. Every path is wrapped; a shadow that throws logs
 *    and disappears. The measurement must not become a new failure mode for the
 *    thing being measured.
 * 3. It never produces an agent. No artifact handle is minted for the shadow
 *    output, so there is nothing to redeem and nothing to create from.
 * 4. It never competes with the real call. Running after rather than alongside
 *    means the six branch calls cannot take rate-limit headroom from the
 *    distillation a person is waiting on — and it makes the shadow's own timing
 *    cleaner, since it is measured without contention.
 *
 * IT COSTS REAL MONEY. Every shadowed distillation is a second full
 * distillation, so while this is on, distillation spend roughly doubles — about
 * $19/month becoming $38 at the measured rate of four a day. It is gated by a
 * feature flag with per-tenant overrides and a sample rate, so it can be turned
 * off instantly and without a deploy.
 */
import { randomUUID } from 'crypto';
import { FeatureFlagService } from '../feature-flags/service';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  graphDecisionAgrees,
  identityLeakageRate,
  skillsRestateStepsRate,
  triggerTypeAgrees,
} from './distill-comparison-metrics';
import type { DistillInput, DistillOutput } from './distill-service';

/**
 * The flag. Absent means off — `isEnabled` returns false for a key it does not
 * find, which is the correct default for something that doubles spend.
 */
export const DISTILL_SHADOW_FLAG = 'distill_shadow_mode';

/** How long a comparison row lives. Experiment data, not a record of anything. */
const COMPARISON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const featureFlags = new FeatureFlagService();

export interface ShadowContext {
  input: DistillInput;
  /** The artifact the person actually received. */
  realOutput: DistillOutput;
  /** The run this shadows, so the two can be paired in distill_runs. */
  realRunId: string;
  realDurationMs: number;
  purpose: 'distill' | 'distill_update';
  /** Whether the real result came from the distillation cache.
   *
   *  A cache hit did no generating, so there is no single-arm timing to pair
   *  against and no single-arm artifact that this input actually produced.
   *  Shadowing one would compare a fresh waved run against a result generated
   *  days ago under a different catalog. */
  servedFromCache: boolean;
}

/**
 * Decide whether to shadow, and if so do it, without ever throwing.
 *
 * Deliberately returns void and is never awaited by the request path. Callers
 * fire it with `void`.
 */
export async function maybeRunShadowDistill(
  ctx: ShadowContext,
  runWaved: (input: DistillInput, onSummary: () => void) => Promise<DistillOutput>,
): Promise<void> {
  try {
    if (!ctx.input.tenantId) return;
    // A cache hit is not a generation; see servedFromCache.
    if (ctx.servedFromCache) return;
    // Recursion guard. A shadow runs with strategy 'waved', and only a 'single'
    // distillation is ever shadowed, so a shadow can never spawn a shadow.
    if ((ctx.input.strategy ?? 'single') !== 'single') return;

    const enabled = await featureFlags.isEnabled(DISTILL_SHADOW_FLAG, ctx.input.tenantId);
    if (!enabled) return;

    const sampleRate = Number(process.env.DISTILL_SHADOW_SAMPLE_RATE ?? '1');
    if (!(sampleRate > 0) || Math.random() >= sampleRate) return;

    // Minted here rather than inside the distill service, so the comparison row
    // written afterwards can name the shadow's telemetry rows. Passed in as
    // `runId`; the service stamps `shadowOfRunId` onto every row it writes, so
    // the pair is joinable from either direction.
    const shadowRunId = randomUUID();
    const startedAt = Date.now();
    let summaryAt: number | null = null;

    const shadowOutput = await runWaved(
      { ...ctx.input, strategy: 'waved', runId: shadowRunId, shadowOfRunId: ctx.realRunId },
      () => { if (summaryAt === null) summaryAt = Date.now(); },
    );
    const durationMs = Date.now() - startedAt;

    await recordComparison(
      ctx,
      shadowRunId,
      shadowOutput,
      durationMs,
      summaryAt === null ? null : summaryAt - startedAt,
    );

    log.info({
      metric: 'distill.shadow.completed',
      tenantId: ctx.input.tenantId,
      realRunId: ctx.realRunId,
      shadowRunId,
      realDurationMs: ctx.realDurationMs,
      shadowDurationMs: durationMs,
      shadowTimeToSummaryMs: summaryAt === null ? null : summaryAt - startedAt,
    }, 'Shadow distillation completed');
  } catch (error) {
    // Rule 2. A shadow failure is a lost data point, never an incident.
    log.warn({
      metric: 'distill.shadow.failed',
      tenantId: ctx.input.tenantId,
      realRunId: ctx.realRunId,
      error: (error as Error).message,
    }, 'Shadow distillation failed');
  }
}

async function recordComparison(
  ctx: ShadowContext,
  shadowRunId: string,
  shadowOutput: DistillOutput,
  shadowDurationMs: number,
  shadowTimeToSummaryMs: number | null,
): Promise<void> {
  const tenantId = ctx.input.tenantId;
  if (!tenantId) return;

  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `INSERT INTO distill_shadow_comparisons (
         tenant_id, agent_id, purpose,
         real_run_id, shadow_run_id,
         real_duration_ms, shadow_duration_ms, shadow_time_to_summary_ms,
         graph_decision_agrees, trigger_type_agrees,
         real_skills_restate_rate, shadow_skills_restate_rate,
         real_identity_leakage, shadow_identity_leakage,
         real_output, shadow_output,
         expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        tenantId,
        ctx.input.agentId ?? null,
        ctx.purpose,
        ctx.realRunId,
        shadowRunId,
        ctx.realDurationMs,
        shadowDurationMs,
        shadowTimeToSummaryMs,
        graphDecisionAgrees(ctx.realOutput, shadowOutput),
        triggerTypeAgrees(ctx.realOutput, shadowOutput),
        skillsRestateStepsRate(ctx.realOutput),
        skillsRestateStepsRate(shadowOutput),
        identityLeakageRate(ctx.realOutput),
        identityLeakageRate(shadowOutput),
        JSON.stringify(ctx.realOutput),
        JSON.stringify(shadowOutput),
        new Date(Date.now() + COMPARISON_TTL_MS),
      ],
    );
  });
}
