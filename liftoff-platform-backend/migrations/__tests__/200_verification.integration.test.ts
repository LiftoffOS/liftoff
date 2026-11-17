// Migration 200 verification tests (integration; requires TEST_DATABASE_URL)
//
// These tests verify that migration 200 enables RLS + policies on the
// in-scope tables and that cross-tenant access is denied. Tables excluded
// from migration 200 are NOT verified here — they're
// only checked to confirm RLS stays OFF (regression guard).
//
// Run after migrations complete:
//   npx jest --config jest.integration.config.js migrations/__tests__/200_verification.integration.test.ts

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Tables that migration 200 should have enabled RLS on.
// The previously-deferred high-blast-radius tables (knowledge_*,
// external_agent_integrations, a2a_task_registry, agent_skill_metrics,
// agent_messages) are now covered now that every callsite uses
// withTenantScope / withAdminScope.
const EXPECTED_RLS_TABLES = [
  'a2a_task_registry',
  // Migration 291 — MCP OAuth front door + durable chat runs
  'oauth_grants',
  'oauth_authorization_codes',
  'oauth_access_tokens',
  'oauth_refresh_tokens',
  'mcp_chat_runs',
  // Migration 293 — chat share links
  'chat_share_links',
  // Migration 294 — per-turn sender attribution (conversation recall)
  'agent_chat_turns',
  // Migration 296 — late-feedback trust outbox (delivers late feedback to governance)
  'late_feedback_trust_outbox',
  // Migration 299 — team-preset provisioning (durable, idempotent, crash-recoverable)
  'team_provisioning_runs',
  'team_provisioning_run_roles',
  'internal_agent_provenance',
  // Migration 300's tuned-model registry + promotion ledger were dropped by migration 330
  // (the self-tuning flywheel is removed).
  // Migration 314 — Liftoff workspace Slack app (ADR-040)
  'slack_workspace_installs',
  'slack_conversation_agents',
  // Migration 483 — an assistant's thread per chat conversation
  'assistant_conversation_threads',
  // Migration 490 — a colleague's thread per team chat
  'agent_chat_colleague_threads',
  // Migration 319 — conversational routine proposals (P1.3)
  'agent_suggestions',
  // Migration 517 — continuations of a platform-assistant turn a bound closed
  'chat_continuations',
  // Migration 320/321 — outbound delivery durability
  'chat_delivery_obligations',
  // Renamed by migration 325 when the registry was generalised to cover Teams.
  'dm_delivery_attempts',
  // Migration 324 — outbound webhooks to customer-owned endpoints
  'outbound_webhooks',
  'outbound_webhook_deliveries',
  // Migration 348: Liftoff, the general platform assistant behind the
  // dashboard composer. Created after the DO-loops in migrations 095/287/289
  // had already run, so 348 writes its own RLS and these four have to be
  // named here to be covered at all. `liftoff_chat_messages` is deliberately
  // absent: it carries no tenant_id and inherits tenancy through its thread,
  // the same decision as insights_chat_messages, so there is no policy for it
  // to hold (asserted below rather than assumed).
  'liftoff_chat_threads',
  'liftoff_rate_limit_events',
  'liftoff_turn_locks',
  'liftoff_turn_signals',
  // Migration 361 — Liftoff Switch. Created long after the DO-loops in
  // migrations 095/287/289 ran, so 361 writes its own ENABLE + FORCE + policy
  // and these four have to be named here to be covered at all. They carry a
  // customer's imported instructions, memories and skills before conversion,
  // which is exactly the material a cross-tenant read must never reach.
  'source_migrations',
  'source_migration_items',
  'source_migration_routines',
  'source_migration_connections',
  // Migration 415 — the referral programme. Created long after the DO-loops in
  // migrations 095/287/289 ran, so 415 writes its own ENABLE + FORCE + policy
  // and these three have to be named here to be covered at all.
  //
  // `referrals` is the one to look at twice: its policy is keyed on
  // referrer_tenant_id, not tenant_id, because the row is the REFERRER's record
  // of what their link earned. A policy written on the referred side would let
  // every referred workspace read the identity of whoever referred it, and
  // would hide the row from the only workspace with a reason to see it.
  'referral_codes',
  'referrals',
  'referral_invites',
  // Migration 416 — distillation wall-clock telemetry. Same story as 361/415:
  // created after the DO-loops, so 416 writes its own ENABLE + FORCE + policy
  // and has to be named here to be covered.
  //
  // Telemetry, but not a content table. Every row is one tenant's distillation
  // and tenant_id is NOT NULL, so unlike `distillation_cache` there are no
  // global rows anyone reads outside an admin context. The cross-tenant A/B
  // comparison goes through withAdminScope / the psql job, both BYPASSRLS.
  'distill_runs',
  // Migration 420 — shadow-mode comparisons. Holds a tenant's generated agent
  // in both output columns, which is exactly what distill_artifacts is
  // FORCE-RLS'd for.
  'distill_shadow_comparisons',
  // Migration 426 — the browser-activity trail of a Liftoff conversation.
  // Same story as 348's four: created after the DO-loops, so 426 writes its
  // own ENABLE + FORCE + policy and the table has to be named here to be
  // covered. Unlike liftoff_chat_messages it DOES carry tenant_id, because
  // its one reader is a service-auth route that has no thread in hand until
  // it resolves one, and the rows describe what a tenant's browser did.
  'liftoff_browser_activity',
  // Migration 478 — the editable name and description of a coding-tool
  // connection, keyed by the connection id whichever family it belongs to
  // (a developer-proxy credential or an mcp_tokens anchor). Created after the
  // DO-loops, so 478 writes its own ENABLE + FORCE + policy.
  'coding_tool_connection_profiles',
  // Migration 511 — a fetched result parked for the job that fetched it
  // (510's whole-result cache, dropped there, was its predecessor)
  'datasets',
  'dataset_records',
  // Migration 530 — the capture link behind a custom API connection. The one
  // table this repo owns for that feature; the connection's own description
  // lives in connector-service's database, RLS-enabled there from its first
  // migration. Created long after the DO-loops in 095/287/289, so 530 writes
  // its own ENABLE + FORCE + policy and the table has to be named here to be
  // covered at all. It carries the declared connection description a person is
  // about to enter a key against, which is exactly what a cross-tenant read
  // must never reach.
  'custom_api_capture_tokens',
  // Enabled by migration 200's DO-loop alongside everything else with a
  // tenant_id: its header records the callsite audit that allowed it (the
  // workflow engine's services, the operator dashboard's cross-tenant read,
  // the billing-controls backfill and the cost-attribution ingesters all go
  // through withTenantScope or withAdminScope).
  'workflow_definitions',
  'workflow_runs',
  'workflow_tasks',
  'alerts',
  'billing_spend_events',
  'cost_attribution_events',
  'cost_attribution_snapshots',
  // Migration 547 — turn identity for the two in-process platform assistants,
  // so recall is keyed to the person who spoke rather than to the thread. The
  // MESSAGE tables beside them carry no tenant_id and are deliberately not
  // here: they are scoped through their thread.
  'liftoff_chat_turns',
  'insights_chat_turns',
];

// Tables that should be EXCLUDED (RLS not enabled in this migration).
// Must stay in sync with the excluded_tables array in migration 200.
//
// The list is SHORTER than it reads in the plan this file was written
// against, and migration 200 is the reason: its own header says the workflow
// tables, `alerts`, `billing_spend_events` and the cost-attribution pair
// "are now wrapped at every callsite in either withTenantScope ... or
// withAdminScope. RLS is enabled on all of them by the DO-loop below", and
// its `excluded_tables` array carries only the platform-global tables plus
// `distillation_cache`. Two workflow children (`workflow_step_executions`,
// `workflow_step_events`) have no tenant_id of their own, so the DO-loop
// never reaches them and they stay off. Anything named here is asserted to
// be RLS-FREE, so a table the migration enables cannot be left in this list.
const EXPECTED_EXCLUDED_TABLES = [
  'distillation_cache',  // intentionally globally shared
  // Workflow children with no tenant_id column: reached through their run,
  // which the DO-loop does cover.
  'workflow_step_executions',
  'workflow_step_events',
];

// Partitioned parents whose child partitions must ALSO stay disabled.
// information_schema lists partitions as 'BASE TABLE' with their own tenant_id,
// so a migration matching on table_name alone would enable RLS on a partition
// of an excluded parent. None of the parents is excluded any more —
// `cost_attribution_events` is enabled with its partitions, and
// `tenant_resource_usage` is no longer in the schema — so the guard has
// nothing to check and the list is empty. It stays as the place a future
// exclusion is declared.
const EXCLUDED_PARTITION_PARENTS: string[] = [];

/**
 * Seeds two tenants + a shared account for RLS denial fixtures. Uses
 * withAdminScope-style bypass via the `app.current_tenant_id` session var
 * left UNSET — RLS policies on tenants/accounts cast against
 * current_setting and fail closed, so we run the seed inside a transaction
 * with the session role temporarily switched to one that bypasses RLS.
 *
 * Simpler approach: just run as the superuser the test DB connects as. The
 * test Postgres connection in CI uses the migration role, which is the
 * table owner and bypasses RLS by default.
 */
async function seedTenants(
  client: PoolClient,
  tenantA: string,
  tenantB: string,
  accountId: string,
): Promise<void> {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version)
     VALUES ($1, $2, 'Test', 'RLS', $3, 'UTC', 1)
     ON CONFLICT (id) DO NOTHING`,
    [accountId, `rls-test-${accountId.slice(0, 8)}`, `rls-test-${accountId.slice(0, 8)}@test.invalid`],
  );
  await client.query(
    `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
     VALUES ($1, $2, 'RLS Test Tenant A', 'standard', 'shared', 'pending', 'pending')
     ON CONFLICT (id) DO NOTHING`,
    [tenantA, accountId],
  );
  await client.query(
    `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
     VALUES ($1, $2, 'RLS Test Tenant B', 'standard', 'shared', 'pending', 'pending')
     ON CONFLICT (id) DO NOTHING`,
    [tenantB, accountId],
  );
  await client.query('COMMIT');
}

/**
 * Cleanup helper. The `tenants` table itself is EXCLUDED from RLS (see
 * migration 095 line 82); a plain `DELETE FROM tenants WHERE id = $1`
 * would succeed without tenant context. But the cascading deletes on
 * RLS-on child tables (tenant_members, internal_agents, mcp_tokens, etc.)
 * are subject to the same policies — without `app.current_tenant_id` set,
 * cascade-triggered DELETEs against those children would silently fail
 * the USING clause. We set the session var to each tenant id before
 * deleting so child cascades pass.
 */
/**
 * The tables whose foreign key to `tenants` does NOT cascade: their fixture
 * rows have to go before the tenant does, or the tenant delete raises 23503
 * and the fixtures survive into the next test.
 *
 * Read from the catalog rather than listed by hand. A hand-written list is
 * exactly what rotted here: each denial test seeds a row in the table it is
 * about, the cleanup deleted only the tenant, and the first non-cascading
 * table to gain a test left its row behind — after which every later test
 * failed on the tenant delete rather than on what it was asserting. Derived,
 * it cannot rot: a new table is covered the day it exists.
 *
 * `tenant_id::text` because the column is not UUID everywhere
 * (`knowledge_items` carries it as TEXT and its policy casts to match).
 */
let blockingTables: string[] | null = null;
async function tablesBlockingTenantDelete(client: PoolClient): Promise<string[]> {
  if (blockingTables) return blockingTables;
  const result = await client.query<{ relname: string }>(`
    SELECT DISTINCT c.relname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_class rt ON rt.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND a.attnum > 0 AND NOT a.attisdropped
    WHERE con.contype = 'f' AND rt.relname = 'tenants'
      AND con.confdeltype <> 'c'
      AND n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY 1
  `);
  blockingTables = result.rows.map((r) => r.relname);
  return blockingTables;
}

async function cleanupTenants(
  client: PoolClient,
  tenantA: string,
  tenantB: string,
  accountId: string,
): Promise<void> {
  // A test that failed mid-transaction leaves the connection aborted, and
  // every statement here would then report that rather than what it did.
  // Ending it first is what makes the cleanup say the truth — and what makes
  // the test above report its own failure instead of this one's.
  await client.query('ROLLBACK').catch(() => undefined);
  const blocking = await tablesBlockingTenantDelete(client);
  await client.query('BEGIN');
  for (const t of [tenantA, tenantB]) {
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [t]);
    // Under the tenant's own scope, so a FORCE-RLS table's USING clause
    // passes and the row is actually reachable to delete.
    //
    // These tables reference each other as well as the tenant (a workflow run
    // names its definition), so there is no single order that works and no
    // deferral to lean on: the constraints are not DEFERRABLE. Delete in
    // passes instead, keeping whatever a foreign key still holds down for the
    // next pass, until nothing is left or a pass frees nothing — which is a
    // cycle, and is raised rather than swallowed.
    let remaining = [...blocking];
    while (remaining.length > 0) {
      const held: string[] = [];
      let lastError: Error | null = null;
      for (const table of remaining) {
        await client.query('SAVEPOINT fixture_delete');
        try {
          await client.query(`DELETE FROM public.${table} WHERE tenant_id::text = $1`, [t]);
          await client.query('RELEASE SAVEPOINT fixture_delete');
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT fixture_delete');
          await client.query('RELEASE SAVEPOINT fixture_delete');
          if ((err as { code?: string }).code !== '23503') throw err;
          held.push(table);
          lastError = err as Error;
        }
      }
      if (held.length === remaining.length) throw lastError ?? new Error('fixture cleanup made no progress');
      remaining = held;
    }
    await client.query(`DELETE FROM tenants WHERE id = $1`, [t]);
  }
  // accounts has no tenant_id column — RLS doesn't apply; plain delete works.
  await client.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
  await client.query('COMMIT');
}

describeFn('Migration 200 verification — RLS coverage', () => {
  let pool: Pool;
  const tenantA = '00000000-0000-0000-0000-0000000000aa';
  const tenantB = '00000000-0000-0000-0000-0000000000bb';

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('drops internal_agents_modelconfig_pre_197', async () => {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'internal_agents_modelconfig_pre_197' AND table_schema = 'public'
    `);
    expect(result.rows).toHaveLength(0);
  });

  it('enables RLS on all expected in-scope tables', async () => {
    const result = await pool.query<{ table_name: string; rls_enabled: boolean }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    `, [EXPECTED_RLS_TABLES]);

    const byTable = new Map(result.rows.map((r) => [r.table_name, r.rls_enabled]));
    for (const table of EXPECTED_RLS_TABLES) {
      expect(byTable.get(table)).toBe(true);
    }
  });

  it('creates a tenant_isolation policy on each in-scope table', async () => {
    const result = await pool.query<{ table_name: string; policy_count: number }>(`
      SELECT c.relname AS table_name, (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    `, [EXPECTED_RLS_TABLES]);

    for (const row of result.rows) {
      expect(row.policy_count).toBeGreaterThanOrEqual(1);
    }
  });

  it('leaves all excluded tables WITHOUT RLS (intentional)', async () => {
    // Check all parents in the exclusion list. Their callers still use
    // getPool() without scope and would silently return zero rows under RLS.
    // Fail loudly if anyone accidentally drops an exclusion.
    const result = await pool.query<{ table_name: string; rls_enabled: boolean }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    `, [EXPECTED_EXCLUDED_TABLES]);

    const byTable = new Map(result.rows.map((r) => [r.table_name, r.rls_enabled]));
    // L1: every excluded table MUST be present in the schema and MUST be
    // RLS-disabled. The previous `if (byTable.has(table))` guard skipped
    // tables that didn't exist — masking accidental drops or typos in the
    // exclusion list. Assert presence first, then assert RLS-disabled.
    for (const table of EXPECTED_EXCLUDED_TABLES) {
      expect(byTable.has(table)).toBe(true);
      expect(byTable.get(table)).toBe(false);
    }
  });

  it('leaves all partitions of deferred parents WITHOUT RLS (regression test for #1)', async () => {
    // PostgreSQL partitions appear as 'BASE TABLE' in information_schema. If
    // the migration's DO-loop matches on table_name alone (without a
    // pg_inherits filter), partitions of excluded parents inadvertently get
    // RLS enabled. The 3 cost-attribution ingesters write to these partitions
    // via the parent and would break.
    const result = await pool.query<{ partition: string; rls_enabled: boolean }>(`
      SELECT child.relname AS partition, child.relrowsecurity AS rls_enabled
      FROM pg_inherits i
      JOIN pg_class child ON child.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE n.nspname = 'public'
        AND parent.relname = ANY($1::text[])
    `, [EXCLUDED_PARTITION_PARENTS]);

    for (const row of result.rows) {
      expect({ partition: row.partition, rls_enabled: row.rls_enabled })
        .toEqual({ partition: row.partition, rls_enabled: false });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Cross-tenant denial tests
  // For each in-scope table, insert as tenant A then assert tenant B cannot
  // SELECT or INSERT. Tables that FK back to `internal_agents` (generated_files,
  // skill_feedback_log) get a parent agent row seeded under the appropriate
  // tenant first. `internal_agents` cascades on tenant delete, so the
  // cleanupTenants helper sweeps the children automatically.
  // ──────────────────────────────────────────────────────────────────────

  it('denies cross-tenant SELECT on mcp_tokens', async () => {
    const tokenIdA = randomUUID();
    const accountId = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // Seed a row as tenant A. mcp_tokens NOT NULL columns without defaults:
      // tenant_id, account_id, token_hash, token_prefix. name/status/expires_at
      // have defaults.
      await client.query('BEGIN');
      // SET LOCAL doesn't accept $N parameter binding via extended query
      // protocol — must use set_config() for parameterized values. Same
      // pattern as production code (e.g., billing-accounts-router.ts:40).
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO mcp_tokens (id, tenant_id, account_id, token_hash, token_prefix, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, 'active', NOW() + INTERVAL '1 day')
        ON CONFLICT (id) DO NOTHING
      `, [tokenIdA, tenantA, accountId, 'test-hash-' + tokenIdA, 'liftoff_mcp_test']);
      await client.query('COMMIT');

      // Try to SELECT as tenant B
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM mcp_tokens WHERE id = $1`,
        [tokenIdA],
      );
      await client.query('ROLLBACK');

      expect(result.rows).toHaveLength(0);

      // INSERT as tenant B with tenant A's id must violate the policy.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO mcp_tokens (id, tenant_id, account_id, token_hash, token_prefix, status, expires_at)
          VALUES ($1, $2, $3, $4, $5, 'active', NOW() + INTERVAL '1 day')
        `, [randomUUID(), tenantA, accountId, 'cross-hash', 'liftoff_mcp_x']),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on distill_runs', async () => {
    const runId = randomUUID();
    const rowId = randomUUID();
    const accountId = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // distill_runs NOT NULL columns without defaults: run_id, tenant_id,
      // purpose, strategy, phase, branch, started_at. id/attempt/created_at
      // have defaults.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO distill_runs (id, run_id, tenant_id, purpose, strategy, phase, branch, started_at)
        VALUES ($1, $2, $3, 'distill', 'single', 'single', 'single', NOW())
        ON CONFLICT (id) DO NOTHING
      `, [rowId, runId, tenantA]);
      await client.query('COMMIT');

      // Read as tenant B — the row must not be visible.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM distill_runs WHERE id = $1`,
        [rowId],
      );
      await client.query('ROLLBACK');

      expect(result.rows).toHaveLength(0);

      // Writing tenant A's telemetry while scoped to tenant B must violate the
      // WITH CHECK half of the policy, not merely be invisible afterwards.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO distill_runs (id, run_id, tenant_id, purpose, strategy, phase, branch, started_at)
          VALUES ($1, $2, $3, 'distill', 'waved', 'wave1', 'summary', NOW())
        `, [randomUUID(), randomUUID(), tenantA]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on distill_shadow_comparisons', async () => {
    const rowId = randomUUID();
    const accountId = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // NOT NULL without defaults: tenant_id, purpose, real_run_id,
      // shadow_run_id, expires_at.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO distill_shadow_comparisons
          (id, tenant_id, purpose, real_run_id, shadow_run_id, expires_at)
        VALUES ($1, $2, 'distill', $3, $4, NOW() + INTERVAL '1 day')
        ON CONFLICT (id) DO NOTHING
      `, [rowId, tenantA, randomUUID(), randomUUID()]);
      await client.query('COMMIT');

      // This table holds two full generated agents. A cross-tenant read here is
      // the same exposure distill_artifacts is FORCE-RLS'd to prevent.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM distill_shadow_comparisons WHERE id = $1`,
        [rowId],
      );
      await client.query('ROLLBACK');

      expect(result.rows).toHaveLength(0);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO distill_shadow_comparisons
            (id, tenant_id, purpose, real_run_id, shadow_run_id, expires_at)
          VALUES ($1, $2, 'distill', $3, $4, NOW() + INTERVAL '1 day')
        `, [randomUUID(), tenantA, randomUUID(), randomUUID()]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on setup_tokens', async () => {
    const tokenStr = `rls-setup-${randomUUID()}`;
    const accountId = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // setup_tokens NOT NULL columns without defaults: token, token_type,
      // full_key, base_url, tenant_id, account_id.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO setup_tokens (token, token_type, full_key, base_url, tenant_id, account_id)
        VALUES ($1, 'mcp', 'liftoff_mcp_xxx', 'https://example.invalid', $2, $3)
        ON CONFLICT (token) DO NOTHING
      `, [tokenStr, tenantA, accountId]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT token FROM setup_tokens WHERE token = $1`,
        [tokenStr],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO setup_tokens (token, token_type, full_key, base_url, tenant_id, account_id)
          VALUES ($1, 'mcp', 'liftoff_mcp_xxx', 'https://example.invalid', $2, $3)
        `, [`rls-setup-x-${randomUUID()}`, tenantA, accountId]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      // Cleanup the seeded setup token — needs tenant A context to see it.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`DELETE FROM setup_tokens WHERE token = $1`, [tokenStr]);
      await client.query('COMMIT');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on generated_files', async () => {
    const accountId = randomUUID();
    const agentIdA = randomUUID();
    const fileIdA = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // Seed a parent agent under tenant A. internal_agents has RLS enabled
      // via migration 095, so we must set tenant context before INSERT.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'RLS Test Agent A')
         ON CONFLICT (id) DO NOTHING`,
        [agentIdA, tenantA],
      );
      // generated_files NOT NULL columns: tenant_id, agent_id, filename,
      // base_name, output_type, gcs_path. version/created_at have defaults.
      await client.query(`
        INSERT INTO generated_files (id, tenant_id, agent_id, filename, base_name, output_type, gcs_path)
        VALUES ($1, $2, $3, 'report.xlsx', 'report', 'xlsx', 'gs://test-bucket/rls/report.xlsx')
        ON CONFLICT (id) DO NOTHING
      `, [fileIdA, tenantA, agentIdA]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM generated_files WHERE id = $1`,
        [fileIdA],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO generated_files (id, tenant_id, agent_id, filename, base_name, output_type, gcs_path)
          VALUES ($1, $2, $3, 'cross.xlsx', 'cross', 'xlsx', 'gs://test-bucket/rls/cross.xlsx')
        `, [randomUUID(), tenantA, agentIdA]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on skill_feedback_log', async () => {
    const accountId = randomUUID();
    const agentIdA = randomUUID();
    const taskId = `rls-task-${randomUUID()}`;

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // Seed parent agent under tenant A.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'RLS Test Agent A')
         ON CONFLICT (id) DO NOTHING`,
        [agentIdA, tenantA],
      );
      // skill_feedback_log NOT NULL columns: agent_id, tenant_id, task_id.
      // processed_at has a default.
      await client.query(`
        INSERT INTO skill_feedback_log (agent_id, tenant_id, task_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (agent_id, task_id) DO NOTHING
      `, [agentIdA, tenantA, taskId]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT task_id FROM skill_feedback_log WHERE task_id = $1`,
        [taskId],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO skill_feedback_log (agent_id, tenant_id, task_id)
          VALUES ($1, $2, $3)
        `, [agentIdA, tenantA, `rls-task-x-${randomUUID()}`]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on slack_user_mappings', async () => {
    const accountId = randomUUID();
    const slackTeamId = `T${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`;
    const slackUserId = `U${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`;

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // slack_user_mappings NOT NULL columns: slack_team_id, slack_user_id,
      // tenant_id. account_id is nullable, slack_email is nullable.
      // PRIMARY KEY (slack_team_id, slack_user_id). No FK to slack_workspaces.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO slack_user_mappings (slack_team_id, slack_user_id, account_id, tenant_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (slack_team_id, slack_user_id) DO NOTHING
      `, [slackTeamId, slackUserId, accountId, tenantA]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT slack_user_id FROM slack_user_mappings WHERE slack_team_id = $1 AND slack_user_id = $2`,
        [slackTeamId, slackUserId],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      // Use a new (team, user) pair so we don't collide with the seeded row.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO slack_user_mappings (slack_team_id, slack_user_id, account_id, tenant_id)
          VALUES ($1, $2, $3, $4)
        `, [`${slackTeamId}X`, `${slackUserId}X`, accountId, tenantA]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      // Cleanup the seeded mapping — slack_user_mappings has no cascade from
      // tenants (parent is INSERTed without ON DELETE CASCADE on tenant_id).
      // Need tenant A context to see (and delete) the row.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `DELETE FROM slack_user_mappings WHERE slack_team_id = $1 AND slack_user_id = $2`,
        [slackTeamId, slackUserId],
      );
      await client.query('COMMIT');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // H2: cross-tenant denial tests for the previously-deferred RLS tables.
  // Migration 200 now enables RLS on these tables; the tests below seed a
  // row under tenant A and assert tenant B cannot SELECT or INSERT.
  // ──────────────────────────────────────────────────────────────────────

  it('denies cross-tenant SELECT and INSERT on a2a_task_registry', async () => {
    const accountId = randomUUID();
    const agentIdA = randomUUID();
    const taskIdA = `rls-a2a-${randomUUID()}`;

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // Seed the FK parent (internal_agents) under tenant A.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'RLS Test Agent A')
         ON CONFLICT (id) DO NOTHING`,
        [agentIdA, tenantA],
      );
      // a2a_task_registry NOT NULL columns: task_id, agent_id, tenant_id,
      // requester_key_id, context_id. id/created_at have defaults.
      await client.query(`
        INSERT INTO a2a_task_registry (task_id, agent_id, tenant_id, requester_key_id, context_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (task_id) DO NOTHING
      `, [taskIdA, agentIdA, tenantA, 'rls-test-requester', 'rls-ctx']);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT task_id FROM a2a_task_registry WHERE task_id = $1`,
        [taskIdA],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO a2a_task_registry (task_id, agent_id, tenant_id, requester_key_id, context_id)
          VALUES ($1, $2, $3, $4, $5)
        `, [`rls-a2a-x-${randomUUID()}`, agentIdA, tenantA, 'rls-test-requester', 'rls-ctx-x']),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on agent_messages', async () => {
    const accountId = randomUUID();
    const messageIdA = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // agent_messages has no FK to internal_agents — sender_id/recipient_id
      // are free-form TEXT. NOT NULL columns: tenant_id, sender_type,
      // sender_id, recipient_type, recipient_id, content.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO agent_messages (id, tenant_id, sender_type, sender_id, recipient_type, recipient_id, content)
        VALUES ($1, $2, 'claude_code', 'rls-sender', 'internal_agent', 'rls-recipient', 'hello')
        ON CONFLICT (id) DO NOTHING
      `, [messageIdA, tenantA]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM agent_messages WHERE id = $1`,
        [messageIdA],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO agent_messages (id, tenant_id, sender_type, sender_id, recipient_type, recipient_id, content)
          VALUES ($1, $2, 'claude_code', 'x', 'internal_agent', 'y', 'cross-tenant')
        `, [randomUUID(), tenantA]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on agent_skill_metrics', async () => {
    const accountId = randomUUID();
    const agentIdA = randomUUID();
    const skillId = `rls-skill-${randomUUID()}`;

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'RLS Test Agent A')
         ON CONFLICT (id) DO NOTHING`,
        [agentIdA, tenantA],
      );
      // agent_skill_metrics NOT NULL columns: agent_id, tenant_id, skill_id, skill_name.
      // PRIMARY KEY (agent_id, skill_id).
      await client.query(`
        INSERT INTO agent_skill_metrics (agent_id, tenant_id, skill_id, skill_name)
        VALUES ($1, $2, $3, 'RLS Skill A')
        ON CONFLICT (agent_id, skill_id) DO NOTHING
      `, [agentIdA, tenantA, skillId]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT skill_id FROM agent_skill_metrics WHERE agent_id = $1 AND skill_id = $2`,
        [agentIdA, skillId],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO agent_skill_metrics (agent_id, tenant_id, skill_id, skill_name)
          VALUES ($1, $2, $3, 'RLS Skill X')
        `, [agentIdA, tenantA, `rls-skill-x-${randomUUID()}`]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on external_agent_integrations', async () => {
    const accountId = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // external_agent_integrations NOT NULL columns: tenant_id, type.
      // UNIQUE (tenant_id, type) — use ON CONFLICT DO NOTHING.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO external_agent_integrations (tenant_id, type, active_key_count)
        VALUES ($1, 'claude_code', 1)
        ON CONFLICT (tenant_id, type) DO NOTHING
      `, [tenantA]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT tenant_id FROM external_agent_integrations WHERE tenant_id = $1`,
        [tenantA],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO external_agent_integrations (tenant_id, type, active_key_count)
          VALUES ($1, 'codex', 2)
        `, [tenantA]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on knowledge_items', async () => {
    // knowledge_items.tenant_id is TEXT (not UUID) — RLS policy compares
    // against current_setting('app.current_tenant_id')::text.
    const accountId = randomUUID();
    const itemIdA = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO knowledge_items (id, tenant_id, title)
        VALUES ($1, $2, 'RLS Knowledge Item A')
        ON CONFLICT (id) DO NOTHING
      `, [itemIdA, tenantA]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM knowledge_items WHERE id = $1`,
        [itemIdA],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO knowledge_items (id, tenant_id, title)
          VALUES ($1, $2, 'RLS Cross-Tenant')
        `, [randomUUID(), tenantA]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      // Cleanup the seeded knowledge_item — needs tenant A context to delete.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`DELETE FROM knowledge_items WHERE id = $1`, [itemIdA]);
      await client.query('COMMIT');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on knowledge_webhook_subscriptions', async () => {
    // knowledge_webhook_subscriptions.tenant_id is TEXT. NOT NULL columns:
    // tenant_id, connector_id, connector_type, external_id, subscription_id,
    // channel_token. UNIQUE (connector_id, external_id).
    const accountId = randomUUID();
    const subIdA = randomUUID();
    const connectorId = `conn-${randomUUID()}`;
    const externalId = `ext-${randomUUID()}`;

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`
        INSERT INTO knowledge_webhook_subscriptions
          (id, tenant_id, connector_id, connector_type, external_id, subscription_id, channel_token)
        VALUES ($1, $2, $3, 'gdrive', $4, 'sub-rls', 'tok-rls')
        ON CONFLICT (connector_id, external_id) DO NOTHING
      `, [subIdA, tenantA, connectorId, externalId]);
      await client.query('COMMIT');

      // Tenant B SELECT should see zero rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM knowledge_webhook_subscriptions WHERE id = $1`,
        [subIdA],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Tenant B INSERT with tenant A's id must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(`
          INSERT INTO knowledge_webhook_subscriptions
            (id, tenant_id, connector_id, connector_type, external_id, subscription_id, channel_token)
          VALUES ($1, $2, $3, 'gdrive', $4, 'sub-cross', 'tok-cross')
        `, [randomUUID(), tenantA, `conn-x-${randomUUID()}`, `ext-x-${randomUUID()}`]),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      // Cleanup the seeded subscription — needs tenant A context to delete.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`DELETE FROM knowledge_webhook_subscriptions WHERE id = $1`, [subIdA]);
      await client.query('COMMIT');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  // ── §0.3 closure: tables removed from exclusion list ────────────────────

  it('denies cross-tenant SELECT and INSERT on workflow_definitions', async () => {
    const accountId = randomUUID();
    const defIdA = randomUUID();
    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO workflow_definitions (id, tenant_id, name, definition, created_by)
         VALUES ($1, $2, 'RLS-Test', '{"nodes":[],"edges":[],"entry_node_id":"x"}'::jsonb, 'rls-test')
         ON CONFLICT (id) DO NOTHING`,
        [defIdA, tenantA],
      );
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM workflow_definitions WHERE id = $1`,
        [defIdA],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO workflow_definitions (id, tenant_id, name, definition, created_by)
           VALUES ($1, $2, 'RLS-Spoof', '{}'::jsonb, 'rls-test')`,
          [randomUUID(), tenantA],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on workflow_runs', async () => {
    const accountId = randomUUID();
    const defIdA = randomUUID();
    const runIdA = randomUUID();
    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO workflow_definitions (id, tenant_id, name, definition, created_by)
         VALUES ($1, $2, 'RLS-Test', '{"nodes":[],"edges":[],"entry_node_id":"x"}'::jsonb, 'rls-test')
         ON CONFLICT (id) DO NOTHING`,
        [defIdA, tenantA],
      );
      await client.query(
        `INSERT INTO workflow_runs (id, tenant_id, definition_id, definition_version, triggered_by)
         VALUES ($1, $2, $3, 1, 'rls-test')
         ON CONFLICT (id) DO NOTHING`,
        [runIdA, tenantA, defIdA],
      );
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM workflow_runs WHERE id = $1`,
        [runIdA],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on alerts', async () => {
    const accountId = randomUUID();
    const alertIdA = randomUUID();
    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO alerts (id, tenant_id, severity, type, message)
         VALUES ($1, $2, 'info', 'rls_test', 'cross-tenant denial test')
         ON CONFLICT (id) DO NOTHING`,
        [alertIdA, tenantA],
      );
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(`SELECT id FROM alerts WHERE id = $1`, [alertIdA]);
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO alerts (id, tenant_id, severity, type, message)
           VALUES ($1, $2, 'info', 'rls_test', 'spoof')`,
          [randomUUID(), tenantA],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on billing_spend_events', async () => {
    const accountId = randomUUID();
    const invocationId = `rls-test-${randomUUID()}`;
    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        // `ou_spend_usd` is gone: the OU-native columns replaced it, and
        // `customer_cost_usd` is the one every customer-facing surface sums.
        `INSERT INTO billing_spend_events (invocation_id, tenant_id, account_id, cost_usd, ou_consumed, customer_cost_usd, cost_bucket)
         VALUES ($1, $2, $3, 0.01, 0.005, 0.01, 'included')
         ON CONFLICT (invocation_id) DO NOTHING`,
        [invocationId, tenantA, accountId],
      );
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT invocation_id FROM billing_spend_events WHERE invocation_id = $1`,
        [invocationId],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Cleanup
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`DELETE FROM billing_spend_events WHERE invocation_id = $1`, [invocationId]);
      await client.query('COMMIT');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on cost_attribution_events', async () => {
    // NB: cost_attribution_events.tenant_id is TEXT (not UUID) per migration 133.
    // The 095/200 DO-loop uses ::text cast for non-UUID columns.
    const accountId = randomUUID();
    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      const insertResult = await client.query(
        // event_type and source are both CHECK-constrained to the kinds the
        // ingesters write; a made-up value is refused by the table before RLS
        // is ever consulted, which is not what this test is asking about.
        `INSERT INTO cost_attribution_events
           (tenant_id, event_type, source, cost_usd, occurred_at)
         VALUES ($1, 'llm_invocation', 'platform_llm', 0.01, NOW())
         RETURNING id`,
        [tenantA],
      );
      const eventId = insertResult.rows[0].id;
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM cost_attribution_events WHERE id = $1`,
        [eventId],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Cleanup
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`DELETE FROM cost_attribution_events WHERE id = $1`, [eventId]);
      await client.query('COMMIT');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  it('denies cross-tenant SELECT and INSERT on cost_attribution_snapshots', async () => {
    const accountId = randomUUID();
    const periodStart = new Date(Date.UTC(2026, 0, 1));
    const periodEnd = new Date(Date.UTC(2026, 0, 1, 1));
    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      const insertResult = await client.query(
        `INSERT INTO cost_attribution_snapshots
           (tenant_id, period_start, period_end, granularity, total_cost_usd)
         VALUES ($1, $2, $3, 'hour', 0.10)
         RETURNING id`,
        [tenantA, periodStart, periodEnd],
      );
      const snapId = insertResult.rows[0].id;
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `SELECT id FROM cost_attribution_snapshots WHERE id = $1`,
        [snapId],
      );
      await client.query('ROLLBACK');
      expect(result.rows).toHaveLength(0);

      // Cleanup
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(`DELETE FROM cost_attribution_snapshots WHERE id = $1`, [snapId]);
      await client.query('COMMIT');
    } finally {
      await cleanupTenants(client, tenantA, tenantB, accountId);
      client.release();
    }
  });

  // `tenant_resource_usage` had a denial test here. Migration 340 dropped the
  // table (resource metering was retired), so the test asserted RLS on a
  // relation that does not exist and failed for that reason alone. Removed
  // rather than skipped: a test that cannot run is not a guard, and the
  // schema-reachability ratchet is what now notices a table nobody reads.
});


// ── Migration 291: cross-tenant denial for the MCP OAuth + chat-run tables ──
// Plan v6.1 census requirement: each of the five new tenant-scoped tables
// gets a literal cross-tenant denial check (SELECT-as-other-tenant empty,
// cross-tenant INSERT rejected), seeded through the real FK graph.

describeFn('Migration 291 verification — MCP OAuth cross-tenant denial', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('denies cross-tenant access on all five tables', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const accountId = randomUUID();
    const clientId = `liftoff_oc_test_${tenantA.slice(0, 8)}`;
    const anchorId = randomUUID();
    const grantId = randomUUID();
    const threadId = randomUUID();
    const runId = randomUUID();
    const codeHash = `code-hash-${runId}`;
    const accessHash = `access-hash-${runId}`;
    const refreshHash = `refresh-hash-${runId}`;
    const RESOURCE = 'https://api-test.example.com/mcp';

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // oauth_clients is platform-global (non-RLS) — plain insert.
      await client.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
         VALUES ($1, 'RLS Test Client', '[]') ON CONFLICT (client_id) DO NOTHING`,
        [clientId],
      );

      // Seed the full graph as tenant A.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO mcp_tokens (id, tenant_id, account_id, token_hash, token_prefix, name, auth_kind, status, expires_at)
         VALUES ($1, $2, $3, NULL, NULL, 'RLS Test Client', 'oauth', 'active', NOW() + INTERVAL '1 day')`,
        [anchorId, tenantA, accountId],
      );
      await client.query(
        `INSERT INTO oauth_grants (id, tenant_id, client_id, account_id, mcp_token_id, resource)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [grantId, tenantA, clientId, accountId, anchorId, RESOURCE],
      );
      await client.query(
        `INSERT INTO oauth_authorization_codes (code_hash, grant_id, tenant_id, redirect_uri, code_challenge, resource)
         VALUES ($1, $2, $3, 'http://localhost:1/cb', 'c', $4)`,
        [codeHash, grantId, tenantA, RESOURCE],
      );
      await client.query(
        `INSERT INTO oauth_access_tokens (token_hash, grant_id, tenant_id, resource, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour')`,
        [accessHash, grantId, tenantA, RESOURCE],
      );
      await client.query(
        `INSERT INTO oauth_refresh_tokens (token_hash, grant_id, tenant_id, client_id, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '30 days')`,
        [refreshHash, grantId, tenantA, clientId, RESOURCE],
      );
      await client.query(
        `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title)
         VALUES ($1, $2, $3, 'mcp', 'rls test')`,
        [threadId, tenantA, accountId],
      );
      await client.query(
        `INSERT INTO mcp_chat_runs (id, tenant_id, anchor_token_id, thread_id, agent_id, user_message)
         VALUES ($1, $2, $3, $4, $5, 'hello')`,
        [runId, tenantA, anchorId, threadId, randomUUID()],
      );
      await client.query('COMMIT');

      // SELECT each row as tenant B — every table must come back empty.
      const denials: Array<[string, string, string]> = [
        ['oauth_grants', 'id', grantId],
        ['oauth_authorization_codes', 'code_hash', codeHash],
        ['oauth_access_tokens', 'token_hash', accessHash],
        ['oauth_refresh_tokens', 'token_hash', refreshHash],
        ['mcp_chat_runs', 'id', runId],
      ];
      for (const [table, pk, value] of denials) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
        const result = await client.query(`SELECT 1 FROM ${table} WHERE ${pk} = $1`, [value]);
        await client.query('ROLLBACK');
        expect({ table, rows: result.rows.length }).toEqual({ table, rows: 0 });
      }

      // Cross-tenant INSERT (tenant B writing a tenant-A grant) must violate
      // the WITH CHECK policy.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO oauth_grants (id, tenant_id, client_id, account_id, mcp_token_id, resource)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), tenantA, clientId, accountId, anchorId, RESOURCE],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      // Cleanup (audit BUG-3): agent_chat_threads has NO ON DELETE CASCADE
      // from tenants — delete the run + thread explicitly (under tenant A
      // context so RLS admits the deletes) BEFORE cleanupTenants, or the
      // tenant delete violates the thread FK.
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
        await client.query(`DELETE FROM mcp_chat_runs WHERE id = $1`, [runId]);
        await client.query(`DELETE FROM agent_chat_threads WHERE id = $1`, [threadId]);
        await client.query('COMMIT');
        await cleanupTenants(client, tenantA, tenantB, accountId);
        await client.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
      } finally {
        client.release();
      }
    }
  });
});

// ── Migration 293: cross-tenant denial for chat_share_links ────────────────

describeFn('Migration 293 verification — chat share links cross-tenant denial', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  it('denies cross-tenant access on chat_share_links', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const accountId = randomUUID();
    const agentId = randomUUID();
    const threadId = randomUUID();
    const shareId = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // Seed the FK graph + share row as tenant A.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'RLS Test Team')`,
        [agentId, tenantA],
      );
      await client.query(
        `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title)
         VALUES ($1, $2, $3, 'web', 'rls test')`,
        [threadId, tenantA, accountId],
      );
      await client.query(
        `INSERT INTO chat_share_links (id, tenant_id, agent_id, thread_id, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [shareId, tenantA, agentId, threadId, accountId],
      );
      await client.query('COMMIT');

      // SELECT as tenant B — must come back empty.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const denied = await client.query(`SELECT 1 FROM chat_share_links WHERE id = $1`, [shareId]);
      await client.query('ROLLBACK');
      expect(denied.rows.length).toBe(0);

      // Cross-tenant INSERT (tenant B writing a tenant-A share) must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO chat_share_links (tenant_id, agent_id, thread_id, created_by)
           VALUES ($1, $2, $3, $4)`,
          [tenantA, agentId, threadId, accountId],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      // Cleanup, mirroring the 291 block (its BUG-3 comment: agent_chat_threads
      // has NO ON DELETE CASCADE from tenants — delete the seeded rows
      // explicitly under tenant A context BEFORE cleanupTenants, or the tenant
      // delete violates the thread FK). The share row would also ride the
      // thread cascade, but explicit is clearer; internal_agents cascades with
      // the tenant delete (016_ai_teams.sql tenant_id FK is ON DELETE CASCADE).
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
        await client.query(`DELETE FROM chat_share_links WHERE id = $1`, [shareId]);
        await client.query(`DELETE FROM agent_chat_threads WHERE id = $1`, [threadId]);
        await client.query('COMMIT');
        await cleanupTenants(client, tenantA, tenantB, accountId);
      } finally {
        client.release();
      }
    }
  });
});

// ── Migration 314: cross-tenant denial for the workspace Slack app tables ───

describeFn('Migration 314 verification — workspace Slack app cross-tenant denial', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  it('denies cross-tenant access on slack_workspace_installs and slack_conversation_agents', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const accountId = randomUUID();
    const agentId = randomUUID();
    const installId = randomUUID();
    const bindingId = randomUUID();
    const teamId = `T${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // Seed an install + a binding as tenant A.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'RLS Test Team')`,
        [agentId, tenantA],
      );
      await client.query(
        `INSERT INTO slack_workspace_installs (id, tenant_id, slack_team_id, install_status)
         VALUES ($1, $2, $3, 'installed')`,
        [installId, tenantA, teamId],
      );
      await client.query(
        `INSERT INTO slack_conversation_agents (id, tenant_id, agent_id, slack_team_id, channel_id, scope)
         VALUES ($1, $2, $3, $4, 'C01ABCD2EFG', 'dm')`,
        [bindingId, tenantA, agentId, teamId],
      );
      await client.query('COMMIT');

      // SELECT as tenant B — both must come back empty.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      const deniedInstall = await client.query(
        `SELECT 1 FROM slack_workspace_installs WHERE id = $1`, [installId],
      );
      const deniedBinding = await client.query(
        `SELECT 1 FROM slack_conversation_agents WHERE id = $1`, [bindingId],
      );
      await client.query('ROLLBACK');
      expect(deniedInstall.rows.length).toBe(0);
      expect(deniedBinding.rows.length).toBe(0);

      // Cross-tenant INSERT (tenant B writing tenant-A rows) must violate WITH CHECK.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO slack_workspace_installs (tenant_id, slack_team_id)
           VALUES ($1, $2)`,
          [tenantA, `T${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO slack_conversation_agents (tenant_id, agent_id, slack_team_id, channel_id, scope)
           VALUES ($1, $2, $3, 'C01ABCD2EFG', 'dm')`,
          [tenantA, agentId, teamId],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      // Both new tables cascade with the tenant delete (tenant_id FK ON DELETE
      // CASCADE); internal_agents cascades too (016_ai_teams.sql). Explicit
      // deletes anyway, mirroring the 293 block's clarity preference.
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
        await client.query(`DELETE FROM slack_conversation_agents WHERE id = $1`, [bindingId]);
        await client.query(`DELETE FROM slack_workspace_installs WHERE id = $1`, [installId]);
        await client.query('COMMIT');
        await cleanupTenants(client, tenantA, tenantB, accountId);
      } finally {
        client.release();
      }
    }
  });
});

// ── Migration 348: cross-tenant denial for the Liftoff chat tables ─────────
//
// Liftoff is the general platform assistant behind the dashboard composer. It
// holds no internal_agents row, so its conversations live in their own tables
// rather than on the agent-chat ones, and each of the four tenant-scoped
// tables gets a literal denial check seeded through the real FK graph.
//
// The signals table is the one worth reading closely: it has no tenant_id of
// its own and resolves tenancy through the lock that owns the turn, so its
// policy is a subquery. A denial there proves the subquery, not just that
// somebody typed ENABLE ROW LEVEL SECURITY.

describeFn('Migration 348 verification: Liftoff chat cross-tenant denial', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  it('leaves liftoff_chat_messages WITHOUT RLS, which is how it inherits tenancy', async () => {
    // Deliberate, and the same shape as insights_chat_messages: no tenant_id
    // column, so tenancy comes from the parent thread, which the repository
    // resolves and permission-checks before any message read or write. Asserted
    // so that adding a tenant_id later without a policy fails here rather than
    // silently shipping an unprotected table.
    const result = await pool.query<{ rls_enabled: boolean; tenant_id_columns: number }>(`
      SELECT c.relrowsecurity AS rls_enabled,
             (SELECT COUNT(*) FROM information_schema.columns col
               WHERE col.table_schema = 'public'
                 AND col.table_name = 'liftoff_chat_messages'
                 AND col.column_name = 'tenant_id')::int AS tenant_id_columns
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'liftoff_chat_messages'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rls_enabled).toBe(false);
    expect(result.rows[0].tenant_id_columns).toBe(0);
  });

  it('denies cross-tenant access on all four tenant-scoped tables', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const accountId = randomUUID();
    const threadId = randomUUID();
    const messageId = randomUUID();
    const rateLimitId = randomUUID();
    const turnId = randomUUID();
    const signalId = randomUUID();

    const client = await pool.connect();
    try {
      await seedTenants(client, tenantA, tenantB, accountId);

      // Seed a thread, a message on it, a rate-limit event, a live turn lock
      // and a signal addressed to that turn: all as tenant A.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
      await client.query(
        `INSERT INTO liftoff_chat_threads (id, tenant_id, account_id, title)
         VALUES ($1, $2, $3, 'rls test')`,
        [threadId, tenantA, accountId],
      );
      // Messages are not RLS (no tenant_id); seeded so the thread carries one
      // and the cascade below is exercised.
      await client.query(
        `INSERT INTO liftoff_chat_messages (id, thread_id, role, content)
         VALUES ($1, $2, 'user', 'hello')`,
        [messageId, threadId],
      );
      await client.query(
        `INSERT INTO liftoff_rate_limit_events (id, tenant_id, account_id)
         VALUES ($1, $2, $3)`,
        [rateLimitId, tenantA, accountId],
      );
      await client.query(
        `INSERT INTO liftoff_turn_locks (tenant_id, thread_id, turn_id)
         VALUES ($1, $2, $3)`,
        [tenantA, threadId, turnId],
      );
      await client.query(
        `INSERT INTO liftoff_turn_signals (id, turn_id, signal_kind, payload)
         VALUES ($1, $2, 'user_message', '{"text":"still there?"}'::jsonb)`,
        [signalId, turnId],
      );
      await client.query('COMMIT');

      // SELECT each row as tenant B: every table must come back empty.
      const denials: Array<[string, string, string]> = [
        ['liftoff_chat_threads', 'id', threadId],
        ['liftoff_rate_limit_events', 'id', rateLimitId],
        ['liftoff_turn_locks', 'thread_id', threadId],
        ['liftoff_turn_signals', 'id', signalId],
      ];
      for (const [table, pk, value] of denials) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
        const result = await client.query(`SELECT 1 FROM ${table} WHERE ${pk} = $1`, [value]);
        await client.query('ROLLBACK');
        expect({ table, rows: result.rows.length }).toEqual({ table, rows: 0 });
      }

      // Cross-tenant INSERTs (tenant B writing tenant-A rows) must violate the
      // WITH CHECK policies.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO liftoff_chat_threads (tenant_id, account_id, title)
           VALUES ($1, $2, 'sneaky')`,
          [tenantA, accountId],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO liftoff_rate_limit_events (tenant_id, account_id)
           VALUES ($1, $2)`,
          [tenantA, accountId],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO liftoff_turn_locks (tenant_id, thread_id, turn_id)
           VALUES ($1, $2, $3)`,
          [tenantA, threadId, randomUUID()],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      // The subquery policy: tenant B may not address a signal to a turn it
      // cannot see, which is what stops a foreign caller injecting a message
      // or a stop into somebody else's live turn.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO liftoff_turn_signals (turn_id, signal_kind, payload)
           VALUES ($1, 'abort', '{}'::jsonb)`,
          [turnId],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      // The lock's tenant_id FK to tenants has no ON DELETE CASCADE, so the
      // tenant delete in cleanupTenants would violate it; the threads and
      // rate-limit tables have no FK to tenants at all, so their rows would
      // simply be left behind. Delete everything explicitly under tenant A
      // context (the tables are FORCE-RLS, so even the owner needs it). The
      // signal rides the lock's cascade and the message rides the thread's,
      // but both are named for the same clarity preference as the 293 block.
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
        await client.query(`DELETE FROM liftoff_turn_signals WHERE id = $1`, [signalId]);
        await client.query(`DELETE FROM liftoff_turn_locks WHERE thread_id = $1`, [threadId]);
        await client.query(`DELETE FROM liftoff_rate_limit_events WHERE id = $1`, [rateLimitId]);
        await client.query(`DELETE FROM liftoff_chat_messages WHERE id = $1`, [messageId]);
        await client.query(`DELETE FROM liftoff_chat_threads WHERE id = $1`, [threadId]);
        await client.query('COMMIT');
        await cleanupTenants(client, tenantA, tenantB, accountId);
      } finally {
        client.release();
      }
    }
  });
});


// ── Migration 415: cross-tenant denial for the referral programme ───────────
//
// The census above proves RLS is ON and a policy exists. This proves the policy
// says the right thing, which for `referrals` is not the obvious thing: it is
// keyed on referrer_tenant_id, so the workspace that must NOT see the row is
// the one that was REFERRED — and a policy accidentally written on
// referred_tenant_id would pass every "is RLS enabled" check while inverting
// who the row belongs to.

describeFn('Migration 415 verification — referral programme cross-tenant denial', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('denies cross-tenant access on all three tables', async () => {
    const referrerTenant = randomUUID();
    const referredTenant = randomUUID();
    const accountId = randomUUID();
    const referralId = randomUUID();
    const inviteId = randomUUID();
    const code = `rls-test-${referrerTenant.slice(0, 8)}`;

    const client = await pool.connect();
    try {
      await seedTenants(client, referrerTenant, referredTenant, accountId);

      // Seed as the referrer, which is who every one of these rows belongs to.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [referrerTenant]);
      await client.query(
        `INSERT INTO referral_codes (tenant_id, code) VALUES ($1, $2)`,
        [referrerTenant, code],
      );
      await client.query(
        `INSERT INTO referrals (id, referrer_tenant_id, referred_tenant_id, referred_account_id, code)
         VALUES ($1, $2, $3, $4, $5)`,
        [referralId, referrerTenant, referredTenant, accountId, code],
      );
      await client.query(
        `INSERT INTO referral_invites (id, tenant_id, email)
         VALUES ($1, $2, $3)`,
        [inviteId, referrerTenant, `rls-test-${referrerTenant.slice(0, 8)}@test.invalid`],
      );
      await client.query('COMMIT');

      // The referrer sees its own rows.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [referrerTenant]);
      const own = await client.query(`SELECT id FROM referrals WHERE id = $1`, [referralId]);
      expect(own.rows).toHaveLength(1);
      await client.query('COMMIT');

      // The REFERRED workspace does not — even though its own id is on the row.
      // This is the assertion the policy's choice of column actually decides.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [referredTenant]);
      const foreignReferral = await client.query(
        `SELECT id FROM referrals WHERE id = $1`, [referralId],
      );
      expect(foreignReferral.rows).toHaveLength(0);
      const foreignCode = await client.query(
        `SELECT code FROM referral_codes WHERE tenant_id = $1`, [referrerTenant],
      );
      expect(foreignCode.rows).toHaveLength(0);
      const foreignInvite = await client.query(
        `SELECT id FROM referral_invites WHERE id = $1`, [inviteId],
      );
      expect(foreignInvite.rows).toHaveLength(0);
      await client.query('COMMIT');

      // Nor may it write a row that would claim the referrer's workspace.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [referredTenant]);
      await expect(
        client.query(
          `INSERT INTO referrals (referrer_tenant_id, referred_account_id, code)
           VALUES ($1, $2, $3)`,
          [referrerTenant, accountId, code],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [referredTenant]);
      await expect(
        client.query(
          `INSERT INTO referral_invites (tenant_id, email) VALUES ($1, $2)`,
          [referrerTenant, 'spoof@test.invalid'],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [referredTenant]);
      await expect(
        client.query(
          `INSERT INTO referral_codes (tenant_id, code) VALUES ($1, $2)`,
          [referrerTenant, `${code}-spoof`],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      // All three tables are FORCE-RLS, so even the owner needs a context to
      // clear them, and referrals.referrer_tenant_id has ON DELETE CASCADE but
      // cleanupTenants runs without one.
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [referrerTenant]);
        await client.query(`DELETE FROM referral_invites WHERE id = $1`, [inviteId]);
        await client.query(`DELETE FROM referrals WHERE id = $1`, [referralId]);
        await client.query(`DELETE FROM referral_codes WHERE tenant_id = $1`, [referrerTenant]);
        await client.query('COMMIT');
        await cleanupTenants(client, referrerTenant, referredTenant, accountId);
      } finally {
        client.release();
      }
    }
  });
});
