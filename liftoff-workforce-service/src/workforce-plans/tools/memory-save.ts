// memory_save Tool (CAIO)
//
// Persists a strategic decision, user preference, or organisational fact
// to the dedicated `caio_memory` table keyed by (tenant_id, account_id, key).
//
// Each save UPSERTs into caio_memory using a stable composite key of
// `{scopeKey}:{dbLayer}` so re-saving the same scope overwrites the prior
// entry rather than accumulating duplicates. Cross-thread persistence is
// achieved by keying on (tenant_id, account_id) rather than threadId.
//
// layer mapping: external 'global' → DB 'global', external 'role' → DB 'personal'
//
// Fails soft: a failure to write is logged and returned as saved=false,
// never rethrows.
//
// Import paths use .js extensions (ESM).

import { randomUUID } from 'node:crypto';
import { log } from '../../infrastructure/logging.js';
import { withTenantContext } from '../../infrastructure/rls.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

/**
 * Default scope key used when the CAIO doesn't supply one. Must match the
 * MemoryService SCOPE_KEY_PATTERN (/^[a-zA-Z0-9_-]+$/) so future migration
 * to the tenant runtime is a drop-in.
 */
export const DEFAULT_SCOPE_KEY = 'workforce-planning';

interface MemorySaveInput {
  content: string;
  layer: 'global' | 'role';
  scopeKey?: string;
  tags?: string[];
}

interface MemorySaveOutput {
  id: string | null;
  saved: boolean;
  layer: string;
  scopeKey: string;
  message: string;
}

/** Map the external layer value to the DB layer column value. */
function toDbLayer(layer: 'global' | 'role'): 'global' | 'personal' {
  return layer === 'global' ? 'global' : 'personal';
}

export const memorySaveTool: WorkforcePlanTool = {
  definition: {
    name: 'memory_save',
    description:
      'Save a strategic decision, user preference, or organisational fact to memory so it persists across planning sessions. Use this after reaching a significant conclusion in the conversation - not for every small detail. Pick layer="global" for tenant-wide knowledge (e.g. "user prefers conservative HITL levels"), or layer="role" for planning-specific context the CAIO itself will recall in future sessions (e.g. "Q2 plan prioritises customer ops agents over engineering"). scopeKey is optional; if omitted, saves are grouped under the default "workforce-planning" bucket. Supply your own kebab-case key (letters, digits, dashes, underscores only) when you want finer-grained recall. Never save credentials, PII, or financial account details - summarise only. The save fails soft: if the memory store is unreachable, the id will be null and you can inform the user.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The memory content to persist (max 4000 chars). A concise factual statement, not a transcript.',
        },
        layer: {
          type: 'string',
          enum: ['global', 'role'],
          description: 'global = tenant-wide, role = CAIO-scoped planning context.',
        },
        scopeKey: {
          type: 'string',
          description: 'Optional stable kebab-case key for this memory (e.g. "q2-2026" or "user-preference"). Defaults to "workforce-planning" when omitted. Must match /^[a-zA-Z0-9_-]+$/.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for filtering on retrieval (max 20 items).',
        },
      },
      required: ['content', 'layer'],
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<MemorySaveOutput> {
    const input = rawInput as unknown as MemorySaveInput;
    const scopeKey =
      input.scopeKey && input.scopeKey.length > 0 ? input.scopeKey : DEFAULT_SCOPE_KEY;

    const dbLayer = toDbLayer(input.layer);

    // Use tenantId as fallback accountId for team/global-layer writes where
    // accountId may not be set.
    const accountId =
      ctx.accountId && ctx.accountId.length > 0 ? ctx.accountId : ctx.tenantId;

    try {
      const id = randomUUID();

      // Stable composite key: one slot per (tenant, account, layer, scopeKey).
      // Re-saving overwrites via ON CONFLICT rather than appending a new row.
      const finalKey = `${scopeKey}:${dbLayer}`;

      // caio_memory is RLS-protected and its policy has no missing_ok, so a
      // raw pool query cannot write to it: the tenant GUC is unset, the policy
      // evaluates to NULL, and the INSERT is rejected. That is exactly what it
      // did — every save since this service was extracted failed and fell into
      // the soft-fail branch below. INV-WF-001.
      const result = await withTenantContext(ctx.tenantId, (client) => client.query<{ id: string }>(
        `INSERT INTO caio_memory(id, tenant_id, account_id, key, layer, content, tags, scope_key)
         VALUES($1, $2, $3, $4, $5, $6, $7::text[], $8)
         ON CONFLICT(tenant_id, account_id, key) DO UPDATE
           SET content    = EXCLUDED.content,
               tags       = EXCLUDED.tags,
               scope_key  = EXCLUDED.scope_key,
               updated_at = NOW()
         RETURNING id`,
        [
          id,
          ctx.tenantId,
          accountId,
          finalKey,
          dbLayer,
          input.content.slice(0, 4000),
          input.tags ?? [],
          input.scopeKey ?? null,
        ],
      ));

      const savedId = result.rows[0]?.id ?? id;

      return {
        id: savedId,
        saved: true,
        layer: input.layer,
        scopeKey,
        message: `Saved to ${input.layer} memory under key "${scopeKey}".`,
      };
    } catch (err) {
      log.warn(
        {
          tenantId: ctx.tenantId,
          accountId,
          error: (err as Error).message,
        },
        'memory_save: failed to write to caio_memory — fail soft',
      );
      return {
        id: null,
        saved: false,
        layer: input.layer,
        scopeKey,
        message:
          'Memory store is unreachable right now. The fact was not persisted - the user will not see it recalled in future sessions. Continue the conversation and try again later if needed.',
      };
    }
  },
};
