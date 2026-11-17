// Turns CollabSkill posteriors into the LiftoffScore contract.
//
// The split this module enforces: the estimator owns fair attribution, and
// nothing it works in reaches the response. mu, sigma and the observation
// count stay here. What ships is a banded 0-100, a confidence word, and
// drivers in units a person already understands.
//
// See src/score/shared-types.ts for the contract and why.

import { getCorrectionStats } from '../insights/data-providers/corrections-provider';
import { getInternalAgents } from '../insights/data-providers/internal-agents-provider';
import { getTenantMembers } from '../insights/data-providers/tenant-members-provider';
import { resolveTimeRange } from '../insights/time-range';
import { log } from '../infrastructure/logging';
import { fetchCollabSkillPosteriors, type SkillPosterior } from './governance-client';
import type {
  LiftoffBand,
  LiftoffConfidence,
  LiftoffDriver,
  LiftoffEntityKind,
  LiftoffGroupKey,
  LiftoffScoreEntry,
  LiftoffScoreGroup,
  LiftoffScoreResponse,
  LiftoffScoreStatus,
} from './shared-types';

/** Tasks an entity needs before it carries a score at all. */
export const MIN_TASKS_TO_RATE = 5;
/** Tasks a workspace needs before any row is shown. */
export const MIN_WORKSPACE_TASKS = 20;

const CONFIDENCE_HIGH_TASKS = 20;
const CONFIDENCE_MEDIUM_TASKS = 10;

const BAND_STRONG = 80;
const BAND_GOOD = 60;
const BAND_NEEDS_WORK = 40;

function bandFor(score: number): LiftoffBand {
  if (score >= BAND_STRONG) return 'strong';
  if (score >= BAND_GOOD) return 'good';
  if (score >= BAND_NEEDS_WORK) return 'needs_work';
  return 'poor';
}

function confidenceFor(tasks: number): LiftoffConfidence {
  if (tasks >= CONFIDENCE_HIGH_TASKS) return 'high';
  if (tasks >= CONFIDENCE_MEDIUM_TASKS) return 'medium';
  return 'early';
}

/**
 * The estimator's own conservative point estimate: mean less three standard
 * deviations, the same quantity the CollabSkill paper reports. Floored at zero
 * because a cold-start entity sits well below it and a negative number has no
 * reading on a 0-100 scale.
 */
export function conservativeEstimate(p: Pick<SkillPosterior, 'mu' | 'sigma'>): number {
  return Math.max(0, p.mu - 3 * p.sigma);
}

function kindFor(entityType: SkillPosterior['entityType']): LiftoffEntityKind | null {
  if (entityType === 'agent') return 'ai_team';
  if (entityType === 'human') return 'person';
  // 'backbone' is a model, not a teammate. It has a posterior because the
  // estimator conditions on it; it is not a row on this panel.
  return null;
}

function groupFor(kind: LiftoffEntityKind): LiftoffGroupKey {
  return kind === 'person' ? 'person' : 'ai';
}

interface NameLookup {
  agents: Map<string, string>;
  people: Map<string, { name: string; email: string | null }>;
}

/**
 * Corrections are the one per-entity driver this repo can source today, from
 * agent_audit_logs via the insights provider. Everything else the contract
 * allows (rework loops, steering rounds) lives in conversation text that no
 * structured column carries yet, and inventing a label for it would be
 * fabrication rather than measurement.
 */
function driversFor(entityId: string, corrections: Map<string, number>): LiftoffDriver[] {
  const count = corrections.get(entityId);
  if (!count) return [];
  return [
    {
      kind: 'hurting',
      dimension: 'results',
      label: count === 1
        ? '1 piece of work needed correcting'
        : `${count} pieces of work needed correcting`,
      benchmark: null,
    },
  ];
}

function buildEntry(
  posterior: SkillPosterior,
  anchor: number,
  names: NameLookup,
  corrections: Map<string, number>,
): LiftoffScoreEntry | null {
  const kind = kindFor(posterior.entityType);
  if (!kind) return null;

  const group = groupFor(kind);
  const person = names.people.get(posterior.entityId);
  const displayName = kind === 'person'
    ? person?.name ?? 'Unknown'
    : names.agents.get(posterior.entityId) ?? 'Unknown';

  const taskCount = posterior.nObservations;
  const rated = taskCount >= MIN_TASKS_TO_RATE && anchor > 0;

  if (!rated) {
    return {
      entityKey: `${kind}:${posterior.entityId}`,
      kind,
      group,
      displayName,
      accountId: kind === 'person' ? posterior.entityId : null,
      email: kind === 'person' ? person?.email ?? null : null,
      taskCount,
      score: null,
      band: null,
      confidence: null,
      resultsBand: null,
      teamworkBand: null,
      drivers: [],
      action: null,
      rated: false,
      // 'single_partner' and 'no_shared_work' both need the interaction graph,
      // which governance-engine does not expose on the posterior. Reporting
      // either without it would be a guess, so an unrated row says only the
      // thing we can actually check.
      notRatedReason: 'too_early',
      tasksToRate: Math.max(0, MIN_TASKS_TO_RATE - taskCount),
    };
  }

  const score = Math.round((100 * conservativeEstimate(posterior)) / anchor);
  const band = bandFor(score);

  return {
    entityKey: `${kind}:${posterior.entityId}`,
    kind,
    group,
    displayName,
    accountId: kind === 'person' ? posterior.entityId : null,
    email: kind === 'person' ? person?.email ?? null : null,
    taskCount,
    score,
    band,
    confidence: confidenceFor(taskCount),
    // The estimator is fed the deliverable grade, so the posterior IS the
    // Results half. Teamwork stays null on purpose: the only Teamwork signal
    // available is turn count, and turn count does not predict outcome
    // (CollabSkill, arXiv:2606.09833, Figure 3: r = 0.046, p = 0.371). A band
    // derived from it would read as meaningful and would not be.
    resultsBand: band,
    teamworkBand: null,
    drivers: kind === 'ai_team' ? driversFor(posterior.entityId, corrections) : [],
    // No action ships until there is a structured thing to point at. The
    // contract says omit rather than emit a vague one.
    action: null,
    rated: true,
    notRatedReason: null,
    tasksToRate: null,
  };
}

function emptyResponse(period: LiftoffScorePeriod, status: LiftoffScoreStatus): LiftoffScoreResponse {
  return {
    period,
    status,
    taskCount: 0,
    computedAt: new Date().toISOString(),
    groups: [],
    entries: [],
  };
}

/** The presets resolveTimeRange accepts, mirrored so the router can validate. */
export const LIFTOFF_SCORE_PERIODS = [
  'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month',
  'last_7_days', 'last_30_days', 'last_90_days',
  'this_quarter', 'last_quarter', 'this_year', 'last_year',
] as const;

export type LiftoffScorePeriod = (typeof LIFTOFF_SCORE_PERIODS)[number];

export interface GetLiftoffScoreOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Builds the panel payload for one tenant.
 *
 * The caller must already have verified that the requester is a member of
 * `tenantId` with permission to see it. This function does no authorisation.
 */
export async function getLiftoffScore(
  tenantId: string,
  period: LiftoffScorePeriod,
  options: GetLiftoffScoreOptions = {},
): Promise<LiftoffScoreResponse> {
  const posteriors = await fetchCollabSkillPosteriors(tenantId, { fetchImpl: options.fetchImpl });
  if (!posteriors || posteriors.length === 0) {
    return emptyResponse(period, 'too_early');
  }

  const scored = posteriors.filter((p) => kindFor(p.entityType) !== null);
  const workspaceTasks = scored.reduce((sum, p) => sum + p.nObservations, 0);
  if (workspaceTasks < MIN_WORKSPACE_TASKS) {
    return { ...emptyResponse(period, 'too_early'), taskCount: workspaceTasks };
  }

  const range = resolveTimeRange({ preset: period });

  const [agents, members, correctionStats] = await Promise.all([
    getInternalAgents(tenantId).catch(() => []),
    getTenantMembers(tenantId).catch(() => []),
    getCorrectionStats(tenantId, range).catch(() => null),
  ]);

  const names: NameLookup = {
    agents: new Map(agents.map((a) => [a.id, a.name || a.role])),
    people: new Map(
      members.map((m) => [m.accountId, { name: m.displayName, email: m.email ?? null }]),
    ),
  };

  const corrections = new Map<string, number>(
    (correctionStats?.byAgent ?? []).map((c) => [c.agentId, c.correctionCount]),
  );

  // The score is anchored inside its own group. Teams and people cannot share
  // one: the posterior is prior-anchored and teams accumulate observations far
  // faster than people do, so a single ranking would order partly by volume.
  const anchors = new Map<LiftoffGroupKey, number>();
  for (const p of scored) {
    const kind = kindFor(p.entityType);
    if (!kind) continue;
    if (p.nObservations < MIN_TASKS_TO_RATE) continue;
    const key = groupFor(kind);
    anchors.set(key, Math.max(anchors.get(key) ?? 0, conservativeEstimate(p)));
  }

  const entries: LiftoffScoreEntry[] = [];
  for (const p of scored) {
    const kind = kindFor(p.entityType);
    if (!kind) continue;
    const entry = buildEntry(p, anchors.get(groupFor(kind)) ?? 0, names, corrections);
    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.rated !== b.rated) return a.rated ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  const groups: LiftoffScoreGroup[] = (['ai', 'person'] as LiftoffGroupKey[])
    .map((key) => ({
      key,
      ratedCount: entries.filter((e) => e.group === key && e.rated).length,
      // Nothing to total until actions carry an hours figure.
      hoursSavedPerMonthAvailable: null,
    }))
    .filter((g) => entries.some((e) => e.group === g.key));

  log.info(
    { tenantId, period, entries: entries.length, tasks: workspaceTasks },
    'score: built panel payload',
  );

  return {
    period,
    // 'on_hold' would mean the workspace splits into groups that share no work.
    // Detecting that needs the interaction graph, which the posterior does not
    // carry, so this endpoint cannot yet emit it.
    status: 'ok',
    taskCount: workspaceTasks,
    computedAt: new Date().toISOString(),
    groups,
    entries,
  };
}
