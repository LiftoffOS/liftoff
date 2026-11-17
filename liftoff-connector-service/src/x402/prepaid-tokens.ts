// Prepaid vendor credit bought from the x402 wallet.
//
// Apify sells its pay-per-event Actors over x402 as a prepaid token: one
// 402-and-pay against agi.apify.com buys an `apify_api_…` bearer whose
// balance is an absolute cap, good for fourteen days, unused credit not
// refunded. The purchase itself is an ordinary x402 v2 `exact` challenge on
// Base (read live: USDC, `amount` = USD × 1e6, GET or POST), so
// it goes through the same paying fetch, the same per-call cap and the same
// daily ceilings as every other x402 payment, and the purchase lands in the
// spend ledger under the vendor's name like any settled payment.
//
// What comes back is a credential for another service to hold. It is
// returned to the caller (platform-backend, over service auth) and never
// logged, never persisted here.
//
// A second funder sits behind the same purchase: when the wallet cannot
// cover the vendor's minimum, the platform's card-funded Locus credits buy
// the very same token through Locus's x402 pass-through of the endpoint
// (purchasePrepaidTokenViaLocus). The token is the vendor's either way; the
// receipt names who paid, so the wallet's reconciliation counts only its own.

import { logger } from '../infra/logging.js';
import { readX402Receipt } from '../clients/connector-transport.js';
import { isLocusConfigured, locusCall, LocusRefusal, type LocusCall } from '../clients/locus.js';
import { x402Fetch } from './payment-client.js';
import { recordX402Spend } from './spend-guard.js';

export const PREPAID_TOKEN_VENDORS = ['apify'] as const;
export type PrepaidTokenVendor = (typeof PREPAID_TOKEN_VENDORS)[number];

/** The most one purchase may be, whatever the caller asks: a token is a
 *  fourteen-day float, not a treasury. */
export const PREPAID_TOKEN_MAX_USD = 50;

const APIFY_PREPAID_URL = 'https://agi.apify.com/protocols/x402/prepaid-tokens';

/** Whose money bought the token: the x402 wallet's USDC, or the platform's
 *  card-funded Locus credits (Locus pays the vendor's x402 challenge from
 *  its own wallet and charges credits), the fallback for a wallet that
 *  cannot cover the vendor's minimum. */
export type PrepaidTokenFunder = 'x402_wallet' | 'locus';
export const PREPAID_TOKEN_FUNDERS: readonly PrepaidTokenFunder[] = ['x402_wallet', 'locus'];

export interface PrepaidTokenPurchase {
  vendor: PrepaidTokenVendor;
  token: string;
  balanceUsd: number;
  expiresAt: string;
  paidUsd: number;
  transaction?: string;
  fundedBy: PrepaidTokenFunder;
}

export class PrepaidTokenError extends Error {
  constructor(
    message: string,
    readonly reason: 'bad_request' | 'vendor_answer_unrecognised' | 'vendor_refused' | 'funder_unavailable',
  ) {
    super(message);
    this.name = 'PrepaidTokenError';
  }
}

/** Apify's answer, as the docs and their published skill show it: `token`,
 *  `remainingBalanceUsd`, `expiresAt`, either bare or under `data`. A body
 *  without a recognisable token is an error, never a guess. */
function readApifyTokenAnswer(body: unknown): { token: string; balanceUsd: number; expiresAt: string } {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const inner = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const token = typeof inner.token === 'string' ? inner.token : undefined;
  const balance = typeof inner.remainingBalanceUsd === 'number'
    ? inner.remainingBalanceUsd
    : typeof inner.balanceUsd === 'number' ? inner.balanceUsd : undefined;
  const expiresAt = typeof inner.expiresAt === 'string' ? inner.expiresAt : undefined;
  if (!token || !token.startsWith('apify_api_') || balance === undefined || !expiresAt) {
    throw new PrepaidTokenError(
      `Apify answered the token purchase without a recognisable token (keys: ${Object.keys(inner).join(', ') || 'none'})`,
      'vendor_answer_unrecognised',
    );
  }
  return { token, balanceUsd: balance, expiresAt };
}

export async function purchasePrepaidToken(
  vendor: string,
  amountUsd: number,
  fetchImpl: typeof x402Fetch = x402Fetch,
): Promise<PrepaidTokenPurchase> {
  if (!(PREPAID_TOKEN_VENDORS as readonly string[]).includes(vendor)) {
    throw new PrepaidTokenError(`no prepaid token is sold by ${vendor}`, 'bad_request');
  }
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > PREPAID_TOKEN_MAX_USD) {
    throw new PrepaidTokenError(`amountUsd must be between 1 and ${PREPAID_TOKEN_MAX_USD}`, 'bad_request');
  }
  // The cap IS the amount: the challenge must ask for exactly what was
  // ordered, and a vendor that asks for more is refused by the guard.
  const resp = await fetchImpl(vendor, { maxPaymentAmountUsd: amountUsd, declaredPriceUsd: amountUsd }, {
    method: 'GET',
    url: APIFY_PREPAID_URL,
    query: { amount: String(amountUsd), currency: 'usd' },
    headers: { Accept: 'application/json' },
  });
  const receipt = readX402Receipt(resp);
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new PrepaidTokenError(
      `Apify refused the token purchase (${resp.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      'vendor_refused',
    );
  }
  const body = await resp.json().catch(() => null);
  const answer = readApifyTokenAnswer(body);
  // Apify's token answer carries no settle-receipt header (read live: the
  // wallet's USDC leaves on-chain, the token comes back, and the response
  // has nothing the x402 library can decode), so the paying
  // fetch books nothing on its own. A token only exists once the payment
  // settled, and the challenge asked for exactly what was ordered, so the
  // ordered amount IS the paid amount: booked here, without a transaction
  // hash, which the daily reconciliation finds on the chain by amount.
  let paidUsd: number;
  let transaction: string | undefined;
  if (receipt) {
    paidUsd = receipt.amountUsd;
    transaction = receipt.transaction;
  } else {
    paidUsd = amountUsd;
    await recordX402Spend(vendor, amountUsd);
    logger.info(
      { event: 'x402_prepaid_settled_without_receipt', vendor, amountUsd, responseHeaders: [...resp.headers.keys()].filter((h) => /payment|x402/i.test(h)) },
      'prepaid token answered with no settle receipt; the ordered amount is booked as paid',
    );
  }
  logger.info(
    { event: 'x402_prepaid_token_purchased', vendor, amountUsd, paidUsd, balanceUsd: answer.balanceUsd, expiresAt: answer.expiresAt, ...(transaction ? { transaction } : {}) },
    'prepaid vendor token purchased from the x402 wallet',
  );
  return {
    vendor: vendor as PrepaidTokenVendor,
    token: answer.token,
    balanceUsd: answer.balanceUsd,
    expiresAt: answer.expiresAt,
    paidUsd,
    ...(transaction ? { transaction } : {}),
    fundedBy: 'x402_wallet',
  };
}

/** Locus's catalog entry for Apify's token endpoint: an x402 pass-through
 *  whose `amount` and `currency` reach Apify as the query parameters it reads
 *  (read live), charged in credits at the challenge's price. */
const LOCUS_APIFY_TOKEN_SLUG = 'x402-agi-apify-com-protocols-x402-prepaid-tokens/call';

/** The same purchase paid with the platform's Locus credits instead of the
 *  wallet: one metered call on the workspace key. The token that comes back
 *  is Apify's own, indistinguishable at run time from one the wallet bought;
 *  only the funder differs, and the caller records it so the wallet's
 *  reconciliation leaves this purchase out. Nothing lands in the x402 spend
 *  ledger: no USDC of ours moved. */
export async function purchasePrepaidTokenViaLocus(
  vendor: string,
  amountUsd: number,
  callImpl: (slug: string, body: Record<string, unknown>, idempotencyKey: string) => Promise<LocusCall> = locusCall,
): Promise<PrepaidTokenPurchase> {
  if (!(PREPAID_TOKEN_VENDORS as readonly string[]).includes(vendor)) {
    throw new PrepaidTokenError(`no prepaid token is sold by ${vendor}`, 'bad_request');
  }
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > PREPAID_TOKEN_MAX_USD) {
    throw new PrepaidTokenError(`amountUsd must be between 1 and ${PREPAID_TOKEN_MAX_USD}`, 'bad_request');
  }
  if (callImpl === locusCall && !isLocusConfigured()) {
    throw new PrepaidTokenError('the platform has no Locus key to buy the token with', 'funder_unavailable');
  }
  let call: LocusCall;
  try {
    call = await callImpl(LOCUS_APIFY_TOKEN_SLUG, { amount: String(amountUsd), currency: 'usd' }, `prepaid-${vendor}-${amountUsd}-${Date.now()}`);
  } catch (err) {
    if (err instanceof LocusRefusal) {
      throw new PrepaidTokenError(`Locus refused the token purchase: ${err.message}`, err.status === 402 ? 'funder_unavailable' : 'vendor_refused');
    }
    throw new PrepaidTokenError(`Locus refused the token purchase: ${(err as Error).message}`, 'vendor_refused');
  }
  const answer = readApifyTokenAnswer(call.body);
  const paidUsd = call.costUsd !== undefined && call.costUsd > 0 ? call.costUsd : amountUsd;
  logger.info(
    { event: 'x402_prepaid_token_purchased', vendor, amountUsd, paidUsd, balanceUsd: answer.balanceUsd, expiresAt: answer.expiresAt, fundedBy: 'locus' },
    'prepaid vendor token purchased with the platform\'s Locus credits',
  );
  return {
    vendor: vendor as PrepaidTokenVendor,
    token: answer.token,
    balanceUsd: answer.balanceUsd,
    expiresAt: answer.expiresAt,
    paidUsd,
    fundedBy: 'locus',
  };
}
