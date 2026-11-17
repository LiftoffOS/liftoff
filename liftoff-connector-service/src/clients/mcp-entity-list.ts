// Enumerating entities on a vendor-hosted MCP connector.
//
// WHY THIS EXISTS
// MCP servers expose TOOLS, not tables. There is no generic "list the things in
// this account" verb, so the five MCP-backed clients here (Clay, Mesh,
// QuickBooks, Xero, and the generic one) each shipped a `list()` that returned
// an empty array and nothing else. That is the worst available answer: a caller
// asking QuickBooks for its customers was told the account had none, when the
// truth was that nobody had wired the call.
//
// Rather than hardcode a tool name per vendor per entity — the thing that made
// the browse route unmaintainable — the tool is DISCOVERED. Every MCP server
// that can enumerate something names that tool after the entity
// (`list_customers`, `get_invoices`, `search_contacts`), so the entity name is
// enough to find it. resolveSqlTool in databricks-mcp.ts already works this way;
// this is the same idea generalised.
//
// When no such tool exists the answer is `unsupported: true`, which is a real
// answer meaning "this connector cannot enumerate that" — as distinct from an
// empty list, which claims the account is empty.

import type { ListResult } from './types.js';
import { logger } from '../infra/logging.js';
import { pickEnumeratingTool, extractRecordArray, toExternalRecords } from './entity-enumeration.js';

interface MCPToolCaller {
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * List `entityType` on an MCP connector by discovering the tool that enumerates
 * it. Returns `unsupported: true` when the server exposes no such tool.
 */
export async function listViaMcpTool(
  client: MCPToolCaller,
  connectorLabel: string,
  entityType: string,
  args: Record<string, unknown> = {},
): Promise<ListResult> {
  const tools = await client.listTools();
  const tool = pickEnumeratingTool(tools, entityType);

  if (!tool) {
    logger.info('MCP list: no enumerating tool for entity', {
      connector: connectorLabel,
      entityType,
      available: tools.length,
    });
    return { records: [], hasMore: false, unsupported: true };
  }

  const rows = extractRecordArray(unwrapContentBlocks(await client.callTool(tool.name, args)));
  return { records: toExternalRecords(rows), hasMore: false };
}

/** MCP replies arrive as `{content: [{type: 'text', text: '<json>'}]}` — a
 *  transport detail specific to this surface, so it is undone here rather than
 *  in the shared extractor. Text that is not JSON is prose, and there is nothing
 *  to enumerate from prose: better an empty list than invented records. */
function unwrapContentBlocks(result: unknown): unknown {
  const obj = result as Record<string, unknown> | null;
  if (!obj || !Array.isArray(obj.content)) return result;

  const text = (obj.content as Array<Record<string, unknown>>)
    .filter(c => c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text as string)
    .join('');
  if (!text) return result;

  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}
