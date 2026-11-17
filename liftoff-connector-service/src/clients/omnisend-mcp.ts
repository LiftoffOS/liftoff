// Omnisend MCP client.
//
// mcp.omnisend.com is a META-TOOL server: tools/list exposes four tools —
// `search`, `tool_schema`, `tool_documentation` and `execute` — and the ~108
// API operations live BEHIND `execute`, named by its `tool_name` argument and
// enumerated by `search`. The generic client discovers an enumerating tool from
// tools/list, and here that list never names an entity, so a picker asking for
// the account's segments would be told the connector cannot enumerate them
// while `execute { tool_name: 'get_segments' }` answers in one call.
//
// So `list()` runs the same discovery one level down: fetch the operations
// from `search`, pick the one that enumerates the entity with the shared
// pickEnumeratingTool rule, and run it through `execute`. Everything else —
// reads, writes, the MCP transport, the token — is the generic client's.

import type { CompensationClient, CreateResult, DeleteResult, ExternalRecord, ListFilters, ListResult, UpdateResult } from './types.js';
import { GenericMCPClient, type GenericMCPClientConfig } from './generic-mcp.js';
import { pickEnumeratingTool, extractRecordArray, toExternalRecords } from './entity-enumeration.js';
import { logger } from '../infra/logging.js';

/** The meta-tools, as the server names them. `operationArg` is the argument
 *  of `executeTool` that names the operation — the same key the HITL seed
 *  rows (`execute:<operation>`) and the runtime gate resolve on. */
export const OMNISEND_META_TOOLS = {
  searchTool: 'search',
  executeTool: 'execute',
  operationArg: 'tool_name',
  payloadArg: 'payload',
} as const;

/** Omnisend names a record's key after the entity — `segmentID`, `campaignID`,
 *  `contactID`, `formID` — where the shared extractor looks for `id`. A picker
 *  keyed on the name instead of the id would hand the agent something it
 *  cannot address, so the vendor key is surfaced as `id` before extraction. */
function withVendorId(row: Record<string, unknown>): Record<string, unknown> {
  if (row.id !== undefined) return row;
  const vendorKey = Object.keys(row).find((k) => /ID$/.test(k) && (typeof row[k] === 'string' || typeof row[k] === 'number'));
  return vendorKey ? { id: row[vendorKey], ...row } : row;
}

interface OmnisendOperation {
  name: string;
  description?: string;
  method?: string;
  path?: string;
}

export class OmnisendMCPClient implements CompensationClient {
  readonly connector = 'omnisend';
  private readonly generic: GenericMCPClient;

  constructor(config: Omit<GenericMCPClientConfig, 'connectorType'>) {
    this.generic = new GenericMCPClient({ ...config, connectorType: 'omnisend' });
  }

  /** The operations behind `execute`, as `search` lists them. `search` ignores
   *  its query and always returns the full list, so one call is the index. */
  private async operations(): Promise<OmnisendOperation[]> {
    const raw = await this.generic.read(OMNISEND_META_TOOLS.searchTool, undefined, {});
    const body = raw.data as { tools?: unknown } | undefined;
    const tools = body && Array.isArray(body.tools) ? (body.tools as OmnisendOperation[]) : [];
    return tools.filter((t) => typeof t.name === 'string');
  }

  async list(entityType: string, _filters?: ListFilters): Promise<ListResult> {
    const operations = await this.operations();
    // Only a GET can enumerate; the operations list carries the method, which
    // the shared name rule alone cannot see (`delete_segment_id` names the
    // entity too).
    const reads = operations.filter((op) => !op.method || op.method.toUpperCase() === 'GET');
    const operation = pickEnumeratingTool(reads, entityType);
    if (!operation) {
      logger.info('omnisend list: no enumerating operation for entity', {
        entityType,
        available: operations.length,
      });
      return { records: [], hasMore: false, unsupported: true };
    }
    const result = await this.generic.read(OMNISEND_META_TOOLS.executeTool, undefined, {
      [OMNISEND_META_TOOLS.operationArg]: operation.name,
      [OMNISEND_META_TOOLS.payloadArg]: {},
    });
    return { records: toExternalRecords(extractRecordArray(result.data).map(withVendorId)), hasMore: false };
  }

  read(entityType: string, entityId?: string, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    return this.generic.read(entityType, entityId, payload);
  }

  create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    return this.generic.create(entityType, data);
  }

  update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    return this.generic.update(entityType, entityId as string, data);
  }

  delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    return this.generic.delete(entityType, entityId, payload);
  }

  restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.generic.restore(entityType, entityId as string, snapshot);
  }

  semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    return this.generic.semanticInverse(entityType, originalAction, entityId, originalResponse);
  }
}
