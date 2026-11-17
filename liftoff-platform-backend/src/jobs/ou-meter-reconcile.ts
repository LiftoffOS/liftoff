// Daily Cloud Scheduler job — reconciles our OU meter ledger against Stripe's
// aggregated_value for the last complete UTC day.
//
// Returns non-2xx when anything drifted, so the scheduler's retryCount engages
// and the job shows as FAILED rather than quietly succeeding. That is the
// specific mistake ou-report made: it caught every per-account failure into a
// counter, returned `success: true` with HTTP 200, and logged the summary
// carrying `errors: 10` at INFO. Cloud Scheduler recorded four months of
// successes over a job that had never worked.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { runOuMeterReconciliation } from '../billing/ou-meter-reconciliation-service';

export const ouMeterReconcileRouter = Router();

ouMeterReconcileRouter.post('/ou-meter-reconcile', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  try {
    const result = await runOuMeterReconciliation();
    const unhealthy = result.drifted + result.exemptMetered + result.stripeErrors;

    if (unhealthy > 0) {
      // 409, not 500: the job ran correctly and found a real disagreement.
      // A distinct code keeps "the reconciliation failed" separable from
      // "the reconciliation worked and the data is wrong" in scheduler logs.
      res.status(409).json({ success: false, reason: 'reconciliation_drift', ...result });
      return;
    }
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'ou_meter_reconcile: job failed');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
