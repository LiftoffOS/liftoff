// Gloria native MCP executor — real-time crypto news/recaps.
//
// Gloria's free tools live on its public MCP server (streamable-HTTP) at
// https://mcp.itsgloria.ai/mcp with NO credential. Its REST API
// (api.itsgloria.ai) is Elite-gated, so the FREE capability is only reachable
// through the MCP — hence an MCP executor, not a REST one like nasdaq.
//
// Why this drives the streamable-HTTP handshake DIRECTLY (via the public-web
// transport) instead of the shared MCPClient wrapper: the shared client serves
// ALLOWLISTED, ALWAYS-AUTHENTICATED servers. It runs a mandatory TokenProvider
// and always sends `Authorization: Bearer`, checks the URL against
// validateMCPUrl, and fetches with no browser-shaped headers. Gloria is the
// opposite on every axis — its free tools are KEYLESS (an empty bearer reads as
// a bot and is refused), its endpoint is not in the MCP allowlist, and its
// bot-management wants a real User-Agent/Accept, which is exactly what
// makePublicWebTransport supplies. This is the correct transport for a public,
// keyless MCP; do not "simplify" it onto MCPClient.
//
// The SSE body is parsed by hand below because that transport's reader is
// coupled to its own credentialed fetch, and Gloria needs the public-web fetch
// above. The handshake is three POSTs: initialize (captures mcp-session-id) ->
// notifications/initialized -> tools/call, each returning one `event: message`
// / `data: <json-rpc>` frame.
//
// The 5 free tools ride the plain no-auth MCP transport. The 2 premium tools
// (get_enriched_news, get_ticker_summary) are NOT gated on the MCP at all —
// probed live: their MCP tools/call answers 200 with an
// instruction blob pointing at gloria's REST endpoints (api.itsgloria.ai),
// and it is THOSE endpoints that answer HTTP 402 (x402 v1, USDC on Base).
// So the premium lane skips the MCP and GETs the REST endpoint directly:
// through the tenant's own Elite bearer when a BYO key is connected (their
// subscription pays, no OU charge), else through the x402 transport, which
// pays the 402 from the platform wallet and re-exposes the settled amount as
// this call's costUsd. Declared prices below are from the endpoints' own 402
// challenges (maxAmountRequired) and seed the spend guard's per-call cap.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import {
  makePublicWebTransport,
  makeX402Transport,
  readX402Receipt,
  DEFAULT_PUBLIC_WEB_HEADERS,
} from './connector-transport.js';
import { tenantOwnApiKey } from './platform-vendor-keys.js';

const GLORIA_MCP_URL = 'https://mcp.itsgloria.ai/mcp';
const MCP_PROTOCOL_VERSION = '2025-06-18';

const FREE_TOOLS = new Set([
  'get_categories',
  'get_latest_news',
  'get_news_recap',
  'search_news',
  'get_news_item',
]);

/** The premium tools' REST endpoints and declared per-call prices, both read
 *  off the endpoints' own live 402 challenges: ticker summary
 *  $0.031, enriched news $0.030. The price feeds the guard's cap (×2), so a
 *  vendor reprice past double fails the call instead of paying. */
export const GLORIA_PREMIUM_REST: Record<string, { url: string; priceUsd: number }> = {
  get_enriched_news: { url: 'https://api.itsgloria.ai/news', priceUsd: 0.03 },
  get_ticker_summary: { url: 'https://api.itsgloria.ai/news-ticker-summary', priceUsd: 0.031 },
};

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { code?: number; message?: string };
}

/** Extract the JSON-RPC message for `id` from a streamable-HTTP body, which is
 *  one or more `event: message` / `data: <json>` frames. Parses every `data:`
 *  line — including a final frame that ends with no trailing blank line, which
 *  is how Gloria frames a single-event response — and returns the one matching
 *  `id`. */
function parseRpc(body: string, id: number): JsonRpcResponse | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.id === id) return parsed;
    } catch {
      /* skip non-JSON keep-alive frames */
    }
  }
  return undefined;
}

export async function gloriaExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  // The bearer is whatever credential arrived — a tenant instance's Elite
  // key, or the platform key the dispatcher rides in on the `internal:`
  // path. Only the funding label asks whose it is.
  const byoKey = ctx.credentials.apiKey?.trim() || undefined;
  const bearerFunding = tenantOwnApiKey(ctx) ? ('tenant_key' as const) : ('platform_key' as const);
  const premiumRest = GLORIA_PREMIUM_REST[ctx.functionName];
  if (premiumRest) return gloriaPremiumCall(ctx, premiumRest, byoKey, bearerFunding);
  if (!FREE_TOOLS.has(ctx.functionName)) {
    return {
      result: {},
      failure: { message: `gloria has no tool named ${ctx.functionName}` },
    };
  }

  const baseHeaders: Record<string, string> = {
    ...DEFAULT_PUBLIC_WEB_HEADERS,
    Accept: 'application/json, text/event-stream',
    ...(byoKey ? { Authorization: `Bearer ${byoKey}` } : {}),
  };
  const transport = makePublicWebTransport('gloria', baseHeaders);

  const started = Date.now();
  try {
    // 1. initialize — capture the session id.
    const initResp = await transport({
      method: 'POST',
      url: GLORIA_MCP_URL,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'liftoff-connector-service', version: '1.0' },
        },
      },
    });
    if (!initResp.ok) {
      return failUnavailable(ctx.functionName, `initialize HTTP ${initResp.status}`, started);
    }
    const sessionId = initResp.headers.get('mcp-session-id') ?? undefined;
    const withSession: Record<string, string> = sessionId ? { 'mcp-session-id': sessionId } : {};

    // 2. initialized notification (no response expected).
    await transport({
      method: 'POST',
      url: GLORIA_MCP_URL,
      headers: withSession,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });

    // 3. tools/call.
    const callResp = await transport({
      method: 'POST',
      url: GLORIA_MCP_URL,
      headers: withSession,
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: ctx.functionName, arguments: ctx.input },
      },
    });
    const vendorLatencyMs = Date.now() - started;
    if (!callResp.ok) {
      return failUnavailable(ctx.functionName, `tools/call HTTP ${callResp.status}`, started);
    }

    const rpc = parseRpc(await callResp.text(), 2);
    if (!rpc) {
      return failUnavailable(ctx.functionName, 'no JSON-RPC response frame', started);
    }
    if (rpc.error) {
      return {
        result: {},
        vendorLatencyMs,
        failure: { message: `gloria.${ctx.functionName}: ${rpc.error.message ?? 'error'}` },
      };
    }
    const content = rpc.result?.content ?? [];
    if (rpc.result?.isError) {
      const msg = content.map((c) => c.text).filter(Boolean).join('; ') || 'gloria tool returned an error';
      return { result: {}, vendorLatencyMs, failure: { message: `gloria.${ctx.functionName}: ${msg}` } };
    }

    // Gloria returns one or more text parts, each a JSON object (a category, a
    // news item, ...). Collect the parseable ones into an items array; keep raw
    // text for anything that is not JSON so nothing is lost.
    const items: unknown[] = [];
    const rawText: string[] = [];
    for (const part of content) {
      if (typeof part.text !== 'string') continue;
      try {
        items.push(JSON.parse(part.text));
      } catch {
        rawText.push(part.text);
      }
    }
    const result: JsonObject = { items } as JsonObject;
    if (rawText.length) (result as Record<string, unknown>).text = rawText.join('\n');

    // Free public source: no per-call charge to attribute.
    return { result, vendorLatencyMs, costUsd: 0 };
  } catch (err) {
    return failUnavailable(ctx.functionName, (err as Error).message, started);
  }
}

/** The premium lane: a direct GET on gloria's REST endpoint.
 *
 *  Funding order mirrors strale's: the tenant's own Elite bearer first (their
 *  subscription pays; costUsd 0, so no OUs are charged), then the platform
 *  x402 wallet. A bearer attempt that comes back 402 means the key is not
 *  Elite-entitled for this endpoint — the call falls through to x402 rather
 *  than failing, because the customer is charged the same OUs either way and
 *  the data is what they asked for. */
async function gloriaPremiumCall(
  ctx: ExecutorContext,
  rest: { url: string; priceUsd: number },
  byoKey: string | undefined,
  bearerFunding: 'tenant_key' | 'platform_key',
): Promise<ExecutorResult> {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.input)) {
    if (typeof v === 'string' && v.trim()) query[k] = v.trim();
    else if (typeof v === 'number' && Number.isFinite(v)) query[k] = String(v);
  }

  const started = Date.now();
  try {
    if (byoKey) {
      const bearer = makePublicWebTransport('gloria', {
        ...DEFAULT_PUBLIC_WEB_HEADERS,
        Authorization: `Bearer ${byoKey}`,
      });
      const resp = await bearer({ method: 'GET', url: rest.url, query });
      if (resp.status !== 402) {
        const vendorLatencyMs = Date.now() - started;
        const parsed = (await resp.json().catch(() => ({}))) as JsonObject;
        if (!resp.ok) {
          return {
            result: parsed ?? {},
            vendorLatencyMs,
            failure: {
              message: `gloria.${ctx.functionName}: HTTP ${resp.status} ${
                (parsed as { error?: string }).error ?? ''
              }`.trim(),
            },
          };
        }
        // The bearer's subscription served it at no per-call charge; the
        // label says whose subscription that was.
        return { result: parsed ?? {}, vendorLatencyMs, costUsd: 0, fundingSource: bearerFunding };
      }
      // 402 on the bearer: the key is not Elite-entitled here — pay instead.
    }

    const transport = makeX402Transport('gloria', { declaredPriceUsd: rest.priceUsd });
    const resp = await transport({ method: 'GET', url: rest.url, query });
    const vendorLatencyMs = Date.now() - started;
    const parsed = (await resp.json().catch(() => ({}))) as JsonObject;

    if (!resp.ok) {
      return {
        result: parsed ?? {},
        vendorLatencyMs,
        failure: {
          message: `gloria.${ctx.functionName}: HTTP ${resp.status} ${
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
      failure: { message: `gloria.${ctx.functionName}: premium call failed (${(err as Error).message})` },
    };
  }
}

function failUnavailable(fn: string, detail: string, started: number): ExecutorResult {
  return {
    result: {},
    vendorLatencyMs: Date.now() - started,
    failure: { message: `gloria.${fn}: MCP call failed (${detail})` },
  };
}

registerConnectorExecutor('gloria', gloriaExecutor);
