import { getBillingProvider } from '../billing/provider';

/**
 * Which cost column the workspace cost surfaces sum.
 *
 * INVARIANT 3 says customer-facing surfaces sum `customer_cost_usd` and never
 * raw `cost_usd`, because the bucket-rated amount is what the customer is
 * actually charged. This is the one carve-out, and it exists because the
 * invariant assumes somebody is being charged.
 *
 * WHAT GOES WRONG WITHOUT IT. A call funded by the customer's own provider key
 * books `customer_cost_usd = 0` with bucket `byok_customer_funded` — correct,
 * because they already paid the vendor and charging Operating Units would bill
 * them twice (invariant 14). An operator running their own deployment on their
 * own keys is in that state for EVERY call. So the Total Cost card reads $0,
 * the Operating Units card reads 0, the Cost Breakdown table is empty, and the
 * vendor invoice climbs all the same. Every query succeeds and every card
 * renders, which is why nothing about it looks broken.
 *
 * THE SWITCH IS THE BILLING PROVIDER, not a new setting. Under `stripe` there
 * is a customer and a charge, so `customer_cost_usd` is the honest figure and
 * invariant 3 holds unchanged. Under `unbilled` nobody is charged, "customer
 * cost" describes nothing, and the only real number is what the vendors cost.
 * Reusing that seam means a deployment cannot end up with a billing mode and a
 * reporting mode that disagree.
 *
 * NOT the `billing_exempt` model. Invariant 11 requires an exempt account to
 * meter, drain and report exactly like a paying one; this is not an exemption
 * inside a billing relationship, it is the absence of one.
 *
 * Call it per query rather than caching: `getBillingProvider()` resolves off
 * configuration that tests override between cases, and a module-level constant
 * would freeze the first answer for the whole jest worker.
 */
export type CostColumn = 'customer_cost_usd' | 'cost_usd';

export function costColumn(): CostColumn {
  return getBillingProvider().kind === 'unbilled' ? 'cost_usd' : 'customer_cost_usd';
}
