#!/usr/bin/env npx ts-node

/**
 * W4 of the work_inbox/ack convention plan
 *
 * After W1 (registry metadata) and W2 (distill primitive) ship, existing
 * agents still have their OLD distilled system prompt baked in — they
 * won't get the acknowledgement contract until they're re-distilled.
 *
 * This script walks every active agent in every tenant, resolves each
 * agent's tool catalog, and re-distills any agent whose catalog contains
 * a workRole='inbox' tool. The result of each re-distill is a NEW
 * stored system_prompt + user_instructions + instructionsMd with the
 * W2 contract section baked in.
 *
 * Behaviour:
 *  - Default dry-run: reports which agents would be re-distilled and
 *    why; makes no writes.
 *  - --execute mode: actually invokes redistillAgent, which persists
 *    the new outputs and bumps the agent's distillation_version.
 *  - --tenant <id> scopes to a single tenant for staged rollout.
 *  - Rate-limited to one re-distill per 2 seconds to stay within LLM
 *    rate limits (matches the existing backfill-agent-instructions-md
 *    script's pacing).
 *
 * Output: one line per agent processed:
 *   { agentId, tenantId, role, pairCount, action, error? }
 * Where action ∈ {'redistilled' | 'skipped_no_inbox' | 'skipped_dry_run' |
 *                 'errored'}.
 *
 * Usage:
 *   npx ts-node src/scripts/redistill-work-inbox-agents.ts                              # dry-run all tenants, inbox-bound agents only
 *   npx ts-node src/scripts/redistill-work-inbox-agents.ts --execute                    # execute all tenants, inbox-bound agents only
 *   npx ts-node src/scripts/redistill-work-inbox-agents.ts --tenant <id>                # single tenant (dry-run)
 *   npx ts-node src/scripts/redistill-work-inbox-agents.ts --tenant <id> --execute
 *   npx ts-node src/scripts/redistill-work-inbox-agents.ts --tenant <id> --force-all   # redistill ALL active agents in tenant (post-Composio-cutover use)
 *   npx ts-node src/scripts/redistill-work-inbox-agents.ts --tenant <id> --force-all --execute
 *
 * Failure mode: per-agent errors are isolated — the script logs and
 * continues. Final summary reports total / redistilled / skipped /
 * errored counts.
 */

import { initDatabase, withAdminScope } from '../infrastructure/database';
import { redistillAgent } from '../internal-agents/redistill-service';
import {
  resolveWorkInboxPairs,
  DistillationError,
} from '../internal-agents/distill-work-inbox-injection';
import type { ToolCatalog } from '../internal-agents/distill-service';
import { log } from '../infrastructure/logging';
import { resolveRuntimeBaseUrl, buildRuntimeHeaders } from '../connectors/tenant-runtime-url';

const RATE_LIMIT_MS = 2000;

interface AgentRow {
  id: string;
  tenant_id: string;
  role: string;
  integrations: unknown;
}

interface IntegrationInfo {
  type?: string;
  manifestId?: string;
}

interface SweepReportLine {
  agentId: string;
  tenantId: string;
  role: string;
  pairCount: number;
  action: 'redistilled' | 'skipped_no_inbox' | 'skipped_dry_run' | 'errored';
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a flat tool catalog for the agent by walking each integration's
 * manifest and fetching its tool list from tenant-runtime. Same path the
 * distill service itself uses, so the catalog we inspect matches the one
 * distill will see when we trigger re-distill.
 */
interface CachedTenantManifests {
  manifests: Array<{ manifestId: string; connectorType: string; alias: string; displayName: string }>;
  toolsByManifest: Map<string, Array<{ name: string; description: string; categories?: string[]; entityType?: string; draftVariant?: string; workRole?: 'inbox' | 'ack'; paired_ack?: string; acknowledges?: string; workItemKind?: string }>>;
}

const tenantCatalogCache = new Map<string, CachedTenantManifests>();

/**
 * Fetch all manifests + their tools for a tenant ONCE per script run, cache
 * it. Subsequent agents in the same tenant reuse the cache. Prevents the
 * tool-catalog rate limit (100 req/min/tenant) from being tripped by
 * per-agent redundant calls.
 *
 * Also dumps verbose stats so we can see how many tools came back per
 * manifest and whether any carry the W1 work_inbox tags.
 */
async function ensureTenantCatalog(tenantId: string): Promise<CachedTenantManifests> {
  const cached = tenantCatalogCache.get(tenantId);
  if (cached) return cached;

  const baseUrl = await resolveRuntimeBaseUrl(tenantId);
  const headers = await buildRuntimeHeaders(tenantId);

  const manifestsRes = await fetch(`${baseUrl}/api/v1/tool-catalog/tenant/${tenantId}/manifests`, {
    method: 'GET', headers,
  });
  if (!manifestsRes.ok) {
    log.warn({ tenantId, status: manifestsRes.status }, 'redistill-sweep: /manifests fetch failed');
    const empty = { manifests: [], toolsByManifest: new Map() };
    tenantCatalogCache.set(tenantId, empty);
    return empty;
  }
  const manifestsData = (await manifestsRes.json()) as { manifests: CachedTenantManifests['manifests'] };
  const manifests = manifestsData.manifests ?? [];
   
  console.log(`[tenant ${tenantId}] manifests: ${manifests.length} → ${manifests.map((m) => m.connectorType).join(', ')}`);

  const toolsByManifest = new Map<string, CachedTenantManifests['toolsByManifest'] extends Map<string, infer V> ? V : never>();
  for (const m of manifests) {
    const toolsRes = await fetch(
      `${baseUrl}/api/v1/tool-catalog/tenant/${tenantId}/manifest/${m.manifestId}/tools`,
      { method: 'GET', headers },
    );
    if (!toolsRes.ok) {
       
      console.log(`  [tenant ${tenantId}] manifest ${m.connectorType}: GET tools → HTTP ${toolsRes.status}`);
      toolsByManifest.set(m.manifestId, []);
      continue;
    }
    const toolsBody = (await toolsRes.json()) as { tools: CachedTenantManifests['toolsByManifest'] extends Map<string, infer V> ? V : never };
    const tools = toolsBody.tools ?? [];
    toolsByManifest.set(m.manifestId, tools);
    const inboxCount = tools.filter((t) => t.workRole === 'inbox').length;
    const ackCount = tools.filter((t) => t.workRole === 'ack').length;
     
    console.log(`  [tenant ${tenantId}] manifest ${m.connectorType}: ${tools.length} tools (${inboxCount} inbox, ${ackCount} ack)`);
    // Sample one inbox tool's full shape on the first manifest that has one
    // so we can verify the wire is carrying W1 metadata.
    const sampleInbox = tools.find((t) => t.workRole === 'inbox');
    if (sampleInbox && !tenantCatalogCache.has(tenantId)) {
       
      console.log(`  [tenant ${tenantId}] sample inbox: ${JSON.stringify({
        name: sampleInbox.name,
        workRole: sampleInbox.workRole,
        paired_ack: sampleInbox.paired_ack,
        workItemKind: sampleInbox.workItemKind,
      })}`);
    }
  }

  const result = { manifests, toolsByManifest };
  tenantCatalogCache.set(tenantId, result);
  return result;
}

async function buildAgentCatalog(
  tenantId: string,
  integrations: IntegrationInfo[],
): Promise<ToolCatalog> {
  const catalog: ToolCatalog = new Map();
  if (integrations.length === 0) return catalog;

  try {
    const tenantCatalog = await ensureTenantCatalog(tenantId);
    const { manifests, toolsByManifest } = tenantCatalog;
    if (manifests.length === 0) return catalog;

    const integrationTypes = new Set(
      integrations.map((i) => i.type).filter((t): t is string => !!t),
    );
    const relevant =
      integrationTypes.size > 0
        ? manifests.filter((m) => integrationTypes.has(m.connectorType))
        : manifests;

    for (const m of relevant) {
      const tools = toolsByManifest.get(m.manifestId) ?? [];
      for (const tool of tools) {
        catalog.set(tool.name, {
          name: tool.name,
          description: tool.description,
          categories: tool.categories,
          entityType: tool.entityType,
          draftVariant: tool.draftVariant,
          workRole: tool.workRole,
          paired_ack: tool.paired_ack,
          acknowledges: tool.acknowledges,
          workItemKind: tool.workItemKind,
        });
      }
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message, tenantId },
      'redistill-sweep: getTenantManifests failed — agent treated as catalog-empty',
    );
  }
  return catalog;
}

async function main() {
  await initDatabase();

  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  // C7 (Composio cutover): --force-all bypasses the inbox-tool gate and
  // redistills EVERY active agent. Used as the post-deploy sweep that
  // brings every stored prompt onto the new stable-name set. Without
  // --force-all the script still only touches agents bound to a
  // work_inbox pair (original W4 behavior).
  const forceAll = args.includes('--force-all');
  const tenantIdx = args.indexOf('--tenant');
  const tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : null;

  console.log('\n=== W4: Redistill agents with work_inbox tools ===');
  console.log(`Mode:      ${execute ? '🚀 EXECUTE' : '🔍 DRY-RUN'}`);
  console.log(`Scope:     ${forceAll ? 'ALL active agents (--force-all)' : 'agents bound to work_inbox pairs'}`);
  console.log(`Tenant:    ${tenantId ?? 'ALL'}`);
  console.log(`Pacing:    1 agent per ${RATE_LIMIT_MS}ms\n`);

  // Pull every non-deleted agent across the chosen scope.
  const rows = (
    tenantId
      ? await withAdminScope({ caller: 'redistill-work-inbox-agents', reason: 'cross-tenant internal_agents redistill sweep' }, (client) => client.query<AgentRow>(
          `SELECT id, tenant_id, role, integrations
           FROM internal_agents
           WHERE tenant_id = $1 AND status != 'deleted'
           ORDER BY id`,
          [tenantId],
        ))
      : await withAdminScope({ caller: 'redistill-work-inbox-agents', reason: 'cross-tenant internal_agents redistill sweep' }, (client) => client.query<AgentRow>(
          `SELECT id, tenant_id, role, integrations
           FROM internal_agents
           WHERE status != 'deleted'
           ORDER BY tenant_id, id`,
        ))
  ).rows;

  console.log(`Found ${rows.length} agent(s) to inspect.\n`);

  const report: SweepReportLine[] = [];
  let counter = 0;
  for (const row of rows) {
    counter++;
    const integrations = Array.isArray(row.integrations)
      ? (row.integrations as IntegrationInfo[])
      : [];

    try {
      const catalog = await buildAgentCatalog(row.tenant_id, integrations);
      let pairs;
      try {
        pairs = resolveWorkInboxPairs(catalog);
      } catch (err) {
        if (err instanceof DistillationError) {
          // Inbox is bound but ack is not — re-distill would fail. Surface
          // the broken-binding case so an operator can fix it, but don't
          // crash the whole sweep.
          report.push({
            agentId: row.id,
            tenantId: row.tenant_id,
            role: row.role,
            pairCount: 0,
            action: 'errored',
            error: `work_inbox_missing_ack: ${err.details.inboxTool} → ${err.details.expectedAck}`,
          });
          console.log(
            `[${counter}/${rows.length}] ❌ ${row.id} (${row.role}): ${err.message}`,
          );
          continue;
        }
        throw err;
      }

      if (pairs.length === 0 && !forceAll) {
        report.push({
          agentId: row.id,
          tenantId: row.tenant_id,
          role: row.role,
          pairCount: 0,
          action: 'skipped_no_inbox',
        });
        if (counter % 25 === 0) {
          console.log(`[${counter}/${rows.length}] (no inbox tools — skipped)`);
        }
        continue;
      }

      if (!execute) {
        report.push({
          agentId: row.id,
          tenantId: row.tenant_id,
          role: row.role,
          pairCount: pairs.length,
          action: 'skipped_dry_run',
        });
        console.log(
          `[${counter}/${rows.length}] 📋 ${row.id} (${row.role}): would re-distill — ${pairs.length} pair(s)`,
        );
        continue;
      }

      console.log(
        `[${counter}/${rows.length}] 🔄 ${row.id} (${row.role}): re-distilling — ${pairs.length} pair(s)`,
      );
      // actor_id is UUID-typed in internal_agent_audit; pass undefined so
      // the audit row records NULL (matches the router's redistill flow).
      // Sweep provenance is captured via the Cloud Run Job name + execution
      // id in Cloud Logging, not the audit row.
      await redistillAgent(row.id, row.tenant_id, undefined);
      report.push({
        agentId: row.id,
        tenantId: row.tenant_id,
        role: row.role,
        pairCount: pairs.length,
        action: 'redistilled',
      });
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      report.push({
        agentId: row.id,
        tenantId: row.tenant_id,
        role: row.role,
        pairCount: 0,
        action: 'errored',
        error: (err as Error).message,
      });
      console.log(
        `[${counter}/${rows.length}] ❌ ${row.id} (${row.role}): ${(err as Error).message}`,
      );
    }
  }

  console.log('\n=== Summary ===');
  const counts = {
    total: report.length,
    redistilled: report.filter((r) => r.action === 'redistilled').length,
    skipped_dry_run: report.filter((r) => r.action === 'skipped_dry_run').length,
    skipped_no_inbox: report.filter((r) => r.action === 'skipped_no_inbox').length,
    errored: report.filter((r) => r.action === 'errored').length,
  };
  console.log(JSON.stringify(counts, null, 2));

  const erroredAgents = report.filter((r) => r.action === 'errored');
  if (erroredAgents.length > 0) {
    console.log(`\nErrored agents (${erroredAgents.length}):`);
    for (const e of erroredAgents) {
      console.log(`  - ${e.agentId} (tenant ${e.tenantId}, role ${e.role}): ${e.error}`);
    }
  }

  process.exit(counts.errored > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
