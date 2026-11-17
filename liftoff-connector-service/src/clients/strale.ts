// Strale native executor — one capability surface, three ways to pay for it.
//
// Strale's REST surface is one execution endpoint taking a capability slug;
// the per-capability functions the distiller sees come from the generated
// registry, and the co-generated DISPATCH map carries each function's slug
// path and the vendor's declared per-call price. The meta-shape stays fully
// contained here: every caller upstream deals in named, individually
// classified functions, never in a do-everything tool.
//
// Whose money pays, in order:
//   1. A workspace's OWN key (a real connector instance carrying a tenant
//      credential): the API-KEY lane (POST /v1/do), funded from THEIR strale
//      balance, booked tenant_key. Their key, their account, always first.
//   2. The platform's Vaaya balance, which resells 167 of the 334 registry
//      capabilities and auto-reloads. Asked first among the platform lanes
//      because the wallet below it does not auto-reload yet, so this is what
//      keeps those capabilities answering once the wallet runs dry. It
//      declines everything it does not resell and costs more where it does
//      (see platform-x402-lane.ts); VAAYA_PASSTHROUGH=off removes the rung.
//   3. The platform x402 wallet: the per-capability /x402/v2/<slug> endpoints
//      the DISPATCH map carries, paid per call in USDC. Taken for every
//      platform-funded call when STRALE_X402_ENABLED=true and the wallet is
//      configured. Every call stamps fundingSource on the wire, which is
//      what the tenant runtime and the control plane book from (INV-PB-013);
//      the flag exists so moving the platform's strale spend onto the wallet
//      is one deliberate operator change, never a side effect of a key
//      going missing.
//   4. The platform key (STRALE_PLATFORM_API_KEY), funded from the platform's
//      strale balance: ONLY for a function Strale does not sell over x402
//      (its x402 catalog answers 404 "not available via x402"; 72 of the 334
//      registry functions), and only while the key is mounted.
//      Unmount the key and those functions become BYO-only, cleanly.
//   With the flag off, 4 is the platform lane as it was before the wallet.
//
// The declared price does double duty: it becomes the per-call spend cap
// (max_price_cents on the key lane, the x402 guard's cap on the other, both
// with headroom for the vendor's own rounding) and the fallback costUsd when
// the response omits the actual charge. The response's own account of what
// it charged — price_cents, or the x402 settle receipt — beats our copy of
// the price list.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { STRALE_DISPATCH } from '../catalog/generated/strale.js';
import { makeConnectorTransport, makeX402Transport, readX402Receipt } from './connector-transport.js';
import { resolvePlatformVendorKey, tenantOwnApiKey } from './platform-vendor-keys.js';
import { isX402Configured } from '../x402/wallet.js';
import { payViaVaaya } from './platform-x402-lane.js';
import { logger } from '../infra/logging.js';

const DO_URL = 'https://api.strale.io/v1/do';
const X402_BASE_URL = 'https://api.strale.io';

interface StraleDoResponse {
  result?: {
    status?: string;
    output?: unknown;
    price_cents?: number;
    provenance?: unknown;
  };
  error_code?: string;
  message?: string;
}

export async function straleExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = STRALE_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return {
      result: {},
      failure: { message: `strale has no capability named ${ctx.functionName}` },
    };
  }
  // A workspace's own key wins outright. (On the `internal:` path the
  // dispatcher rides the PLATFORM key in credentials so it joins the
  // secret-scrub set; tenantOwnApiKey tells the two apart.)
  const byoKey = tenantOwnApiKey(ctx);
  if (byoKey) return straleKeyCall(ctx, dispatch, byoKey, 'tenant_key');

  // Not the tenant's, so whatever rides in credentials is the platform key
  // the dispatcher put there; the env is the fallback for a caller that
  // did not.
  const platformKey = ctx.credentials.apiKey?.trim() || resolvePlatformVendorKey('strale');

  // The auto-reloading rung, ahead of both platform balances. It answers only
  // for a capability it resells and charges nothing when it cannot, so the
  // lanes below are reached unchanged.
  const viaVaaya = await payViaVaaya({
    connectorType: 'strale',
    functionName: ctx.functionName,
    path: dispatch.path,
    input: ctx.input,
    declaredPriceUsd: dispatch.priceUsd,
  });
  if (viaVaaya.funded) {
    return {
      // The key lane's shape, so no caller can tell which lane paid.
      result: { output: (viaVaaya.raw ?? null) as JsonObject[keyof JsonObject], provenance: null },
      vendorLatencyMs: viaVaaya.vendorLatencyMs,
      costUsd: viaVaaya.costUsd,
      fundingSource: 'platform_key',
      ...(viaVaaya.failure ? { failure: viaVaaya.failure } : {}),
    };
  }

  if (process.env.STRALE_X402_ENABLED === 'true' && isX402Configured()) {
    const paid = await straleX402Call(ctx, dispatch);
    if (!paid.notSoldOverX402 || !platformKey) return paid.result;
    logger.info(
      { event: 'strale_x402_unavailable_key_fallback', functionName: ctx.functionName },
      'strale does not sell this capability over x402; the platform key runs it',
    );
    return straleKeyCall(ctx, dispatch, platformKey, 'platform_key');
  }
  if (platformKey) return straleKeyCall(ctx, dispatch, platformKey, 'platform_key');
  return {
    result: {},
    failure: { message: 'strale credential is not provisioned (no tenant key, no platform key, and the x402 lane is not enabled)' },
  };
}

/** The API-key lane: POST /v1/do with a bearer, funded from whichever strale
 *  account the bearer belongs to. */
async function straleKeyCall(
  ctx: ExecutorContext,
  dispatch: { method: string; path: string; priceUsd?: number },
  apiKey: string,
  fundingSource: 'tenant_key' | 'platform_key',
): Promise<ExecutorResult> {
  const slug = dispatch.path.split('/').filter(Boolean).pop() ?? '';
  const body: JsonObject = {
    capability_slug: slug,
    inputs: ctx.input,
    // Our spend cap for this one call: double the declared price, floor 10
    // cents, so a vendor-side reprice fails the call instead of silently
    // charging more. Left unset when no price is declared — the vendor's own
    // default cap applies.
    ...(typeof dispatch.priceUsd === 'number'
      ? { max_price_cents: Math.max(Math.ceil(dispatch.priceUsd * 100) * 2, 10) }
      : {}),
  };

  const started = Date.now();
  // The shared transport applies the authorization (Strale's convention is a
  // bearer); the idempotency key rides as an extra header.
  const transport = makeConnectorTransport({ accessToken: apiKey }, 'strale');
  try {
    const resp = await transport({
      method: 'POST',
      url: DO_URL,
      body,
      headers: { 'Idempotency-Key': ctx.idempotencyKey },
    });
    const vendorLatencyMs = Date.now() - started;
    const parsed = (await resp.json().catch(() => ({}))) as StraleDoResponse;

    if (!resp.ok || parsed.error_code) {
      return {
        result: (parsed as JsonObject) ?? {},
        vendorLatencyMs,
        failure: {
          message: `strale ${slug} failed: ${parsed.error_code ?? resp.status} ${parsed.message ?? ''}`.trim(),
        },
      };
    }
    if (parsed.result?.status && parsed.result.status !== 'completed') {
      return {
        result: (parsed.result ?? {}) as JsonObject,
        vendorLatencyMs,
        failure: { message: `strale ${slug} ended in status ${parsed.result.status}` },
      };
    }

    const chargedCents = parsed.result?.price_cents;
    const costUsd =
      typeof chargedCents === 'number' ? chargedCents / 100 : dispatch.priceUsd;
    return {
      result: {
        output: (parsed.result?.output ?? null) as JsonObject[keyof JsonObject],
        provenance: (parsed.result?.provenance ?? null) as JsonObject[keyof JsonObject],
      },
      vendorLatencyMs,
      ...(typeof costUsd === 'number' ? { costUsd } : {}),
      // The per-call price drains whichever account the bearer belongs to.
      fundingSource,
    };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `strale request failed: ${(err as Error).message}` },
    };
  }
}

/** Strale's answer for a capability its x402 catalog does not carry (read
 *  live: HTTP 404, "Capability not found or not available via
 *  x402."). The one refusal that means "another lane", not "this call
 *  failed". */
function notSoldOverX402(status: number, parsed: { error?: unknown }): boolean {
  return status === 404 && typeof parsed.error === 'string' && /not available via x402/i.test(parsed.error);
}

/** The keyless lane: pay the capability's own /x402/v2/<slug> endpoint per
 *  call. The DISPATCH map's path and method describe this surface directly;
 *  GET capabilities take the inputs as query params, POST as the JSON body.
 *  The result keeps the key lane's { output, provenance } shape so callers
 *  cannot tell the lanes apart. `notSoldOverX402` is set when the vendor
 *  says this capability has no x402 endpoint at all. */
async function straleX402Call(
  ctx: ExecutorContext,
  dispatch: { method: string; path: string; priceUsd?: number },
): Promise<{ result: ExecutorResult; notSoldOverX402: boolean }> {
  const transport = makeX402Transport('strale', { declaredPriceUsd: dispatch.priceUsd });
  const isGet = dispatch.method.toUpperCase() === 'GET';
  const query: Record<string, string> = {};
  if (isGet) {
    for (const [k, v] of Object.entries(ctx.input)) {
      if (typeof v === 'string' && v.trim()) query[k] = v.trim();
      else if (typeof v === 'number' && Number.isFinite(v)) query[k] = String(v);
      else if (typeof v === 'boolean') query[k] = String(v);
    }
  }

  const started = Date.now();
  try {
    const resp = await transport({
      method: isGet ? 'GET' : 'POST',
      url: `${X402_BASE_URL}${dispatch.path}`,
      ...(isGet ? { query } : { body: ctx.input }),
      headers: { 'Idempotency-Key': ctx.idempotencyKey },
    });
    const vendorLatencyMs = Date.now() - started;
    const parsed = (await resp.json().catch(() => ({}))) as JsonObject;

    if (!resp.ok) {
      return {
        notSoldOverX402: notSoldOverX402(resp.status, parsed as { error?: unknown }),
        result: {
          result: parsed ?? {},
          vendorLatencyMs,
          failure: {
            message: `strale ${ctx.functionName} failed: HTTP ${resp.status} ${
              (parsed as { error?: string; message?: string }).error
              ?? (parsed as { message?: string }).message ?? ''
            }`.trim(),
          },
        },
      };
    }

    const receipt = readX402Receipt(resp);
    return {
      notSoldOverX402: false,
      result: {
        result: {
          output: (parsed ?? null) as JsonObject[keyof JsonObject],
          provenance: null,
        },
        vendorLatencyMs,
        ...(receipt ? { costUsd: receipt.amountUsd } : {}),
        fundingSource: 'x402_wallet',
      },
    };
  } catch (err) {
    return {
      notSoldOverX402: false,
      result: {
        result: {},
        vendorLatencyMs: Date.now() - started,
        failure: { message: `strale x402 request failed: ${(err as Error).message}` },
      },
    };
  }
}

registerConnectorExecutor('strale', straleExecutor);
