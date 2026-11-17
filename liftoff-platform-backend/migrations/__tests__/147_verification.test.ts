// Migration 147 verification tests
//
// These tests verify the mcp_tokens table created by migration 147.
// Run after migrations complete: npm test -- migrations/__tests__/147_verification.test.ts

import { Pool } from 'pg';

// Skip these tests unless TEST_DATABASE_URL is set (integration tests only)
const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('Migration 147 verification — mcp_tokens', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should have the mcp_tokens table', async () => {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'mcp_tokens' AND table_schema = 'public'
    `);
    expect(result.rows).toHaveLength(1);
  });

  it('should have all required columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'mcp_tokens' AND table_schema = 'public'
    `);
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);

    expect(columns).toContain('id');
    expect(columns).toContain('tenant_id');
    expect(columns).toContain('account_id');
    expect(columns).toContain('token_hash');
    expect(columns).toContain('token_prefix');
    expect(columns).toContain('name');
    expect(columns).toContain('status');
    expect(columns).toContain('last_used_at');
    expect(columns).toContain('expires_at');
    expect(columns).toContain('created_at');
    expect(columns).toContain('deleted_at');
  });

  it('should reject invalid status values', async () => {
    await expect(
      pool.query(`
        INSERT INTO mcp_tokens
          (tenant_id, account_id, token_hash, token_prefix, status)
        VALUES
          (gen_random_uuid(), gen_random_uuid(), 'hash-invalid', 'liftoff_mcp_', 'disabled')
      `)
    ).rejects.toThrow();
  });

  it('should have status defaulting to active', async () => {
    const result = await pool.query(`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'mcp_tokens' AND column_name = 'status' AND table_schema = 'public'
    `);
    expect(result.rows[0].column_default).toContain('active');
  });

  it('should have name defaulting to Default', async () => {
    const result = await pool.query(`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'mcp_tokens' AND column_name = 'name' AND table_schema = 'public'
    `);
    expect(result.rows[0].column_default).toContain('Default');
  });

  it('should have expires_at defaulting to approximately NOW() + 365 days', async () => {
    const result = await pool.query(`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'mcp_tokens' AND column_name = 'expires_at' AND table_schema = 'public'
    `);
    const columnDefault: string = result.rows[0].column_default;
    // Default expression should reference '365 days' interval
    expect(columnDefault).toContain('365 days');
  });

  it('should have a unique index on token_hash where deleted_at IS NULL', async () => {
    const result = await pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'mcp_tokens' AND schemaname = 'public'
        AND indexname = 'idx_mcp_tokens_hash'
    `);
    expect(result.rows).toHaveLength(1);
    // Should be a partial index filtering deleted_at IS NULL
    expect(result.rows[0].indexdef).toContain('deleted_at IS NULL');
  });

  it('should have an index on tenant_id where deleted_at IS NULL', async () => {
    const result = await pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'mcp_tokens' AND schemaname = 'public'
        AND indexname = 'idx_mcp_tokens_tenant'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain('deleted_at IS NULL');
  });

  it('should have an index on account_id where deleted_at IS NULL', async () => {
    const result = await pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'mcp_tokens' AND schemaname = 'public'
        AND indexname = 'idx_mcp_tokens_account'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain('deleted_at IS NULL');
  });

  it('idx_mcp_tokens_hash should be a UNIQUE index', async () => {
    const result = await pool.query(`
      SELECT ix.indisunique
      FROM pg_class c
      JOIN pg_index ix ON c.oid = ix.indrelid
      JOIN pg_class ic ON ic.oid = ix.indexrelid
      WHERE c.relname = 'mcp_tokens'
        AND ic.relname = 'idx_mcp_tokens_hash'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indisunique).toBe(true);
  });
});
