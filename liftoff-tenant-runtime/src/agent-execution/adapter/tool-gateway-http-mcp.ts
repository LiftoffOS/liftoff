// Localhost HTTP exposure of the governed tool seam for external-process engines.
//
// External engines (Codex CLI subprocess, opencode server) cannot use the
// InMemoryTransport the in-process adapters use — their MCP config accepts only a
// URL-based remote server (Codex: `[mcp_servers.NAME] url=...`; opencode:
// McpRemoteConfig{type:'remote',url}).
//
// IMPORTANT (governance): we do NOT expose the raw createToolGatewayMcpServer
// instance. Its handlers enforce only the outbound-communication oversight gate,
// NOT the full per-tool `hitlGate` that the hybrid loop registers (that fires
// only inside dispatchFunctionCall). So instead we stand up a thin MCP proxy
// whose ListTools returns the catalog and whose CallTool routes through
// dispatchFunctionCall(catalog, name, args, bridgeContext) — the SAME governed
// path OpenAI/Gemini use (registered hitlGate + untrusted framing + OU-metering +
// single-result bound). Because the proxy runs in the same process as the
// adapter, they share the BridgeContext: a HITL-gated call sets
// bridgeContext.pendingHitlGate, which the adapter observes to pause the engine.
// Stateless streamable-HTTP suits the single local client.

import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolCatalog } from './catalog-types';
import { dispatchFunctionCall, type BridgeContext } from './mcp-bridge';
import { stampRemembered } from './remembered-stamp';
import { logger } from '../../infrastructure/logging';

export interface ToolGatewayHttpMcp {
  /** Full MCP endpoint URL, e.g. http://127.0.0.1:54321/mcp */
  url: string;
  /** Bearer token the engine must send (Authorization: Bearer <token>). */
  bearerToken: string;
  /** Tear down the HTTP server + transport. Call in the adapter's finally. */
  close(): Promise<void>;
}

/** How often a running call reports that it is still running.
 *
 *  Well inside the 60-second default an engine falls back to when it is told
 *  nothing, so the first heartbeat lands long before the shortest timeout any
 *  client applies. */
function progressIntervalMs(): number {
  const raw = Number(process.env.TOOL_PROGRESS_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

/** Normalize dispatchFunctionCall's return into an MCP CallToolResult. Success
 *  results are already `{content,isError}`; HITL/delegation/error markers are the
 *  legacy `{error,...}` shape → wrap as an isError text result. */
function toCallToolResult(raw: unknown): CallToolResult {
  const r = raw as { content?: unknown; isError?: boolean };
  if (r && Array.isArray(r.content)) return r as CallToolResult;
  return { content: [{ type: 'text', text: JSON.stringify(raw ?? {}) }], isError: true };
}

/**
 * Serve the governed tool seam over localhost HTTP so a subprocess engine can
 * reach it as a remote MCP server. Every tool call routes through the shared
 * BridgeContext, so HITL/framing/metering apply exactly as for in-process engines.
 */
export async function exposeCatalogOverHttp(
  catalog: McpToolCatalog,
  bridgeContext: BridgeContext,
): Promise<ToolGatewayHttpMcp> {
  const bearerToken = randomUUID();

  // One MCP server and one transport PER REQUEST. The transport is stateless
  // (no session id: the single local client needs none), and a stateless
  // transport answers exactly one request — the SDK refuses a second with
  // "Stateless transport cannot be reused across requests", which the node
  // wrapper surfaces as a bodiless 500. Built once and reused, the proxy
  // answered `initialize` and nothing after it: every tool call on the two
  // engines behind it failed at the handshake. The server is a handful of
  // closures over the catalog and the bridge context, so building it per
  // request costs nothing that matters.
  const makeServer = (): Server => {
    const server = new Server(
      { name: 'tool-gateway-http', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: catalog.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as { type: 'object' },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      // No model call id reaches this path: the engine's MCP client carries
      // none, and the engine's finished event carries the engine's own id,
      // which nothing here can match. So the proxy issues an id of its own,
      // dispatches and records under it, and hands the id — and, only when
      // the bridge's observer answered true, the outcome — back on the
      // result's `_meta`, for the adapter to read off the engine's finished
      // event. See remembered-stamp.ts for why the id alone would not do.
      const callId = randomUUID();
      // SAY "STILL WORKING" WHILE A LONG CALL RUNS.
      //
      // Every engine that reaches this proxy calls tools with
      // `resetTimeoutOnProgress: true` — it is built to extend its patience
      // when the server reports progress. This server never reported any, so
      // the only lever left was a flat per-call timeout large enough for the
      // slowest tool in the catalog, and a call that took longer than the
      // engine's default died as `-32001 Request timed out` while the bridge
      // was still serving it.
      //
      // A progress notification only reaches the client on the request's own
      // SSE stream, which is why `enableJsonResponse` is off below: a buffered
      // JSON response has nowhere to put one.
      //
      // Sent only when the client asked for it. `progressToken` is the client's
      // request to be told, and the MCP spec says a server sends progress for a
      // token it was given and for no other.
      const progressToken = req.params._meta?.progressToken;
      const heartbeat = progressToken === undefined ? undefined : setInterval(() => {
        void extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: 0, message: `${req.params.name} still running` },
        }).catch(() => undefined);
      }, progressIntervalMs());
      let raw: unknown;
      try {
        raw = await dispatchFunctionCall(
          catalog,
          req.params.name,
          (req.params.arguments ?? {}) as Record<string, unknown>,
          bridgeContext,
          { callId },
        );
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      const result = toCallToolResult(raw);
      const recorded = bridgeContext.recordedCalls?.delete(callId) ?? false;
      const withMetadata = result as CallToolResult & { metadata?: unknown };
      return {
        ...result,
        _meta: stampRemembered(result._meta, callId, recorded),
        metadata: stampRemembered(withMetadata.metadata, callId, recorded),
      };
    });
    return server;
  };

  const httpServer = http.createServer((httpReq, httpRes) => {
    void (async () => {
      if ((httpReq.headers.authorization || '') !== `Bearer ${bearerToken}`) {
        httpRes.writeHead(401).end();
        return;
      }
      let rawBody = '';
      for await (const chunk of httpReq) rawBody += chunk;
      let body: unknown;
      try {
        body = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        body = undefined;
      }
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // SSE, so a long call can report progress while it runs (see the
        // heartbeat in the call handler). `enableJsonResponse: true` buffers
        // every message and answers once at the end, which leaves a progress
        // notification nowhere to go.
        //
        // Safe for every client here: the transport already REFUSES a POST
        // whose Accept header does not list both `application/json` and
        // `text/event-stream` (406), so any engine reaching this proxy today
        // already accepts a stream.
        enableJsonResponse: false,
      });
      httpRes.on('close', () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(httpReq, httpRes, body);
    })().catch((err) => {
      logger.warn({ err: (err as Error).message }, 'tool-gateway-http-mcp request failed');
      if (!httpRes.headersSent) httpRes.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;

  return {
    url,
    bearerToken,
    close: async () => {
      // `close()` alone stops accepting and then WAITS for every open
      // connection to end. The engine holds a keep-alive connection to this
      // server, and a call parked on an approval is an in-flight request, so
      // close waited on Node's own request timeout (300s): observed as a
      // ~300s shutdown after an approval pause. The engine is gone by the time
      // this runs; nothing on those connections is still wanted.
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeIdleConnections();
      httpServer.closeAllConnections();
      await closed;
    },
  };
}
