// WS-5.1 — one-shot backfill that quarantines integration elements whose
// `id` is not a UUID. Saves the bad elements into
// `internal_agents.integrations_quarantine` (added in migration 257) and
// removes them from the live `integrations` column.

import { withAdminScope } from '../infrastructure/database';

async function main() {
  const bad = await withAdminScope({ caller: 'quarantine-invalid-integrations', reason: 'cross-tenant scan+quarantine of internal_agents' }, (client) => client.query(`
    SELECT id, tenant_id, integrations
    FROM internal_agents
    WHERE deleted_at IS NULL
      AND integrations IS NOT NULL
      AND jsonb_typeof(integrations) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(integrations) AS elem
        WHERE elem->>'id' IS NULL
           OR elem->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
  `));
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const row of bad.rows) {
    const all = row.integrations as Array<{ id?: unknown; selectedObjects?: unknown }>;
    const valid: typeof all = [];
    const quarantined: typeof all = [];
    for (const el of all) {
      if (typeof el?.id === 'string' && uuidRe.test(el.id)) valid.push(el);
      else quarantined.push(el);
    }
    await withAdminScope({ caller: 'quarantine-invalid-integrations', reason: 'cross-tenant scan+quarantine of internal_agents' }, (client) => client.query(
      `UPDATE internal_agents
       SET integrations = $1::jsonb,
           integrations_quarantine = COALESCE(integrations_quarantine, '[]'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(valid), JSON.stringify(quarantined), row.id],
    ));
    console.log(`quarantined ${quarantined.length} elements on agent ${row.id} (tenant ${row.tenant_id})`);
  }
  console.log(`done; processed ${bad.rowCount} agents`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
