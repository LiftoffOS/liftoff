// Browserbase pay-per-use native executor — x402 per-call payments.
//
// POSTs on x402.browserbase.com; each priced endpoint answers 402 (protocol
// v1 — network name 'base') and the x402 transport pays it from the platform
// wallet and retries. No credential, no BYO lane: the payment is the
// authorization. NOT the BYOK 'browserbase' web-tool connector, which is a
// tenant's own key driven from the tenant runtime — this type is
// 'browserbase_x402' and is platform-funded per call.
//
// Only the request/response tools (search, fetch) are served; the
// session-shaped endpoints are excluded on purpose (see the generated
// registry's header). costUsd is the settled amount off the payment receipt.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { BROWSERBASE_X402_DISPATCH } from '../catalog/generated/browserbase-x402.js';
import { makeX402Transport, readX402Receipt } from './connector-transport.js';

const BASE_URL = 'https://x402.browserbase.com';

/** The body fields each tool forwards. An allow-list rather than a
 *  passthrough: the gateway also accepts knobs we deliberately do not expose
 *  (allowInsecureSsl bypasses TLS verification; proxies changes routing), and
 *  an agent must not discover them by guessing. */
const FORWARDED_FIELDS: Record<string, string[]> = {
  search_the_web: ['query', 'numResults'],
  fetch_page_content: ['url', 'allowRedirects'],
};

export async function browserbaseX402Executor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = BROWSERBASE_X402_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return {
      result: {},
      failure: { message: `browserbase_x402 has no tool named ${ctx.functionName}` },
    };
  }

  const body: JsonObject = {};
  for (const field of FORWARDED_FIELDS[ctx.functionName] ?? []) {
    const v = ctx.input[field];
    if (v !== undefined && v !== null) (body as Record<string, unknown>)[field] = v;
  }

  const transport = makeX402Transport('browserbase_x402', { declaredPriceUsd: dispatch.priceUsd });
  const started = Date.now();
  try {
    const resp = await transport({
      method: 'POST',
      url: `${BASE_URL}${dispatch.path}`,
      body,
    });
    const vendorLatencyMs = Date.now() - started;
    const parsed = (await resp.json().catch(() => ({}))) as JsonObject;

    if (!resp.ok) {
      return {
        result: parsed ?? {},
        vendorLatencyMs,
        failure: {
          message: `browserbase_x402 ${ctx.functionName} failed: HTTP ${resp.status} ${
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
      failure: { message: `browserbase_x402 request failed: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('browserbase_x402', browserbaseX402Executor);
