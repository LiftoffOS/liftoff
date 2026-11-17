import type { SkillUpdater } from '../types';
import { additiveKalmanV1 } from './additive-kalman-v1';
import { mechanicalV0 } from './mechanical-v0';

// The DS ships additional updaters (e.g. additive-kalman-v1) by adding one entry
// here. --model-version on the rollup selects which fold runs.
export const UPDATERS: Record<string, SkillUpdater> = {
  [mechanicalV0.modelVersion]: mechanicalV0,
  [additiveKalmanV1.modelVersion]: additiveKalmanV1,
};
