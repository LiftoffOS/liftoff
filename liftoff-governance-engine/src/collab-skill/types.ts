// CollabSkill types. The updater contract is a STATELESS recompute: it always
// receives the full match set (in deterministic order) and returns the complete
// posterior map — it is never handed persisted priors. This structurally
// prevents the double-counting a persisted-prior + overlapping-window design
// would suffer, and makes every rollup run idempotent.

/** invocations.outcome, in full.
 *
 *  This enumerated three states while the producing column has admitted four
 *  since tenant-runtime migration 329. The rollup `JSON.parse`s the export and
 *  CASTS to MatchRecord without validating, so a 'gated' row did not fail here —
 *  it flowed straight into the fold typed as something it is not. Widening the
 *  producer alone would have moved the failure downstream instead of fixing it,
 *  which is why this lands in the same change set. */
const MATCH_OUTCOMES = ['success', 'error', 'escalated', 'gated'] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

/** tenant-runtime's TerminalState, mirrored across the service boundary.
 *
 *  `outcome` is a four-value PROJECTION of eight terminal states, and two of them
 *  land on 'gated': a run governance REFUSED, and a run PAUSED waiting for a
 *  person — which resumes. Those are opposite events for a collaboration score,
 *  and no other column on the row separates them. */
const TERMINAL_STATES = [
  'success', 'task_failed', 'escalated', 'gated', 'stopped', 'limit_reached', 'engine_error', 'paused',
] as const;
export type MatchTerminalState = (typeof TERMINAL_STATES)[number];

export interface MatchRecord {
  tenantId: string;
  sessionId: string;
  agentId: string;
  humanId: string | null;
  backbone: string; // `${provider}:${model ?? 'unknown'}`
  scope: string;     // 'global' in v0 — the DS owns finer grains
  y: number | null;  // deliverable score 0-100 (null before the grader runs)
  outcome: MatchOutcome;
  /** Null for rows the exporter produced before collab-session schema_version 3,
   *  and for backfilled rows (the backfill reads `invocations`, which stores the
   *  projection, not the state). Consumers must handle null rather than assume a
   *  default. */
  terminalState?: MatchTerminalState | null;
  startedAt: string;
}

export interface SkillPosterior {
  tenantId: string;
  entityType: 'agent' | 'human' | 'backbone';
  entityId: string;
  scope: string;
  mu: number;
  sigma: number;
  nObservations: number;
  lastMatchAt: string | null;
}

export interface SkillUpdater {
  readonly modelVersion: string;
  /** Pure fold from empty over matches in (startedAt, sessionId) order. */
  update(matches: MatchRecord[]): Map<string, SkillPosterior>;
}

/** Serialization is EXACTLY this template — single ASCII space separator. */
export const posteriorKey = (
  p: Pick<SkillPosterior, 'tenantId' | 'entityType' | 'entityId' | 'scope'>,
): string => `${p.tenantId} ${p.entityType} ${p.entityId} ${p.scope}`;
