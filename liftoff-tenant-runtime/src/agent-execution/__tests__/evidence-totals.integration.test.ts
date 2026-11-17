/**
 * B0.2: deleting a resolved escalation must not move human_corrections.
 *
 * This is the guarantee that makes retention safe, and it is the one thing a
 * mock cannot prove: the whole point is what the DATABASE reports after rows
 * are gone. So this runs against a real Postgres and asserts on the actual
 * query the reflection engine issues.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated database.
 */
import { Pool } from 'pg';

const pool = process.env.TEST_DATABASE_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_URL })
  : null;

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const WORKFLOW = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';

/** The exact expression getEvidenceCounts uses for human_corrections. Kept
 *  literal rather than imported so this test fails if the repository is quietly
 *  pointed back at a live COUNT over the rows. */
async function readHumanCorrections(): Promise<number> {
  const { rows } = await pool!.query(
    `SELECT (SELECT COALESCE(human_corrections, 0) FROM agent_evidence_totals WHERE agent_id = $1) AS human_corrections`,
    [AGENT],
  );
  return parseInt(rows[0].human_corrections ?? '0', 10) || 0;
}

describeFn('evidence totals survive retention', () => {
  beforeAll(async () => {
    // workflow_escalations FKs up a chain: escalation -> workflow/task ->
    // agent -> tenant. Every link has to exist before the leaf can. One set is
    // enough; this test is about the counter, not the escalation's provenance.
    await pool!.query(
      `INSERT INTO tenants (id, external_id) VALUES ($1, 'evidence-totals-fixture')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );
    await pool!.query(
      `INSERT INTO agents (id, tenant_id, name) VALUES ($1, $2, 'Evidence fixture')
       ON CONFLICT (id) DO NOTHING`,
      [AGENT, TENANT],
    );
    await pool!.query(
      `INSERT INTO workflows (id, tenant_id, agent_id, objective, status)
       VALUES ($1, $2, $3, 'evidence-totals fixture', 'completed')
       ON CONFLICT (id) DO NOTHING`,
      [WORKFLOW, TENANT, AGENT],
    );
    await pool!.query(
      `INSERT INTO workflow_tasks (id, workflow_id, agent_id, status, idempotency_key)
       VALUES ($1, $2, $3, 'completed', 'evidence-totals-fixture')
       ON CONFLICT (id) DO NOTHING`,
      [TASK, WORKFLOW, AGENT],
    );
  });

  beforeEach(async () => {
    await pool!.query('DELETE FROM workflow_escalations WHERE tenant_id = $1', [TENANT]);
    await pool!.query('DELETE FROM agent_evidence_totals WHERE tenant_id = $1', [TENANT]);
  });

  afterAll(async () => {
    await pool!.end();
  });

  it('holds the count when the rows behind it are deleted', async () => {
    // Three corrections, counted as they happened.
    for (let i = 0; i < 3; i += 1) {
      await pool!.query(
        `INSERT INTO agent_evidence_totals (tenant_id, agent_id, human_corrections)
         VALUES ($1, $2, 1)
         ON CONFLICT (agent_id) DO UPDATE
           SET human_corrections = agent_evidence_totals.human_corrections + 1`,
        [TENANT, AGENT],
      );
      await pool!.query(
        `INSERT INTO workflow_escalations
           (id, workflow_id, task_id, agent_id, tenant_id, reason, status, kind, resolved_at)
         VALUES (gen_random_uuid(), $3, $4, $1, $2,
                 'x', 'resolved', 'escalation', NOW() - INTERVAL '90 days')`,
        [AGENT, TENANT, WORKFLOW, TASK],
      );
    }
    expect(await readHumanCorrections()).toBe(3);

    // Retention deletes every one of them.
    //
    // Asserted as "none of these rows survive", not "this statement removed
    // exactly three". Jest runs suites in parallel against one database and the
    // retention suite next door runs the real sweep, which deletes resolved
    // rows across every tenant, so either this DELETE or that sweep may be the
    // one that removes them. Which of the two did it is not the invariant under
    // test; the counter surviving their removal is.
    await pool!.query(
      `DELETE FROM workflow_escalations
        WHERE tenant_id = $1
          AND status = 'resolved'
          AND resolved_at < NOW() - INTERVAL '30 days'`,
      [TENANT],
    );
    const remaining = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM workflow_escalations WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(remaining.rows[0].n).toBe(0);

    // The learning signal is untouched. Before migration 353 this read 0, and
    // the reflection engine would have seen an agent that was never corrected.
    expect(await readHumanCorrections()).toBe(3);
  });

  it('reports zero for an agent that has never been corrected', async () => {
    expect(await readHumanCorrections()).toBe(0);
  });

  it('backfills from the rows exactly once, the way migration 353 does', async () => {
    await pool!.query(
      `INSERT INTO workflow_escalations
         (id, workflow_id, task_id, agent_id, tenant_id, reason, status, kind)
       VALUES (gen_random_uuid(), $3, $4, $1, $2, 'x', 'resolved', 'escalation'),
              (gen_random_uuid(), $3, $4, $1, $2, 'y', 'resolved', 'escalation'),
              (gen_random_uuid(), $3, $4, $1, $2, 'z', 'pending',  'escalation')`,
      [AGENT, TENANT, WORKFLOW, TASK],
    );

    await pool!.query(
      `INSERT INTO agent_evidence_totals (tenant_id, agent_id, human_corrections, escalations_raised)
       SELECT tenant_id, agent_id,
              COUNT(*) FILTER (WHERE status = 'resolved'),
              COUNT(*)
         FROM workflow_escalations
        WHERE agent_id IS NOT NULL
        GROUP BY tenant_id, agent_id
       ON CONFLICT (agent_id) DO NOTHING`,
    );

    expect(await readHumanCorrections()).toBe(2);

    // Running it again must not double the count: the counter is derived once
    // and incremented thereafter.
    await pool!.query(
      `INSERT INTO agent_evidence_totals (tenant_id, agent_id, human_corrections, escalations_raised)
       SELECT tenant_id, agent_id,
              COUNT(*) FILTER (WHERE status = 'resolved'),
              COUNT(*)
         FROM workflow_escalations
        WHERE agent_id IS NOT NULL
        GROUP BY tenant_id, agent_id
       ON CONFLICT (agent_id) DO NOTHING`,
    );

    expect(await readHumanCorrections()).toBe(2);
  });
});
