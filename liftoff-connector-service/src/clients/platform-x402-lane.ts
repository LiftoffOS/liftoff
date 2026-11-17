// Who pays for a platform-funded x402 call, in order.
//
// Three of the keyless x402 vendors (strale, kadec0, google_trends) are also
// resold by Vaaya, which settles with the merchant out of a prepaid balance
// that auto-reloads. The platform's own x402 wallet does not auto-reload yet,
// so a wallet that runs dry takes those capabilities dark until someone tops
// it up by hand. Asking Vaaya first removes that outage; the wallet stays as
// the lane behind it and is still the only funder for an endpoint Vaaya does
// not resell (the generated map says which — browserbase_x402 is none of
// them, because Vaaya resells Browserbase session lifecycle and we call
// /search and /fetch).
//
// This is a resilience order, not a cheaper one. Measured against the Vaaya
// catalog, Vaaya is dearer on 176 of the 178 endpoints that map
// — about 1.4x on strale and kadec0, up to 1.67x on trends — and those are
// pass-through charges, so the premium reaches the customer's Operating Units.
// Set VAAYA_PASSTHROUGH=off to put every one of these calls back on the wallet.
//
// The fallthrough rule is the one that matters: the wallet is asked ONLY when
// Vaaya charged nothing. Vaaya reports a failed call as charged_cents 0 and
// bills nothing for it, so a refusal costs us a little latency and never a
// double payment; but if Vaaya did charge, that answer is the answer, success
// or failure, because paying twice for one call is the harm being avoided.

import type { JsonObject } from '@bufbuild/protobuf';
import { VAAYA_PASSTHROUGH } from '../catalog/generated/vaaya-passthrough.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS } from './connector-transport.js';
import { VAAYA_API_KEY_ENV, maxCostCents } from './vaaya.js';
import { logger } from '../infra/logging.js';

const VAAYA_BASE = 'https://vaaya.ai/api/run';

/** The funders for a platform-paid x402 call, in the order they are asked.
 *  A workspace's OWN key, where a vendor has one, is resolved by the executor
 *  before it ever reaches this lane. */
export const PLATFORM_X402_FUNDERS = ['vaaya', 'x402_wallet'] as const;

export type PlatformX402Outcome =
  | { funded: true; result: JsonObject; raw: unknown; costUsd: number; vendorLatencyMs: number; failure?: { message: string } }
  | { funded: false; reason: 'not_mapped' | 'not_configured' | 'disabled' | 'unpaid' };

interface VaayaAnswer {
  ok?: boolean;
  data?: unknown;
  charged_cents?: number;
  error?: string | { message?: string };
  message?: string;
}

/** Ask the platform's Vaaya balance to pay for one upstream x402 call.
 *  Returns `funded: false` whenever the wallet should be asked instead. */
export async function payViaVaaya(opts: {
  connectorType: string;
  functionName: string;
  path: string;
  input: JsonObject;
  declaredPriceUsd?: number;
}): Promise<PlatformX402Outcome> {
  if (process.env.VAAYA_PASSTHROUGH === 'off') return { funded: false, reason: 'disabled' };

  const mapped = VAAYA_PASSTHROUGH[opts.connectorType]?.[opts.path];
  if (!mapped) return { funded: false, reason: 'not_mapped' };

  const apiKey = process.env[VAAYA_API_KEY_ENV]?.trim();
  if (!apiKey) return { funded: false, reason: 'not_configured' };

  // The ceiling is Vaaya's own listed price doubled where it lists one, since
  // Vaaya's price is the one being quoted; our declared price is the fallback
  // for an endpoint it quotes per call.
  const capCents =
    mapped.priceCents !== null
      ? Math.max(1, mapped.priceCents * 2)
      : maxCostCents(opts.declaredPriceUsd ?? 0.05);

  const transport = makePublicWebTransport('vaaya', {
    ...DEFAULT_PUBLIC_WEB_HEADERS,
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  });
  const started = Date.now();
  let body: VaayaAnswer = {};
  let status = 0;
  try {
    const resp = await transport({
      method: 'POST',
      url: `${VAAYA_BASE}/${mapped.action}`,
      // `endpoint` LAST for the same reason the vaaya executor spreads its
      // fixed arguments last: the upstream path is the platform's choice, and
      // an input argument must not be able to point the call somewhere else.
      body: { ...opts.input, endpoint: mapped.endpoint, max_cost_cents: capCents },
    });
    status = resp.status;
    body = (await resp.json().catch(() => ({}))) as VaayaAnswer;
  } catch (err) {
    logger.info(
      { event: 'vaaya_passthrough_unreachable', connectorType: opts.connectorType, functionName: opts.functionName, err: (err as Error).message },
      'the vaaya lane could not be reached; the x402 wallet pays for this call',
    );
    return { funded: false, reason: 'unpaid' };
  }

  const vendorLatencyMs = Date.now() - started;
  const charged = typeof body.charged_cents === 'number' && Number.isFinite(body.charged_cents) ? body.charged_cents : 0;
  const ok = status === 200 && body.ok !== false;

  if (!ok && charged <= 0) {
    // Nothing was paid, so nothing is lost by letting the wallet try.
    logger.info(
      { event: 'vaaya_passthrough_declined', connectorType: opts.connectorType, functionName: opts.functionName, status },
      'the vaaya lane did not answer and charged nothing; the x402 wallet pays for this call',
    );
    return { funded: false, reason: 'unpaid' };
  }

  if (!ok) {
    // Charged and still failed: report the charge rather than pay again.
    const detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? `HTTP ${status}`;
    return {
      funded: true,
      result: {},
      raw: null,
      costUsd: charged / 100,
      vendorLatencyMs,
      failure: { message: `${opts.connectorType} ${opts.functionName} failed: ${detail}` },
    };
  }

  const data = body.data;
  const result: JsonObject =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as JsonObject)
      : ({ items: data ?? [] } as unknown as JsonObject);
  return { funded: true, result, raw: data ?? null, costUsd: charged / 100, vendorLatencyMs };
}
