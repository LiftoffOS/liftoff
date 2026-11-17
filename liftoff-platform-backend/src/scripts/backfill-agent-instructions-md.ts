#!/usr/bin/env npx ts-node

/**
 * Backfill instructions_md for existing internal agents.
 *
 * For each active agent with instructions_md IS NULL, calls the distill
 * service to generate instructionsMd from the agent's existing role,
 * responsibilities, integrations, and additionalContext. Only writes
 * instructions_md — does NOT overwrite systemPrompt or userInstructions.
 *
 * Usage:
 *   npx ts-node scripts/backfill-agent-instructions-md.ts                    # dry-run all tenants
 *   npx ts-node scripts/backfill-agent-instructions-md.ts --execute          # execute all tenants
 *   npx ts-node scripts/backfill-agent-instructions-md.ts --tenant <id>      # single tenant (dry-run)
 *   npx ts-node scripts/backfill-agent-instructions-md.ts --tenant <id> --execute
 *
 * Rate limited: one agent per 2 seconds to stay within LLM rate limits.
 */

import { initDatabase, withAdminScope } from '../infrastructure/database';
import { distillInternalAgent } from '../internal-agents/distill-service';
import { log } from '../infrastructure/logging';

const RATE_LIMIT_MS = 2000;

interface AgentRow {
  id: string;
  tenant_id: string;
  role: string;
  responsibilities: string | null;
  integrations: unknown;
  additional_context: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // Initialize DB pool — required before any pool.query() call.
  // The pool is lazy-initialized via initDatabase() which reads
  // DB_HOST/CLOUD_SQL_CONNECTION_NAME/DB_PASSWORD from env/secrets.
  await initDatabase();

  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const tenantIdx = args.indexOf('--tenant');
  const tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : null;

  console.log(`\n=== Backfill agent instructions_md ===`);
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
  if (tenantId) console.log(`Tenant: ${tenantId}`);
  console.log('');

  const query = tenantId
    ? `SELECT id, tenant_id, role, responsibilities, integrations, additional_context
       FROM internal_agents
       WHERE instructions_md IS NULL AND deleted_at IS NULL AND status = 'active' AND tenant_id = $1
       ORDER BY created_at`
    : `SELECT id, tenant_id, role, responsibilities, integrations, additional_context
       FROM internal_agents
       WHERE instructions_md IS NULL AND deleted_at IS NULL AND status = 'active'
       ORDER BY tenant_id, created_at`;

  const params = tenantId ? [tenantId] : [];
  // internal_agents is RLS-enabled; this backfill reads cross-tenant (or a
  // single --tenant) with no request scope → withAdminScope (mirrors the write).
  const result = await withAdminScope(
    { caller: 'backfill-agent-instructions-md.read', reason: 'cross-tenant (or --tenant) read of internal_agents rows needing instructions_md backfill' },
    (client) => client.query<AgentRow>(query, params),
  );

  console.log(`Found ${result.rows.length} agents to backfill.\n`);

  if (result.rows.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;

  for (const row of result.rows) {
    const integrations = Array.isArray(row.integrations)
      ? (row.integrations as Array<{ id: string; name?: string; type?: string; selectedObjects?: string[] }>).map(i => ({
          id: i.id,
          name: i.name || i.type || 'unknown',
          type: i.type || 'unknown',
          selectedObjects: i.selectedObjects || [],
        }))
      : [];

    console.log(`[${row.tenant_id}] ${row.id} — "${row.role}"`);

    if (!execute) {
      console.log(`  → DRY-RUN: would call distill and write instructions_md\n`);
      succeeded++;
      continue;
    }

    try {
      const distillResult = await distillInternalAgent({
        role: row.role,
        responsibilities: row.responsibilities || '',
        integrations,
        additionalContext: row.additional_context,
        tenantId: row.tenant_id,
        agentId: row.id,
      });

      await withAdminScope({ caller: 'backfill-agent-instructions-md', reason: 'cross-tenant (or --tenant) backfill of internal_agents.instructions_md' }, (client) => client.query(
        `UPDATE internal_agents SET instructions_md = $1, updated_at = NOW() WHERE id = $2`,
        [distillResult.instructionsMd, row.id],
      ));

      console.log(`  → OK (${distillResult.instructionsMd?.length ?? 0} chars)\n`);
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  → FAILED: ${msg}\n`);
      log.error({ agentId: row.id, tenantId: row.tenant_id, error: msg }, 'backfill-agent-instructions-md: distill failed');
      failed++;
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n=== Done ===`);
  console.log(`Succeeded: ${succeeded}, Failed: ${failed}, Total: ${result.rows.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
