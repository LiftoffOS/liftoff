// Migration 194 (CAIO + HRBP system-agent seed) content tests.
//
// We can't easily spin up Postgres in unit tests, but the seed SQL is a
// frozen text artifact whose shape we depend on:
//   - it inserts both UUIDs (CAIO + HRBP) as is_system rows
//   - the system_prompt skeletons carry {{TODAY}}, {{PLAN_STATE}}, {{TOOLS}}
//     (CAIO) / {{TOOLS}} (HRBP) so renderSystemPrompt's string-replace works
//   - tier defaults to "medium" on both
//   - both rows assert tenant_id IS NULL and system_role IS NOT NULL

import { readFileSync } from 'fs';
import { join } from 'path';

const SEED_PATH = join(__dirname, '..', '..', '..', 'migrations', '194_seed_system_agents.sql');

describe('migration 194 seed content', () => {
  const sql = readFileSync(SEED_PATH, 'utf-8');

  it('inserts both system-agent UUIDs', () => {
    expect(sql).toMatch(/'00000000-0000-0000-0000-000000000001'::uuid/);
    expect(sql).toMatch(/'00000000-0000-0000-0000-000000000002'::uuid/);
  });

  it('marks both rows is_system=TRUE with tenant_id NULL', () => {
    // Match the INSERT VALUES block — every system-agent row must have
    // both `TRUE` (for is_system) and `NULL` (for tenant_id).
    const inserts = sql.split('INSERT INTO').slice(1);
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const insert of inserts) {
      expect(insert).toMatch(/TRUE/);
      expect(insert).toMatch(/NULL/);
    }
  });

  it('declares system_role for both seeds', () => {
    expect(sql).toMatch(/'caio'/);
    expect(sql).toMatch(/'hrbp'/);
  });

  it('CAIO system_prompt carries {{TODAY}}, {{PLAN_STATE}}, and {{TOOLS}} placeholders', () => {
    // The CAIO INSERT contains all three placeholders inside its $PROMPT$ block.
    const caioBlock = sql.split('hrbp')[0]; // before the HRBP INSERT
    expect(caioBlock).toContain('{{TODAY}}');
    expect(caioBlock).toContain('{{PLAN_STATE}}');
    expect(caioBlock).toContain('{{TOOLS}}');
  });

  it('HRBP system_prompt carries {{TOOLS}} placeholder', () => {
    const hrbpBlock = sql.split("'hrbp'")[1] ?? '';
    expect(hrbpBlock).toContain('{{TOOLS}}');
  });

  it('both rows set model_config to tier=medium by default', () => {
    expect(sql.match(/'\{"tier":"medium"\}'::jsonb/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
