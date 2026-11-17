// Live tool enumeration for EXTERNAL AGENTS.
//
// Every other MCP class already reads its tool list from the live server:
// vendor-hosted MCP (GitHub / Notion / Stripe) and custom MCP servers both go
// through enumerateVendorMcpTools, which does a paginated `tools/list` behind a
// 5-minute (url, headers-hash) cache. External agents were the last holdout —
// they served `external_agents.raw_mcp_tools`, a snapshot taken once at
// discovery and never refreshed. A vendor that shrinks its surface leaves the
// snapshot listing dozens of REST-shaped tools while the live server exposes
// two, so agents are offered tools that answer `MCP error -32603: Unknown
// tool`, and the pre-dispatch existence check validated against the same stale
// snapshot and waved them through.
//
// This module reuses ONLY the list fetch. It deliberately does NOT reuse
// enumerateVendorMcpTools itself, because that helper names tools
// `composeToolName(serverId, name)` and stamps a `serverId` that routes
// dispatch over the remote transport — which for an external agent would both
// rename every tool (breaking distilled instructions that reference
// `external__<alias>__<tool>`) and bypass ExternalAgentHandler.execute, where
// the Layer 2/3/4 authorization checks, HITL gate and audit logging live.
// Naming, dispatch and classification stay exactly where they were; only the
// SOURCE of the list changes.

import { fetchVendorToolList, type VendorMcpToolListEntry } from '../agent-execution/adapter/vendor-mcp-enumerate';
import type { ExternalAgentConfig, ExternalAgentCredentials } from './external-agent-handler';
import { logger } from '../infrastructure/logging';
import { external_agent_tool_list_degraded_total } from '../observability/runtime-extensions-metrics';

/** Does this MCP result say the tool does not exist on the server?
 *
 *  Matches the JSON-RPC method-not-found code and the message CoinGecko's
 *  server (and others) return through -32603 for an unrecognised tool name. */
export function isUnknownToolError(result: unknown): boolean {
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    return false;
  }
  return /unknown tool|-32601/i.test(text ?? '');
}

/** Auth headers for a direct MCP call to an external agent's endpoint.
 *  Mirrors the header assembly ExternalAgentHandler uses for its own calls. */
export function buildExternalAgentAuthHeaders(
  credentials: ExternalAgentCredentials,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (credentials.authType === 'bearer_token' && credentials.bearerToken) {
    headers['Authorization'] = `Bearer ${credentials.bearerToken}`;
  } else if (credentials.authType === 'api_key' && credentials.apiKey) {
    headers['X-Service-Token'] = credentials.apiKey;
  } else if (credentials.authType === 'custom_headers' && credentials.customHeaders) {
    for (const h of credentials.customHeaders) headers[h.key] = h.value;
  }
  return headers;
}

/** The external agent's CURRENT tool list.
 *
 *  A2A transports have no `tools/list`, so they keep snapshot semantics.
 *  On any fetch failure we fall back to the stored snapshot rather than to `[]`:
 *  vendor MCP degrades to empty only because it has no fallback, whereas here a
 *  flaky server would otherwise strip an agent of every tool it owns. */
export async function listExternalAgentTools(
  config: ExternalAgentConfig,
  credentials: ExternalAgentCredentials,
): Promise<VendorMcpToolListEntry[]> {
  const snapshot = (config.rawMcpTools ?? []) as VendorMcpToolListEntry[];

  if (config.transportType === 'a2a') return snapshot;

  try {
    const entries = await fetchVendorToolList(
      config.endpointUrl,
      buildExternalAgentAuthHeaders(credentials),
      (config.transportType || 'streamable-http') as 'http' | 'streamable-http' | 'sse' | 'stdio',
    );

    // INV-PB-008: `degraded` marks a tool whose schema is not acceptable to the
    // LLM tool API, and it is computed by platform-backend's discovery pipeline
    // — a raw tools/list cannot know it. Both catalog builders skip degraded
    // tools, so carrying the marker across from the snapshot is what keeps that
    // invariant enforced now that the live list is the source. A tool the
    // server has ADDED since the last discovery has no verdict yet and is
    // treated as acceptable, exactly as a freshly discovered tool would be.
    const degraded = new Set(
      (snapshot as Array<VendorMcpToolListEntry & { degraded?: boolean }>)
        .filter(t => t.degraded === true)
        .map(t => t.name),
    );
    if (degraded.size === 0) return entries;
    return entries.map(entry =>
      degraded.has(entry.name) ? { ...entry, degraded: true } : entry,
    ) as VendorMcpToolListEntry[];
  } catch (err) {
    external_agent_tool_list_degraded_total.inc({ external_agent_id: config.id });
    logger.warn(
      { externalAgentId: config.id, err: (err as Error).message },
      'external agent tools/list failed — falling back to the stored snapshot',
    );
    return snapshot;
  }
}
