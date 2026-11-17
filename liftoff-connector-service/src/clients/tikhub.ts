// TikHub native executor — direct REST against api.tikhub.io.
//
// The generated registry (catalog/generated/tikhub.ts) carries a co-generated
// DISPATCH map (function name -> the vendor's own method + path), so this
// executor never guesses a route and can never drift from the functions the
// distiller sees: both come off the same OpenAPI in the same generator run.
//
// TikHub retrieves public social-platform data and mutates nothing anywhere;
// every function is read-classified. GET inputs travel as query parameters,
// the few POST operations take the input as a JSON body. Credential: the
// tenant's own key when the connector instance carries one, else the platform
// key (platform-funded default for this internal-tier vendor).

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { TIKHUB_DISPATCH } from '../catalog/generated/tikhub.js';
import { TIKHUB_PRICES } from '../catalog/generated/tikhub-prices.js';
import { makeConnectorTransport, type HttpMethod } from './connector-transport.js';
import { resolvePlatformVendorKey } from './platform-vendor-keys.js';

const BASE_URL = 'https://api.tikhub.io';

function buildQuery(input: JsonObject): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue;
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** The answer inside the vendor's envelope. A 2xx body is
 *  `{ code, router, params, data, ... }` plus the vendor's own presentation:
 *  a docs link on its domain, a support link, a billing notice in two
 *  languages, a cache note. The result is domain data the model reads as
 *  written, and a platform vendor is never named to a model, so only the
 *  fields that carry the answer travel: the status code, the route (a path,
 *  no host), the echoed parameters and the data. A body without `data` is
 *  passed whole, so an unfamiliar shape loses nothing. */
function answerOf(body: JsonObject): JsonObject {
  if (!('data' in body)) return body;
  const kept: JsonObject = {};
  for (const key of ['code', 'router', 'params', 'data'] as const) {
    if (key in body) kept[key] = body[key];
  }
  return kept;
}

export async function tikhubExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = TIKHUB_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return {
      result: {},
      failure: { message: `tikhub has no operation named ${ctx.functionName}` },
    };
  }
  const apiKey = ctx.credentials.apiKey || resolvePlatformVendorKey('tikhub');
  if (!apiKey) {
    return {
      result: {},
      failure: { message: 'tikhub credential is not provisioned (no tenant key and no platform key)' },
    };
  }

  const isGet = dispatch.method === 'get';
  const url = `${BASE_URL}${dispatch.path}${isGet ? buildQuery(ctx.input) : ''}`;
  const started = Date.now();
  // The shared transport applies the authorization; the api key rides as the
  // access token because TikHub's convention IS a bearer.
  const transport = makeConnectorTransport({ accessToken: apiKey }, 'tikhub');
  try {
    const resp = await transport({
      method: dispatch.method.toUpperCase() as HttpMethod,
      url,
      ...(isGet ? {} : { body: ctx.input }),
    });
    const vendorLatencyMs = Date.now() - started;
    const text = await resp.text();
    let body: JsonObject;
    try {
      body = JSON.parse(text) as JsonObject;
    } catch {
      body = { raw: text.slice(0, 4000) };
    }
    if (!resp.ok) {
      return {
        result: body,
        vendorLatencyMs,
        failure: { message: `tikhub ${dispatch.path} returned ${resp.status}` },
      };
    }
    // TikHub is prepaid and returns no per-call charge in the response, so the
    // cost is its own declared per-endpoint price (tikhub-prices.ts, from
    // get_all_endpoints_info). Without it the call books $0 and the workspace
    // is never OU-charged for it (INV-PB-013). A stale path absent from the
    // price table leaves costUsd unset rather than guessing.
    const costUsd = TIKHUB_PRICES[dispatch.path];
    return {
      result: answerOf(body),
      vendorLatencyMs,
      ...(typeof costUsd === 'number' ? { costUsd } : {}),
    };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `tikhub request failed: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('tikhub', tikhubExecutor);
