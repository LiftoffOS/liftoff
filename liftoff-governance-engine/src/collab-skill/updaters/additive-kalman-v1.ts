// Additive collaboration model: y = s_A + s_H + noise.
//
// mechanical-v0 folds a pass/fail mean per agent. That is a per-agent success
// rate, and a per-agent success rate is dominated by which operators happened to
// use the agent: Shao et al. (arXiv:2606.09833, Figure 2) report the same agent
// winning against its own autonomous baseline 74% of the time under a
// top-quartile operator and 27% under a bottom-quartile one. This updater exists
// to remove that confound by treating the operator's contribution as a latent
// value to solve for rather than variance to average over.
//
// The observation is the GRADE, not the outcome. A match whose `y` is null
// carries no observation for this model and is skipped; see SKIPPED, below.
//
// Same stateless-recompute contract as every updater: the full match set arrives
// in (startedAt, sessionId) order and the complete posterior map is returned.
// Priors are re-seeded here on every run, never read back from the store.

import {
  posteriorKey,
  type MatchRecord,
  type SkillPosterior,
  type SkillUpdater,
} from '../types';
import { matchPolarity } from './mechanical-v0';

/** Prior mean for every entity, in grade points.
 *
 *  Zero, following the paper: the first observation is explained entirely by the
 *  participants rather than by a baseline, and the split between them is settled
 *  by their relative uncertainty. */
export const PRIOR_MU = 0;

/** Prior standard deviation, in grade points. Wide on a 0-100 scale, so the
 *  first few observations move an entity freely. */
export const PRIOR_SIGMA = 25;

/** Observation noise (beta), in grade points. Provisional: it sets how much a
 *  single graded session is allowed to move a posterior, and the DS should tune
 *  it against real grade dispersion before anything derived from this is shown
 *  to anyone. */
export const OBS_SIGMA = 15;

/** Why a match was not folded. Returned for the caller's accounting rather than
 *  logged here, because this fold is pure. */
export type SkipReason = 'no_grade' | 'no_signal';

export function skipReason(m: MatchRecord): SkipReason | null {
  // No grade means no observation. `y` is null until the grader has run, which
  // for most sessions is the normal state today.
  if (m.y === null || !Number.isFinite(m.y)) return 'no_grade';
  // A run that stopped for governance or ran out of budget says nothing about
  // how well the pair collaborated. mechanical-v0 owns that rule and exports it;
  // diverging from it silently would make two folds disagree about the same row.
  if (matchPolarity(m) === 'none') return 'no_signal';
  return null;
}

interface Participant {
  key: string;
  seed: SkillPosterior;
}

function participants(m: MatchRecord): Participant[] {
  const out: Participant[] = [
    {
      key: posteriorKey({ tenantId: m.tenantId, entityType: 'agent', entityId: m.agentId, scope: m.scope }),
      seed: blank(m.tenantId, 'agent', m.agentId, m.scope),
    },
  ];
  // Unattended runs have no operator. The update then reduces to a single-party
  // form, which the same arithmetic handles: x is a vector of ones of whatever
  // length the participant list happens to be.
  if (m.humanId) {
    out.push({
      key: posteriorKey({ tenantId: m.tenantId, entityType: 'human', entityId: m.humanId, scope: m.scope }),
      seed: blank(m.tenantId, 'human', m.humanId, m.scope),
    });
  }
  return out;
}

function blank(
  tenantId: string,
  entityType: SkillPosterior['entityType'],
  entityId: string,
  scope: string,
): SkillPosterior {
  return {
    tenantId,
    entityType,
    entityId,
    scope,
    mu: PRIOR_MU,
    sigma: PRIOR_SIGMA,
    nObservations: 0,
    lastMatchAt: null,
  };
}

export const additiveKalmanV1: SkillUpdater = {
  modelVersion: 'additive-kalman-v1',
  update(matches: MatchRecord[]): Map<string, SkillPosterior> {
    const out = new Map<string, SkillPosterior>();

    for (const m of matches) {
      if (skipReason(m) !== null) continue;
      const y = m.y as number;

      const parts = participants(m);
      const priors = parts.map(p => out.get(p.key) ?? p.seed);
      const variances = priors.map(p => p.sigma * p.sigma);

      // r = y - x'm, the amount the pair's current estimate failed to predict.
      const predicted = priors.reduce((sum, p) => sum + p.mu, 0);
      const residual = y - predicted;

      // K = Sigma x / (x' Sigma x + beta^2). Sigma is held diagonal: the joint
      // update produces cross-covariance between the two participants and we
      // write back only the marginals, which is the standard streaming
      // approximation. Two consequences the DS should know about: the fold is
      // order dependent, and a pair that recurs often has its shared uncertainty
      // counted more than once, which makes sigma optimistic for that pair.
      const denom = variances.reduce((sum, v) => sum + v, 0) + OBS_SIGMA * OBS_SIGMA;
      const gains = variances.map(v => v / denom);

      parts.forEach((part, i) => {
        const prior = priors[i];
        // Sigma' = Sigma - K x' Sigma. On the diagonal that is v - K_i * v.
        const posteriorVariance = variances[i] - gains[i] * variances[i];
        out.set(part.key, {
          ...prior,
          mu: prior.mu + gains[i] * residual,
          sigma: Math.sqrt(posteriorVariance),
          nObservations: prior.nObservations + 1,
          lastMatchAt: m.startedAt,
        });
      });
    }

    return out;
  },
};
