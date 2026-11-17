// People Data Labs native REST executor — person/company enrichment & search.
//
// Bypasses Composio: a native REST executor over PDL's v5 API
// (api.peopledatalabs.com/v5), exposing the curated lead-gen set in
// generated/pdl.ts. Auth is PDL's `X-Api-Key` header (not a bearer, not a query
// param), so the public-web transport carries the request with that header —
// the platform key on the internal:pdl path, or a workspace's own connected key.
//
// PDL is pay-per-MATCH: an enrich that finds a record consumes a credit; a
// no-match or a 400 does not. Every function is a read; the balance is a
// fail-closed concern (no auto-reload on the free tier), not a gating one.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { PDL_DISPATCH } from '../catalog/generated/pdl.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS } from './connector-transport.js';
import { resolvePlatformVendorKey, tenantOwnApiKey } from './platform-vendor-keys.js';

const PDL_BASE = 'https://api.peopledatalabs.com';

interface PdlResponse {
  status?: number;
  data?: unknown;
  error?: { type?: unknown; message?: string };
  matches?: unknown;
}

export async function pdlExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = PDL_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return { result: {}, failure: { message: `pdl has no tool named ${ctx.functionName}` } };
  }
  const byoKey = tenantOwnApiKey(ctx);
  const apiKey = ctx.credentials.apiKey || resolvePlatformVendorKey('pdl');
  if (!apiKey) {
    return { result: {}, failure: { message: 'pdl credential is not provisioned (no tenant key, no platform key)' } };
  }
  const funding = byoKey ? ('tenant_key' as const) : ('platform_key' as const);

  const transport = makePublicWebTransport('pdl', { ...DEFAULT_PUBLIC_WEB_HEADERS, 'X-Api-Key': apiKey });
  const isGet = dispatch.method === 'GET';
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
      method: dispatch.method,
      url: `${PDL_BASE}${dispatch.path}`,
      ...(isGet ? { query } : { body: ctx.input }),
    });
    const vendorLatencyMs = Date.now() - started;
    const parsed = (await resp.json().catch(() => ({}))) as PdlResponse;

    if (!resp.ok || (typeof parsed.status === 'number' && parsed.status >= 400)) {
      return {
        result: (parsed as JsonObject) ?? {},
        vendorLatencyMs,
        failure: {
          message: `pdl.${ctx.functionName}: ${parsed.error?.message ?? `HTTP ${resp.status}`}`,
        },
      };
    }

    // PDL returns { status, data } for enrich, { data: [...] } / { matches }
    // for search/identify. Surface whichever is present. No per-call USD is
    // reported (credits are a plan quota), so costUsd is left unset; the call is
    // recorded as usage regardless.
    const payload = parsed.data ?? parsed.matches ?? null;
    return {
      result: { data: payload as JsonObject[keyof JsonObject] },
      vendorLatencyMs,
      fundingSource: funding,
    };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `pdl.${ctx.functionName}: request failed (${(err as Error).message})` },
    };
  }
}

registerConnectorExecutor('pdl', pdlExecutor);
