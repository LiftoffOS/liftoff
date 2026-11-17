/**
 * One-off migration: fixes agents whose triggerConfig.eventTopic was hallucinated
 * by distillation (pre event-topics injection). Run once after all three services deploy.
 *
 * Strategy: for each affected agent, find its first polled+listImplemented integration
 * and set eventTopic to that integration's primary topic. Reset to 'manual' if none found.
 *
 * Required env vars:
 *   DATABASE_URL          — Postgres connection string
 *   CONNECTOR_SERVICE_URL — URL of the connector-service instance (for getCatalog())
 *   CONNECTOR_SERVICE_TOKEN — Service auth token (X-Service-Auth header)
 *
 * Usage: DATABASE_URL=... CONNECTOR_SERVICE_URL=... CONNECTOR_SERVICE_TOKEN=... \
 *          npx ts-node scripts/migrate-agent-trigger-configs.ts [--dry-run]
 */

import { Pool } from 'pg';
import { getCatalog } from '../src/connectors/connector-service-client';

const isDryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  if (!process.env.CONNECTOR_SERVICE_URL) {
    console.error('CONNECTOR_SERVICE_URL is required');
    process.exit(1);
  }
  if (!process.env.CONNECTOR_SERVICE_TOKEN) {
    console.error('CONNECTOR_SERVICE_TOKEN is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  // 1. Load canonical topics (only listImplemented:true) from connector-service
  const catalog = await getCatalog();
  const canonicalByType = new Map<string, string[]>(
    catalog.connectors
      .filter(c => c.polling?.some(p => p.listImplemented))
      .map(c => [
        c.type,
        [...new Set(c.polling!.filter(p => p.listImplemented).flatMap(p => p.eventTopics))],
      ])
  );
  const allCanonicalTopics = new Set([...canonicalByType.values()].flat());

  // 2. Fetch agents with event triggers
  const { rows: agents } = await pool.query<{
    id: string;
    tenant_id: string;
    trigger_config: Record<string, unknown> | string;
    integrations: Array<{ type?: string }> | null;
  }>(
    `SELECT id, tenant_id, trigger_config, integrations
     FROM internal_agents
     WHERE trigger_config->>'type' = 'event'`
  );

  console.log(`Found ${agents.length} agents with event triggers`);

  let fixed = 0, reset = 0, skipped = 0;

  for (const agent of agents) {
    const triggerConfig = typeof agent.trigger_config === 'string'
      ? JSON.parse(agent.trigger_config) as Record<string, unknown>
      : agent.trigger_config;
    const currentTopic: string = (triggerConfig?.eventTopic as string) ?? '';

    // Already a canonical topic — no-op
    if (allCanonicalTopics.has(currentTopic)) {
      skipped++;
      continue;
    }

    // integrations is JSONB: IntegrationPermission[] — type field is optional
    const integrations: Array<{ type?: string }> = agent.integrations ?? [];
    const polledIntegration = integrations.find(i => i.type && canonicalByType.has(i.type));

    if (polledIntegration?.type) {
      const correctTopic = canonicalByType.get(polledIntegration.type)![0];
      console.log(
        isDryRun ? '[DRY RUN] would fix' : 'fixed',
        { agentId: agent.id, from: currentTopic, to: correctTopic },
      );
      if (!isDryRun) {
        await pool.query(
          `UPDATE internal_agents
           SET trigger_config = trigger_config || $1::jsonb
           WHERE id = $2`,
          [JSON.stringify({ eventTopic: correctTopic }), agent.id],
        );
      }
      fixed++;
    } else {
      console.warn(
        isDryRun ? '[DRY RUN] would reset to manual' : 'reset to manual',
        { agentId: agent.id, topic: currentTopic },
      );
      if (!isDryRun) {
        await pool.query(
          `UPDATE internal_agents
           SET trigger_config = $1::jsonb
           WHERE id = $2`,
          [JSON.stringify({ type: 'manual', reasoning: 'reset by migrate-agent-trigger-configs: no polled integration found' }), agent.id],
        );
      }
      reset++;
    }
  }

  console.log('migration complete', { fixed, reset, skipped, total: agents.length, isDryRun });
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
