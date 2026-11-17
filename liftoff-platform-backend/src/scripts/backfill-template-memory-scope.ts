#!/usr/bin/env npx ts-node

/**
 * Give template hires the memory scope their template declares.
 *
 * The create route redeems the distill artifact for every generated field but
 * did not redeem `memoryScope`, so every hire made through the wizard held the
 * create default whatever its template said, and the runtime refused the
 * role-layer memory steps the distiller had authored against the template's
 * grant. The route now redeems it; this repairs the hires made before it did.
 *
 * Eligibility is EVIDENCE, not equality. The API accepts a memoryScope, so a
 * row holding the default may hold it because somebody chose it. A hire is
 * repaired only when its template declares a scope AND no `created` audit row
 * carried a `memoryScope` key AND no `updated` audit row carried one under
 * `after` — the audit trail stores the request as sent (an update as
 * {before, after}), so "never carried" is "never set". The write goes
 * through the service so the runtime receives the update event, as any other
 * scope change would.
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-template-memory-scope.ts              # dry-run
 *   npx ts-node src/scripts/backfill-template-memory-scope.ts --execute    # write
 *   npx ts-node src/scripts/backfill-template-memory-scope.ts --tenant <id> [--execute]
 *
 * Reports the rows WRITTEN as counted from the database afterwards, not as
 * tallied by the loop; a second run reports 0 eligible.
 */

import { initDatabase, withAdminScope } from '../infrastructure/database';
import { getTemplate, initTemplateLoader } from '../agent-templates/loader';
import { internalAgentService } from '../internal-agents/service';
import { normalizeMemoryScope } from '../internal-agents/memory-scope';
import type { MemoryScope } from '../internal-agents/types';

interface HireRow {
  id: string;
  tenant_id: string;
  role: string;
  template_id: string;
  memory_scope: unknown;
}

const ELIGIBLE_SQL = `
  SELECT a.id, a.tenant_id, a.role, a.template_id, a.memory_scope
  FROM internal_agents a
  WHERE a.template_id IS NOT NULL
    AND a.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM internal_agent_audit au
      WHERE au.internal_agent_id = a.id
        AND (
          -- A create audit stores the request itself; an update audit stores
          -- {before, after} and 'after' is the request. 'before' always
          -- carries the current scope and is not evidence of anything.
          (au.action = 'created' AND au.changes ? 'memoryScope')
          OR (au.action = 'updated' AND au.changes->'after' ? 'memoryScope')
        )
    )
    AND ($1::uuid IS NULL OR a.tenant_id = $1::uuid)
  ORDER BY a.tenant_id, a.created_at`;

function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  const key = (s: MemoryScope) => JSON.stringify({
    r: [...(s.readableLayers ?? [])].sort(),
    w: [...(s.writableLayers ?? [])].sort(),
    k: [...(s.scopeKeys ?? [])].sort(),
  });
  return key(a) === key(b);
}

async function main() {
  await initDatabase();
  // The catalog is read from disk once, at boot; a script has no boot.
  initTemplateLoader();

  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const tenantIdx = args.indexOf('--tenant');
  const tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : null;

  console.log('\n=== Backfill template memory scope ===');
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
  if (tenantId) console.log(`Tenant: ${tenantId}`);

  const candidates = await withAdminScope(
    { caller: 'backfill-template-memory-scope.read', reason: 'cross-tenant (or --tenant) read of template hires whose scope was never set by a request' },
    (client) => client.query<HireRow>(ELIGIBLE_SQL, [tenantId]),
  );

  const targets: Array<{ row: HireRow; scope: MemoryScope }> = [];
  for (const row of candidates.rows) {
    const template = getTemplate(row.template_id);
    if (!template?.defaultMemoryScope) {
      console.log(`[${row.tenant_id}] ${row.id} "${row.role}" — template ${row.template_id} declares no scope; skipped`);
      continue;
    }
    const wanted = normalizeMemoryScope(template.defaultMemoryScope);
    const current = normalizeMemoryScope(row.memory_scope);
    if (sameScope(current, wanted)) {
      console.log(`[${row.tenant_id}] ${row.id} "${row.role}" — already holds the template's scope; skipped`);
      continue;
    }
    targets.push({ row, scope: wanted });
    console.log(`[${row.tenant_id}] ${row.id} "${row.role}" — ${JSON.stringify(current)} → ${JSON.stringify(wanted)}`);
  }

  console.log(`\nEligible: ${targets.length} of ${candidates.rows.length} candidate hires.`);
  if (!execute || targets.length === 0) {
    console.log(execute ? 'Nothing to do.' : 'DRY-RUN: no writes.');
    process.exit(0);
  }

  let failed = 0;
  for (const { row, scope } of targets) {
    try {
      // No actor: the audit column is a UUID and this is the platform, not a
      // person. The audit row still records the scope written, which is what
      // makes a second run find nothing eligible.
      const updated = await internalAgentService.update(
        row.id,
        row.tenant_id,
        { memoryScope: scope },
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

  // Measured, not tallied: the rows that now hold the template's scope.
  const written = await withAdminScope(
    { caller: 'backfill-template-memory-scope.verify', reason: 'count the rows the backfill actually changed' },
    (client) => client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM internal_agents WHERE id = ANY($1::uuid[]) AND memory_scope::jsonb = ANY($2::jsonb[])`,
      [targets.map((t) => t.row.id), targets.map((t) => JSON.stringify(t.scope))],
    ),
  );
  const remaining = await withAdminScope(
    { caller: 'backfill-template-memory-scope.verify', reason: 'count the hires still eligible after the backfill' },
    (client) => client.query<HireRow>(ELIGIBLE_SQL, [tenantId]),
  );
  const stillEligible = remaining.rows.filter((row) => {
    const template = getTemplate(row.template_id);
    return template?.defaultMemoryScope
      && !sameScope(normalizeMemoryScope(row.memory_scope), normalizeMemoryScope(template.defaultMemoryScope));
  }).length;

  console.log(`\nRows now holding their template's scope (counted from the database): ${written.rows[0]?.n ?? '0'} of ${targets.length}`);
  console.log(`Failures: ${failed}`);
  console.log(`Still eligible after the run: ${stillEligible}`);
  process.exit(failed > 0 || stillEligible > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
