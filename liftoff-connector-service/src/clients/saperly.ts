// Saperly native REST executor — telephony for AI agents (numbers, calls, SMS,
// connections/personas, and TCPA consent).
//
// Supersedes the MCP executor (src/clients/saperly-mcp.ts, removed): Saperly's
// OpenAPI REST surface (https://api.saperly.com) is the complete, canonical one,
// and the MCP subset omitted the consent tools (Saperly rejects outbound to a
// peer with no recorded consent — enforced independently of any model), the
// connection/AI-persona model a number is answered by, and pricing/transcript/
// recording. The REST paths + methods live in SAPERLY_DISPATCH.
//
// BYO-KEY ONLY. Telephony is identity-bound (US A2P 10DLC must be registered
// under the WORKSPACE's own legal identity, in its own Saperly account), so
// there is no platform Saperly credential — the workspace's own key rides as the
// Bearer (makeConnectorTransport). Funding is therefore always 'tenant_key'.
// Write/outbound/destructive tools are approval-gated by their classification
// categories on the platform capability surface (a call or text reaches a real
// person and costs money), so they never run without a human approval.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { SAPERLY_DISPATCH } from '../catalog/generated/saperly.js';
import { makeConnectorTransport } from './connector-transport.js';

const SAPERLY_BASE = 'https://api.saperly.com';

/** Fill `{param}` placeholders in a path from the call input, returning the
 *  resolved path and the set of input keys consumed (so they are not also sent
 *  in the body/query). A placeholder with no matching input value is a caller
 *  error surfaced as a typed failure by the executor. */
function fillPath(path: string, input: JsonObject): { path: string; used: Set<string>; missing: string | null } {
  const used = new Set<string>();
  let missing: string | null = null;
  const filled = path.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) {
      used.add(key);
      return encodeURIComponent(v);
    }
    if (typeof v === 'number') {
      used.add(key);
      return encodeURIComponent(String(v));
    }
    missing = key;
    return '';
  });
  return { path: filled, used, missing };
}

export async function saperlyExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = SAPERLY_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return { result: {}, failure: { message: `saperly has no tool named ${ctx.functionName}` } };
  }

  // BYO-only: the workspace's own Saperly key. No platform fallback exists.
  const apiKey = ctx.credentials.apiKey;
  if (!apiKey) {
    return {
      result: {},
      failure: { message: 'saperly requires a connected workspace key (there is no platform Saperly account)' },
    };
  }

  const { path, used, missing } = fillPath(dispatch.path, ctx.input);
  if (missing) {
    return { result: {}, failure: { message: `saperly.${ctx.functionName}: missing required '${missing}'` } };
  }

  // Everything not consumed by a path placeholder is the payload: query for a
  // GET, JSON body otherwise.
  const isGet = dispatch.method === 'GET';
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.input)) {
    if (!used.has(k)) payload[k] = v;
  }
  const query: Record<string, string> = {};
  if (isGet) {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.trim()) query[k] = v.trim();
      else if (typeof v === 'number' && Number.isFinite(v)) query[k] = String(v);
      else if (typeof v === 'boolean') query[k] = String(v);
    }
  }

  const transport = makeConnectorTransport({ accessToken: apiKey }, 'saperly');
  const started = Date.now();
  try {
    const resp = await transport({
      method: dispatch.method,
      url: `${SAPERLY_BASE}${path}`,
      ...(isGet ? { query } : { body: payload }),
    });
    const vendorLatencyMs = Date.now() - started;
    const parsed = (await resp.json().catch(() => ({}))) as JsonObject & { error?: unknown; message?: unknown };

    if (!resp.ok) {
      const detail =
        (typeof parsed.error === 'string' && parsed.error) ||
        (typeof parsed.message === 'string' && parsed.message) ||
        `HTTP ${resp.status}`;
      return {
        result: parsed ?? {},
        vendorLatencyMs,
        failure: { message: `saperly.${ctx.functionName}: ${detail}` },
      };
    }

    return {
      // Saperly returns the resource JSON directly. No per-call USD is reported
      // on the wire (number rental is a monthly charge, calls/SMS metered on the
      // workspace's own prepaid balance), so costUsd is left unset — the call is
      // still recorded as usage, and get_usage reads the balance.
      result: parsed ?? {},
      vendorLatencyMs,
      fundingSource: 'tenant_key',
    };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `saperly.${ctx.functionName}: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('saperly', saperlyExecutor);
