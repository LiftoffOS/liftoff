// Backfill internal_agents.skills from the tenant-runtime live skill set, and
// stamp provenance on every skill (P1.0 — Hermes lift).
//
// Why this exists:
//   Skills had two divergent stores. internal_agents.skills (control plane)
//   held only the last DISTILL output; the live set — including every skill the
//   reflection flywheel authored — lived exclusively in tenant-runtime, written
//   through the skills_updated event. Nothing ever wrote the flywheel's output
//   back to the control-plane column.
//
//   P1.0 makes the control-plane column authoritative: service.update merges
//   incoming skills against it by provenance so a redistill preserves what was
//   learned. That merge is only correct if the column actually holds the live
//   set first — otherwise the first merge would "preserve" nothing and the very
//   redistill it protects against would still wipe the learned skills.
//
//   So this script must run BEFORE the merge path is exercised in an
//   environment (i.e. right after deploy, ahead of the first Optimize).
//
// Provenance tagging, in precedence order:
//   1. agent_skill_metrics.origin — the control plane's own record of who
//      authored a skill ('distill' | 'reflection' | 'hitl'), keyed
//      (agent_id, skill_id). 'reflection'/'hitl' → learned.
//   2. The flywheel's transient id convention (`reflection:<uuid>:<origin>`) —
//      only observable if a skill was appended but not yet re-synced.
//   3. Default 'distilled'.
//
// Deliberately does NOT publish any event: the runtime already holds these
// skills verbatim (they are its own rows). This is a control-plane-side
// reconciliation only, so it cannot disturb a running agent.
//
// Run as a Cloud Run Job using the platform-backend image at a SHA that
// contains this script:
//   --command=node --args="dist/scripts/backfill-skill-provenance.js"
//
// Idempotent: re-running recomputes the same set. Archived skills, which the
// runtime never sees, are read from the column and carried across rather than
// erased — so a re-run after the archive verb has been used is still safe.
// Pass DRY_RUN=true to report without writing.

import { closePools, initDatabase, withAdminScope, withTenantScope } from '../infrastructure/database';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { log } from '../infrastructure/logging';
import type { Skill, SkillProvenance } from '../internal-agents/types';

interface AgentRow {
  id: string;
  tenant_id: string;
  role: string;
}

const DRY_RUN = process.env.DRY_RUN === 'true';

/** `reflection:<uuid>:<originatingSkillId>` — minted by skill-feedback-service
 *  for a brand-new pitfall skill. The runtime does not persist it (its own id
 *  column is a UUID), so it is only ever visible pre-sync. */
function looksFlywheelMinted(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith('reflection:');
}

function resolveProvenance(
  skillId: string | undefined,
  originBySkillId: Map<string, string>,
): SkillProvenance {
  const origin = skillId ? originBySkillId.get(skillId) : undefined;
  if (origin === 'reflection' || origin === 'hitl') return 'learned';
  if (looksFlywheelMinted(skillId)) return 'learned';
  return 'distilled';
}

interface RuntimeSkillLike {
  id?: string;
  name: string;
  description: string;
  instruction: string;
  tags?: string[];
}

export interface MergeResult {
  merged: Skill[];
  /** Non-archived column skills the runtime does not have. Writing the merged
   *  set erases these, so the caller must report them rather than drop them. */
  droppedFromColumn: Skill[];
  learnedTagged: number;
  preservedFromColumn: number;
}

/**
 * Combine the runtime's live set with what the column already knows.
 *
 * Extracted and exported so the precedence rule is testable on its own. It is
 * the whole correctness of this script: get it wrong in the obvious direction
 * and the sweep downgrades the provenance it was written to establish.
 */
export function resolveMergedSkills(
  runtimeSkills: RuntimeSkillLike[],
  columnSkills: Skill[],
  originBySkillId: Map<string, string>,
): MergeResult {
  // What the column already says about a skill, by id AND by name. Name is
  // load-bearing: the runtime does not persist the ids we send it, so the same
  // skill comes back under a fresh uuid and an id-only match would miss every
  // time.
  const columnBySkillKey = new Map<string, Skill>();
  for (const s of columnSkills) {
    if (s.id) columnBySkillKey.set(s.id, s);
    if (s.name) columnBySkillKey.set(s.name, s);
  }

  let learnedTagged = 0;
  let preservedFromColumn = 0;

  const fromRuntime: Skill[] = runtimeSkills.map((s) => {
    const prior = (s.id ? columnBySkillKey.get(s.id) : undefined) ?? columnBySkillKey.get(s.name);
    // The column is authoritative (ADR-043), so a provenance it already carries
    // wins over anything recomputed here. Without this the sweep DOWNGRADES its
    // own subject: a flywheel skill the merge path already stamped `learned`
    // comes back from the runtime under a regenerated uuid, misses the metrics
    // lookup keyed on the old id, defaults to `distilled`, and overwrites the
    // correct value. A presence check cannot see it — the skill is still there,
    // only its provenance changed.
    const priorProvenance = prior?.provenance && prior.provenance !== 'distilled'
      ? prior.provenance
      : undefined;
    const provenance = priorProvenance ?? resolveProvenance(s.id, originBySkillId);
    if (provenance === 'learned') learnedTagged += 1;
    if (priorProvenance) preservedFromColumn += 1;
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      instruction: s.instruction,
      tags: s.tags ?? [],
      provenance,
      // Operator intent lives only in the column: the runtime never sees these
      // flags, so recomputing them from its payload would clear them.
      ...(prior?.protected === true ? { protected: true } : {}),
    };
  });

  const known = new Set(fromRuntime.flatMap((s) => [s.id, s.name].filter(Boolean) as string[]));
  const isAbsent = (s: Skill) => !known.has(s.id ?? '') && !known.has(s.name);

  // Archived skills exist only in the column; carry them across untouched.
  const archivedOnly = columnSkills.filter((s) => s.archived === true && isAbsent(s));

  // Anything else the column holds that the runtime does not would be ERASED.
  // Harmless when this script was written — it was meant to run immediately
  // after deploy, before the column could hold anything the runtime had not
  // seen — but the merge path has been live for a while, so the column can
  // legitimately be ahead.
  const droppedFromColumn = columnSkills.filter((s) => s.archived !== true && isAbsent(s));

  return {
    merged: [...fromRuntime, ...archivedOnly],
    droppedFromColumn,
    learnedTagged,
    preservedFromColumn,
  };
}

async function main(): Promise<void> {
  // Required before the per-agent withTenantScope reads and writes below.
  // withAdminScope builds its own admin pool lazily, so the enumeration that
  // follows would work without this and every per-agent step would then throw
  // "Database not initialized" — a sweep that names the right agents and syncs
  // none of them. index.ts calls this at boot; a Cloud Run Job has no boot.
  await initDatabase();

  const agents = await withAdminScope({
    caller: 'scripts/backfill-skill-provenance',
    reason: 'P1.0 one-time sync of internal_agents.skills from the runtime live set',
  }, async (client) => {
    const result = await client.query<AgentRow>(
      // Tenant-less rows are excluded. The two platform system agents carry an
      // empty tenant_id, so the runtime skills call for them returns HTTP 500
      // every time — they have no tenant runtime to ask. Left in, they were two
      // guaranteed failures per run, which set a non-zero exit code and made a
      // completely successful sweep look like a partial one.
      `SELECT id, tenant_id, role
       FROM internal_agents
       WHERE deleted_at IS NULL AND status != 'deleted'
         AND tenant_id IS NOT NULL AND tenant_id::text <> ''
       ORDER BY tenant_id, id`,
    );
    return result.rows;
  });

  log.info({ agentCount: agents.length, dryRun: DRY_RUN }, 'skill-provenance backfill: start');

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let learnedTagged = 0;
  let dropped = 0;
  let preservedFromColumn = 0;

  for (const agent of agents) {
    try {
      const { skills: runtimeSkills } = await tenantRuntimeClient.getAgentSkills(
        agent.tenant_id,
        agent.id,
      );
      if (!runtimeSkills || runtimeSkills.length === 0) {
        skipped += 1;
        continue;
      }

      // Origin per skill id, from the control plane's own metrics table, plus
      // whatever the column already holds. The column read is what protects
      // ARCHIVED skills: they are filtered out of every payload the runtime
      // receives, so the runtime set this script syncs from cannot contain
      // them, and writing that set back verbatim would delete them.
      const { originBySkillId, columnSkills } = await withTenantScope(agent.tenant_id, async (client) => {
        const metrics = await client.query<{ skill_id: string; origin: string }>(
          `SELECT skill_id, origin FROM agent_skill_metrics WHERE agent_id = $1`,
          [agent.id],
        );
        const row = await client.query<{ skills: Skill[] | null }>(
          `SELECT skills FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
          [agent.id, agent.tenant_id],
        );
        return {
          originBySkillId: new Map(metrics.rows.map((r) => [r.skill_id, r.origin])),
          columnSkills: Array.isArray(row.rows[0]?.skills) ? row.rows[0].skills : [],
        };
      });

      const {
        merged, droppedFromColumn,
        learnedTagged: agentLearned, preservedFromColumn: agentPreserved,
      } = resolveMergedSkills(runtimeSkills, columnSkills, originBySkillId);
      learnedTagged += agentLearned;
      preservedFromColumn += agentPreserved;

      if (droppedFromColumn.length > 0) {
        dropped += droppedFromColumn.length;
        log.warn(
          {
            agentId: agent.id, tenantId: agent.tenant_id, role: agent.role,
            skills: droppedFromColumn.map((s) => ({ name: s.name, provenance: s.provenance })),
          },
          'skill-provenance backfill: column skills absent from the runtime set would be erased',
        );
      }

      if (!DRY_RUN) {
        await withTenantScope(agent.tenant_id, (client) =>
          client.query(
            `UPDATE internal_agents SET skills = $1::jsonb, updated_at = NOW()
             WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL`,
            [JSON.stringify(merged), agent.id, agent.tenant_id],
          ),
        );
      }
      synced += 1;
      log.info(
        {
          agentId: agent.id, tenantId: agent.tenant_id, role: agent.role,
          skillCount: merged.length, preserved: agentPreserved,
        },
        'skill-provenance backfill: agent synced',
      );
    } catch (err) {
      failed += 1;
      log.error(
        { agentId: agent.id, tenantId: agent.tenant_id, error: (err as Error).message },
        'skill-provenance backfill: agent failed (continuing)',
      );
    }
  }

  log.info(
    { total: agents.length, synced, skipped, failed, learnedTagged, preservedFromColumn, dropped, dryRun: DRY_RUN },
    'skill-provenance backfill: complete',
  );

  if (failed > 0) process.exitCode = 1;
}

// Guarded so the merge rule above can be imported and tested without the
// script running itself on import. Same shape as the convergence script.
if (require.main === module) {
  main()
    .then(async () => { await closePools(); })
    .catch((err) => {
      log.error({ error: (err as Error).message }, 'skill-provenance backfill: fatal');
      process.exit(1);
    });
}
