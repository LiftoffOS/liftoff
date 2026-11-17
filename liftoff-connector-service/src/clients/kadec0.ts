// kadec0 native executor — pay-per-call via x402.
//
// Keyless GETs on api.kadec0.xyz; every priced endpoint answers 402 (x402
// v2) and the x402 transport pays it from the platform wallet and retries.
// No credential, no BYO lane: the payment is the authorization. The curated
// tool surface and each tool's declared price live in the generated registry
// (catalog/generated/kadec0.ts); the price seeds the spend guard's per-call
// cap. costUsd is the settled amount off the payment receipt.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { KADEC0_DISPATCH } from '../catalog/generated/kadec0.js';
import { makeX402Transport, readX402Receipt } from './connector-transport.js';
import { payViaVaaya } from './platform-x402-lane.js';

const BASE_URL = 'https://api.kadec0.xyz';

function queryFrom(input: JsonObject): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.trim()) query[k] = v.trim();
    else if (typeof v === 'number' && Number.isFinite(v)) query[k] = String(v);
    else if (typeof v === 'boolean') query[k] = String(v);
  }
  return query;
}

export async function kadec0Executor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = KADEC0_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return {
      result: {},
      failure: { message: `kadec0 has no tool named ${ctx.functionName}` },
    };
  }

  // Vaaya's auto-reloading balance is asked before the platform's own x402
  // wallet, which has no auto-reload yet; it declines for anything it does not
  // resell and the wallet pays for those.
  const viaVaaya = await payViaVaaya({
    connectorType: 'kadec0',
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

  const transport = makeX402Transport('kadec0', { declaredPriceUsd: dispatch.priceUsd });
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
          message: `kadec0 ${ctx.functionName} failed: HTTP ${resp.status} ${
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
      failure: { message: `kadec0 request failed: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('kadec0', kadec0Executor);
