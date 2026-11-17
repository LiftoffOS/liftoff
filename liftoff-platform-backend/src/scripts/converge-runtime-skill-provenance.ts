// Make the runtime's view of skill provenance agree with the column's.
//
// The two stores disagree by construction for everything older than TR's
// migration 334. That migration added `agent_skills.provenance` with
// `NOT NULL DEFAULT 'distilled'`, which was the only sane default for a column
// being added to live rows — but it means every skill the reflection flywheel
// authored before that day reads as `distilled` on the runtime side while the
// control-plane column correctly says `learned`. The same is true of
// `protected`, which defaulted to `false` over skills an operator had taken
// ownership of.
//
// The control plane is authoritative (ADR-043) and now behaves that way in
// code, so the disagreement no longer LOSES anything: the flywheel's re-join
// takes the column's value, and every publish carries it. But until an agent
// happens to publish, the runtime keeps serving the wrong answer to anything
// that reads it directly — the skills list on the settings page, usefulness
// scoring, a future feature that trusts the field.
//
// So this forces the publish. It reads nothing from the runtime and decides
// nothing: it re-publishes what the column already says, which is exactly what
// the runtime's own subscriber applies on any ordinary skills change. That is
// what makes it safe to re-run — it is idempotent in the strongest sense, since
// running it twice publishes byte-identical payloads.
//
// Usage:
// Lives under src/ so it compiles into dist/ and can run as a Cloud Run Job.
// That is not a preference: Cloud SQL is private-IP only, so a job in the VPC
// is the only way this reaches the database at all, and a script outside the
// TypeScript rootDir never reaches the image.
//
//   node dist/scripts/converge-runtime-skill-provenance.js            # dry run
//   node dist/scripts/converge-runtime-skill-provenance.js --apply
//   node dist/scripts/converge-runtime-skill-provenance.js --apply --tenant <uuid>

import { withAdminScope } from '../infrastructure/database';
import { publishEvent } from '../internal-agents/events';
import { skillsForRuntime } from '../internal-agents/skill-provenance';
import { logger as log } from '../infrastructure/logging';

interface AgentRow {
  id: string;
  tenant_id: string;
  role: string;
  current_version: number;
  skills: unknown;
}

interface Skill {
  id?: string;
  name: string;
  provenance?: string;
  protected?: boolean;
  archived?: boolean;
}

/**
 * Agents whose column holds at least one skill the runtime's defaults would
 * have got wrong.
 *
 * Narrowed rather than "every agent with skills" on purpose: a publish is a
 * real event with real subscribers, and re-emitting one for every agent in the
 * fleet to correct a handful is the kind of well-meant sweep that fills a
 * queue. An agent whose skills are all plain distilled output already agrees.
 */
export function needsConvergence(skills: Skill[]): boolean {
  return skills.some((s) =>
    (s.provenance && s.provenance !== 'distilled')
    || s.protected === true
    || s.archived === true);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const tenantArg = process.argv.indexOf('--tenant');
  const onlyTenant = tenantArg > -1 ? process.argv[tenantArg + 1] : null;

  const agents = await withAdminScope(
    {
      caller: 'scripts.converge-runtime-skill-provenance',
      reason: 'read internal_agents.skills fleet-wide to re-publish authoritative provenance',
    },
    (client) => client.query<AgentRow>(
      `SELECT id, tenant_id, role, current_version, skills
         FROM internal_agents
        WHERE deleted_at IS NULL
          AND skills IS NOT NULL
          AND jsonb_array_length(skills) > 0
          ${onlyTenant ? 'AND tenant_id = $1' : ''}
        ORDER BY tenant_id, id`,
      onlyTenant ? [onlyTenant] : [],
    ),
  );

  let considered = 0;
  let published = 0;
  const failures: Array<{ agentId: string; error: string }> = [];

  for (const row of agents.rows) {
    const skills = (Array.isArray(row.skills) ? row.skills : []) as Skill[];
    considered++;
    if (!needsConvergence(skills)) continue;

    const drift = skills.filter((s) =>
      (s.provenance && s.provenance !== 'distilled') || s.protected || s.archived);

    if (!apply) {
      log.info(
        {
          tenantId: row.tenant_id,
          agentId: row.id,
          role: row.role,
          wouldPublish: drift.map((s) => ({
            name: s.name, provenance: s.provenance, protected: s.protected, archived: s.archived,
          })),
        },
        'would re-publish authoritative skill provenance',
      );
      published++;
      continue;
    }

    try {
      await publishEvent({
        entityType: 'internal_agent',
        entityId: row.id,
        eventType: 'tenant.internal_agent.skills_updated',
        entityVersion: row.current_version,
        eventVersion: 1,
        tenantId: row.tenant_id,
        payload: {
          agentId: row.id,
          // The same filter every other publish uses: archived skills stay in
          // the column and are never carried to the runtime, which is how the
          // runtime drops them from its active set without needing to know the
          // concept exists.
          skills: skillsForRuntime(skills as never),
          updatedAt: new Date().toISOString(),
          source: 'provenance_convergence',
        },
      });
      published++;
    } catch (err) {
      failures.push({ agentId: row.id, error: (err as Error).message });
    }
  }

  log.info(
    { considered, published, failed: failures.length, mode: apply ? 'apply' : 'dry-run' },
    apply
      ? 'republished authoritative skill provenance to the runtime'
      : 'dry run — nothing published; re-run with --apply',
  );

  if (failures.length > 0) {
    // Listed rather than summarised: a partial run is safe to repeat, and the
    // person repeating it should know which agents to check.
    log.error({ failures }, 'some agents could not be published; re-running is safe');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    log.error({ error: (err as Error).message }, 'convergence script failed');
    process.exit(1);
  });
}
