// Every reachable model has a published rate, said out loud at boot.
//
// WHY AN UNPRICED MODEL IS INVISIBLE RATHER THAN ABSENT. computeRowCost never
// bills zero: a model with no rate falls back to a conservative default, which
// is some OTHER model's price. So the failure does not look like a failure. The
// request succeeds, a usage row is written, a number appears on the cost page,
// and it is wrong on every row for that model, indefinitely, until somebody
// compares the total against a vendor invoice.
//
// There is a ratchet over the code-side table already
// (src/llm/__tests__/pricing-coverage.test.ts), and it cannot see this one. A
// model becomes reachable by having a row in `models` with status 'approved',
// which is a DATABASE fact: somebody registers a model through a migration or
// the admin surface, and no test in the suite has a database. The only moment
// the two halves can be compared is when something is running with both in
// hand, which is what this is for.
//
// It reports and never throws. A deployment with an unpriced model is misbilled
// and still working, and refusing to boot over it would turn a reporting
// problem into an outage.

import type { Pool } from 'pg';
import { log } from '../infrastructure/logging';
import { MODEL_PRICING, pricingKeysFor } from './pricing';

export interface PricingCoverage {
  approved: number;
  unpriced: string[];
}

/**
 * Compare the approved models against the rates that exist, in the database and
 * in the code table.
 *
 * Exported separately from the reporting so a caller can assert on the result
 * rather than on a log line.
 */
export async function pricingCoverage(pool: Pool): Promise<PricingCoverage> {
  const [approved, priced] = await Promise.all([
    pool.query<{ provider: string; model_id: string }>(
      `SELECT provider, model_id FROM models
        WHERE status = 'approved'
        ORDER BY provider, model_id`,
    ),
    pool.query<{ provider: string; model_id: string }>(
      `SELECT provider, model_id FROM model_pricing`,
    ),
  ]);

  const dbKeys = new Set(priced.rows.map((r) => `${r.provider}:${r.model_id}`));
  const unpriced = approved.rows
    .filter((r) =>
      pricingKeysFor(r.provider, r.model_id).every(
        (key) => !dbKeys.has(key) && MODEL_PRICING[key] === undefined,
      ),
    )
    .map((r) => `${r.provider}:${r.model_id}`);

  return { approved: approved.rows.length, unpriced };
}

/**
 * Report coverage once, at boot.
 *
 * Swallows its own failures on purpose. This runs while the service is coming
 * up; a database that is not ready yet, or a `models` table that does not exist
 * because the migrations have not run, must not take the process down. The
 * answer in that case is simply unknown, and saying so is honest.
 */
export async function reportPricingCoverageAtBoot(pool: Pool): Promise<void> {
  try {
    const { approved, unpriced } = await pricingCoverage(pool);

    if (unpriced.length === 0) {
      log.info(
        { event: 'model_pricing_coverage', approvedModels: approved, unpricedModels: 0 },
        'pricing coverage: every approved model has a published rate',
      );
      return;
    }

    log.error(
      {
        event: 'model_pricing_missing',
        approvedModels: approved,
        unpricedModels: unpriced.length,
        models: unpriced,
      },
      'pricing coverage: approved models have NO rate in model_pricing and no MODEL_PRICING entry. '
        + 'Every usage row for these is billed at the conservative default, which is another '
        + "model's price, and every cost surface will show that number as though it were real. "
        + "Record the vendor's published rate in src/llm/pricing.ts.",
    );
  } catch (err) {
    log.warn(
      { event: 'model_pricing_coverage_unavailable', err },
      'pricing coverage could not be checked at boot; this says nothing about whether the models are priced',
    );
  }
}
