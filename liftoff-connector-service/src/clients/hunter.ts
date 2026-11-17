// Hunter.io native REST executor — email/company/person enrichment & search.
//
// Bypasses Composio: the lead-gen value (domain search, email finder/verifier,
// person/company/combined enrichment, people discovery, account) is Hunter's
// clean REST surface (api.hunter.io/v2), so this is a native REST executor over
// the curated set in generated/hunter.ts — not the 101-tool MCP, which is
// mostly CRM/campaign management we do not want to expose.
//
// Auth is Hunter's `?api_key=` query parameter (NOT a bearer), so the public-web
// transport carries the request and the key rides in the query — the platform
// key on the internal:hunterio path, or a workspace's own connected key. Every
// function is a read; Hunter meters CREDITS per call (email_count/get_account are
// free), so a call fails closed when the balance is exhausted (there is no
// auto-reload), and get_account reads the remaining balance.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { HUNTER_DISPATCH } from '../catalog/generated/hunter.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS } from './connector-transport.js';
import { resolvePlatformVendorKey, tenantOwnApiKey } from './platform-vendor-keys.js';

const HUNTER_BASE = 'https://api.hunter.io';

interface HunterResponse {
  data?: unknown;
  meta?: unknown;
  errors?: Array<{ id?: string; code?: number; details?: string }>;
}

export async function hunterExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = HUNTER_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return { result: {}, failure: { message: `hunter has no tool named ${ctx.functionName}` } };
  }
  const byoKey = tenantOwnApiKey(ctx);
  const apiKey = ctx.credentials.apiKey || resolvePlatformVendorKey('hunterio');
  if (!apiKey) {
    return { result: {}, failure: { message: 'hunter credential is not provisioned (no tenant key, no platform key)' } };
  }
  const funding = byoKey ? ('tenant_key' as const) : ('platform_key' as const);

  const transport = makePublicWebTransport('hunter', { ...DEFAULT_PUBLIC_WEB_HEADERS });
  const isGet = dispatch.method === 'GET';
  // The api_key always rides in the query; GET inputs join it there too.
  const query: Record<string, string> = { api_key: apiKey };
  if (isGet) {
    for (const [k, v] of Object.entries(ctx.input)) {
      if (typeof v === 'string' && v.trim()) query[k] = v.trim();
      else if (typeof v === 'number' && Number.isFinite(v)) query[k] = String(v);
      else if (typeof v === 'boolean') query[k] = String(v);
      else if (Array.isArray(v)) query[k] = v.map(String).join(',');
    }
  }

  const started = Date.now();
  try {
    const resp = await transport({
      method: dispatch.method,
      url: `${HUNTER_BASE}${dispatch.path}`,
      query,
      ...(isGet ? {} : { body: ctx.input }),
    });
    const vendorLatencyMs = Date.now() - started;
    const parsed = (await resp.json().catch(() => ({}))) as HunterResponse;

    if (!resp.ok || (parsed.errors && parsed.errors.length > 0)) {
      const detail =
        parsed.errors?.map((e) => e.details).filter(Boolean).join('; ') || `HTTP ${resp.status}`;
      return {
        result: (parsed as JsonObject) ?? {},
        vendorLatencyMs,
        failure: { message: `hunter.${ctx.functionName}: ${detail}` },
      };
    }

    // Hunter returns { data, meta }; meta carries the credit usage. No per-call
    // USD is reported (credits are a plan quota), so costUsd is left unset — the
    // call is recorded as usage regardless, and get_account tracks the balance.
    return {
      result: {
        data: (parsed.data ?? null) as JsonObject[keyof JsonObject],
        meta: (parsed.meta ?? null) as JsonObject[keyof JsonObject],
      },
      vendorLatencyMs,
      fundingSource: funding,
    };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `hunter.${ctx.functionName}: request failed (${(err as Error).message})` },
    };
  }
}

registerConnectorExecutor('hunterio', hunterExecutor);
