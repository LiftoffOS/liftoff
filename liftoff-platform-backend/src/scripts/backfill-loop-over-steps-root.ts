#!/usr/bin/env npx ts-node

/**
 * Re-root every stored `loop.over` that addresses `output.<stepId>.<field>`.
 *
 * `output` is bound to the PREVIOUS step's output, not to a map of steps, so
 * `output.s13.cards_to_update` walks `s13Output["s13"]["cards_to_update"]` and
 * throws `TemplateResolutionError`. The loop then iterates zero times, the
 * hybrid loop routes to recovery rather than the author's `onFailure`, and the
 * work the loop existed to do is never done. The distiller's own schema offered
 * that form; it now names `steps.<stepId>.<field>`, and this repairs the graphs
 * authored while it did not.
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION. Two reasons, the second decisive:
 *
 *   - `scripts/ci-fences/migration-force-rls-fence.sh` is the GENERAL fence:
 *     any migration writing an RLS-forced table needs the NO FORCE / FORCE
 *     escape, whatever it targets.
 *   - `InternalAgentService.update` does four things in one transaction that
 *     raw SQL does not: it re-pins the workflow integrity hash, increments
 *     `current_version`, writes the `internal_agent_versions` row, and enqueues
 *     the outbox event that publishes the new steps to the runtime. Raw SQL
 *     would leave the OLD hash against NEW steps, and the runtime's
 *     `verifyWorkflowStepsHash` would then fail EVERY run of these agents
 *     with "Workflow steps have been tampered with" — bricking the teams this
 *     exists to repair.
 *
 * Idempotent: a value already rooted at `steps.` does not match, so a second
 * run finds nothing to rewrite.
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-loop-over-steps-root.ts              # dry-run
 *   npx ts-node src/scripts/backfill-loop-over-steps-root.ts --execute    # write
 *   npx ts-node src/scripts/backfill-loop-over-steps-root.ts --tenant <id> [--execute]
 *
 * Reports the rows WRITTEN as counted from the database afterwards, not as
 * tallied by the loop.
 */

import { initDatabase, withAdminScope } from '../infrastructure/database';
import { internalAgentService } from '../internal-agents/service';
import {
  planLoopOverRewrites,
  unresolvableLoopOverCount,
  type LoopOverRewrite,
} from '../internal-agents/loop-over-rewrite';
import type { WorkflowStep } from '@liftoffos/shared-types';

interface AgentRow {
  id: string;
  tenant_id: string;
  role: string;
  workflow_steps: unknown;
}

/** The read is cross-tenant by nature: the defect is fleet-wide and the rows
 *  carrying it are not known in advance, so no tenant scope can serve it. */
const CANDIDATE_SQL = `
  SELECT a.id, a.tenant_id, a.role, a.workflow_steps
  FROM internal_agents a
  WHERE a.deleted_at IS NULL
    AND a.workflow_steps IS NOT NULL
    AND a.workflow_steps::text LIKE '%output.%'
    AND ($1::uuid IS NULL OR a.tenant_id = $1::uuid)
  ORDER BY a.tenant_id, a.created_at`;

async function main() {
  await initDatabase();

  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const tenantIdx = args.indexOf('--tenant');
  const tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : null;

  console.log('\n=== Backfill loop.over to the steps root ===');
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
  if (tenantId) console.log(`Tenant: ${tenantId}`);

  const candidates = await withAdminScope(
    {
      caller: 'backfill-loop-over-steps-root.read',
      reason: 'cross-tenant (or --tenant) read of stored workflow steps whose loop collection cannot resolve',
    },
    (client) => client.query<AgentRow>(CANDIDATE_SQL, [tenantId]),
  );

  const targets: Array<{ row: AgentRow; steps: WorkflowStep[]; rewrites: LoopOverRewrite[] }> = [];
  let matched = 0;
  let skippedValues = 0;
  for (const row of candidates.rows) {
    const stored = Array.isArray(row.workflow_steps) ? (row.workflow_steps as WorkflowStep[]) : null;
    if (!stored || stored.length === 0) continue;
    const { steps, rewrites, skipped } = planLoopOverRewrites(stored);
    matched += rewrites.length + skipped.length;
    skippedValues += skipped.length;
    for (const s of skipped) {
      console.log(`[${row.tenant_id}] ${row.id} "${row.role}" ${s.stepId} — skipped: ${s.reason} (${s.over})`);
    }
    if (rewrites.length === 0) continue;
    for (const r of rewrites) {
      console.log(`[${row.tenant_id}] ${row.id} "${row.role}" ${r.stepId} — ${r.from} → ${r.to}`);
    }
    targets.push({ row, steps, rewrites });
  }

  console.log(
    `\nMatched values: ${matched} (${matched - skippedValues} rewritable, ${skippedValues} skipped) `
    + `across ${targets.length} changed row(s) of ${candidates.rows.length} candidate row(s).`,
  );
  if (!execute || targets.length === 0) {
    console.log(execute ? 'Nothing to do.' : 'DRY-RUN: no writes.');
    process.exit(0);
  }

  let failed = 0;
  for (const { row, steps } of targets) {
    try {
      // `internalAgentId` first, `tenantId` second. No actor: the audit column
      // is a UUID and this is the platform, not a person — a string like
      // 'system:loop-over-backfill' would fail the cast. `'manual'` is the
      // VersionSource, which is the fifth argument.
      const updated = await internalAgentService.update(
        row.id,
        row.tenant_id,
        { workflowSteps: steps },
        undefined,
        'manual',
      );
      if (!updated) {
        failed++;
        console.error(`  ${row.id}: update returned no agent`);
      }
    } catch (err) {
      failed++;
      console.error(`  ${row.id}: ${(err as Error).message}`);
    }
  }

  // Measured, not tallied. Two facts, because they answer different questions:
  // whether the rows this run targeted are now clean, and whether anything in
  // the fleet still carries the form.
  const after = await withAdminScope(
    {
      caller: 'backfill-loop-over-steps-root.verify',
      reason: 'count the rows the backfill actually changed',
    },
    (client) => client.query<AgentRow>(
      `SELECT id, tenant_id, role, workflow_steps FROM internal_agents WHERE id = ANY($1::uuid[])`,
      [targets.map((t) => t.row.id)],
    ),
  );
  const stillBroken = after.rows.reduce((n, r) => n + unresolvableLoopOverCount(r.workflow_steps), 0);
  const cleanRows = after.rows.filter((r) => unresolvableLoopOverCount(r.workflow_steps) === 0).length;

  const remaining = await withAdminScope(
    {
      caller: 'backfill-loop-over-steps-root.verify',
      reason: 'count every row still carrying an unresolvable loop collection after the run',
    },
    (client) => client.query<AgentRow>(CANDIDATE_SQL, [tenantId]),
  );
  const fleetRemaining = remaining.rows.reduce((n, r) => n + unresolvableLoopOverCount(r.workflow_steps), 0);

  console.log(`\nRows now free of output.<stepId> loop collections (counted from the database): ${cleanRows} of ${targets.length}`);
  console.log(`Values still unrewritten in those rows: ${stillBroken}`);
  console.log(`Values still unrewritten fleet-wide (skipped ones included): ${fleetRemaining}`);
  console.log(`Failures: ${failed}`);
  process.exit(failed > 0 || stillBroken > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
