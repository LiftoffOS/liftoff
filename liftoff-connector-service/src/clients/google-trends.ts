// Google Trends native executor — pay-per-call via x402 (the x402 Atlas).
//
// Keyless GETs on google-trends.use.x402atlas.com; every priced endpoint
// answers 402 (x402 v2) and the x402 transport pays it from the platform
// wallet and retries. No credential exists for this vendor at all — the
// payment is the authorization — so there is no BYO lane and no platform key.
//
// The generated registry (catalog/generated/google-trends.ts) carries each
// tool's path and DECLARED price; the price seeds the spend guard's per-call
// cap (declared ×2, floor $0.02) so a vendor-side reprice fails the call
// instead of silently charging more. costUsd is the settled amount off the
// payment receipt — the vendor's account of what it charged beats our copy
// of the price list.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { GOOGLE_TRENDS_DISPATCH } from '../catalog/generated/google-trends.js';
import { makeX402Transport, readX402Receipt } from './connector-transport.js';
import { payViaVaaya } from './platform-x402-lane.js';

const BASE_URL = 'https://google-trends.use.x402atlas.com';

function queryFrom(input: JsonObject): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.trim()) query[k] = v.trim();
    else if (typeof v === 'number' && Number.isFinite(v)) query[k] = String(v);
  }
  return query;
}

export async function googleTrendsExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = GOOGLE_TRENDS_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return {
      result: {},
      failure: { message: `google_trends has no tool named ${ctx.functionName}` },
    };
  }

  // Vaaya's auto-reloading balance is asked before the platform's own x402
  // wallet, which has no auto-reload yet; it declines for anything it does not
  // resell and the wallet pays for those.
  const viaVaaya = await payViaVaaya({
    connectorType: 'google_trends',
    functionName: ctx.functionName,
    path: dispatch.path,
    input: ctx.input,
    declaredPriceUsd: dispatch.priceUsd,
  });
  if (viaVaaya.funded) {
    return {
      result: viaVaaya.result,
      vendorLatencyMs: viaVaaya.vendorLatencyMs,
      costUsd: viaVaaya.costUsd,
      fundingSource: 'platform_key',
      ...(viaVaaya.failure ? { failure: viaVaaya.failure } : {}),
    };
  }

  const transport = makeX402Transport('google_trends', { declaredPriceUsd: dispatch.priceUsd });
  const started = Date.now();
  try {
    const resp = await transport({
      method: 'GET',
      url: `${BASE_URL}${dispatch.path}`,
      query: queryFrom(ctx.input),
    });
    const vendorLatencyMs = Date.now() - started;
    const parsed = (await resp.json().catch(() => ({}))) as JsonObject;

    if (!resp.ok) {
      return {
        result: parsed ?? {},
        vendorLatencyMs,
        failure: {
          message: `google_trends ${ctx.functionName} failed: HTTP ${resp.status} ${
            (parsed as { error?: string }).error ?? ''
          }`.trim(),
        },
      };
    }

    const receipt = readX402Receipt(resp);
    return {
      result: parsed ?? {},
      vendorLatencyMs,
      costUsd: receipt?.amountUsd ?? 0,
      fundingSource: 'x402_wallet',
    };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `google_trends request failed: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('google_trends', googleTrendsExecutor);
