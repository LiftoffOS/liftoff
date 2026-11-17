// Reflection Engine Service Implementation
// Per Section 16: Reflection engine with backpressure

import { ReflectionTrigger, ReflectionSuggestion, ReflectionQuota, ReflectionTriggerType, EvidenceCounts } from './types';
import { ReflectionRepository, EVIDENCE_RECENCY_WINDOW_DAYS } from './repository';
import {
  mayRewriteDescription,
  MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE,
} from './skill-rewrite-policy';
import { autoPromoteReflection } from './auto-promote';
import { AgentRepository } from '../agent-lifecycle/repository';
import { VertexAIClient } from '../infrastructure/vertex-ai';
import { logger } from '../infrastructure/logging';
import { pool } from '../infrastructure/database';
import { postSkillFeedback } from '../platform-callback/client';
import { isExecutionAllowed } from '../entitlements-client/service';

// Evidence type weights for density calculation
// Per Section 16: Different evidence types have different significance
// Weights sum to 1.0, and every weighted signal must be one the runtime
// records. A signal that can only read zero is not neutral in a weighted
// average: it takes a share of the weight, drags density down, and can leave
// the maximum achievable density below the threshold — a gate that cannot
// open. With these weights an agent qualifies on repeated recent FAILURES
// alone, at exactly 0.50, which is the intended reading of "this agent is
// worth reflecting on".
const EVIDENCE_WEIGHTS = {
  failures: 0.50,           // Errored runs
  humanCorrections: 0.25,   // Human overrides
  escalations: 0.25,        // Open escalations show uncertainty areas
};

// Minimum evidence counts needed for meaningful reflection
const MIN_EVIDENCE_COUNTS = {
  failures: 3,              // At least 3 failures to show a pattern
  humanCorrections: 2,      // 2+ human corrections is significant
  escalations: 3,           // Multiple escalations indicate real uncertainty
};

// Success run threshold for triggering reflection
const SUCCESS_RUN_THRESHOLD = 50;

// Phase 5: Late-rejection feedback threshold for the 'flagged_feedback'
// trigger. Two flags in seven days is enough to justify a reflection job —
// late rejection is the strongest individual signal we get because it
// represents a human deliberately overriding the agent's output post-hoc.
const FLAGGED_FEEDBACK_MIN_COUNT = 2;
const FLAGGED_FEEDBACK_WINDOW_DAYS = 7;

export class ReflectionEngineService {
  private repository = new ReflectionRepository();
  private agentRepository = new AgentRepository();
  private vertexAI = new VertexAIClient();

  // Per Section 16: Reflection runs:
  // - after repeated failures
  // - after repeated undos
  // - after repeated human corrections
  // - after N successful runs
  // - on scheduled cadence

  async triggerReflection(agentId: string, trigger: ReflectionTrigger): Promise<{ started: boolean; reason?: string }> {
    // Guard: only run reflection for ACTIVE agents. Cloud Tasks may deliver
    // a reflection job after the agent has been paused, which would spend
    // model tokens on a paused agent.
    const agent = await this.agentRepository.findById(agentId);
    if (!agent || agent.lifecycle !== 'ACTIVE') {
      logger.info('Reflection skipped: agent not ACTIVE', {
        agent_id: agentId,
        lifecycle: agent?.lifecycle ?? 'not_found',
      });
      return { started: false, reason: `Agent not ACTIVE (lifecycle: ${agent?.lifecycle ?? 'not_found'})` };
    }

    // BILLING-GATE: tenant suspension does NOT change agent.lifecycle, so the
    // ACTIVE check above passes for a suspended tenant whose agents are still
    // ACTIVE. Reflection runs a MEDIUM-tier model through llmClient and drains
    // Operating Units,
    // so a suspended / not-execution-allowed tenant must not accrue new drain
    // (e.g. a late human feedback flag arriving after suspension). Mirror the
    // L3 entitlement gate that scheduled agent execution already enforces.
    if (!(await isExecutionAllowed(trigger.tenantId))) {
      logger.info('Reflection skipped: tenant not execution-allowed (suspended)', {
        agent_id: agentId,
        tenant_id: trigger.tenantId,
      });
      return { started: false, reason: 'Tenant not execution-allowed (suspended)' };
    }

    // Check quotas first. The weekly allowance is per AGENT, so the agent has
    // to be named — passing only the tenant reads a zero.
    const quota = await this.getQuotaStatus(trigger.tenantId, agentId);

    // EVERY decline is logged with its reason.
    //
    // These four returned silently. The lifecycle and admission checks above
    // log, so a skip there is one grep away; a quota or density decline left
    // no trace at all, and "the reflection produced nothing" was
    // indistinguishable from "the reflection never ran". A weekly quota that
    // is never reset and declines every run should take one log line to spot,
    // not a full investigation.
    const decline = (reason: string, detail: Record<string, unknown> = {}) => {
      logger.info('Reflection skipped', {
        agent_id: agentId,
        tenant_id: trigger.tenantId,
        trigger_type: trigger.triggerType,
        reason,
        ...detail,
      });
      return { started: false, reason };
    };

    // Per Section 16: Reflection quotas / backpressure
    if (quota.dailyRunsRemaining <= 0) {
      return decline('Daily reflection quota exceeded', {
        used: quota.dailyRunsUsed, limit: quota.dailyRunsLimit,
      });
    }

    if (quota.weeklyAgentRunsRemaining <= 0) {
      return decline('Weekly agent reflection quota exceeded', {
        used: quota.weeklyAgentRunsUsed, limit: quota.weeklyAgentRunsLimit,
      });
    }

    if (quota.concurrentJobsRemaining <= 0) {
      return decline('Max concurrent reflection jobs reached', {
        current: quota.currentConcurrentJobs, limit: quota.maxConcurrentJobs,
      });
    }

    // Per Section 16: Reflection should only run when evidence density justifies it
    const evidenceDensity = await this.calculateEvidenceDensity(agentId, trigger);
    if (evidenceDensity < 0.5) {
      return decline('Insufficient evidence density', { density: evidenceDensity });
    }

    // Start reflection job
    await this.runReflection(agentId, trigger);
    return { started: true };
  }

  /** The agent's instruction state and invocation count, right now.
   *
   *  Null when the state cannot be read, and the caller treats that as a reason
   *  NOT to reflect. Returning a partial baseline would produce a suggestion
   *  that looks ordinary and is unguardable — applicable over an operator's
   *  edit, and impossible to revert. */
  private async captureInstructionBaseline(agentId: string, tenantId: string): Promise<{
    state: { systemPrompt: string | null; userInstructions: string | null; entityVersion: number | null };
    hash: string;
    trajectoryVersion: number | null;
  } | null> {
    try {
      const { hashInstructionState } = await import('../learning/suggestion-applier');
      const r = await pool.query(
        `SELECT system_prompt, user_instructions, entity_version FROM agents WHERE id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      );
      if (r.rows.length === 0) return null;
      const state = {
        systemPrompt: (r.rows[0].system_prompt as string | null) ?? null,
        userInstructions: (r.rows[0].user_instructions as string | null) ?? null,
        entityVersion: (r.rows[0].entity_version as number | null) ?? null,
      };
      const counted = await pool.query(
        `SELECT COUNT(*)::text AS cnt FROM invocations WHERE agent_id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      ).catch(() => null);
      const n = Number(counted?.rows[0]?.cnt);
      return {
        state,
        hash: hashInstructionState(state),
        trajectoryVersion: Number.isFinite(n) ? n : null,
      };
    } catch (err) {
      logger.warn(
        { agentId, error: (err as Error).message },
        'could not capture a reflection baseline — this suggestion will not be guarded against a concurrent edit',
      );
      return null;
    }
  }

  private async runReflection(agentId: string, trigger: ReflectionTrigger): Promise<void> {
    // Per Section 16: Reflection reads:
    // - instruction version
    // - workflow summaries
    // - task outcomes
    // - escalation history
    // - undo history
    // - human feedback
    // - policy denials

    // Phase 5: Pull the triggering feedbackId out of metadata so the
    // repository can hoist that specific row to the front of
    // flaggedFeedback. Missing or wrong type is treated as absent.
    const triggerFeedbackId =
      trigger.triggerType === 'flagged_feedback' &&
      typeof trigger.metadata?.feedbackId === 'string'
        ? (trigger.metadata.feedbackId as string)
        : undefined;

    // Snapshot the entity BEFORE anything else in this method.
    //
    // Everything below — the context gather, the LLM call — takes seconds, and
    // the plan that comes out of it is a plan against THIS state. An operator
    // edit landing in that window is otherwise overwritten by it with no trace.
    // The hash travels with the suggestion and is re-checked at apply time; the
    // snapshot itself is what a revert writes back.
    //
    // A reflection that CANNOT capture a baseline does not run. That is the
    // whole guard: a suggestion with no baseline can be applied over an
    // operator's edit and can never be reverted, so creating one would produce
    // exactly the two defects this work exists to remove — and it would produce
    // them silently, because a suggestion missing its baseline looks like every
    // other suggestion. Skipping the run costs one reflection cycle; the
    // alternative costs somebody's work.
    const baseline = await this.captureInstructionBaseline(agentId, trigger.tenantId);
    if (!baseline) {
      logger.warn(
        {
          agent_id: agentId,
          tenant_id: trigger.tenantId,
          trigger_type: trigger.triggerType,
          event: 'reflection_skipped_no_baseline',
        },
        'reflection skipped: the agent state could not be snapshotted, so any suggestion from it could '
        + 'neither be guarded against a concurrent edit nor reverted',
      );
      return;
    }

    // Phase 8C: Pass tenantId for performance + audit data enrichment
    const context = await this.repository.gatherReflectionContext(
      agentId,
      trigger.tenantId,
      triggerFeedbackId,
    );

    // Phase 5: Surface the trigger information on the context itself so
    // the reflection prompt can focus the LLM on the right signal.
    context.triggerType = trigger.triggerType;
    context.triggerMetadata = trigger.metadata;

    // Skills flywheel: populate injectedSkills so the reflection prompt can
    // evaluate skill effectiveness and emit refinement suggestions.
    const injectedSkillIds = trigger.metadata?.injectedSkillIds as string[] | undefined;
    if (injectedSkillIds?.length) {
      // observation_count rides along because `usefulness <= 0` is what
      // unlocks a description rewrite in the reflection prompt, and a score
      // built from two unlucky runs is not evidence. See migration 347.
      const skillRows = await pool.query(
        `SELECT id, name, description, instruction, usefulness_score, observation_count
         FROM agent_skills
         WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [injectedSkillIds, trigger.tenantId],
      );
      context.injectedSkills = skillRows.rows.map(r => ({
        id: r.id as string,
        name: r.name as string,
        description: r.description as string,
        instruction: r.instruction as string,
        usefulnessScore: r.usefulness_score as number,
        observationCount: r.observation_count as number,
      }));
    }

    // Per Section 15/17: Use Claude on Vertex AI for reflection
    const analysis = await this.vertexAI.runReflection(trigger.tenantId, agentId, context);

    // Per Section 16: Reflection writes:
    // - suggestion
    // - evidence references
    // - confidence score
    // - recurrence score
    // - severity
    //
    // Phase 5: persist triggeredBy so the applier can refuse to auto-apply
    // suggestions that originated from a single post-hoc rejection.
    const suggestionId = await this.repository.saveSuggestion({
      agentId,
      suggestion: analysis.suggestion,
      evidenceRefs: analysis.evidenceRefs,
      confidenceScore: analysis.confidenceScore,
      recurrenceScore: analysis.recurrenceScore,
      severity: analysis.severity,
      triggeredBy: trigger.triggerType,
      beforeState: baseline.state,
      baselineHash: baseline.hash,
      trajectoryVersion: baseline.trajectoryVersion,
      // What this suggestion expects to change, and how to tell. Without it
      // "did this help?" has nothing to compare against — which is why nothing
      // has ever been able to answer it.
      expectedOutcome: analysis.expectedOutcome ?? null,
    });

    // Skills flywheel: post non-neutral skill feedback to platform-backend.
    // Fire-and-forget — a callback failure must never block the reflection pipeline.
    if (analysis.skillFeedback?.length) {
      // The rewrite conditions are ENFORCED here, not merely requested in the
      // prompt. The prompt states them so the model does not waste a rewrite it
      // cannot use; this is what makes them a boundary. A prompt asking a model
      // to respect a threshold is a preference, and the model is looking at
      // untrusted execution history when it decides.
      //
      // A description rewrite changes what a skill MATCHES, so getting it wrong
      // silently removes working guidance from future runs. It is allowed only
      // when the score says persistent misfire AND there were enough settled
      // runs for that score to mean anything. Absent evidence (the skill was
      // not in this run's injected set, or the count is unknown) fails closed.
      const bySkillId = new Map(
        (context.injectedSkills ?? []).map(s => [s.id, s]),
      );
      const rewriteAllowed = (skillId: string | undefined): boolean =>
        mayRewriteDescription(skillId ? bySkillId.get(skillId) : undefined);

      const callableFeedback = analysis.skillFeedback
        .filter(sf => sf.outcome !== 'neutral')
        .map(sf => {
          const allowRewrite = rewriteAllowed(sf.skillId);
          if (sf.refinedDescription && !allowRewrite) {
            const skill = sf.skillId ? bySkillId.get(sf.skillId) : undefined;
            logger.info(
              {
                agentId,
                skillId: sf.skillId,
                usefulnessScore: skill?.usefulnessScore ?? null,
                observationCount: skill?.observationCount ?? null,
                threshold: MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE,
              },
              'reflection: dropped a description rewrite — not enough evidence of persistent misfire',
            );
          }
          return {
            skillId: sf.skillId ?? '',
            skillName: sf.skillName,
            outcome: sf.outcome === 'helped' ? 'success' as const : 'failure' as const,
            refinedInstruction: sf.refinedInstruction,
            refinedDescription: allowRewrite ? sf.refinedDescription : undefined,
            newPitfallSkill: sf.newPitfallSkill,
          };
        });

      if (callableFeedback.length > 0) {
        postSkillFeedback({
          tenantId: trigger.tenantId,
          agentId,
          taskId: trigger.metadata?.taskId as string | undefined,
          feedback: callableFeedback,
        }).catch(err =>
          logger.warn({ error: (err as Error).message, agentId }, 'reflection: skill-feedback callback failed (non-fatal)'),
        );
      }
    }

    // 6+2: Format structured suggestion before auto-promote
    const formattedSuggestion = [
      `**Rule:** ${analysis.rule || analysis.suggestion}`,
      analysis.why ? `**Why:** ${analysis.why}` : '',
      analysis.appliesWhen ? `**Applies when:** ${analysis.appliesWhen}` : '',
    ].filter(Boolean).join('\n');

    // Auto-promote high-confidence suggestions to memory (autonomous learning loop).
    // Fire-and-forget — failure here should never block the reflection pipeline.
    try {
      await autoPromoteReflection(trigger.tenantId, agentId, {
        // The real id. This was the literal string 'unknown', because
        // saveSuggestion returned void — so auto-promote cast 'unknown' to a
        // uuid, Postgres rejected it, and the promote failed on EVERY
        // reflection. Swallowed as non-fatal, so the loop looked complete
        // while its last step had never once run.
        id: suggestionId,
        suggestion: formattedSuggestion,
        confidenceScore: analysis.confidenceScore,
        severity: analysis.severity,
        // Extract connector/tool context from trigger metadata if available
        connectorType: trigger.metadata?.connectorType as string | undefined,
        toolName: trigger.metadata?.toolName as string | undefined,
        errorCategory: trigger.metadata?.errorCategory as string | undefined,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, agentId }, 'auto-promote after reflection failed (non-fatal)');
    }

    // Phase 8.5E: Intelligent memory pruning during scheduled reflections.
    // Review auto-generated memories: check if error patterns still occur,
    // and supersede stale ones.
    try {
      const { pruneStaleMemories } = require('../learning/memory-pruner');
      await pruneStaleMemories(trigger.tenantId, agentId);
    } catch (err) {
      // Non-fatal: pruner module may not be available yet
      logger.warn({ err }, 'Non-fatal: memory pruning failed during reflection');
    }
  }

  async getSuggestions(agentId: string): Promise<ReflectionSuggestion[]> {
    return this.repository.getSuggestions(agentId);
  }

  // Per Section 16: Reflection quotas
  async getQuotaStatus(tenantId: string, agentId?: string): Promise<ReflectionQuota> {
    return this.repository.getQuotaStatus(tenantId, agentId);
  }

  /** The evidence-density reading for an agent, with no trigger-specific bonus.
   *
   *  Exposed so a consumer outside the reflection pipeline — the conversation-note
   *  promotion gate — asks the SAME question at the SAME threshold rather than
   *  inventing a second, looser standard beside it. A quota check is not a
   *  substitute: quotas bound how often we may learn, and density bounds whether
   *  there is anything to learn from, which is the question promotion is asking.
   *
   *  `scheduled` is the honest trigger to read it under: it is the one trigger
   *  type that carries neither a bonus nor the flagged_feedback bypass, so what
   *  comes back is the base weighted score over the agent's own evidence and
   *  nothing else. */
  async evidenceDensityFor(agentId: string, tenantId: string): Promise<number> {
    const trigger: ReflectionTrigger = { tenantId, triggerType: 'scheduled' };
    return this.calculateEvidenceDensity(agentId, trigger);
  }

  // Per Section 16: Evidence density determines if reflection is worthwhile
  private async calculateEvidenceDensity(agentId: string, trigger: ReflectionTrigger): Promise<number> {
    // Phase 5: For 'flagged_feedback', bypass the standard density math.
    // shouldTriggerReflection already gated on >=2 flags in 7 days, and
    // each late rejection is itself the evidence — there is no other
    // signal type to weight. Returning a saturated density lets the job
    // proceed without needing co-occurring failures/undos/etc.
    //
    // 'n_successful_runs' bypasses it for the same reason, and the reason is
    // sharper here: the density score is built ENTIRELY from things going
    // wrong — failures, human corrections, open escalations. A healthy agent
    // scores ~0 on all three no matter how much work it does, so it can never
    // clear the 0.5 threshold, and the trigger designed to learn from VOLUME
    // was sitting behind a gate that only opens on damage. The sweep reports
    // such an agent as "skippedLowDensity" — which reads as "nothing to learn
    // here" when it means "nothing has gone wrong here".
    //
    // shouldTriggerReflection has already gated this at SUCCESS_RUN_THRESHOLD
    // successful runs SINCE THE LAST REFLECTION, so the volume is the evidence,
    // exactly as a flagged rejection is. "What should this agent do better
    // after fifty good runs" is a legitimate question and the density gate was
    // answering it with silence.
    if (trigger.triggerType === 'flagged_feedback' || trigger.triggerType === 'n_successful_runs') {
      logger.info('Evidence density bypassed: the trigger threshold is itself the evidence', {
        agent_id: agentId,
        trigger_type: trigger.triggerType,
      });
      return 1.0;
    }

    // Calculate how much evidence exists for meaningful reflection
    const counts: EvidenceCounts = await this.repository.getEvidenceCounts(agentId);

    // Calculate normalized scores for each evidence type
    // Normalize by minimum thresholds to determine significance
    const normalizedScores = {
      failures: Math.min(counts.failures / MIN_EVIDENCE_COUNTS.failures, 1),
      humanCorrections: Math.min(counts.humanCorrections / MIN_EVIDENCE_COUNTS.humanCorrections, 1),
      escalations: Math.min(counts.escalations / MIN_EVIDENCE_COUNTS.escalations, 1),
    };

    // Learned weights, not the static constant.
    //
    // `updateLearningModel` has been writing pattern weights on every recorded
    // outcome, and `getAdjustedEvidenceWeights` has been computing this
    // adjustment, and NOTHING read it: density used the static EVIDENCE_WEIGHTS,
    // so the loop that learns which evidence predicts a good suggestion was
    // written and never consumed. With no patterns recorded the call returns the
    // defaults, so this is a no-op until outcomes exist — which is the point at
    // which it starts mattering.
    const weights = await this.getAdjustedEvidenceWeights(agentId);

    // Calculate weighted score
    const weightedScore =
      normalizedScores.failures * weights.failures +
      normalizedScores.humanCorrections * weights.humanCorrections +
      normalizedScores.escalations * weights.escalations;

    // Apply trigger-specific bonuses
    let triggerBonus = 0;
    switch (trigger.triggerType) {
      case 'repeated_failures':
        // Boost density if trigger is specifically about failures
        triggerBonus = normalizedScores.failures >= 0.5 ? 0.15 : 0;
        break;
      case 'repeated_human_corrections':
        // Boost density if trigger is specifically about human corrections
        triggerBonus = normalizedScores.humanCorrections >= 0.5 ? 0.15 : 0;
        break;
      // No 'n_successful_runs' case: it returns above, with the volume itself
      // as the evidence. A bonus here could never have rescued it anyway — 0.2
      // on top of a healthy agent's 0 is still short of the 0.5 threshold,
      // which is why that branch looked like a gate and worked like a wall.
      case 'scheduled':
        // Scheduled reflections get a small baseline bonus
        triggerBonus = 0.1;
        break;
      // Note: 'flagged_feedback' is handled by the early return at the top
      // of this method — it always returns density 1.0 so we never reach
      // this switch.
    }

    // Calculate recency factor - more recent evidence is more valuable
    const recencyFactor = await this.calculateRecencyFactor(agentId, counts);

    // Final density score
    const finalScore = Math.min((weightedScore + triggerBonus) * recencyFactor, 1);

    logger.info('Evidence density calculated', {
      agent_id: agentId,
      trigger_type: trigger.triggerType,
      counts,
      normalizedScores,
      weightedScore,
      triggerBonus,
      recencyFactor,
      finalScore,
    });

    return finalScore;
  }

  // Calculate recency factor based on when evidence occurred
  private async calculateRecencyFactor(agentId: string, counts: EvidenceCounts): Promise<number> {
    // Get time-weighted evidence counts from the recent window vs older. The
    // window is a shared constant because it is bounded by the escalation
    // retention window; see EVIDENCE_RECENCY_WINDOW_DAYS.
    const recentCounts = await this.repository.getRecentEvidenceCounts(
      agentId, EVIDENCE_RECENCY_WINDOW_DAYS,
    );

    // Calculate what percentage of evidence is recent
    const totalEvidence = counts.failures + counts.humanCorrections + counts.escalations;
    const recentEvidence = recentCounts.failures + recentCounts.humanCorrections + recentCounts.escalations;

    if (totalEvidence === 0) {
      return 0.5; // Baseline factor when no evidence
    }

    const recencyRatio = recentEvidence / totalEvidence;

    // Scale from 0.7 to 1.2 based on recency
    // More recent evidence = higher factor
    return 0.7 + (recencyRatio * 0.5);
  }

  // Per Section 16: Increment quota when reflection job is enqueued
  async incrementQuotaOnEnqueue(tenantId: string, agentId: string): Promise<void> {
    await this.repository.incrementDailyRunsUsed(tenantId);
    await this.repository.incrementWeeklyAgentRunsUsed(tenantId, agentId);
    await this.repository.incrementConcurrentJobs(tenantId);

    logger.info('Reflection quota incremented on enqueue', {
      tenant_id: tenantId,
      agent_id: agentId,
    });
  }

  // Per Section 16: Decrement quota when reflection job completes or fails
  async decrementQuotaOnCompletion(tenantId: string): Promise<void> {
    await this.repository.decrementConcurrentJobs(tenantId);

    logger.info('Reflection quota decremented on completion', {
      tenant_id: tenantId,
    });
  }

  // Check if reflection should be triggered based on event counts
  async shouldTriggerReflection(
    agentId: string,
    tenantId: string,
    triggerType: ReflectionTriggerType
  ): Promise<{ shouldTrigger: boolean; reason?: string }> {
    const counts = await this.repository.getEvidenceCounts(agentId);

    switch (triggerType) {
      case 'repeated_failures':
        if (counts.failures >= MIN_EVIDENCE_COUNTS.failures) {
          return { shouldTrigger: true };
        }
        return { shouldTrigger: false, reason: `Only ${counts.failures} failures, need ${MIN_EVIDENCE_COUNTS.failures}` };

      case 'repeated_human_corrections':
        if (counts.humanCorrections >= MIN_EVIDENCE_COUNTS.humanCorrections) {
          return { shouldTrigger: true };
        }
        return { shouldTrigger: false, reason: `Only ${counts.humanCorrections} corrections, need ${MIN_EVIDENCE_COUNTS.humanCorrections}` };

      case 'n_successful_runs':
        if (counts.successfulRuns >= SUCCESS_RUN_THRESHOLD) {
          return { shouldTrigger: true };
        }
        return { shouldTrigger: false, reason: `Only ${counts.successfulRuns} successful runs, need ${SUCCESS_RUN_THRESHOLD}` };

      case 'scheduled':
        // Scheduled reflections always trigger if quota allows
        return { shouldTrigger: true };

      case 'flagged_feedback': {
        const flagged = await this.repository.countFlaggedLateFeedback(
          agentId,
          FLAGGED_FEEDBACK_WINDOW_DAYS,
        );
        if (flagged >= FLAGGED_FEEDBACK_MIN_COUNT) {
          return { shouldTrigger: true };
        }
        return {
          shouldTrigger: false,
          reason: `Only ${flagged} flagged feedback in last ${FLAGGED_FEEDBACK_WINDOW_DAYS} days, need ${FLAGGED_FEEDBACK_MIN_COUNT}`,
        };
      }

      default:
        return { shouldTrigger: false, reason: 'Unknown trigger type' };
    }
  }

  // ===========================================
  // GAP-023 FIX: Learning Loop Implementation
  // Per Section 16: Track suggestion outcomes to improve future reflections
  // ===========================================

  /** Applied suggestions old enough to judge and not yet judged. Read by the
   *  outcome-closure job — the caller `recordSuggestionOutcome` never had. */
  async suggestionsAwaitingOutcome(olderThanHours: number, limit = 50): Promise<Array<{
    id: string;
    agentId: string;
    expectedOutcome: string | null;
    appliedAt: Date;
  }>> {
    return this.repository.getSuggestionsAwaitingOutcome(olderThanHours, limit);
  }

  /** Undo an applied suggestion.
   *
   *  Returns the material rather than writing directly, and the caller applies
   *  it through the same update path a normal write uses. A revert that bypassed
   *  the provenance merge could itself violate the provenance rules the merge
   *  exists to enforce — the undo would become the thing that needs undoing.
   *
   *  Refuses when the agent has changed since the suggestion was applied: the
   *  recorded after_state is what the revert assumes it is undoing, and if that
   *  no longer matches, a blind revert would discard whatever changed in between. */
  async getRevertPlan(suggestionId: string, currentState: unknown): Promise<{
    ok: true;
    agentId: string;
    beforeState: unknown;
  } | { ok: false; reason: string }> {
    const material = await this.repository.getRevertMaterial(suggestionId);
    if (!material) {
      return { ok: false, reason: 'no applied suggestion with a recorded before_state' };
    }
    const { hashInstructionState } = await import('../learning/suggestion-applier');
    const expected = hashInstructionState(material.afterState as Parameters<typeof hashInstructionState>[0]);
    const actual = hashInstructionState(currentState as Parameters<typeof hashInstructionState>[0]);
    if (expected !== actual) {
      return {
        ok: false,
        reason: 'the agent has changed since this suggestion was applied; reverting would discard that change too',
      };
    }
    return { ok: true, agentId: material.agentId, beforeState: material.beforeState };
  }

  // Record outcome when a suggestion is applied
  async recordSuggestionOutcome(
    suggestionId: string,
    outcome: {
      applied: boolean;
      appliedBy?: string;
      appliedAt?: Date;
      effectiveMeasure?: 'improved' | 'no_change' | 'degraded';
      feedback?: string;
    }
  ): Promise<void> {
    await this.repository.updateSuggestionOutcome(suggestionId, outcome);

    // Update learning model based on outcome
    await this.updateLearningModel(suggestionId, outcome);

    logger.info('Suggestion outcome recorded', {
      suggestionId,
      applied: outcome.applied,
      effectiveMeasure: outcome.effectiveMeasure,
    });
  }

  // Update learning weights based on suggestion outcomes
  private async updateLearningModel(
    suggestionId: string,
    outcome: {
      applied: boolean;
      effectiveMeasure?: 'improved' | 'no_change' | 'degraded';
    }
  ): Promise<void> {
    const suggestion = await this.repository.getSuggestionById(suggestionId);
    if (!suggestion) return;

    // Calculate effectiveness score
    let effectivenessScore = 0;
    if (outcome.applied && outcome.effectiveMeasure === 'improved') {
      effectivenessScore = 1.0;
    } else if (outcome.applied && outcome.effectiveMeasure === 'no_change') {
      effectivenessScore = 0.3;
    } else if (outcome.applied && outcome.effectiveMeasure === 'degraded') {
      effectivenessScore = -0.5;
    } else if (!outcome.applied) {
      effectivenessScore = 0; // Neutral - no data
    }

    // Update pattern weights in learning model
    await this.repository.updatePatternWeight({
      agentId: suggestion.agentId,
      pattern: suggestion.suggestion.substring(0, 100), // Pattern identifier
      evidenceTypes: suggestion.evidenceRefs.map(e => e.type),
      weight: effectivenessScore,
      sampleCount: 1,
    });

    logger.debug('Learning model updated', {
      suggestionId,
      effectivenessScore,
      pattern: suggestion.suggestion.substring(0, 50),
    });
  }

  // Get learning insights for an agent
  async getLearningInsights(agentId: string): Promise<LearningInsights> {
    const patterns = await this.repository.getPatternWeights(agentId);
    const suggestions = await this.repository.getSuggestions(agentId);

    // Calculate aggregate statistics
    const appliedSuggestions = suggestions.filter(s => s.appliedAt);
    const totalSuggestions = suggestions.length;
    const applicationRate = totalSuggestions > 0
      ? appliedSuggestions.length / totalSuggestions
      : 0;

    // Find most effective patterns
    const effectivePatterns = patterns
      .filter(p => p.weight > 0.5 && p.sampleCount >= 3)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);

    // Find patterns that often don't help
    const ineffectivePatterns = patterns
      .filter(p => p.weight < 0 && p.sampleCount >= 3)
      .sort((a, b) => a.weight - b.weight)
      .slice(0, 5);

    return {
      agentId,
      totalSuggestions,
      appliedSuggestions: appliedSuggestions.length,
      applicationRate,
      effectivePatterns,
      ineffectivePatterns,
      averageConfidence: suggestions.length > 0
        ? suggestions.reduce((sum, s) => sum + s.confidenceScore, 0) / suggestions.length
        : 0,
    };
  }

  // Adjust evidence weights based on learned patterns
  async getAdjustedEvidenceWeights(agentId: string): Promise<typeof EVIDENCE_WEIGHTS> {
    const patterns = await this.repository.getPatternWeights(agentId);

    // Start with default weights
    const adjustedWeights = { ...EVIDENCE_WEIGHTS };

    // Adjust based on learned patterns
    for (const pattern of patterns) {
      if (pattern.sampleCount < 5) continue; // Need sufficient samples

      for (const evidenceType of pattern.evidenceTypes) {
        const key = evidenceType as keyof typeof EVIDENCE_WEIGHTS;
        if (adjustedWeights[key] !== undefined) {
          // Adjust weight based on pattern effectiveness
          // Positive patterns increase weight, negative patterns decrease
          const adjustment = pattern.weight * 0.05 * (pattern.sampleCount / 10);
          adjustedWeights[key] = Math.max(0.05, Math.min(0.5, adjustedWeights[key] + adjustment));
        }
      }
    }

    // Normalized back to a distribution summing to 1.0.
    //
    // Without this the adjustments are additive with per-key clamps, so the sum
    // drifts — and density is compared against a FIXED 0.5 threshold. Drift the
    // sum below the threshold and the gate can never open; drift it above and
    // every agent qualifies. Normalizing keeps the learned signal (which
    // evidence type matters MORE for this agent, relative to the others) while
    // leaving the scale the threshold is calibrated against intact.
    const total = Object.values(adjustedWeights).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const key of Object.keys(adjustedWeights) as Array<keyof typeof EVIDENCE_WEIGHTS>) {
        adjustedWeights[key] = adjustedWeights[key] / total;
      }
    }

    return adjustedWeights;
  }

  // Generate meta-reflection on reflection quality
  async generateMetaReflection(tenantId: string): Promise<MetaReflection> {
    const suggestions = await this.repository.getAllTenantSuggestions(tenantId);

    // Group by agent
    const byAgent = new Map<string, typeof suggestions>();
    for (const suggestion of suggestions) {
      const existing = byAgent.get(suggestion.agentId) || [];
      existing.push(suggestion);
      byAgent.set(suggestion.agentId, existing);
    }

    // Calculate per-agent metrics
    const agentMetrics: MetaReflection['agentMetrics'] = [];
    for (const [agentId, agentSuggestions] of byAgent.entries()) {
      const applied = agentSuggestions.filter(s => s.appliedAt);
      const improved = applied.filter(s => s.effectiveMeasure === 'improved');

      agentMetrics.push({
        agentId,
        suggestionCount: agentSuggestions.length,
        applicationRate: agentSuggestions.length > 0
          ? applied.length / agentSuggestions.length
          : 0,
        improvementRate: applied.length > 0
          ? improved.length / applied.length
          : 0,
        averageConfidence: agentSuggestions.length > 0
          ? agentSuggestions.reduce((sum, s) => sum + s.confidenceScore, 0) / agentSuggestions.length
          : 0,
      });
    }

    // Calculate overall metrics
    const totalSuggestions = suggestions.length;
    const totalApplied = suggestions.filter(s => s.appliedAt).length;
    const totalImproved = suggestions.filter(s => s.effectiveMeasure === 'improved').length;

    return {
      tenantId,
      generatedAt: new Date(),
      totalSuggestions,
      overallApplicationRate: totalSuggestions > 0 ? totalApplied / totalSuggestions : 0,
      overallImprovementRate: totalApplied > 0 ? totalImproved / totalApplied : 0,
      agentMetrics,
      recommendations: this.generateMetaRecommendations(agentMetrics),
    };
  }

  private generateMetaRecommendations(
    agentMetrics: MetaReflection['agentMetrics']
  ): string[] {
    const recommendations: string[] = [];

    // Find agents with low application rate
    const lowApplicationAgents = agentMetrics.filter(m => m.applicationRate < 0.2 && m.suggestionCount > 5);
    if (lowApplicationAgents.length > 0) {
      recommendations.push(
        `Consider reviewing suggestion quality for agents: ${lowApplicationAgents.map(a => a.agentId).join(', ')} ` +
        `- low application rates may indicate suggestions aren't actionable.`
      );
    }

    // Find agents with low improvement rate despite applications
    const lowImprovementAgents = agentMetrics.filter(
      m => m.applicationRate > 0.5 && m.improvementRate < 0.3 && m.suggestionCount > 5
    );
    if (lowImprovementAgents.length > 0) {
      recommendations.push(
        `Suggestions for agents ${lowImprovementAgents.map(a => a.agentId).join(', ')} ` +
        `are frequently applied but rarely improve outcomes - consider adjusting reflection criteria.`
      );
    }

    // Find agents with high improvement rate
    const highPerformers = agentMetrics.filter(
      m => m.improvementRate > 0.7 && m.applicationRate > 0.5 && m.suggestionCount > 5
    );
    if (highPerformers.length > 0) {
      recommendations.push(
        `Reflection is highly effective for agents: ${highPerformers.map(a => a.agentId).join(', ')} ` +
        `- consider increasing reflection frequency or threshold for these agents.`
      );
    }

    return recommendations;
  }
}

// Learning loop types
interface LearningInsights {
  agentId: string;
  totalSuggestions: number;
  appliedSuggestions: number;
  applicationRate: number;
  effectivePatterns: PatternWeight[];
  ineffectivePatterns: PatternWeight[];
  averageConfidence: number;
}

interface PatternWeight {
  agentId: string;
  pattern: string;
  evidenceTypes: string[];
  weight: number;
  sampleCount: number;
}

interface MetaReflection {
  tenantId: string;
  generatedAt: Date;
  totalSuggestions: number;
  overallApplicationRate: number;
  overallImprovementRate: number;
  agentMetrics: Array<{
    agentId: string;
    suggestionCount: number;
    applicationRate: number;
    improvementRate: number;
    averageConfidence: number;
  }>;
  recommendations: string[];
}
