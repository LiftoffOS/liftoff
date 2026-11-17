// Backfill agent_skills rows in tenant-runtime by re-emitting the
// tenant.internal_agent.skills_updated event for every active internal_agent
// whose internal_agents.skills[] is non-empty.
//
// Why this exists:
//   Before migration 258 in tenant-runtime, every initial skill-write path
//   (instruction-compiler.createAndActivateForInternalAgent) silently
//   stored NULL embedding because agent_skills.embedding was vector(1536)
//   while the platform default produces 768d. The INSERT succeeded with
//   embedding=NULL but the skill rows became invisible to retrieval.
//   Migration 258 in tenant-runtime fixed the dimension; the write-time
//   path now has retries and ERROR-level logging on persistent failure.
//
//   But existing internal_agents that were created BEFORE migration 258
//   have NO agent_skills rows at all in tenant-runtime (the initial INSERT
//   failed with the dimension error and was caught + swallowed). The
//   periodic sweeper recovers NULL embeddings but cannot recover MISSING
//   rows. This script re-emits the skills_updated event for each affected
//   agent; tenant-runtime's handleInternalAgentSkillsUpdated calls
//   updateAgentSkillsOnly which inserts the rows with proper embeddings.
//
// Run as a Cloud Run Job using the platform-backend image at a SHA that
// contains this script:
//   gcloud run jobs create runtime-skill-backfill \
//     --image=<platform-backend image> \
//     --region=us-west1 --project=YOUR_CONTROL_PROJECT \
//     --set-cloudsql-instances=... --vpc-connector=serverless-connector \
//     --set-env-vars="<full platform-backend env>" \
//     --set-secrets="DB_PASSWORD=control-plane-db-password:latest,..." \
//     --command=node \
//     --args="dist/scripts/backfill-runtime-agent-skills.js"
//
// Idempotent — the event handler's updateAgentSkillsOnly() supersedes any
// existing active agent_skills rows and re-inserts. Even if a row already
// has a proper embedding, re-running just rewrites it identically.

import { withAdminScope } from '../infrastructure/database';
import { publishEvent } from '../events/publisher';
import { log } from '../infrastructure/logging';

interface AgentRow {
  id: string;
  tenant_id: string;
  current_version: number;
  role: string;
  skills: Array<{
    id?: string;
    name?: string;
    description?: string;
    instruction?: string;
    tags?: string[];
  }>;
}

export async function runRuntimeSkillBackfill(): Promise<void> {
  const tenantFilter = process.env.TENANT_ID_FILTER;
  const dryRun = process.env.DRY_RUN === 'true';

  log.info({ tenantFilter, dryRun }, 'runtime-skill-backfill: starting');

  const rows = await withAdminScope(
    { caller: 'scripts.backfill-runtime-agent-skills', reason: 'cross-tenant active-agent skills enumeration' },
    async (client) => {
      const sql = `SELECT id, tenant_id, current_version, role, COALESCE(skills, '[]'::jsonb) AS skills
                   FROM internal_agents
                   WHERE status = 'active'
                     AND deleted_at IS NULL
                     AND skills IS NOT NULL
                     AND jsonb_array_length(skills) > 0
                     ${tenantFilter ? "AND tenant_id = $1::uuid" : ''}
                   ORDER BY created_at ASC`;
      const result = await client.query<AgentRow>(sql, tenantFilter ? [tenantFilter] : []);
      return result.rows;
    },
  );

  log.info({ candidateCount: rows.length }, 'runtime-skill-backfill: agents discovered');

  let published = 0;
  let failed = 0;

  for (const row of rows) {
    const now = new Date().toISOString();
    const payload = {
      agentId: row.id,
      skills: row.skills,
      updatedAt: now,
      source: 'backfill:runtime-agent-skills',
    };

    if (dryRun) {
      log.info(
        { agentId: row.id, tenantId: row.tenant_id, role: row.role, skillCount: row.skills.length },
        'runtime-skill-backfill: would publish skills_updated (dry-run)',
      );
      continue;
    }

    try {
      // entityVersion=null on the envelope bypasses tenant-runtime's
      // version gate (subscriber.ts:351 — events at version ≤ last
      // processed get discarded as stale). Without this, a backfill
      // re-emit of skills_updated at the agent's current_version is
      // dropped silently because the agent already processed an event
      // at that version (the original create). The reconciler uses the
      // same envelope=null + payload-carries-version pattern.
      await publishEvent({
        entityType: 'internal_agent',
        entityId: row.id,
        eventType: 'tenant.internal_agent.skills_updated',
        entityVersion: null,
        eventVersion: 1,
        tenantId: row.tenant_id,
        payload: { ...payload, entityVersion: row.current_version },
      });
      published += 1;
      log.info(
        { agentId: row.id, tenantId: row.tenant_id, role: row.role, skillCount: row.skills.length },
        'runtime-skill-backfill: published skills_updated',
      );
    } catch (err) {
      failed += 1;
      log.error(
        { agentId: row.id, tenantId: row.tenant_id, err: (err as Error).message },
        'runtime-skill-backfill: publish failed',
      );
    }
  }

  log.info(
    { candidates: rows.length, published, failed, dryRun },
    'runtime-skill-backfill: complete',
  );
}

if (require.main === module) {
  runRuntimeSkillBackfill().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
