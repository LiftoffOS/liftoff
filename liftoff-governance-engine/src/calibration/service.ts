// the weekly calibration sweep (Cloud Scheduler → POST /calibration/run).
//
// The SAME loop runs from day one: below the sample floor it returns `hold` (the cold-start
// no-op); once a tenant accrues enough labeled data the same loop moves the value. No warm-up
// path, no cold-start knobs.

import { runCalibration } from './loop';
import { calibrationStore, listCalibrationTenants } from './repository';
import { TRUST_CONSTANTS } from './trust-constants';
import { log } from '../infrastructure/logging';

const WINDOW_DAYS = Number(process.env.CALIB_WINDOW_DAYS ?? 7);

export interface CalibrationSweepSummary {
  tenants: number;
  runs: number;
  held: number;
  promoted: number;
  rolledBack: number;
}

/** Run every registered constant for every tenant over the trailing window. Never throws for a
 *  single tenant/constant — failures are logged and the sweep continues. */
export async function runCalibrationSweep(now: Date = new Date()): Promise<CalibrationSweepSummary> {
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const tenants = await listCalibrationTenants();

  let runs = 0;
  let held = 0;
  let promoted = 0;
  let rolledBack = 0;

  for (const tenantId of tenants) {
    for (const constant of TRUST_CONSTANTS) {
      try {
        const row = await runCalibration(tenantId, constant, windowStart, windowEnd, calibrationStore);
        runs++;
        if (row.outcome === 'hold') held++;
        else if (row.outcome === 'promote') {
          promoted++;
          log.info(
            { tenant_id: tenantId, constant: constant.name, applied_value: row.appliedValue, samples: row.sampleCount },
            'calibration_promote',
          );
        } else if (row.outcome === 'rollback') {
          rolledBack++;
          // Guardrail metric: a log-based metric keys on this event
          // (calibration_rollback_total > 0 ⇒ alert; see runbooks/calibration.md).
          log.warn(
            { tenant_id: tenantId, constant: constant.name, applied_value: row.appliedValue, guardrail: row.guardrailDelta },
            'calibration_auto_rollback',
          );
        }
      } catch (err) {
        log.error({ err: (err as Error).message, tenant_id: tenantId, constant: constant.name }, 'calibration run failed');
      }
    }
  }

  log.info({ tenants: tenants.length, runs, held, promoted, rolledBack }, 'calibration sweep complete');
  return { tenants: tenants.length, runs, held, promoted, rolledBack };
}
