// Backfill agent_skill_metrics for all active agents that have no skill metric rows.
//
// Run once after deploying migration 158 (agent_skill_metrics + skill_feedback_log tables).
//
// Usage (ts-node):
//   DATABASE_URL=postgres://... TENANT_RUNTIME_SERVICE_TOKEN=... \
//   npx ts-node --project tsconfig.json src/scripts/backfill-skill-metrics.ts
//
// Usage (compiled, Cloud Run job):
//   node -e "require('./dist/scripts/backfill-skill-metrics').runBackfill().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);})"
//
// Idempotent — agents that already have skill metric rows are skipped.

import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { withAdminScope, withTenantScope } from '../infrastructure/database';

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;

interface AgentRow {
  id: string;
  tenant_id: string;
  runtime_url: string | null;
}

interface RuntimeSkill {
  id: string;
  name: string;
  description: string;
  instruction: string;
  tags: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runBackfill(): Promise<void> {
  const serviceToken = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  const total = await withAdminScope(
    { caller: 'scripts.backfill-skill-metrics.count', reason: 'cross-tenant active-agent count' },
    async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) FROM internal_agents
         WHERE status = 'active' AND deleted_at IS NULL`,
      );
      return parseInt(result.rows[0].count, 10);
    },
  );
  console.log(`Active agents to check: ${total}`);

  let offset = 0;
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  while (offset < total) {
    const rows = await withAdminScope(
      { caller: 'scripts.backfill-skill-metrics.page', reason: 'cross-tenant agent page for backfill' },
      async (client) => {
        const result = await client.query<AgentRow>(
          `SELECT ia.id, ia.tenant_id, t.runtime_url
           FROM internal_agents ia
           JOIN tenants t ON t.id = ia.tenant_id
           WHERE ia.status = 'active' AND ia.deleted_at IS NULL
           ORDER BY ia.created_at ASC
           LIMIT $1 OFFSET $2`,
          [BATCH_SIZE, offset],
        );
        return result.rows;
      },
    );

    if (rows.length === 0) break;

    for (const agent of rows) {
      const hasMetrics = await withTenantScope(agent.tenant_id, async (client) => {
        const existsResult = await client.query<{ skill_id: string }>(
          `SELECT skill_id FROM agent_skill_metrics WHERE agent_id = $1 LIMIT 1`,
          [agent.id],
        );
        return existsResult.rows.length > 0;
      });
      if (hasMetrics) {
        skipped++;
        continue;
      }

      if (!agent.runtime_url) {
        console.warn(`  agent ${agent.id}: no runtime_url for tenant ${agent.tenant_id}, skipping`);
        failed++;
        continue;
      }

      try {
        const skillsUrl = `${agent.runtime_url}/api/agents/${agent.id}/skills?tenantId=${agent.tenant_id}`;
        // Cloud Run IAM requires an OIDC identity token; app-level service token goes in X-Service-Auth.
        const oidcHeaders = await buildOidcAuthHeader(agent.runtime_url);
        const headers: Record<string, string> = { ...oidcHeaders };
        if (serviceToken) headers['X-Service-Auth'] = serviceToken;
        const response = await fetch(skillsUrl, { method: 'GET', headers });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime`);
        }

        const data = await response.json() as { skills: RuntimeSkill[] };
        const skills: RuntimeSkill[] = data.skills ?? [];

        if (skills.length === 0) {
          skipped++;
          continue;
        }

        await withTenantScope(agent.tenant_id, async (client) => {
          for (const skill of skills) {
            await client.query(
              `INSERT INTO agent_skill_metrics (agent_id, tenant_id, skill_id, skill_name, origin)
               VALUES ($1, $2, $3, $4, 'distill')
               ON CONFLICT (agent_id, skill_id) DO NOTHING`,
              [agent.id, agent.tenant_id, skill.id, skill.name],
            );
          }
        });

        processed++;
        if (processed % 10 === 0) {
          console.log(`  seeded ${processed} agents (skipped ${skipped}, failed ${failed})`);
        }
      } catch (err) {
        failed++;
        console.warn(`  failed agent ${agent.id}: ${(err as Error).message}`);
      }
    }

    offset += rows.length;
    if (offset < total) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`Done. processed=${processed}, skipped=${skipped}, failed=${failed}`);
}

// Allow direct ts-node invocation
if (require.main === module) {
  runBackfill().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
