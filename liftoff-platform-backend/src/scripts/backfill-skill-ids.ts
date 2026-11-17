// Give every stored skill a stable id, adopting the one the runtime already uses.
//
// `internal_agents.skills[].id` is optional and, before the provenance merge
// started assigning one, nothing set it. A skill that reaches the runtime
// without an id is inserted under a freshly generated one on every publish,
// which supersedes its own predecessor and strands the metrics row keyed to the
// old id. The merge now mints an id, but only for agents that are published
// again — this sweep closes the gap for everything already stored.
//
// It adopts the RUNTIME's id rather than minting a new one. The runtime's active
// row for a skill already carries an id; writing that same id into the column
// means the next publish reactivates that row through ON CONFLICT (id) instead
// of inserting a replacement, so the sweep costs no churn and keeps existing
// per-skill metrics attached. A skill the runtime does not have gets a fresh id,
// since there is nothing to adopt.
//
// Matching is by name, which is what identifies a skill when no id exists —
// `identityKey` in skill-provenance.ts falls back to the same thing.
//
// Nothing is published. Once the column agrees with the runtime the two are
// already consistent, and a publish would only rewrite rows that are correct.
//
// Usage:
// Lives under src/ so it compiles into dist/ and can run as a Cloud Run Job.
// Cloud SQL is private-IP only, so a job in the VPC is the only way this reaches
// the database at all.
//
//   DRY_RUN=true node dist/scripts/backfill-skill-ids.js   # report only
//   node dist/scripts/backfill-skill-ids.js                # apply

import { randomUUID } from 'crypto';
import { closePools, initDatabase, withAdminScope, withTenantScope } from '../infrastructure/database';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { log } from '../infrastructure/logging';
import type { Skill } from '../internal-agents/types';

interface AgentRow {
  id: string;
  tenant_id: string;
  role: string;
}

const DRY_RUN = process.env.DRY_RUN === 'true';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A skill the runtime can reactivate in place, or a new id when it cannot. */
export function assignSkillIds(
  columnSkills: Skill[],
  runtimeSkills: Array<{ id: string; name: string }>,
): { skills: Skill[]; adopted: number; minted: number; alreadyHadId: number } {
  const runtimeIdByName = new Map<string, string>();
  for (const r of runtimeSkills) {
    // Only a real UUID is worth adopting: the runtime column is typed uuid, so
    // anything else could never have come from it.
    if (r.id && UUID_RE.test(r.id)) runtimeIdByName.set(nameKey(r.name), r.id);
  }

  let adopted = 0;
  let minted = 0;
  let alreadyHadId = 0;

  const skills = columnSkills.map((s) => {
    if (s.id) {
      alreadyHadId += 1;
      return s;
    }
    const fromRuntime = runtimeIdByName.get(nameKey(s.name));
    if (fromRuntime) {
      adopted += 1;
      return { ...s, id: fromRuntime };
    }
    minted += 1;
    return { ...s, id: randomUUID() };
  });

  return { skills, adopted, minted, alreadyHadId };
}

async function main(): Promise<void> {
  // withAdminScope builds its own admin pool lazily, and the per-agent reads and
  // writes below need the ordinary pool. index.ts initialises at boot; a Cloud
  // Run Job has no boot.
  await initDatabase();

  const agents = await withAdminScope({
    caller: 'scripts/backfill-skill-ids',
    reason: 'one-time assignment of stable skill ids to stored agent skills',
  }, async (client) => {
    const result = await client.query<AgentRow>(
      // Tenant-less rows are excluded: the two platform system agents carry an
      // empty tenant_id and have no tenant runtime to ask, so the skills call
      // for them fails every time.
      `SELECT id, tenant_id, role
         FROM internal_agents
        WHERE deleted_at IS NULL AND status != 'deleted'
          AND tenant_id IS NOT NULL AND tenant_id::text <> ''
          AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(skills, '[]'::jsonb)) e
                 WHERE e->>'id' IS NULL OR e->>'id' = ''
              )
        ORDER BY tenant_id, id`,
    );
    return result.rows;
  });

  log.info({ agentCount: agents.length, dryRun: DRY_RUN }, 'skill-id backfill: start');

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let totalAdopted = 0;
  let totalMinted = 0;

  for (const agent of agents) {
    try {
      const { skills: runtimeSkills } = await tenantRuntimeClient.getAgentSkills(
        agent.tenant_id,
        agent.id,
      );

      const columnSkills = await withTenantScope(agent.tenant_id, async (client) => {
        const row = await client.query<{ skills: Skill[] | null }>(
          `SELECT skills FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
          [agent.id, agent.tenant_id],
        );
        return Array.isArray(row.rows[0]?.skills) ? row.rows[0].skills : [];
      });

      if (columnSkills.length === 0) {
        skipped += 1;
        continue;
      }

      const { skills, adopted, minted, alreadyHadId } = assignSkillIds(
        columnSkills,
        runtimeSkills ?? [],
      );

      if (adopted === 0 && minted === 0) {
        skipped += 1;
        continue;
      }

      totalAdopted += adopted;
      totalMinted += minted;

      if (!DRY_RUN) {
        await withTenantScope(agent.tenant_id, async (client) => {
          await client.query(
            `UPDATE internal_agents SET skills = $1::jsonb WHERE id = $2 AND tenant_id = $3`,
            [JSON.stringify(skills), agent.id, agent.tenant_id],
          );
        });
      }

      updated += 1;
      log.info(
        {
          agentId: agent.id,
          tenantId: agent.tenant_id,
          role: agent.role,
          adopted,
          minted,
          alreadyHadId,
          dryRun: DRY_RUN,
        },
        'skill-id backfill: agent processed',
      );
    } catch (err) {
      failed += 1;
      log.error(
        { agentId: agent.id, tenantId: agent.tenant_id, error: (err as Error).message },
        'skill-id backfill: agent failed (continuing)',
      );
    }
  }

  log.info(
    { total: agents.length, updated, skipped, failed, totalAdopted, totalMinted, dryRun: DRY_RUN },
    'skill-id backfill: complete',
  );

  if (failed > 0) process.exitCode = 1;
}

// Guarded so assignSkillIds can be imported and tested without the script
// running itself on import. Same shape as the sibling backfills.
if (require.main === module) {
  main()
    .then(async () => { await closePools(); })
    .catch((err) => {
      log.error({ error: (err as Error).message }, 'skill-id backfill: fatal');
      process.exit(1);
    });
}
