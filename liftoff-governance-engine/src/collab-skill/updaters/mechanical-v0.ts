// Default updater: agent-only running mean of pass/fail, matching the shipped
// trust-ledger semantics. Proves the seam end to end before the DS's Bayesian
// additive model (y = s_A + s_H + ε) is dropped in as a sibling.

import {
  posteriorKey,
  type MatchOutcome,
  type MatchRecord,
  type MatchTerminalState,
  type SkillPosterior,
  type SkillUpdater,
} from '../types';

/** Polarity of one match for the fold.
 *
 *  'none' is not a zero. It means the run carries NO evidence about how well the
 *  agent collaborates, so it must not enter the mean in either direction.
 *
 *  This mirrors tenant-runtime's `learningSignal()`
 *  (src/agent-execution/terminal-state.ts), which already decided this question
 *  for the memory and skill loops and states the reasoning in the file:
 *  "Scoring it negative would penalise memories for the platform's own
 *  governance decisions." The fold here did the exact opposite —
 *  `pass = m.outcome === 'success' ? 1 : 0` — so every escalated, gated and
 *  paused session counted as a failure, and a team configured to stop for
 *  approval on most of its work was marked down for doing what it was told.
 *
 *  Mirrored rather than imported: it lives in a different service and cannot be
 *  depended on across the boundary. It must be kept in step with it by hand. */
export type MatchPolarity = 'positive' | 'negative' | 'none';

/** Exactly `learningSignal(state)`, for the states that reach this store. */
function polarityFromTerminalState(state: MatchTerminalState): MatchPolarity {
  if (state === 'success') return 'positive';
  // Running out of budget is not evidence the agent collaborates badly — the run
  // was cut off, not misled. Same reasoning as escalated/gated below.
  if (state === 'limit_reached') return 'none';
  if (state === 'task_failed' || state === 'engine_error') return 'negative';
  // escalated, gated, paused, stopped: the run stopped for a reason that says
  // nothing about the quality of the collaboration.
  return 'none';
}

/** Fallback for rows that carry no terminal state: everything emitted before
 *  collab-session schema_version 3, and every backfilled row.
 *
 *  Exact for three of the four outcomes. 'success' is 'success'; 'escalated' is
 *  'escalated'; and 'gated' covers only the terminal states `gated` and `paused`,
 *  which `learningSignal` scores identically ('none'), so the ambiguity is
 *  harmless HERE — it matters to a reader of the store, not to this fold.
 *
 *  'error' is the imprecise one: it projects `task_failed`, `engine_error` AND
 *  `limit_reached`, and the first two are negative while the third is none.
 *  Scored negative, because two of the three are, and because that is what this
 *  fold already did for them. A row carrying `terminalState` never takes this
 *  path. */
function polarityFromOutcome(outcome: MatchOutcome): MatchPolarity {
  switch (outcome) {
    case 'success': return 'positive';
    case 'error': return 'negative';
    case 'escalated': return 'none';
    case 'gated': return 'none';
  }
}

/** The polarity one match folds in with. Prefers the terminal state, which is
 *  the value `learningSignal` is defined over. */
export function matchPolarity(m: Pick<MatchRecord, 'outcome' | 'terminalState'>): MatchPolarity {
  return m.terminalState
    ? polarityFromTerminalState(m.terminalState)
    : polarityFromOutcome(m.outcome);
}

export const mechanicalV0: SkillUpdater = {
  modelVersion: 'mechanical-v0',
  update(matches: MatchRecord[]): Map<string, SkillPosterior> {
    const out = new Map<string, SkillPosterior>();
    for (const m of matches) {
      const polarity = matchPolarity(m);
      // A no-signal match is skipped ENTIRELY — not folded in as a zero, and not
      // counted as an observation either. Counting it would leave the mean alone
      // while shrinking sigma (1/√n), which reads as growing confidence built on
      // runs that said nothing.
      if (polarity === 'none') continue;

      const key = posteriorKey({ tenantId: m.tenantId, entityType: 'agent', entityId: m.agentId, scope: m.scope });
      const prev = out.get(key) ?? {
        tenantId: m.tenantId,
        entityType: 'agent' as const,
        entityId: m.agentId,
        scope: m.scope,
        mu: 0,
        sigma: 1,
        nObservations: 0,
        lastMatchAt: null,
      };
      const pass = polarity === 'positive' ? 1 : 0;
      const n = prev.nObservations + 1;
      out.set(key, {
        ...prev,
        nObservations: n,
        mu: prev.mu + (pass - prev.mu) / n,
        sigma: 1 / Math.sqrt(n),
        lastMatchAt: m.startedAt,
      });
    }
    return out;
  },
};
