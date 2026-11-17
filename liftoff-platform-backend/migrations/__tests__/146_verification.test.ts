// Migration 146 verification tests
//
// These tests verify the agent_messages table created by migration 146.
// Run after migrations complete: npm test -- migrations/__tests__/146_verification.test.ts

import { Pool } from 'pg';

// Skip these tests unless TEST_DATABASE_URL is set (integration tests only)
const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('Migration 146 verification — agent_messages', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should have the agent_messages table', async () => {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'agent_messages' AND table_schema = 'public'
    `);
    expect(result.rows).toHaveLength(1);
  });

  it('should have all required columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'agent_messages' AND table_schema = 'public'
    `);
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);

    expect(columns).toContain('id');
    expect(columns).toContain('tenant_id');
    expect(columns).toContain('sender_type');
    expect(columns).toContain('sender_id');
    expect(columns).toContain('recipient_type');
    expect(columns).toContain('recipient_id');
    expect(columns).toContain('content');
    expect(columns).toContain('metadata');
    expect(columns).toContain('status');
    expect(columns).toContain('expires_at');
    expect(columns).toContain('created_at');
    expect(columns).toContain('read_at');
  });

  it('should reject invalid sender_type values', async () => {
    await expect(
      pool.query(`
        INSERT INTO agent_messages
          (tenant_id, sender_type, sender_id, recipient_type, recipient_id, content)
        VALUES
          (gen_random_uuid(), 'invalid_type', 'sender-1', 'claude_code', 'recipient-1', 'hello')
      `)
    ).rejects.toThrow();
  });

  it('should reject invalid recipient_type values', async () => {
    await expect(
      pool.query(`
        INSERT INTO agent_messages
          (tenant_id, sender_type, sender_id, recipient_type, recipient_id, content)
        VALUES
          (gen_random_uuid(), 'claude_code', 'sender-1', 'bad_type', 'recipient-1', 'hello')
      `)
    ).rejects.toThrow();
  });

  it('should reject invalid status values', async () => {
    await expect(
      pool.query(`
        INSERT INTO agent_messages
          (tenant_id, sender_type, sender_id, recipient_type, recipient_id, content, status)
        VALUES
          (gen_random_uuid(), 'claude_code', 'sender-1', 'internal_agent', 'recipient-1', 'hello', 'deleted')
      `)
    ).rejects.toThrow();
  });

  it('should reject content longer than 51200 characters', async () => {
    const oversizedContent = 'x'.repeat(51201);
    await expect(
      pool.query(`
        INSERT INTO agent_messages
          (tenant_id, sender_type, sender_id, recipient_type, recipient_id, content)
        VALUES
          (gen_random_uuid(), 'claude_code', 'sender-1', 'internal_agent', 'recipient-1', $1)
      `, [oversizedContent])
    ).rejects.toThrow();
  });

  it('should have status defaulting to pending', async () => {
    const result = await pool.query(`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'agent_messages' AND column_name = 'status' AND table_schema = 'public'
    `);
    expect(result.rows[0].column_default).toContain('pending');
  });

  it('should have metadata defaulting to empty object', async () => {
    const result = await pool.query(`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'agent_messages' AND column_name = 'metadata' AND table_schema = 'public'
    `);
    expect(result.rows[0].column_default).toContain('{}');
  });

  it('should have expires_at defaulting to approximately NOW() + 7 days', async () => {
    const result = await pool.query(`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'agent_messages' AND column_name = 'expires_at' AND table_schema = 'public'
    `);
    const columnDefault: string = result.rows[0].column_default;
    // Default expression should reference '7 days' interval
    expect(columnDefault).toContain('7 days');
  });

  it('should have idx_agent_messages_recipient index', async () => {
    const result = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'agent_messages' AND schemaname = 'public'
    `);
    const indexes = result.rows.map((r: { indexname: string }) => r.indexname);
    expect(indexes).toContain('idx_agent_messages_recipient');
  });

  it('should have idx_agent_messages_sender index', async () => {
    const result = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'agent_messages' AND schemaname = 'public'
    `);
    const indexes = result.rows.map((r: { indexname: string }) => r.indexname);
    expect(indexes).toContain('idx_agent_messages_sender');
  });

  it('should have idx_agent_messages_expiry index', async () => {
    const result = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'agent_messages' AND schemaname = 'public'
    `);
    const indexes = result.rows.map((r: { indexname: string }) => r.indexname);
    expect(indexes).toContain('idx_agent_messages_expiry');
  });

  it('idx_agent_messages_recipient should be a partial index on status = pending', async () => {
    const result = await pool.query(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'agent_messages'
        AND schemaname = 'public'
        AND indexname = 'idx_agent_messages_recipient'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain("status = 'pending'");
  });

  it('idx_agent_messages_expiry should be a partial index on status = pending', async () => {
    const result = await pool.query(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'agent_messages'
        AND schemaname = 'public'
        AND indexname = 'idx_agent_messages_expiry'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain("status = 'pending'");
  });
});
