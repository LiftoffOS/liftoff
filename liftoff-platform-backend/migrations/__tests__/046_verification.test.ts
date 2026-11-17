// Migration 046 verification tests
// Per implementation plan: [TE-007]
//
// These tests verify the integrity of tool classification data after migrations.
// Run after migrations complete: npm test -- migrations/__tests__/046_verification.test.ts

import { Pool } from 'pg';

// Skip these tests unless TEST_DATABASE_URL is set (integration tests only)
const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('Migration 046 verification', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should have expected integration types after migration', async () => {
    const result = await pool.query(`
      SELECT DISTINCT integration_type
      FROM tool_classification_cache
      ORDER BY integration_type
    `);

    const integrationTypes = result.rows.map((r: { integration_type: string }) => r.integration_type);

    // Should include all expected integrations from BUILTIN_CONNECTORS
    expect(integrationTypes).toContain('gmail');
    expect(integrationTypes).toContain('stripe');
    expect(integrationTypes).toContain('hubspot');
    expect(integrationTypes).toContain('slack');
    expect(integrationTypes).toContain('lever');
    expect(integrationTypes).toContain('zendesk');
    expect(integrationTypes).toContain('jira');

    // Should have at least 7 integration types
    expect(integrationTypes.length).toBeGreaterThanOrEqual(7);
  });

  it('should have no NULL categories for seeded tools', async () => {
    const result = await pool.query(`
      SELECT tool_name
      FROM tool_classification_cache
      WHERE categories IS NULL
    `);

    expect(result.rows).toHaveLength(0);
  });

  it('should have no duplicate tool_name entries', async () => {
    const result = await pool.query(`
      SELECT tool_name, COUNT(*) as count
      FROM tool_classification_cache
      GROUP BY tool_name
      HAVING COUNT(*) > 1
    `);

    expect(result.rows).toHaveLength(0);
  });

  it('should have valid 12-char hashes', async () => {
    const result = await pool.query(`
      SELECT tool_name, tool_description_hash
      FROM tool_classification_cache
      WHERE LENGTH(tool_description_hash) != 12
         OR tool_description_hash !~ '^[a-f0-9]{12}$'
    `);

    expect(result.rows).toHaveLength(0);
  });

  it('should have at least 50 tools seeded', async () => {
    const result = await pool.query(`
      SELECT COUNT(*) as count FROM tool_classification_cache
    `);

    const count = parseInt(result.rows[0].count, 10);
    expect(count).toBeGreaterThanOrEqual(50);
  });

  it('should have correct draft variants for communication tools', async () => {
    const result = await pool.query(`
      SELECT tool_name, draft_variant
      FROM tool_classification_cache
      WHERE tool_name IN ('gmail_send_email', 'gmail_reply_email', 'hubspot_send_email', 'slack_send_message', 'zendesk_reply_ticket')
    `);

    const draftVariants = Object.fromEntries(
      result.rows.map((r: { tool_name: string; draft_variant: string | null }) => [r.tool_name, r.draft_variant])
    );

    expect(draftVariants['gmail_send_email']).toBe('gmail_create_draft');
    expect(draftVariants['gmail_reply_email']).toBe('gmail_create_draft');
    expect(draftVariants['hubspot_send_email']).toBe('hubspot_create_email_draft');
    expect(draftVariants['slack_send_message']).toBe('slack_schedule_message');
    expect(draftVariants['zendesk_reply_ticket']).toBe('zendesk_create_draft_reply');
  });

  it('should have customerCommunication category for send/reply tools', async () => {
    const result = await pool.query(`
      SELECT tool_name, categories
      FROM tool_classification_cache
      WHERE tool_name IN ('gmail_send_email', 'gmail_reply_email', 'hubspot_send_email', 'zendesk_reply_ticket')
    `);

    for (const row of result.rows) {
      expect(row.categories).toContain('customerCommunication');
    }
  });

  it('should have financialActions category for stripe charge/refund tools', async () => {
    const result = await pool.query(`
      SELECT tool_name, categories
      FROM tool_classification_cache
      WHERE tool_name IN ('stripe_create_charge', 'stripe_refund_charge', 'stripe_create_invoice')
    `);

    for (const row of result.rows) {
      expect(row.categories).toContain('financialActions');
    }
  });

  it('should have hiringDecisions category for lever hiring tools', async () => {
    const result = await pool.query(`
      SELECT tool_name, categories
      FROM tool_classification_cache
      WHERE tool_name IN ('lever_send_offer', 'lever_reject_application', 'lever_update_candidate_status')
    `);

    for (const row of result.rows) {
      expect(row.categories).toContain('hiringDecisions');
    }
  });

  it('should have empty categories for read-only tools', async () => {
    const result = await pool.query(`
      SELECT tool_name, categories
      FROM tool_classification_cache
      WHERE tool_name IN ('gmail_search', 'gmail_read_email', 'stripe_get_balance', 'hubspot_get_contact')
    `);

    for (const row of result.rows) {
      expect(row.categories).toEqual([]);
    }
  });
});
