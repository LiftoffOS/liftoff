import type { TriggerConfig, CompanionCron } from './types';

/** Loader-side normalization helper used everywhere lifecycle code reads companions.
 *  Normalizes the deprecated singular `companionCron` to the array form. */
export function getCompanionCrons(tc: TriggerConfig | null | undefined): CompanionCron[] {
  if (!tc) return [];
  if (tc.companionCrons?.length) return tc.companionCrons;
  if (tc.companionCron) {
    return [{ label: 'default', cronExpr: tc.companionCron.cronExpr, timezone: tc.companionCron.timezone }];
  }
  return [];
}
