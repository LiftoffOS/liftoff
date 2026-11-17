// Vaaya native executor — enrichment, signal and public-records vendors
// resold per call on one prepaid balance the platform funds.
//
// One platform account, a `vaaya_sk_` bearer from the environment, and one
// call shape: POST https://vaaya.ai/api/run/{service}/{action} with the
// action's own parameters plus `max_cost_cents`, a ceiling Vaaya enforces
// BEFORE dispatch (a dearer quote is refused and nothing is charged). The
// answer is `{ ok, data, charged_cents, balance_remaining_cents,
// transaction_id }`; a 5xx is not charged. The charge Vaaya reports is this
// call's costUsd, funded by the platform (`platform_key`), so the customer's
// Operating Units are drawn from what the call actually cost.
//
// No BYO lane here: a workspace that holds its own account with the vendor
// behind a function connects THAT vendor's card (tomba is not one yet; the
// email vendors are hunterio/contactout/pdl), and discovery ranks its own
// connection ahead of this rung. The vendor behind each function is a
// dispatch detail in catalog/generated/vaaya.ts, never a name the model sees.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { VAAYA_DISPATCH } from '../catalog/generated/vaaya.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS } from './connector-transport.js';

const VAAYA_BASE = 'https://vaaya.ai/api/run';
export const VAAYA_API_KEY_ENV = 'VAAYA_API_KEY';

/** Vaaya's ceiling is whole cents; the guard rule everywhere else is the
 *  declared price ×2. A $0.01 action therefore caps at 2¢, a $0.25 one at 50¢. */
export function maxCostCents(priceUsd: number): number {
  return Math.max(1, Math.ceil(priceUsd * 2 * 100));
}

interface VaayaAnswer {
  ok?: boolean;
  data?: unknown;
  charged_cents?: number;
  balance_remaining_cents?: number;
  transaction_id?: string;
  error?: string | { message?: string; code?: string };
  message?: string;
}

function errorText(body: VaayaAnswer, status: number): string {
  const e = body.error;
  const text = typeof e === 'string' ? e : e?.message ?? body.message;
  return text ? `HTTP ${status} ${text}` : `HTTP ${status}`;
}

/** The platform's prepaid Vaaya balance, in USD (the wallet reports cents).
 *  Vaaya sells packs and never recharges on its own, so this is the figure
 *  platform-backend's vendor-spend monitor watches. */
export async function vaayaBalanceUsd(): Promise<number> {
  const apiKey = process.env[VAAYA_API_KEY_ENV]?.trim();
  if (!apiKey) throw new Error('vaaya credential is not provisioned (no platform key)');
  const transport = makePublicWebTransport('vaaya', { ...DEFAULT_PUBLIC_WEB_HEADERS, Accept: 'application/json', Authorization: `Bearer ${apiKey}` });
  const resp = await transport({ method: 'GET', url: 'https://vaaya.ai/api/v1/wallet' });
  const body = (await resp.json().catch(() => ({}))) as { wallet?: { prepaid_cents?: number } };
  if (!resp.ok) throw new Error(`vaaya wallet: HTTP ${resp.status}`);
  const cents = body.wallet?.prepaid_cents;
  if (typeof cents !== 'number' || !Number.isFinite(cents)) throw new Error('vaaya wallet: no prepaid_cents in the answer');
  return cents / 100;
}

export async function vaayaExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = VAAYA_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return { result: {}, failure: { message: `vaaya has no tool named ${ctx.functionName}` } };
  }
  const apiKey = process.env[VAAYA_API_KEY_ENV]?.trim();
  if (!apiKey) {
    return { result: {}, failure: { message: 'vaaya credential is not provisioned (no platform key)' } };
  }

  const transport = makePublicWebTransport('vaaya', {
    ...DEFAULT_PUBLIC_WEB_HEADERS,
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  });
  const started = Date.now();
  try {
    const resp = await transport({
      method: 'POST',
      url: `${VAAYA_BASE}/${dispatch.action}`,
      // `fixed` LAST, deliberately: a meta-action like the market-data rung's
      // `fetch` takes the upstream path as an ordinary parameter, and the path
      // is the platform's choice, not the model's. Spreading it after the
      // model's input means a function is pinned to the endpoint its
      // definition names and cannot be pointed somewhere else by an argument.
      body: { ...ctx.input, ...(dispatch.fixed ?? {}), max_cost_cents: maxCostCents(dispatch.priceUsd) },
    });
    const vendorLatencyMs = Date.now() - started;
    const body = (await resp.json().catch(() => ({}))) as VaayaAnswer;

    if (!resp.ok || body.ok === false) {
      // 402 here is Vaaya's own balance (or a refused ceiling), not an x402
      // challenge: the platform account is empty, which is a funding matter.
      // Worded as an explicit payment-required status so the capability
      // path parks this rung for a while instead of retrying it every call.
      const detail = resp.status === 402 ? 'HTTP 402 payment required (platform balance exhausted or ceiling refused)' : errorText(body, resp.status);
      return {
        result: {},
        vendorLatencyMs,
        failure: { message: `vaaya ${ctx.functionName} failed: ${detail}` },
      };
    }

    const charged = typeof body.charged_cents === 'number' && Number.isFinite(body.charged_cents) ? body.charged_cents : 0;
    const data = body.data;
    const result: JsonObject =
      data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as JsonObject)
        : ({ items: data ?? [] } as unknown as JsonObject);
    return {
      result,
      vendorLatencyMs,
      costUsd: charged / 100,
      fundingSource: 'platform_key',
    };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `vaaya request failed: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('vaaya', vaayaExecutor);
