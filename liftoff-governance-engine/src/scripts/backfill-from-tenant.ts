// Backfill governance-pg from a tenant-runtime DB.
//
// Phase 3 ported the governance engine code + provisioned governance-pg,
// but the pre-existing action / usage / audit / burn-state rows in every
// tenant-runtime DB were never copied over. The tables are empty and the
// engine is flying blind — cached_entitlements has no rows so admission
// checks fail fail-closed, burn_state has no row so credit accounting is
// stuck at 0, and every historical audit record is invisible.
//
// This script reads one tenant's DB (SOURCE_DB_HOST) and upserts the
// rows into governance-pg with the new schema. Run it once per tenant
// DB (shared-tenancy only has one today: YOUR_TENANT_PROJECT).
//
// Schema deltas (source → target):
//
//   burn_state:
//     used_credits(int)        → credits_used(numeric)
//     remaining_credits(int)   → credits_remaining(numeric)
//     billing_period_start     → period_start(date, truncated)
//     last_updated             → updated_at
//     DROP: included_credits, overage_credits, billing_period_end
//
//   cached_entitlements:
//     tenant_id(uuid→text), entity_version, operational_status pass through
//     everything else is bundled into entitlements_json
//
//   usage_events:
//     tenant_id(uuid→text), event_type, created_at pass through
//     credits(int) → units(numeric)
//     cost_usd = 0 (historical; not retroactively billed)
//     DROP: action_id, workflow_id, agent_id, metadata (schema loss)
//
//   audit_logs:
//     tenant_id(uuid→text), action pass through
//     triggered_by → actor
//     internal_agent_id or invocation_id → target
//     input_args + output_summary + error_code + outcome → metadata jsonb
//
//   actions:
//     tenant_id, agent_id → text
//     connector+entity_type+action_type → tool_name (dotted composite)
//     status, idempotency_key, created_at pass through
//     external_response → result
//     cost_usd defaults to 0
//     DROP: workflow_id, task_id, target_ref, pre_action_snapshot, error,
//           completed_at, trace_id, undo_support_mode, instruction_version,
//           conflict_resolution_mode, payload, audit_log_id, is_external_write
//
// Env vars:
//   ENVIRONMENT, DB_HOST/DB_NAME/DB_USER/DB_PASSWORD (governance-pg),
//   SOURCE_DB_HOST/SOURCE_DB_NAME/SOURCE_DB_USER/SOURCE_DB_PASSWORD,
//   DRY_RUN (default true), BATCH_SIZE (default 500)

import { Pool } from 'pg';

interface BurnStateRow {
  tenant_id: string;
  included_credits: number;
  used_credits: number;
  remaining_credits: number;
  overage_credits: number;
  billing_period_start: Date;
  billing_period_end: Date;
  last_updated: Date;
}

interface CachedEntitlementsRow {
  tenant_id: string;
  entity_version: number;
  operational_status: string;
  agent_execution_allowed: boolean;
  remaining_credits: number;
  included_monthly_credits: number;
  overage_allowed: boolean;
  overage_ceiling: number;
  updated_at: Date;
}

interface UsageEventRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  workflow_id: string | null;
  action_id: string | null;
  event_type: string;
  credits: number;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface AuditLogRow {
  id: string;
  tenant_id: string;
  internal_agent_id: string | null;
  external_agent_id: string | null;
  user_id: string | null;
  thread_id: string | null;
  invocation_id: string | null;
  action: string;
  input_args: Record<string, unknown> | null;
  output_summary: string | null;
  outcome: string | null;
  error_code: string | null;
  triggered_by: string | null;
  duration_ms: number | null;
  created_at: Date;
}

interface ActionRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  workflow_id: string | null;
  task_id: string | null;
  idempotency_key: string;
  connector: string;
  entity_type: string;
  action_type: string;
  target_ref: string | null;
  pre_action_snapshot: Record<string, unknown> | null;
  external_response: Record<string, unknown> | null;
  status: string;
  error: string | null;
  completed_at: Date | null;
  created_at: Date;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const env = process.env.ENVIRONMENT ?? 'dev';
  const batchSize = parseInt(process.env.BATCH_SIZE ?? '500', 10);
  console.log(`[gov-backfill] env=${env} dryRun=${dryRun} batchSize=${batchSize}`);

  // Supports two connection modes per side:
  //   - Unix socket (set {SIDE}_DB_SOCKET to the Cloud Run --add-cloudsql-
  //     instances socket path, e.g. /cloudsql/YOUR_PROJECT:YOUR_REGION:YOUR_INSTANCE)
  //   - TCP private IP (set {SIDE}_DB_HOST)
  // Unix socket is required when the source + destination DBs live in
  // different GCP projects / VPCs and no VPC peering exists — the Cloud SQL
  // Auth Proxy sidecar built into Cloud Run mounts the socket in /cloudsql/.
  const sourceConn = process.env.SOURCE_DB_SOCKET
    ? { host: process.env.SOURCE_DB_SOCKET }
    : { host: process.env.SOURCE_DB_HOST };
  const destConn = process.env.DB_SOCKET
    ? { host: process.env.DB_SOCKET }
    : { host: process.env.DB_HOST };

  const source = new Pool({
    ...sourceConn,
    database: process.env.SOURCE_DB_NAME ?? 'tenant_runtime',
    user: process.env.SOURCE_DB_USER ?? 'tenant_app',
    password: process.env.SOURCE_DB_PASSWORD,
  });
  const dest = new Pool({
    ...destConn,
    database: process.env.DB_NAME ?? 'governance_engine',
    user: process.env.DB_USER ?? 'governance_app',
    password: process.env.DB_PASSWORD,
  });

  const counts = {
    burn_state: { inserted: 0, skipped: 0 },
    cached_entitlements: { inserted: 0, skipped: 0 },
    usage_events: { inserted: 0, skipped: 0 },
    audit_logs: { inserted: 0, skipped: 0 },
    actions: { inserted: 0, skipped: 0 },
  };

  try {
    // ── burn_state ────────────────────────────────────────────────────────
    const bs = await source.query<BurnStateRow>(
      `SELECT tenant_id::text AS tenant_id, included_credits, used_credits,
              remaining_credits, overage_credits, billing_period_start,
              billing_period_end, last_updated FROM burn_state`,
    );
    console.log(`[gov-backfill] burn_state: ${bs.rows.length} rows`);
    for (const r of bs.rows) {
      if (dryRun) {
        console.log(`[gov-backfill] DRY_RUN: burn_state tenant=${r.tenant_id} used=${r.used_credits} remaining=${r.remaining_credits}`);
        continue;
      }
      const res = await dest.query(
        `INSERT INTO burn_state (tenant_id, period_start, credits_used, credits_remaining, updated_at)
         VALUES ($1, $2::date, $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           period_start = EXCLUDED.period_start,
           credits_used = EXCLUDED.credits_used,
           credits_remaining = EXCLUDED.credits_remaining,
           updated_at = EXCLUDED.updated_at`,
        [r.tenant_id, r.billing_period_start, r.used_credits, r.remaining_credits, r.last_updated],
      );
      if ((res.rowCount ?? 0) > 0) counts.burn_state.inserted++;
      else counts.burn_state.skipped++;
    }

    // ── cached_entitlements ──────────────────────────────────────────────
    const ce = await source.query<CachedEntitlementsRow>(
      `SELECT tenant_id::text AS tenant_id, entity_version, operational_status,
              agent_execution_allowed, remaining_credits, included_monthly_credits,
              overage_allowed, overage_ceiling, updated_at FROM cached_entitlements`,
    );
    console.log(`[gov-backfill] cached_entitlements: ${ce.rows.length} rows`);
    for (const r of ce.rows) {
      const entitlementsJson = {
        agent_execution_allowed: r.agent_execution_allowed,
        remaining_credits: r.remaining_credits,
        included_monthly_credits: r.included_monthly_credits,
        overage_allowed: r.overage_allowed,
        overage_ceiling: r.overage_ceiling,
      };
      if (dryRun) {
        console.log(`[gov-backfill] DRY_RUN: cached_entitlements tenant=${r.tenant_id} v=${r.entity_version}`);
        continue;
      }
      const res = await dest.query(
        `INSERT INTO cached_entitlements (tenant_id, entity_version, operational_status,
                                          entitlements_json, cached_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           entity_version = EXCLUDED.entity_version,
           operational_status = EXCLUDED.operational_status,
           entitlements_json = EXCLUDED.entitlements_json,
           updated_at = EXCLUDED.updated_at`,
        [r.tenant_id, r.entity_version, r.operational_status, JSON.stringify(entitlementsJson), r.updated_at],
      );
      if ((res.rowCount ?? 0) > 0) counts.cached_entitlements.inserted++;
      else counts.cached_entitlements.skipped++;
    }

    // ── usage_events (paginated; 2k+ rows) ───────────────────────────────
    let lastUeCreatedAt: Date | null = null;
    let lastUeId: string | null = null;
    for (;;) {
      const ue: { rows: UsageEventRow[] } = lastUeCreatedAt
        ? await source.query<UsageEventRow>(
            `SELECT id, tenant_id::text AS tenant_id, agent_id::text AS agent_id,
                    workflow_id::text AS workflow_id, action_id::text AS action_id,
                    event_type, credits, metadata, created_at
               FROM usage_events
              WHERE (created_at, id) > ($1, $2)
              ORDER BY created_at, id
              LIMIT $3`,
            [lastUeCreatedAt, lastUeId, batchSize],
          )
        : await source.query<UsageEventRow>(
            `SELECT id, tenant_id::text AS tenant_id, agent_id::text AS agent_id,
                    workflow_id::text AS workflow_id, action_id::text AS action_id,
                    event_type, credits, metadata, created_at
               FROM usage_events ORDER BY created_at, id LIMIT $1`,
            [batchSize],
          );
      if (ue.rows.length === 0) break;
      for (const r of ue.rows) {
        if (dryRun) { counts.usage_events.inserted++; continue; }
        const res = await dest.query(
          `INSERT INTO usage_events (id, tenant_id, event_type, units, cost_usd, created_at)
           VALUES ($1, $2, $3, $4, 0, $5)
           ON CONFLICT DO NOTHING`,
          [r.id, r.tenant_id, r.event_type, r.credits, r.created_at],
        );
        if ((res.rowCount ?? 0) > 0) counts.usage_events.inserted++;
        else counts.usage_events.skipped++;
      }
      const last = ue.rows[ue.rows.length - 1];
      lastUeCreatedAt = last.created_at;
      lastUeId = last.id;
      console.log(`[gov-backfill] usage_events batch done: processed=${counts.usage_events.inserted + counts.usage_events.skipped}`);
      if (ue.rows.length < batchSize) break;
    }

    // ── audit_logs (paginated) ───────────────────────────────────────────
    let lastAlCreatedAt: Date | null = null;
    let lastAlId: string | null = null;
    for (;;) {
      const al: { rows: AuditLogRow[] } = lastAlCreatedAt
        ? await source.query<AuditLogRow>(
            `SELECT id, tenant_id::text AS tenant_id,
                    internal_agent_id::text AS internal_agent_id,
                    external_agent_id::text AS external_agent_id,
                    user_id::text AS user_id, thread_id::text AS thread_id,
                    invocation_id::text AS invocation_id,
                    action, input_args, output_summary, outcome, error_code,
                    triggered_by, duration_ms, created_at
               FROM audit_logs
              WHERE (created_at, id) > ($1, $2)
              ORDER BY created_at, id
              LIMIT $3`,
            [lastAlCreatedAt, lastAlId, batchSize],
          )
        : await source.query<AuditLogRow>(
            `SELECT id, tenant_id::text AS tenant_id,
                    internal_agent_id::text AS internal_agent_id,
                    external_agent_id::text AS external_agent_id,
                    user_id::text AS user_id, thread_id::text AS thread_id,
                    invocation_id::text AS invocation_id,
                    action, input_args, output_summary, outcome, error_code,
                    triggered_by, duration_ms, created_at
               FROM audit_logs ORDER BY created_at, id LIMIT $1`,
            [batchSize],
          );
      if (al.rows.length === 0) break;
      for (const r of al.rows) {
        const metadata = {
          input_args: r.input_args,
          output_summary: r.output_summary,
          outcome: r.outcome,
          error_code: r.error_code,
          duration_ms: r.duration_ms,
          external_agent_id: r.external_agent_id,
          user_id: r.user_id,
          thread_id: r.thread_id,
          invocation_id: r.invocation_id,
        };
        const target = r.invocation_id ?? r.internal_agent_id ?? r.external_agent_id ?? '';
        const actor = r.triggered_by ?? r.user_id ?? 'system';
        if (dryRun) { counts.audit_logs.inserted++; continue; }
        const res = await dest.query(
          `INSERT INTO audit_logs (id, tenant_id, actor, action, target, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT DO NOTHING`,
          [r.id, r.tenant_id, actor, r.action, target, JSON.stringify(metadata), r.created_at],
        );
        if ((res.rowCount ?? 0) > 0) counts.audit_logs.inserted++;
        else counts.audit_logs.skipped++;
      }
      const last = al.rows[al.rows.length - 1];
      lastAlCreatedAt = last.created_at;
      lastAlId = last.id;
      console.log(`[gov-backfill] audit_logs batch done: processed=${counts.audit_logs.inserted + counts.audit_logs.skipped}`);
      if (al.rows.length < batchSize) break;
    }

    // ── actions (paginated; partitioned table) ───────────────────────────
    let lastAcCreatedAt: Date | null = null;
    let lastAcId: string | null = null;
    for (;;) {
      const ac: { rows: ActionRow[] } = lastAcCreatedAt
        ? await source.query<ActionRow>(
            `SELECT id, tenant_id::text AS tenant_id, agent_id::text AS agent_id,
                    idempotency_key, connector, entity_type, action_type,
                    external_response, status, created_at
               FROM actions
              WHERE (created_at, id) > ($1, $2)
              ORDER BY created_at, id
              LIMIT $3`,
            [lastAcCreatedAt, lastAcId, batchSize],
          )
        : await source.query<ActionRow>(
            `SELECT id, tenant_id::text AS tenant_id, agent_id::text AS agent_id,
                    idempotency_key, connector, entity_type, action_type,
                    external_response, status, created_at
               FROM actions ORDER BY created_at, id LIMIT $1`,
            [batchSize],
          );
      if (ac.rows.length === 0) break;
      for (const r of ac.rows) {
        const toolName = [r.connector, r.entity_type, r.action_type].filter(Boolean).join('.');
        if (dryRun) { counts.actions.inserted++; continue; }
        const res = await dest.query(
          `INSERT INTO actions (id, tenant_id, agent_id, tool_name, idempotency_key,
                                status, result, cost_usd, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 0, $8)
           ON CONFLICT DO NOTHING`,
          [r.id, r.tenant_id, r.agent_id ?? '', toolName, r.idempotency_key, r.status,
           JSON.stringify(r.external_response ?? {}), r.created_at],
        );
        if ((res.rowCount ?? 0) > 0) counts.actions.inserted++;
        else counts.actions.skipped++;
      }
      const last = ac.rows[ac.rows.length - 1];
      lastAcCreatedAt = last.created_at;
      lastAcId = last.id;
      console.log(`[gov-backfill] actions batch done: processed=${counts.actions.inserted + counts.actions.skipped}`);
      if (ac.rows.length < batchSize) break;
    }

    console.log(`[gov-backfill] SUMMARY dryRun=${dryRun}`);
    for (const [table, c] of Object.entries(counts)) {
      console.log(`  ${table}: inserted=${c.inserted} skipped=${c.skipped}`);
    }
  } finally {
    await source.end();
    await dest.end();
  }
}

main().catch((err) => {
  console.error('[gov-backfill] FATAL', err);
  process.exit(1);
});
