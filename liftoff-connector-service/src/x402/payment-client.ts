// The x402 paying fetch — wraps a vendor HTTP call so a 402 challenge is
// paid from the platform wallet and retried, per the x402 v2 protocol.
//
// Per REQUEST this builds a fresh x402Client + x402HTTPClient around the
// shared lazy signer (wallet.ts). The wrapper objects are plain construction
// — the expensive, env-gated part is the signer, resolved once — and a
// per-request client is what lets the payment-required hook capture THIS
// call's required amount without cross-talk between concurrent calls on the
// same connector.
//
// The guard order is: per-call cap + daily ceilings (x402SpendGuard, before
// anything is signed, via the onPaymentRequired hook) → library-level
// SpendControls.maxAmountPerPayment as belt-and-braces → sign → retry with
// the payment header. After a settled payment, the settle receipt (decoded
// off the response headers exactly as the library wrote them) is recorded in
// the daily ledger and re-exposed to the executor on two synthetic response
// headers, so the transport contract stays `(req) => Response` while the
// executor can still turn the paid amount into costUsd.

import { wrapFetchWithPayment, x402Client, x402HTTPClient } from '@x402/fetch';
import type { PaymentRequirements, SelectPaymentRequirements } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { ExactEvmSchemeV1 } from '@x402/evm/exact/v1/client';
import { logger } from '../infra/logging.js';
import type { ConnectorRequest } from '../clients/connector-transport.js';
import {
  DEFAULT_PUBLIC_WEB_HEADERS,
  X402_PAID_USD_HEADER,
  X402_TRANSACTION_HEADER,
} from '../clients/connector-transport.js';
import { getX402Signer } from './wallet.js';
import { assertX402SpendAllowed, perCallCapUsd, recordX402Spend } from './spend-guard.js';

/** USDC on Base — 6 decimals. The exact scheme's atomic `amount` strings are
 *  converted at this scale. (Base network id eip155:8453; USDC is the asset
 *  every §4 vendor charges in.) */
const USDC_DECIMALS = 6;

export interface X402TransportOptions {
  /** Per-call ceiling in USD. Absent → declared price ×2, floor $0.02. */
  maxPaymentAmountUsd?: number;
  /** The vendor's declared per-call price, when the catalog knows it. */
  declaredPriceUsd?: number;
  defaultHeaders?: Record<string, string>;
}

function withQuery(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

function atomicToUsd(amount: string): number {
  const n = Number(amount);
  return Number.isFinite(n) ? n / 10 ** USDC_DECIMALS : NaN;
}

/** True for an offer our EVM scheme registration can satisfy: a v2 CAIP-2
 *  network id (eip155:*) or the v1 network NAME 'base' — browserbase still
 *  speaks x402Version 1, where 'base' is the whole spelling. */
function isEvmOffer(network: unknown): boolean {
  return typeof network === 'string' && (network.startsWith('eip155:') || network === 'base');
}

/** An offer's amount, across protocol versions: v2 carries `amount`, v1
 *  carries `maxAmountRequired` (both atomic USDC strings on our vendors). */
function offerAtomicAmount(offer: PaymentRequirements): string | undefined {
  const v1 = (offer as unknown as { maxAmountRequired?: string }).maxAmountRequired;
  return offer.amount ?? v1;
}

/** Pick the CHEAPEST payable offer. The library's default selector takes
 *  accepts[0] after filtering (verified in @x402/core 2.25.0), which is not
 *  necessarily the offer minRequiredUsd priced for the guard — so the choice
 *  is pinned here and guard and payer agree by construction. */
const cheapestOfferSelector: SelectPaymentRequirements = (_version, accepts) => {
  let best = accepts[0];
  let bestUsd = Number.POSITIVE_INFINITY;
  for (const offer of accepts) {
    const amount = offerAtomicAmount(offer);
    const usd = amount === undefined ? NaN : atomicToUsd(amount);
    if (Number.isFinite(usd) && usd < bestUsd) {
      best = offer;
      bestUsd = usd;
    }
  }
  return best;
};

/** The smallest USD amount among the challenge's EVM offers — the amount the
 *  cheapest-offer selector will pay. Non-EVM offers are ignored (we register
 *  only the EVM scheme). */
function minRequiredUsd(accepts: readonly PaymentRequirements[]): number | undefined {
  const usds = accepts
    .filter((r) => isEvmOffer(r.network))
    .map((r) => {
      const amount = offerAtomicAmount(r);
      return amount === undefined ? NaN : atomicToUsd(amount);
    })
    .filter((n) => Number.isFinite(n));
  return usds.length ? Math.min(...usds) : undefined;
}

/**
 * Perform one vendor request with x402 payment applied on a 402 challenge.
 * Called by makeX402Transport (the third transport sibling) — executors go
 * through the transport, never through this directly.
 */
export async function x402Fetch(
  connectorType: string,
  opts: X402TransportOptions | undefined,
  req: ConnectorRequest,
): Promise<Response> {
  const signer = await getX402Signer();
  const capUsd = perCallCapUsd(opts?.declaredPriceUsd, opts?.maxPaymentAmountUsd);

  // Registered for BOTH protocol versions: the §4 vendors are mixed (strale,
  // google-trends and the x402 Atlas serve v2; gloria and browserbase still
  // serve v1 with the network NAME 'base'). Same signer, same asset — but
  // each protocol version needs ITS OWN scheme class: the v2 scheme's
  // payload builder takes only CAIP-2 network ids, so handing it a v1
  // challenge dies with "Unsupported network format: base". ExactEvmSchemeV1
  // is the class built for the v1 wire shape.
  const client = new x402Client(cheapestOfferSelector)
    .register('eip155:*', new ExactEvmScheme(signer))
    .registerV1('base', new ExactEvmSchemeV1(signer));
  // Library-level belt-and-braces under the guard's own check.
  client.setSpendControls({ maxAmountPerPayment: `$${capUsd.toFixed(6)}` });

  // Captured by the payment-required hook so a settle receipt that omits the
  // amount (the exact scheme settles exactly what was authorized) can still be
  // booked at the authorized value.
  let requiredUsd: number | undefined;

  const httpClient = new x402HTTPClient(client);
  httpClient.onPaymentRequired(async ({ paymentRequired }) => {
    requiredUsd = minRequiredUsd(paymentRequired.accepts);
    // A challenge whose offers we cannot price refuses at the cap: unknown is
    // not permission to spend.
    await assertX402SpendAllowed(connectorType, requiredUsd ?? Number.POSITIVE_INFINITY, capUsd);
  });

  const payFetch = wrapFetchWithPayment(fetch, httpClient);

  const headers: Record<string, string> = {
    ...(opts?.defaultHeaders ?? DEFAULT_PUBLIC_WEB_HEADERS),
    ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(req.headers ?? {}),
  };

  const resp = await payFetch(withQuery(req.url, req.query), {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });

  // Decode the settle receipt, if this call actually paid. A response with no
  // payment-response header (a free endpoint, or a challenge that was never
  // paid) simply passes through.
  let paidUsd: number | undefined;
  let transaction: string | undefined;
  try {
    const settle = httpClient.getPaymentSettleResponse((name) => resp.headers.get(name));
    if (settle && settle.success !== false) {
      transaction = settle.transaction;
      paidUsd = settle.amount !== undefined ? atomicToUsd(settle.amount) : requiredUsd;
    }
  } catch {
    // No settle header on the response — nothing was paid.
  }

  if (paidUsd === undefined || !Number.isFinite(paidUsd)) return resp;

  await recordX402Spend(connectorType, paidUsd);
  logger.info(
    { event: 'x402_payment_settled', connectorType, paidUsd, transaction },
    'x402 payment settled',
  );

  const annotated = new Headers(resp.headers);
  annotated.set(X402_PAID_USD_HEADER, paidUsd.toFixed(6));
  if (transaction) annotated.set(X402_TRANSACTION_HEADER, transaction);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: annotated,
  });
}
