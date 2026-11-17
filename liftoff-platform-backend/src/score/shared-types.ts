// src/score/shared-types.ts — SOURCE OF TRUTH for backend and frontend
//
// LiftoffScore rates how well each agent and each person works with others.
//
// The estimator behind it models every participant in a session as a latent
// value and solves for all of them together, so a team's rating is not just a
// measure of who happened to use it. That machinery stays on the server. None
// of it reaches this file, on purpose.
//
// An earlier version of this contract exposed the estimator directly: posterior
// mean, standard deviation, a conservative mu - 3*sigma, and a per-filter sample
// count. All of it rendered, and the result was unreadable. A row said
// "Teamwork 62 48 with a person" and nobody could say what any of the four
// numbers meant or what to do about them.
//
// So the split is now explicit. The server owns fair attribution and turns its
// estimate into three things a person can act on:
//
//   score       an anchored 0-100 with named bands, so the number means
//               something without a manual
//   drivers     the observable facts behind the score, in real units
//   action      the single next thing worth doing, with its expected payoff
//
// Uncertainty is still honoured, but as a word rather than a sigma, and an
// entity we cannot fairly rate carries no score at all.

/** Named band for a score. Carries the meaning the raw number cannot. */
export type LiftoffBand = 'strong' | 'good' | 'needs_work' | 'poor'

/**
 * How much to trust this row yet, in the reader's terms rather than in sigma.
 * `early` still shows a score but says so plainly; below that an entity is
 * simply not rated.
 */
export type LiftoffConfidence = 'high' | 'medium' | 'early'

/** Which half of the score a driver belongs to. */
export type LiftoffDimension = 'results' | 'teamwork'

/**
 * One observable fact behind the score.
 *
 * `label` must be a complete sentence in units a person already understands
 * ("9 in 10 tasks accepted first time", "3.4 rounds of steering per task").
 * Never a rating, never a percentage of a latent quantity.
 */
export interface LiftoffDriver {
  kind: 'helping' | 'hurting'
  dimension: LiftoffDimension
  label: string
  /** Optional anchor so the number lands. "best here: 1.2" */
  benchmark?: string | null
}

/**
 * The next thing worth doing about this row, and what it is worth.
 *
 * A score with no action attached is a report. This is the field that makes it
 * a product, so the server should omit the whole object rather than emit a
 * vague one.
 */
/**
 * The team's own words, quoted rather than paraphrased.
 *
 * A resource name like "the billing sheet" exists only inside the free text of
 * a clarification question. Turning that into "connect the billing sheet it
 * works around" reads convincingly and is fabrication. Quoting the stored
 * string instead is traceable to a row, and more persuasive, because it is the
 * team saying what it needs.
 */
export interface LiftoffEvidence {
  /** Verbatim from clarifications.question. Never rewritten. */
  quote: string
  /** How many times it asked. Makes a one-off distinguishable from a pattern. */
  occurrences: number
}

export interface LiftoffAction {
  /**
   * Imperative, and it names a STRUCTURED thing: a connector from the catalogue,
   * a settings screen, a team. Never a noun lifted out of free text.
   */
  label: string
  /** Where in the app to go and do it. */
  href?: string | null
  /** Expected monthly time back if it is done. Drives the payoff chip. */
  hoursSavedPerMonth?: number | null
  /** Optional support for the claim, in the team's own words. */
  evidence?: LiftoffEvidence | null
}

/** Why an entity is present but carries no score. */
export type LiftoffNotRatedReason =
  /** Too few tasks to be fair to them yet. */
  | 'too_early'
  /** Only ever worked with one counterpart, so their share is not separable. */
  | 'single_partner'
  /** No shared work with the rest of the workspace. */
  | 'no_shared_work'

/** Every AI kind shares one list; people have their own. */
export type LiftoffGroupKey = 'ai' | 'person'

export type LiftoffEntityKind =
  | 'person'
  | 'ai_team'
  | 'external_collaborator'
  | 'coding_teammate'

export interface LiftoffScoreEntry {
  /** `${kind}:${id}` — the unified actor id the app otherwise lacks. */
  entityKey: string
  kind: LiftoffEntityKind
  group: LiftoffGroupKey
  displayName: string
  /** People only. Seeds UserAvatar so a person keeps one colour everywhere. */
  accountId: string | null
  email: string | null

  /** Tasks this rating is based on. Said once per row, never per dimension. */
  taskCount: number

  /**
   * 0-100, anchored so 100 is the best achievable in this workspace rather than
   * an abstract ceiling. Null when `rated` is false, so there is no number for
   * the UI to leak.
   */
  score: number | null
  band: LiftoffBand | null
  confidence: LiftoffConfidence | null

  /**
   * The two halves as bands, not numbers. Reading "Results strong, Teamwork
   * needs work" gives the diagnosis at a glance, which two more integers on the
   * same unexplained scale did not.
   */
  resultsBand: LiftoffBand | null
  teamworkBand: LiftoffBand | null

  /** Ordered, best first for helping and worst first for hurting. Keep it short. */
  drivers: LiftoffDriver[]
  action: LiftoffAction | null

  rated: boolean
  notRatedReason: LiftoffNotRatedReason | null
  /** For honest "needs about N more tasks" copy. */
  tasksToRate: number | null
}

export interface LiftoffScoreGroup {
  key: LiftoffGroupKey
  ratedCount: number
  /**
   * Total monthly hours the open actions in this group are worth. The reason an
   * admin reads the panel at all, so it belongs at the top of the group.
   */
  hoursSavedPerMonthAvailable: number | null
}

export type LiftoffScoreStatus =
  /** Rate away. */
  | 'ok'
  /** Under the workspace floor. Show the new-workspace notice. */
  | 'too_early'
  /** Workspace splits into groups sharing no work, so nothing compares. */
  | 'on_hold'

export interface LiftoffScoreResponse {
  period: string
  status: LiftoffScoreStatus
  /** Tasks scored across the whole workspace in this window. */
  taskCount: number
  computedAt: string
  groups: LiftoffScoreGroup[]
  entries: LiftoffScoreEntry[]
}
