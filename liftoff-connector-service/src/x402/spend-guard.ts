// x402SpendGuard — treasury guards on the platform x402 wallet.
//
// Two independent checks run BEFORE a payment is signed, and a settled payment
// is recorded after the fact:
//
//   1. Per-call cap — the 402's required amount must not exceed the cap the
//      executor derived from the vendor's declared price (×2, floor $0.02 —
//      the same headroom idiom strale's max_price_cents uses). A vendor-side
//      reprice fails the call instead of silently charging more.
//   2. Daily ceilings — a global and a per-vendor USD ceiling per UTC day,
//      counted in x402_spend_ledger (migration 026). Over the ceiling the
//      payment is refused and an alert-level log fires.
//
// These are WALLET-DRAIN guards on the platform's own funds — a property of
// the treasury, never of the agent. Nothing here gates what an agent may DO:
// a refused payment surfaces as an ordinary vendor failure on that one call.
// Keep the naming: x402SpendGuard, never executionCap.
//
// Ledger writes are best-effort by design: a ledger outage must not turn a
// paid, settled vendor call into a failure. The check side FAILS CLOSED (a
// ledger that cannot be read refuses the payment — an unreadable ceiling is
// not permission to spend), the record side fails open with a warn.

import { getAdminPool } from '../db/pool.js';
import { logger } from '../infra/logging.js';

/** Per-call default cap when the vendor declares no price: the floor. */
export const X402_PER_CALL_FLOOR_USD = 0.02;

const DEFAULT_GLOBAL_DAILY_CEILING_USD = 25;
const DEFAULT_VENDOR_DAILY_CEILING_USD = 10;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function globalDailyCeilingUsd(): number {
  return envNumber('X402_DAILY_CEILING_USD', DEFAULT_GLOBAL_DAILY_CEILING_USD);
}

export function vendorDailyCeilingUsd(): number {
  return envNumber('X402_VENDOR_DAILY_CEILING_USD', DEFAULT_VENDOR_DAILY_CEILING_USD);
}

/** The per-call cap for a tool: declared vendor price ×2, floor $0.02. An
 *  explicit override (makeX402Transport's maxPaymentAmountUsd) wins. */
export function perCallCapUsd(declaredPriceUsd?: number, overrideUsd?: number): number {
  if (typeof overrideUsd === 'number' && overrideUsd > 0) return overrideUsd;
  if (typeof declaredPriceUsd === 'number' && declaredPriceUsd > 0) {
    return Math.max(declaredPriceUsd * 2, X402_PER_CALL_FLOOR_USD);
  }
  return X402_PER_CALL_FLOOR_USD;
}

export class X402SpendRefusedError extends Error {
  readonly reason: 'per_call_cap' | 'daily_ceiling';
  constructor(reason: 'per_call_cap' | 'daily_ceiling', message: string) {
    super(message);
    this.name = 'X402SpendRefusedError';
    this.reason = reason;
  }
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Refuse (throw) when paying `requiredUsd` for `connectorType` would exceed
 * the per-call cap or a daily ceiling. Runs before the payment is signed.
 */
export async function assertX402SpendAllowed(
  connectorType: string,
  requiredUsd: number,
  capUsd: number,
): Promise<void> {
  if (requiredUsd > capUsd) {
    const message =
      `x402 payment refused: ${connectorType} requires $${requiredUsd.toFixed(6)} `
      + `which exceeds this call's cap of $${capUsd.toFixed(6)} — the vendor may have repriced`;
    logger.error(
      { event: 'x402_spend_refused', reason: 'per_call_cap', connectorType, requiredUsd, capUsd },
      message,
    );
    throw new X402SpendRefusedError('per_call_cap', message);
  }

  // Daily ceilings. Fail closed: if the ledger cannot be read, refuse — an
  // unreadable ceiling is not permission to spend.
  const day = utcDay();
  const pool = await getAdminPool();
  const result = await pool.query<{ vendor_spent: string | null; total_spent: string | null }>(
    `SELECT
       SUM(spent_usd) FILTER (WHERE connector_type = $2) AS vendor_spent,
       SUM(spent_usd)                                    AS total_spent
     FROM x402_spend_ledger
     WHERE day = $1`,
    [day, connectorType],
  );
  const vendorSpent = Number(result.rows[0]?.vendor_spent ?? 0);
  const totalSpent = Number(result.rows[0]?.total_spent ?? 0);

  const vendorCeiling = vendorDailyCeilingUsd();
  const globalCeiling = globalDailyCeilingUsd();
  if (vendorSpent + requiredUsd > vendorCeiling || totalSpent + requiredUsd > globalCeiling) {
    const scope = vendorSpent + requiredUsd > vendorCeiling ? 'vendor' : 'global';
    const message =
      `x402 payment refused: the ${scope} daily ceiling is reached `
      + `(${connectorType} spent $${vendorSpent.toFixed(4)}/$${vendorCeiling} today, `
      + `all vendors $${totalSpent.toFixed(4)}/$${globalCeiling})`;
    logger.error(
      {
        event: 'x402_spend_refused',
        reason: 'daily_ceiling',
        scope,
        connectorType,
        requiredUsd,
        vendorSpent,
        vendorCeiling,
        totalSpent,
        globalCeiling,
      },
      message,
    );
    throw new X402SpendRefusedError('daily_ceiling', message);
  }
}

/**
 * Record a SETTLED payment into the daily ledger. Best-effort: a ledger write
 * failure logs and returns — the vendor call already succeeded and was paid,
 * and failing it now would charge the wallet for a result nobody received.
 */
export async function recordX402Spend(connectorType: string, paidUsd: number): Promise<void> {
  if (!(paidUsd > 0)) return;
  try {
    const pool = await getAdminPool();
    await pool.query(
      `INSERT INTO x402_spend_ledger (day, connector_type, spent_usd, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (day, connector_type) DO UPDATE SET
         spent_usd  = x402_spend_ledger.spent_usd + EXCLUDED.spent_usd,
         updated_at = NOW()`,
      [utcDay(), connectorType, paidUsd],
    );
  } catch (err) {
    logger.warn(
      { event: 'x402_spend_record_failed', connectorType, paidUsd, err: (err as Error).message },
      'x402 spend ledger write failed — the payment itself settled; ledger is behind by this row',
    );
  }
}
