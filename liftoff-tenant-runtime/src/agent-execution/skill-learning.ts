// Skill-learning settlement for a finished autonomous run.
//
// One gate for every skill-statistics writer: learningSignal(terminalState).
// An escalated or gated run is a governance decision — a human was asked to
// act, which says nothing about skill quality — so it must contribute nothing
// to usefulness scores or outcome counters, exactly as it already contributed
// nothing to the reflection trigger. The human's verdict on gated work
// arrives later through the hitl-enforcement path as hitl_approved /
// hitl_rejected, which is the real signal for that case.
//
// The posted outcome derives from the terminal signal, not from
// toolCallsExecuted: the old tool-count heuristic posted 'success' for a run
// that executed tools and then FAILED. The usefulness delta keeps the
// tool-count heuristic on purpose — it measures a different axis ("did the
// skill lead to action") — but only inside evidentiary runs.

import { learningSignal } from './terminal-state';
import type { TerminalState } from './types';
import { postSkillFeedback } from '../platform-callback/client';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export interface SkillLearningInput {
  tenantId: string;
  agentId: string;
  taskId?: string;
  injectedSkillIds: string[];
  terminalState: TerminalState;
  toolCallsExecuted: number;
}

/**
 * Settle usefulness scores and outcome counters for the skills injected into
 * a finished run. Returns the learning signal so the caller can reuse it for
 * the reflection trigger without recomputing. 'none' means nothing was
 * written (governance outcome or no injected skills).
 */
export async function settleSkillLearning(input: SkillLearningInput): Promise<'positive' | 'negative' | 'none'> {
  const signal = learningSignal(input.terminalState);
  if (input.injectedSkillIds.length === 0 || signal === 'none') return 'none';

  // Populated by the settlement UPDATE below and read by the feedback callback
  // after it, which is why it is declared out here: the callback runs whether or
  // not the UPDATE succeeded, and the control plane keys its per-skill metrics on
  // the name when it has one.
  const skillNames = new Map<string, string>();

  try {
    const delta = input.toolCallsExecuted > 0 ? 1 : -1;
    const pool = getPoolForService('scheduled-execution');
    // `usefulness_score` is the AUTONOMOUS-surface score (migration 347). This
    // is its only writer, and the tool-count delta is only defensible here:
    // an autonomous run that executed nothing did nothing, whereas a chat turn
    // that executes nothing is an ordinary answer. Chat settles nothing, so it
    // drops the term from re-ranking instead (RERANK_WEIGHTS in
    // skills/retrieval.ts) — see migration 347 for why a parallel chat column
    // was rejected.
    //
    // observation_count rises with every settled contribution regardless of
    // sign — it is the evidence count the reflection gate reads, so it must
    // count the runs we watched, not the ones that went well.
    //
    // RETURNING carries the names back: they are not in the input, which holds
    // ids only, and taking them from the rows this statement settled guarantees
    // the name belongs to the row that was actually counted.
    const settled = await pool.query<{ id: string; name: string }>(
      `UPDATE agent_skills
       SET usefulness_score = usefulness_score + $1,
           observation_count = observation_count + 1,
           updated_at = NOW()
       WHERE id = ANY($2::uuid[])
       RETURNING id, name`,
      [delta, input.injectedSkillIds],
    );
    for (const row of settled.rows) skillNames.set(row.id, row.name);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Non-fatal: skill usefulness tracking failed');
  }

  // The settlement statement is where the names normally come from. If it did
  // not run, read them directly rather than reporting the feedback nameless: a
  // metric row keyed on an id whose skill nobody can name is unjoinable
  // afterwards, and the control plane only fills the name in on first write.
  if (skillNames.size === 0) {
    try {
      const named = await getPoolForService('scheduled-execution').query<{ id: string; name: string }>(
        'SELECT id, name FROM agent_skills WHERE id = ANY($1::uuid[])',
        [input.injectedSkillIds],
      );
      for (const row of named.rows) skillNames.set(row.id, row.name);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Non-fatal: skill-name lookup for feedback failed');
    }
  }

  const skillOutcome = signal === 'positive' ? ('success' as const) : ('failure' as const);
  postSkillFeedback({
    tenantId: input.tenantId,
    agentId: input.agentId,
    taskId: input.taskId,
    feedback: input.injectedSkillIds.map((skillId) => ({
      skillId,
      skillName: skillNames.get(skillId) ?? '',
      outcome: skillOutcome,
    })),
  }).catch((err) =>
    logger.warn({ error: (err as Error).message }, 'agent-execution: skill-feedback callback failed (non-fatal)'),
  );

  return signal;
}
