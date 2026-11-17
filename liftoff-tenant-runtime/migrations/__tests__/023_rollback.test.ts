// Migration 023 Rollback Tests (TE-003)
// Tests for ai_team_agent_mapping migration rollback

import { Pool } from 'pg';

// Test database connection
let pool: Pool;

async function runMigration(filename: string): Promise<void> {
  const fs = await import('fs');
  const path = await import('path');
  const migrationPath = path.join(__dirname, '..', filename);
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await pool.query(sql);
}

async function checkTableExists(tableName: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = $1
    )`,
    [tableName]
  );
  return result.rows[0].exists;
}

async function getTableColumns(tableName: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
     AND table_name = $1`,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
}

// Guarded like every other migration test (357, 359): without the guard it
// fails the suite on any machine without a database.
const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('Migration 023 Rollback', () => {
  beforeAll(async () => {
    // Use test database connection
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/liftoff_test',
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean slate - run rollback first to ensure clean state
    try {
      await runMigration('023_ai_team_agent_mapping_rollback.sql');
    } catch {
      // Ignore errors if table doesn't exist
    }
  });

  it('should cleanly rollback migration', async () => {
    // Run migration forward
    await runMigration('023_ai_team_agent_mapping.sql');

    // Verify tables and columns exist
    const tableExists = await checkTableExists('ai_team_agent_mapping');
    expect(tableExists).toBe(true);

    // Verify columns added to agents table
    const agentColumns = await getTableColumns('agents');
    expect(agentColumns).toContain('agent_type');
    expect(agentColumns).toContain('hitl_level');
    expect(agentColumns).toContain('model_config');
    expect(agentColumns).toContain('exec_config');
    expect(agentColumns).toContain('memory_scope');
    expect(agentColumns).toContain('trigger_config');
    expect(agentColumns).toContain('entity_version');
    expect(agentColumns).toContain('system_prompt');
    expect(agentColumns).toContain('user_instructions');

    // Run rollback
    await runMigration('023_ai_team_agent_mapping_rollback.sql');

    // Verify tables and columns removed
    const tableExistsAfter = await checkTableExists('ai_team_agent_mapping');
    expect(tableExistsAfter).toBe(false);

    // Verify columns removed from agents
    const columnsAfter = await getTableColumns('agents');
    expect(columnsAfter).not.toContain('agent_type');
    expect(columnsAfter).not.toContain('hitl_level');
    expect(columnsAfter).not.toContain('model_config');
    expect(columnsAfter).not.toContain('exec_config');
    expect(columnsAfter).not.toContain('memory_scope');
    expect(columnsAfter).not.toContain('trigger_config');
    expect(columnsAfter).not.toContain('entity_version');
    expect(columnsAfter).not.toContain('system_prompt');
    expect(columnsAfter).not.toContain('user_instructions');
  });

  it('should handle rollback with existing data', async () => {
    // Run migration forward
    await runMigration('023_ai_team_agent_mapping.sql');

    // Create test agent
    const agentResult = await pool.query(
      `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'Test Agent', 'DRAFT', 'IDLE')
       RETURNING id`
    );
    const agentId = agentResult.rows[0].id;

    // Create test mapping
    await pool.query(
      `INSERT INTO ai_team_agent_mapping (ai_team_id, agent_id, tenant_id)
       VALUES (gen_random_uuid(), $1, gen_random_uuid())`,
      [agentId]
    );

    // Verify data exists
    const mappingCount = await pool.query(
      `SELECT COUNT(*) FROM ai_team_agent_mapping`
    );
    expect(parseInt(mappingCount.rows[0].count)).toBeGreaterThan(0);

    // Run rollback - should cascade delete mappings
    await runMigration('023_ai_team_agent_mapping_rollback.sql');

    // Verify table no longer exists
    const tableExists = await checkTableExists('ai_team_agent_mapping');
    expect(tableExists).toBe(false);
  });

  it('should be idempotent - running rollback twice should not error', async () => {
    // Run migration forward
    await runMigration('023_ai_team_agent_mapping.sql');

    // Run rollback twice - should not throw
    await runMigration('023_ai_team_agent_mapping_rollback.sql');
    await expect(
      runMigration('023_ai_team_agent_mapping_rollback.sql')
    ).resolves.not.toThrow();
  });

  it('should allow re-migration after rollback', async () => {
    // Run migration forward
    await runMigration('023_ai_team_agent_mapping.sql');

    // Run rollback
    await runMigration('023_ai_team_agent_mapping_rollback.sql');

    // Run migration again - should succeed
    await runMigration('023_ai_team_agent_mapping.sql');

    // Verify table exists again
    const tableExists = await checkTableExists('ai_team_agent_mapping');
    expect(tableExists).toBe(true);
  });
});
