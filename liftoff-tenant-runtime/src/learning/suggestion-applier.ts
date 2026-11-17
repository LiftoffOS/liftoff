// Suggestion Applier
// When a reflection suggestion is accepted, applies it to the agent's instruction.
//
// REVIEW FIX DE-002: Uses `entity_version` (not `current_version`) on agents table.
//
// Phase 5 gap fix: Callers may pass `source: 'auto-apply'` to indicate the
// call is coming from a background auto-applier rather than an explicit
// human accept. Suggestions tagged with `triggered_by = 'flagged_feedback'`
// are rejected in that path — a single post-hoc rejection is not enough
// evidence to modify an agent's instructions without a human in the loop,
// so those suggestions must always be reviewed via the explicit accept
// endpoint. The default remains `'human-accept'` for backward compat.

import { createHash } from 'crypto';
import { llmClient } from '../llm/client';
import { getEntitlementsClient } from '../entitlements-client/service';
import { memoryService } from '../memory/service';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { LLMProvider } from '../llm/types';
import { getManagedSecret } from '../infrastructure/secret-store';

export type ApplySuggestionSource = 'human-accept' | 'auto-apply';

export class AutoApplyForbiddenError extends Error {
  constructor(suggestionId: string, triggeredBy: string) {
    super(
      `Refusing to auto-apply reflection suggestion ${suggestionId} with triggered_by='${triggeredBy}'. Suggestions originating from flagged_feedback require explicit human review.`,
    );
    this.name = 'AutoApplyForbiddenError';
  }
}

/** A suggestion that can no longer be applied honestly.
 *
 *  Distinct from a failure: the suggestion is fine, the world moved. The row is
 *  marked `stale` rather than deleted, so the reflection that produced it is
 *  still there to re-plan from. */
export class StaleSuggestionError extends Error {
  constructor(suggestionId: string, why: string) {
    super(`Refusing to apply reflection suggestion ${suggestionId}: ${why}.`);
    this.name = 'StaleSuggestionError';
  }
}

/** How far the agent's invocation count may drift between planning a suggestion
 *  and applying it.
 *
 *  Not zero: a suggestion is planned asynchronously and an active agent runs
 *  while a person is reading it, so demanding an exact match would make every
 *  suggestion for a busy agent unappliable. Twenty runs is enough for a review
 *  to happen and few enough that the behaviour described is still the current
 *  behaviour. */
export const MAX_TRAJECTORY_DRIFT = 20;

/** A stable fingerprint of the instruction state a suggestion was planned
 *  against. Content, not a timestamp: two writes that produce identical text are
 *  not a conflict, and refusing them would block a re-apply that changes nothing. */
/** Write an agent's instructions everywhere a prompt might read them.
 *
 *  There are two rows, and only one of them is read at execution time.
 *  `agents.user_instructions` is where the reflection loop has always written
 *  and read back from. Every prompt path loads
 *  `compiled_instructions.user_instructions` for the ACTIVE version —
 *  `chat-turn-handler`'s getActiveInstruction and the autonomous equivalent in
 *  agent-execution. So a refinement written only to `agents` changed a row,
 *  bumped a version, wrote an audit record, and changed nothing any model saw.
 *
 *  Apply and revert both go through here so they cannot drift: a revert that
 *  restored one table while apply wrote two would leave the refined text stuck
 *  in the row that actually matters, which is a worse state than never having
 *  applied it.
 *
 *  Returns whether an active compiled row was updated, so the caller can say so
 *  rather than assume it. */
export async function writeAgentInstructions(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  input: {
    agentId: string;
    tenantId: string;
    userInstructions: string | null;
    entityVersion: number;
  },
): Promise<{ compiledUpdated: boolean }> {
  await pool.query(
    `UPDATE agents SET user_instructions = $1, entity_version = $2, updated_at = NOW()
      WHERE id = $3 AND tenant_id = $4`,
    [input.userInstructions, input.entityVersion, input.agentId, input.tenantId],
  );
  // Scoped to the ACTIVE row, not the newest: a superseded or draft compiled
  // instruction is not what any prompt loads, and writing one would reproduce
  // the same silence somewhere new.
  // RUNTIME_AGENT_ID_OK: `agentId` is a runtime `agents.id`, not a control-plane
  // id. The caller loads the agent with `SELECT ... FROM agents WHERE id = $1`
  // and throws 'Agent not found' on zero rows, so a control-plane id could never
  // reach here without the whole apply failing first. `compiled_instructions`
  // is keyed on the same runtime id — getActiveInstruction resolves through
  // resolveRuntimeAgentId before querying it.
  const compiled = await pool.query(
    `UPDATE compiled_instructions SET user_instructions = $1, updated_at = NOW()
      WHERE agent_id = $2 AND tenant_id = $3 AND status = 'active'`,
    [input.userInstructions, input.agentId, input.tenantId],
  );
  return { compiledUpdated: (compiled.rowCount ?? 0) > 0 };
}

export function hashInstructionState(state: {
  systemPrompt?: string | null;
  userInstructions?: string | null;
  entityVersion?: number | null;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      systemPrompt: state.systemPrompt ?? null,
      userInstructions: state.userInstructions ?? null,
      entityVersion: state.entityVersion ?? null,
    }))
    .digest('hex');
}

/** The agent's invocation count — the "trajectory version" a suggestion is
 *  stamped with at plan time. Returns null when it cannot be read, which the
 *  caller treats as "cannot judge staleness" rather than as "stale". */
async function currentTrajectoryVersion(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ cnt: string }> }> },
  agentId: string,
  tenantId: string,
): Promise<number | null> {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::text AS cnt FROM invocations WHERE agent_id = $1 AND tenant_id = $2`,
      [agentId, tenantId],
    );
    const n = Number(r.rows[0]?.cnt);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function applySuggestion(
  tenantId: string,
  agentId: string,
  suggestionId: string,
  options: { source?: ApplySuggestionSource } = {},
): Promise<{ newVersion: number; memoriesCreated: number }> {
  const source: ApplySuggestionSource = options.source ?? 'human-accept';
  const pool = getPoolForService('reflection-engine');

  // Load suggestion
  const sugResult = await pool.query(
    `SELECT * FROM reflection_suggestions WHERE id = $1 AND agent_id = $2`,
    [suggestionId, agentId]
  );
  if (sugResult.rows.length === 0) throw new Error('Suggestion not found');
  const suggestion = sugResult.rows[0];

  // Phase 5 gap fix: refuse auto-apply of flagged_feedback-tagged rows.
  // The only legitimate application path for these is the explicit
  // PATCH /suggestions/:id/accept endpoint, which passes source=
  // 'human-accept' (the default).
  if (source === 'auto-apply' && suggestion.triggered_by === 'flagged_feedback') {
    logger.warn(
      {
        tenantId,
        agentId,
        suggestionId,
        triggeredBy: suggestion.triggered_by,
      },
      'Refusing to auto-apply flagged_feedback-triggered suggestion',
    );
    throw new AutoApplyForbiddenError(suggestionId, suggestion.triggered_by);
  }

  // Load current agent instruction
  // REVIEW FIX DE-002: tenant runtime agents table uses entity_version, not current_version
  const agentResult = await pool.query(
    `SELECT system_prompt, user_instructions, entity_version FROM agents WHERE id = $1 AND tenant_id = $2`,
    [agentId, tenantId]
  );
  if (agentResult.rows.length === 0) throw new Error('Agent not found');
  const agent = agentResult.rows[0];

  // ── Lost-update guard ───────────────────────────────────────────────────
  //
  // The reflection LLM call below takes seconds, and the plan was built against
  // the state as it was BEFORE it. An operator edit landing inside that window
  // is otherwise overwritten with no trace: their change simply disappears, and
  // nothing anywhere records that it was ever made.
  //
  // baseline_hash was taken at PLAN time. If the entity has moved since, the
  // apply is REFUSED — the suggestion is kept and logged, not discarded, so the
  // work is still there to re-plan against the state that actually exists.
  const currentBaseline = hashInstructionState({
    systemPrompt: agent.system_prompt,
    userInstructions: agent.user_instructions,
    entityVersion: agent.entity_version,
  });
  if (!suggestion.baseline_hash) {
    // A suggestion planned before baselines existed. It cannot be guarded and it
    // will not be revertible, and both of those are worth saying out loud rather
    // than discovering later from a missing before_state. Applied anyway: these
    // rows are pending work an operator already reviewed, and refusing them
    // would strand that review with no way to act on it. New suggestions always
    // carry a baseline — runReflection refuses to plan without one.
    logger.warn(
      { tenantId, agentId, suggestionId, event: 'reflection_suggestion_unguarded_apply' },
      'applying a suggestion that predates baseline capture: a concurrent operator edit '
      + 'cannot be detected and this apply cannot be reverted',
    );
  }
  if (suggestion.baseline_hash && suggestion.baseline_hash !== currentBaseline) {
    logger.warn(
      {
        tenantId, agentId, suggestionId,
        plannedAgainst: suggestion.baseline_hash,
        currentBaseline,
        event: 'reflection_suggestion_stale_baseline',
      },
      'entry changed during reflection planning — refusing to apply over it',
    );
    await pool.query(
      `UPDATE reflection_suggestions SET status = 'stale', updated_at = NOW() WHERE id = $1`,
      [suggestionId],
    ).catch(() => undefined);
    throw new StaleSuggestionError(suggestionId, 'the agent changed while this suggestion was being planned');
  }

  // ── Stale-plan guard ────────────────────────────────────────────────────
  //
  // A suggestion planned against a trajectory the agent has since moved past
  // corrects behaviour it has already stopped exhibiting.
  if (suggestion.trajectory_version != null) {
    const versionNow = await currentTrajectoryVersion(pool, agentId, tenantId);
    if (versionNow != null && versionNow - Number(suggestion.trajectory_version) > MAX_TRAJECTORY_DRIFT) {
      logger.warn(
        {
          tenantId, agentId, suggestionId,
          plannedAt: Number(suggestion.trajectory_version),
          versionNow,
          event: 'reflection_suggestion_stale_trajectory',
        },
        'suggestion was planned against behaviour the agent has moved past — discarding',
      );
      await pool.query(
        `UPDATE reflection_suggestions SET status = 'stale', updated_at = NOW() WHERE id = $1`,
        [suggestionId],
      ).catch(() => undefined);
      throw new StaleSuggestionError(suggestionId, 'the agent has moved on from the behaviour this describes');
    }
  }

  const beforeState = {
    systemPrompt: agent.system_prompt,
    userInstructions: agent.user_instructions,
    entityVersion: agent.entity_version,
  };

  // Use LLM to apply suggestion to instruction
  const taskConfig = await getEntitlementsClient().getModelForTask(tenantId, 'suggestion_applier');
  const response = await llmClient.complete(
    {
      messages: [
        {
          role: 'user',
          content: `You are updating an AI agent's instructions based on a reflection insight.

Current instructions:
${agent.user_instructions || '(none)'}

Reflection suggestion to apply:
${suggestion.suggestion}

Evidence:
${JSON.stringify(suggestion.evidence_refs)}

Output the updated instructions. Incorporate the suggestion naturally. Do not add commentary — output only the revised instructions.`,
        },
      ],
      maxTokens: 4000,
    },
    llmClient.modelSelectionFor(taskConfig),
    { tenantId, agentId, purpose: 'suggestion_applier' },
  );

  const revisedInstructions = response.content;

  // Update agent instruction and bump version.
  //
  // BOTH tables, and the second one is the point. `agents.user_instructions` is
  // where this loop has always written and where it reads back from, so a
  // refinement round-tripped correctly and the audit trail recorded both sides.
  // No prompt reads that column. Every prompt path — `chat-turn-handler`'s
  // getActiveInstruction and the autonomous one in agent-execution — reads
  // `compiled_instructions.user_instructions` for the ACTIVE version.
  //
  // So an accepted refinement changed a row, bumped a version, wrote an audit
  // record, and changed nothing the model ever saw. The loop has been closed on
  // itself since it was written. Writing the active compiled row is what makes
  // the refinement reach a turn.
  const newVersion = (agent.entity_version || 1) + 1;
  const { compiledUpdated } = await writeAgentInstructions(pool, {
    agentId, tenantId, userInstructions: revisedInstructions, entityVersion: newVersion,
  });
  if (!compiledUpdated) {
    // Not fatal, and not silent either. An agent with no active compiled
    // instruction cannot execute at all, so this means the refinement landed
    // for an agent that was never going to read it — which is worth a line,
    // because it is exactly the failure this change exists to end.
    logger.warn(
      { agentId, tenantId, suggestionId },
      'Refinement applied but no ACTIVE compiled_instructions row exists — it will not reach a prompt',
    );
  }

  // Mark suggestion as applied, and record BOTH sides of the change.
  //
  // before_state is what a revert writes back; after_state is what a revert
  // checks against first. Without the pair, "revert refinement N" has to assume
  // nothing else touched the agent since — and a blind revert on that assumption
  // discards whatever did.
  const afterState = {
    systemPrompt: agent.system_prompt,
    userInstructions: revisedInstructions,
    entityVersion: newVersion,
  };
  await pool.query(
    `UPDATE reflection_suggestions
        SET status = 'accepted',
            applied_at = NOW(),
            applied_by = COALESCE(applied_by, $2),
            before_state = COALESCE(before_state, $3::jsonb),
            after_state = $4::jsonb
      WHERE id = $1`,
    [suggestionId, source, JSON.stringify(beforeState), JSON.stringify(afterState)]
  );

  // Save the suggestion as a memory for context
  await memoryService.saveMemory({
    tenantId,
    layer: 'individual',
    scopeKey: `reflection-applied-${suggestionId.slice(0, 8)}`,
    content: `Applied reflection insight: ${suggestion.suggestion}`,
    agentId,
    tags: ['reflection', 'applied-suggestion'],
    contentClassification: 'internal',
    source: {
      nodeType: 'system_event' as const,
      refId: suggestionId,
      agentId,
      metadata: { triggerType: 'suggestion_applied', suggestionId },
    },
  });

  logger.info({ tenantId, agentId, suggestionId, newVersion }, 'Reflection suggestion applied to instruction');

  // Re-distillation trigger: if 3+ instruction-update suggestions have been
  // accepted for this agent in the last 30 days, publish a redist_recommended
  // event so the platform backend can surface a UI nudge.
  try {
    const recentAccepted = await pool.query(
      `SELECT COUNT(*) as cnt FROM reflection_suggestions
       WHERE agent_id = $1 AND status = 'accepted'
         AND applied_at > NOW() - INTERVAL '30 days'`,
      [agentId],
    );
    const acceptedCount = parseInt(recentAccepted.rows[0]?.cnt || '0', 10);
    if (acceptedCount >= 3) {
      // Publish via the control plane API (same pattern as audit log posting)
      const controlPlaneUrl = process.env.CONTROL_PLANE_API_URL;
      const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
      if (controlPlaneUrl && serviceToken) {
        fetch(`${controlPlaneUrl}/api/events/publish`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Auth': serviceToken,
          },
          body: JSON.stringify({
            entityType: 'internal_agent',
            entityId: agentId,
            eventType: 'tenant.internal_agent.redist_recommended',
            tenantId,
            payload: { suggestionCount: acceptedCount, lastSuggestionId: suggestionId },
          }),
        }).catch((err: Error) =>
          logger.warn({ agentId, error: err.message }, 'Failed to publish redist_recommended event (non-fatal)'),
        );
      }
      logger.info({ agentId, acceptedCount }, 'Re-distillation recommended — 3+ accepted suggestions in 30 days');
    }
  } catch (err) {
    // Non-fatal — don't block the suggestion apply on event publishing
    logger.warn({ agentId, error: (err as Error).message }, 'redist_recommended check failed (non-fatal)');
  }

  return { newVersion, memoriesCreated: 1 };
}
