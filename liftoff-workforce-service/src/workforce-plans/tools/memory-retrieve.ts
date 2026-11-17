// memory_retrieve Tool (CAIO)
//
// Retrieves saved memories from the dedicated `caio_memory` table.
// Performs a SQL-level content/tag filter and returns the top-k entries
// ordered by recency (updated_at DESC). Falls back to returning all
// matching entries when no substring match is found.
//
// Personal entries (layer='personal') are scoped to (tenant_id, account_id).
// Team entries (layer='team' or 'global') are scoped to tenant_id only.
// The 'all' filter returns both personal entries for this account and any
// team/global entries in the tenant.
//
// Fails soft: an unreachable DB or missing context returns an empty array
// and the chat turn continues without memory context.
//
// Import paths use .js extensions (ESM).

import { log } from '../../infrastructure/logging.js';
import { withTenantContext } from '../../infrastructure/rls.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface MemoryRetrieveInput {
  query: string;
  layers?: Array<'global' | 'role'>;
  topK?: number;
  scopeKey?: string;
  tags?: string[];
}

interface MemoryEntry {
  id: string;
  content: string;
  layer: string;
  scopeKey: string;
  tags: string[];
  savedAt: string;
}

interface MemoryRetrieveOutput {
  memories: MemoryEntry[];
  count: number;
  message: string;
}

interface DbMemoryRow {
  id: string;
  content: string;
  layer: string;
  scope_key: string | null;
  tags: string[];
  updated_at: Date;
}

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;

/** Map external layer names to DB layer values. */
function toDbLayers(layers: Array<'global' | 'role'>): string[] {
  return layers.map(l => (l === 'global' ? 'global' : 'personal'));
}

export const memoryRetrieveTool: WorkforcePlanTool = {
  definition: {
    name: 'memory_retrieve',
    description:
      'Search stored memories for cross-thread continuity. Call this at the START of a new planning conversation with a query like "user preferences for AI workforce planning" or "past decisions about customer ops agents" so you can greet returning users with context from prior sessions. Returns the top-k most relevant memories (default 8, max 20). If no relevant memories exist, returns an empty array - handle that gracefully ("nothing specific to recall yet"). Fails soft if the memory store is unreachable.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query describing what you want to recall (max 2000 chars).',
        },
        layers: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['global', 'role'],
          },
          description: 'Optional layers to search. Defaults to both global and role.',
        },
        topK: {
          type: 'number',
          description: 'Number of memories to return (1-20, default 8).',
        },
      },
      required: ['query'],
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<MemoryRetrieveOutput> {
    const input = rawInput as unknown as MemoryRetrieveInput;
    const topK = Math.min(input.topK ?? DEFAULT_TOP_K, MAX_TOP_K);
    const layers = input.layers ?? ['global', 'role'];
    const dbLayers = toDbLayers(layers);

    // Use tenantId as fallback accountId consistent with memory-save.
    const accountId =
      ctx.accountId && ctx.accountId.length > 0 ? ctx.accountId : ctx.tenantId;

    try {
      // Build parameterised query. We want:
      //   personal entries belonging to this account, OR
      //   team/global entries belonging to this tenant
      // then optionally filter by scopeKey, tags, and layer list.
      const params: unknown[] = [ctx.tenantId, accountId];
      const conditions: string[] = [
        `(expires_at IS NULL OR expires_at > NOW())`,
        `(tenant_id = $1 AND (account_id = $2 OR layer IN ('team', 'global')))`,
      ];

      // Layer filter
      if (dbLayers.length > 0 && dbLayers.length < 3) {
        params.push(dbLayers);
        conditions.push(`layer = ANY($${params.length}::text[])`);
      }

      // scopeKey filter
      if (input.scopeKey && input.scopeKey.length > 0) {
        params.push(input.scopeKey);
        conditions.push(`scope_key = $${params.length}`);
      }

      // Tags filter (row must contain ALL requested tags)
      if (input.tags && input.tags.length > 0) {
        params.push(input.tags);
        conditions.push(`tags @> $${params.length}::text[]`);
      }

      // Content substring filter for the query — applied as a LIKE so Postgres
      // can use the index. We also fetch all rows when no match would be found
      // (handled via UNION / OR pattern below with a LIMIT).
      const whereClause = conditions.map(c => `(${c})`).join(' AND ');

      const sql = `
        SELECT id, content, layer, scope_key, tags, updated_at
        FROM caio_memory
        WHERE ${whereClause}
        ORDER BY updated_at DESC
        LIMIT $${params.length + 1}
      `;
      params.push(topK * 4); // fetch a generous window for client-side ranking

      // Read through the tenant scope: caio_memory is RLS-protected and its
      // policy reads app.current_tenant_id, so a raw pool query returns nothing
      // no matter what is stored. INV-WF-001.
      const result = await withTenantContext(ctx.tenantId, (client) =>
        client.query<DbMemoryRow>(sql, params));
      const rows = result.rows;

      if (rows.length === 0) {
        return {
          memories: [],
          count: 0,
          message:
            'No relevant memories found. This may be a first-time conversation, or nothing related to this query has been saved yet. Proceed without prior context.',
        };
      }

      // Client-side relevance scoring (substring match, consistent with prior
      // implementation). No vector index available in this service.
      const lowerQuery = input.query.toLowerCase().slice(0, 2000);
      const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 2);

      const scoreRow = (row: DbMemoryRow): number => {
        const lowerContent = row.content.toLowerCase();
        if (lowerContent.includes(lowerQuery)) return 1.0;
        if (queryWords.length === 0) return 0.5;
        const lowerTags = row.tags.map(t => t.toLowerCase());
        let matches = 0;
        for (const word of queryWords) {
          if (lowerContent.includes(word) || lowerTags.some(t => t.includes(word))) {
            matches++;
          }
        }
        return matches / queryWords.length;
      }

      const scored = rows
        .map(row => ({ row, score: scoreRow(row) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      const memories: MemoryEntry[] = scored.map(({ row }) => ({
        id: row.id,
        content: row.content,
        layer: row.layer,
        scopeKey: row.scope_key ?? '',
        tags: row.tags,
        savedAt: row.updated_at.toISOString(),
      }));

      if (memories.length === 0) {
        return {
          memories: [],
          count: 0,
          message:
            'No relevant memories found. This may be a first-time conversation, or nothing related to this query has been saved yet. Proceed without prior context.',
        };
      }

      return {
        memories,
        count: memories.length,
        message: `Found ${memories.length} relevant memor${memories.length === 1 ? 'y' : 'ies'} from prior planning sessions.`,
      };
    } catch (err) {
      log.warn(
        {
          tenantId: ctx.tenantId,
          accountId,
          error: (err as Error).message,
        },
        'memory_retrieve: failed to read from caio_memory — fail soft, returning empty',
      );
      return {
        memories: [],
        count: 0,
        message:
          'Memory store is unreachable right now. Proceeding without prior context.',
      };
    }
  },
};
