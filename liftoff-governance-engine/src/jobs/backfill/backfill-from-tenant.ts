#!/usr/bin/env node
/**
 * backfill-from-tenant.ts — Phase 3d data migration tool.
 *
 * Copies governance rows from a single tenant's Cloud SQL instance into the
 * centralized governance-pg. Idempotent (ON CONFLICT ... DO UPDATE) so it can
 * be re-run without creating duplicates.
 *
 * Usage (CLI):
 *   ts-node scripts/backfill/backfill-from-tenant.ts \
 *     --tenant-id liftoffos \
 *     --tenant-db-host 10.x.y.z \
 *     --tenant-db-password-secret projects/.../secrets/tenant-pg-password/versions/latest \
 *     --governance-db-host 10.a.b.c \
 *     --governance-db-password-secret projects/.../secrets/governance-pg-password/versions/latest \
 *     [--batch-size 500] \
 *     [--tables actions,hitl_approval_requests,usage_events,audit_logs,action_allowlists,burn_state,kill_switches] \
 *     [--dry-run]
 *
 * Can also be invoked with env vars (Cloud Run Job friendly):
 *   BACKFILL_TENANT_ID, BACKFILL_TENANT_DB_HOST, BACKFILL_TENANT_DB_PASSWORD_SECRET,
 *   BACKFILL_GOVERNANCE_DB_HOST, BACKFILL_GOVERNANCE_DB_PASSWORD_SECRET,
 *   BACKFILL_BATCH_SIZE, BACKFILL_TABLES, BACKFILL_DRY_RUN
 *
 * Schema drift note: the tenant DB carries ~15 extra columns per table beyond
 * governance-pg migration 001 — these are projected down. For fidelity we keep
 * the source JSON blob under a `source_row` key on governance-pg columns that
 * use JSONB payloads (result / metadata / pattern / action_payload) so nothing
 * is silently lost.
 */

import { Pool, PoolClient } from 'pg';

const ALL_TABLES = [
  'actions',
  'hitl_approval_requests',
  'usage_events',
  'audit_logs',
  'action_allowlists',
  'burn_state',
  'kill_switches',
] as const;

type TableName = (typeof ALL_TABLES)[number];

export interface BackfillOptions {
  tenantId: string;
  tenantDbHost: string;
  tenantDbPort?: number;
  tenantDbName?: string;
  tenantDbUser?: string;
  tenantDbPassword: string;
  governanceDbHost: string;
  governanceDbPort?: number;
  governanceDbName?: string;
  governanceDbUser?: string;
  governanceDbPassword: string;
  batchSize: number;
  tables: TableName[];
  dryRun: boolean;
  logger?: (msg: string) => void;
}

export interface TableResult {
  table: TableName;
  readCount: number;
  writeCount: number;
  skipped: number;
  errors: number;
}

export interface BackfillSummary {
  tenantId: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tables: TableResult[];
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function parseCliArgs(argv: string[]): Partial<Record<string, string | boolean>> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function resolveSecret(secretRef: string): Promise<string> {
  // If the value doesn't look like a Secret Manager resource path, treat it
  // as a literal password (useful for local testing).
  if (!secretRef.startsWith('projects/')) return secretRef;

  // Lazy-load to avoid requiring the dep in tests that pass raw passwords.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: secretRef });
  const payload = version.payload?.data?.toString('utf8');
  if (!payload) throw new Error(`Secret ${secretRef} returned empty payload`);
  return payload;
}

async function buildOptionsFromEnvAndArgs(argv: string[]): Promise<BackfillOptions> {
  const cli = parseCliArgs(argv);
  const pick = (cliKey: string, envKey: string): string | undefined => {
    const v = cli[cliKey];
    if (typeof v === 'string' && v.length > 0) return v;
    return process.env[envKey];
  };
  const pickFlag = (cliKey: string, envKey: string): boolean => {
    if (cli[cliKey] === true) return true;
    const env = process.env[envKey];
    return env === '1' || env === 'true';
  };

  const tenantId = pick('tenant-id', 'BACKFILL_TENANT_ID');
  const tenantDbHost = pick('tenant-db-host', 'BACKFILL_TENANT_DB_HOST');
  const tenantSecret = pick('tenant-db-password-secret', 'BACKFILL_TENANT_DB_PASSWORD_SECRET');
  const governanceDbHost = pick('governance-db-host', 'BACKFILL_GOVERNANCE_DB_HOST');
  const governanceSecret = pick(
    'governance-db-password-secret',
    'BACKFILL_GOVERNANCE_DB_PASSWORD_SECRET',
  );

  for (const [k, v] of Object.entries({
    tenantId,
    tenantDbHost,
    tenantSecret,
    governanceDbHost,
    governanceSecret,
  })) {
    if (!v) throw new Error(`backfill: missing required argument ${k}`);
  }

  const tablesRaw = pick('tables', 'BACKFILL_TABLES') ?? ALL_TABLES.join(',');
  const rawTables = tablesRaw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  for (const t of rawTables) {
    if (!(ALL_TABLES as readonly string[]).includes(t)) {
      throw new Error(`backfill: unknown table "${t}"`);
    }
  }
  const tables = rawTables as TableName[];

  const batchSize = Number(pick('batch-size', 'BACKFILL_BATCH_SIZE') ?? '500');
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error(`backfill: invalid batch-size "${batchSize}"`);
  }

  return {
    tenantId: tenantId!,
    tenantDbHost: tenantDbHost!,
    tenantDbPort: Number(pick('tenant-db-port', 'BACKFILL_TENANT_DB_PORT') ?? '5432'),
    tenantDbName: pick('tenant-db-name', 'BACKFILL_TENANT_DB_NAME') ?? 'tenant_runtime',
    tenantDbUser: pick('tenant-db-user', 'BACKFILL_TENANT_DB_USER') ?? 'tenant_app',
    tenantDbPassword: await resolveSecret(tenantSecret!),
    governanceDbHost: governanceDbHost!,
    governanceDbPort: Number(pick('governance-db-port', 'BACKFILL_GOVERNANCE_DB_PORT') ?? '5432'),
    governanceDbName: pick('governance-db-name', 'BACKFILL_GOVERNANCE_DB_NAME') ?? 'governance_engine',
    governanceDbUser: pick('governance-db-user', 'BACKFILL_GOVERNANCE_DB_USER') ?? 'governance_admin',
    governanceDbPassword: await resolveSecret(governanceSecret!),
    batchSize,
    tables,
    dryRun: pickFlag('dry-run', 'BACKFILL_DRY_RUN'),
  };
}

// ─── Table mappers ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Mapper = (row: Row, tenantId: string) => { values: unknown[]; sql: string };

// Build an idempotent UPSERT. `cols[0]` is the conflict key by convention,
// unless `conflictCols` is provided (e.g. composite PK on kill_switches).
function upsert(
  table: string,
  cols: string[],
  jsonbIdx: number[] = [],
  conflictCols?: string[],
): string {
  const placeholders = cols.map((_, i) => {
    const n = `$${i + 1}`;
    return jsonbIdx.includes(i) ? `${n}::jsonb` : n;
  }).join(', ');
  const keys = conflictCols ?? [cols[0]];
  const updates = cols
    .filter(c => !keys.includes(c))
    .map(c => `${c} = EXCLUDED.${c}`)
    .join(', ');
  return `
    INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${updates}
  `;
}

// Pack source-only columns under a nested key so schema drift doesn't lose data.
function pack(extra: Row): string {
  return JSON.stringify({ source_row: extra });
}

const MAPPERS: Record<TableName, Mapper> = {
  // Dest cols: id, tenant_id, agent_id, tool_name, idempotency_key, status,
  // result (JSONB), cost_usd, created_at. Extra source cols are nested into
  // result.source_row for lossless replay.
  actions: (row, tenantId) => ({
    sql: upsert(
      'actions',
      ['id', 'tenant_id', 'agent_id', 'tool_name', 'idempotency_key', 'status',
       'result', 'cost_usd', 'created_at'],
      [6],
    ),
    values: [
      row.id, tenantId, row.agent_id,
      row.connector && row.action_type ? `${row.connector}:${row.action_type}`
        : (row.action_type as string | null) ?? null,
      row.idempotency_key, row.status ?? 'pending',
      pack({
        workflow_id: row.workflow_id, task_id: row.task_id,
        connector: row.connector, entity_type: row.entity_type,
        action_type: row.action_type, target_ref: row.target_ref,
        pre_action_snapshot: row.pre_action_snapshot,
        external_response: row.external_response, error: row.error,
        completed_at: row.completed_at, trace_id: row.trace_id,
        instruction_version: row.instruction_version,
        undo_support_mode: row.undo_support_mode,
        conflict_resolution_mode: row.conflict_resolution_mode,
        payload: row.payload, is_external_write: row.is_external_write,
        audit_log_id: row.audit_log_id,
      }),
      0, row.created_at,
    ],
  }),

  // Dest: id, tenant_id, agent_id, action_payload (JSONB), status,
  // requested_at, resolved_at
  hitl_approval_requests: (row, tenantId) => ({
    sql: upsert(
      'hitl_approval_requests',
      ['id', 'tenant_id', 'agent_id', 'action_payload', 'status',
       'requested_at', 'resolved_at'],
      [3],
    ),
    values: [
      row.id, tenantId, row.agent_id,
      pack({
        pending_tool_calls: row.pending_tool_calls,
        tool_calls_hash: row.tool_calls_hash, reason: row.reason,
        hitl_level: row.hitl_level, decided_by: row.decided_by,
        decided_by_role: row.decided_by_role, decision: row.decision,
        rejection_reason: row.rejection_reason,
        idempotency_key: row.idempotency_key, expires_at: row.expires_at,
        workflow_id: row.workflow_id, task_id: row.task_id,
        updated_at: row.updated_at,
      }),
      row.status, row.created_at ?? row.requested_at, row.decided_at ?? null,
    ],
  }),

  // Dest: id, tenant_id, event_type, units, cost_usd, created_at. Credits
  // copied to units; cost_usd stays 0 until credit→USD rate lands.
  usage_events: (row, tenantId) => ({
    sql: upsert(
      'usage_events',
      ['id', 'tenant_id', 'event_type', 'units', 'cost_usd', 'created_at'],
    ),
    values: [row.id, tenantId, row.event_type, Number(row.credits ?? 0), 0, row.created_at],
  }),

  // Dest PK is tenant_id. Billing_period_end / included / overage not yet in dest.
  burn_state: (row, tenantId) => ({
    sql: upsert(
      'burn_state',
      ['tenant_id', 'period_start', 'credits_used', 'credits_remaining', 'updated_at'],
    ),
    values: [
      tenantId, row.billing_period_start,
      Number(row.used_credits ?? 0), Number(row.remaining_credits ?? 0),
      row.last_updated ?? new Date(),
    ],
  }),

  // Dest: id, tenant_id, actor, action, target, metadata (JSONB), created_at.
  audit_logs: (row, tenantId) => ({
    sql: upsert(
      'audit_logs',
      ['id', 'tenant_id', 'actor', 'action', 'target', 'metadata', 'created_at'],
      [5],
    ),
    values: [
      row.id, tenantId,
      (row.triggered_by as string | null)
        ?? (row.user_id ? `human:${row.user_id}` : null)
        ?? (row.ai_team_id ? `agent:${row.ai_team_id}` : null),
      row.action,
      (row.invocation_id as string | null) ?? (row.thread_id as string | null) ?? null,
      pack({
        ai_team_id: row.ai_team_id, user_id: row.user_id,
        thread_id: row.thread_id, invocation_id: row.invocation_id,
        external_agent_id: row.external_agent_id, input_args: row.input_args,
        output_summary: row.output_summary, outcome: row.outcome,
        error_code: row.error_code, triggered_by: row.triggered_by,
        duration_ms: row.duration_ms,
      }),
      row.created_at,
    ],
  }),

  // Dest: id, tenant_id, connector_type, entity_type, action_type, pattern
  // (JSONB), created_at. entity_types JSONB array flattens to single string.
  action_allowlists: (row, tenantId) => {
    const entityTypes = row.entity_types as unknown;
    let entityType = '*';
    if (Array.isArray(entityTypes) && entityTypes.length > 0) entityType = String(entityTypes[0]);
    else if (typeof entityTypes === 'string' && entityTypes.length > 0) entityType = entityTypes;
    return {
      sql: upsert(
        'action_allowlists',
        ['id', 'tenant_id', 'connector_type', 'entity_type', 'action_type',
         'pattern', 'created_at'],
        [5],
      ),
      values: [
        row.id, tenantId, row.connector, entityType, row.action_type,
        pack({
          agent_id: row.agent_id, instruction_version: row.instruction_version,
          entity_types: row.entity_types, field_restrictions: row.field_restrictions,
          conditions: row.conditions, enabled: row.enabled,
        }),
        row.created_at,
      ],
    };
  },

  // Dest composite PK: (tenant_id, switch_name). `switch_type` enum flattens
  // into a switch_name string (see buildSwitchName).
  kill_switches: (row, tenantId) => ({
    sql: upsert(
      'kill_switches',
      ['tenant_id', 'switch_name', 'state', 'updated_at'],
      [],
      ['tenant_id', 'switch_name'],
    ),
    values: [tenantId, buildSwitchName(row), row.enabled ? 'on' : 'off',
             row.updated_at ?? new Date()],
  }),
};

function buildSwitchName(row: Row): string {
  const type = (row.switch_type as string) ?? 'unknown';
  if (type === 'connector_type_disabled' && row.connector_type) {
    return `connector:${row.connector_type}`;
  }
  if (type === 'workflow_type_disabled' && row.agent_id) {
    return `agent:${row.agent_id}`;
  }
  if (type === 'global_freeze') return row.tenant_id == null ? 'global' : 'tenant';
  return type;
}

// ─── Table runner ────────────────────────────────────────────────────────────

async function runTable(
  table: TableName,
  tenantId: string,
  source: Pool,
  dest: Pool,
  batchSize: number,
  dryRun: boolean,
  logger: (msg: string) => void,
): Promise<TableResult> {
  const result: TableResult = { table, readCount: 0, writeCount: 0, skipped: 0, errors: 0 };

  const total = await source.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  const expected: number = total.rows[0]?.n ?? 0;
  logger(`[${table}] ${expected} source rows; batch=${batchSize}${dryRun ? ' (dry-run)' : ''}`);

  const mapper = MAPPERS[table];
  const cursorName = `cur_${table}_${Date.now()}`;
  let client: PoolClient | null = null;
  try {
    client = await source.connect();
    await client.query('BEGIN');
    await client.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR SELECT * FROM ${table}`);

    for (;;) {
      const batch = await client.query(`FETCH ${batchSize} FROM ${cursorName}`);
      if (batch.rows.length === 0) break;
      result.readCount += batch.rows.length;

      if (!dryRun) {
        for (const row of batch.rows) {
          try {
            const { sql, values } = mapper(row as Row, tenantId);
            await dest.query(sql, values);
            result.writeCount++;
          } catch (err) {
            result.errors++;
            logger(`[${table}] error on id=${(row as Row).id}: ${(err as Error).message}`);
          }
        }
      } else {
        result.skipped += batch.rows.length;
      }

      logger(`[${table}] progress ${result.readCount}/${expected}`);
    }

    await client.query(`CLOSE ${cursorName}`);
    await client.query('COMMIT');
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    client?.release();
  }

  logger(
    `[${table}] read=${result.readCount} write=${result.writeCount} ` +
      `skipped=${result.skipped} errors=${result.errors}`,
  );
  return result;
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

export async function runBackfill(opts: BackfillOptions): Promise<BackfillSummary> {
  const logger = opts.logger ?? ((msg: string) => console.log(msg));
  const startedAt = new Date();

  const source = new Pool({
    host: opts.tenantDbHost,
    port: opts.tenantDbPort ?? 5432,
    database: opts.tenantDbName ?? 'tenant_runtime',
    user: opts.tenantDbUser ?? 'tenant_app',
    password: opts.tenantDbPassword,
    max: 4,
  });
  const dest = new Pool({
    host: opts.governanceDbHost,
    port: opts.governanceDbPort ?? 5432,
    database: opts.governanceDbName ?? 'governance_engine',
    user: opts.governanceDbUser ?? 'governance_admin',
    password: opts.governanceDbPassword,
    max: 4,
  });

  const tableResults: TableResult[] = [];
  try {
    for (const table of opts.tables) {
      const r = await runTable(
        table,
        opts.tenantId,
        source,
        dest,
        opts.batchSize,
        opts.dryRun,
        logger,
      );
      tableResults.push(r);
    }
  } finally {
    await source.end().catch(() => undefined);
    await dest.end().catch(() => undefined);
  }

  const finishedAt = new Date();
  const summary: BackfillSummary = {
    tenantId: opts.tenantId,
    dryRun: opts.dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    tables: tableResults,
  };
  logger(
    `SUMMARY tenant=${summary.tenantId} dryRun=${summary.dryRun} ` +
      `duration=${summary.durationMs}ms tables=${JSON.stringify(summary.tables)}`,
  );
  return summary;
}

async function main(): Promise<void> {
  const opts = await buildOptionsFromEnvAndArgs(process.argv.slice(2));
  const summary = await runBackfill(opts);
  const anyErrors = summary.tables.some(t => t.errors > 0);
  process.exit(anyErrors ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('backfill failed:', err);
    process.exit(2);
  });
}
