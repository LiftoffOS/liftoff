// Migration 257 verification — confirms the support-template backfill on
// agents.template_id matches the rows it was supposed to and leaves
// everything else alone.
//
// Companion to platform-backend/migrations/__tests__/233_backfill_template_id.integration.test.ts.

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT_ID = '00000000-0000-0000-0000-000000000bf2';
const BACKFILL_SQL = `
  UPDATE agents
     SET template_id = 'customer-support-representative'
   WHERE template_id IS NULL
     AND role = 'Customer Support Representative'
     AND lifecycle <> 'ARCHIVED'`;

describeFn('Migration 257 — backfill agents.template_id', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => { await pool.end(); });

  afterEach(async () => {
    await pool.query(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT_ID]);
  });

  async function insertAgent(args: {
    role: string;
    templateId?: string | null;
    lifecycle?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  }): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO agents
         (tenant_id, name, lifecycle, runtime_status, agent_type, hitl_level,
          model_config, exec_config, memory_scope, system_prompt, user_instructions,
          delegates, role, template_id)
       VALUES ($1, $2, $3, 'IDLE', 'agent', 3, '{}', '{}', '{}', '', '', '[]', $2, $4)
       RETURNING id`,
      [TENANT_ID, args.role, args.lifecycle ?? 'ACTIVE', args.templateId ?? null],
    );
    return r.rows[0].id;
  }

  async function getTemplateId(id: string): Promise<string | null> {
    const r = await pool.query<{ template_id: string | null }>(
      `SELECT template_id FROM agents WHERE id = $1`,
      [id],
    );
    return r.rows[0]?.template_id ?? null;
  }

  async function rerunBackfill(): Promise<number> {
    const r = await pool.query(BACKFILL_SQL);
    return r.rowCount ?? 0;
  }

  it('sets template_id on an existing support agent whose role matches the catalog', async () => {
    const id = await insertAgent({ role: 'Customer Support Representative' });
    expect(await rerunBackfill()).toBeGreaterThanOrEqual(1);
    expect(await getTemplateId(id)).toBe('customer-support-representative');
  });

  it('does not overwrite a manually-set template_id', async () => {
    const id = await insertAgent({
      role: 'Customer Support Representative',
      templateId: 'sales-prospector',
    });
    await rerunBackfill();
    expect(await getTemplateId(id)).toBe('sales-prospector');
  });

  it('skips agents whose role was customised away from the canonical string', async () => {
    const a = await insertAgent({ role: 'customer support representative' });
    const b = await insertAgent({ role: 'Senior Customer Support Specialist' });
    await rerunBackfill();
    expect(await getTemplateId(a)).toBeNull();
    expect(await getTemplateId(b)).toBeNull();
  });

  it('skips ARCHIVED agents (tombstones — runtime does not execute them)', async () => {
    const id = await insertAgent({
      role: 'Customer Support Representative',
      lifecycle: 'ARCHIVED',
    });
    await rerunBackfill();
    expect(await getTemplateId(id)).toBeNull();
  });

  it('is idempotent — re-running matches zero new rows', async () => {
    await insertAgent({ role: 'Customer Support Representative' });
    await rerunBackfill();
    expect(await rerunBackfill()).toBe(0);
  });
});
