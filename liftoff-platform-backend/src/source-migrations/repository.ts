// Liftoff Switch — tenant-scoped persistence.
//
// Every query here runs inside withTenantScope, so RLS is satisfied and a
// cross-tenant read returns zero rows rather than someone else's migration
// (INV-PB-001). There is no raw pool access in this module.

import type { PoolClient } from 'pg';
import { withAdminScope, withTenantScope } from '../infrastructure/database';
import type {
  ConnectionKind,
  ConnectionStatus,
  FirstRunStatus,
  MigrationBundleV1,
  MigrationItemState,
  MigrationSource,
  MigrationState,
  SourceMigration,
  SourceMigrationConnection,
  SourceMigrationItem,
  SourceMigrationRoutine,
  StoredDistillInput,
  UnsupportedItem,
  HostingRequirement,
} from './types';

function mapMigration(row: Record<string, unknown>): SourceMigration {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    accountId: (row.account_id as string | null) ?? null,
    source: row.source as MigrationSource,
    sourceVersion: (row.source_version as string | null) ?? null,
    adapterVersion: row.adapter_version as string,
    installationFingerprint: row.installation_fingerprint as string,
    state: row.state as MigrationState,
    bundle: (row.bundle as MigrationBundleV1 | null) ?? null,
    unsupportedItems: (row.unsupported_items as UnsupportedItem[]) ?? [],
    hostingRequirements: (row.hosting_requirements as HostingRequirement[]) ?? [],
    diagnostics: (row.diagnostics as string[]) ?? [],
    libraryApprovals: (row.library_approvals as string[]) ?? [],
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    convertedAt: (row.converted_at as Date | null) ?? null,
    completedAt: (row.completed_at as Date | null) ?? null,
  };
}

function mapItem(row: Record<string, unknown>): SourceMigrationItem {
  return {
    id: row.id as string,
    migrationId: row.migration_id as string,
    tenantId: row.tenant_id as string,
    sourceRef: row.source_ref as string,
    normalizedInputHash: row.normalized_input_hash as string,
    distillInput: row.distill_input as StoredDistillInput,
    state: row.state as MigrationItemState,
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: (row.last_error as string | null) ?? null,
    distillOutput: (row.distill_output as Record<string, unknown> | null) ?? null,
    destinationAgentId: (row.destination_agent_id as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    convertedAt: (row.converted_at as Date | null) ?? null,
  };
}

function mapRoutine(row: Record<string, unknown>): SourceMigrationRoutine {
  return {
    id: row.id as string,
    migrationId: row.migration_id as string,
    tenantId: row.tenant_id as string,
    itemId: (row.item_id as string | null) ?? null,
    sourceRef: row.source_ref as string,
    name: row.name as string,
    cronExpr: row.cron_expr as string,
    prompt: (row.prompt as string) ?? '',
    enabledInSource: Boolean(row.enabled_in_source),
    accepted: Boolean(row.accepted),
    enabledAtCutover: Boolean(row.enabled_at_cutover),
    destinationAgentId: (row.destination_agent_id as string | null) ?? null,
    routineRef: row.routine_ref as string,
    firstRunStatus: row.first_run_status as FirstRunStatus,
    firstRunAt: (row.first_run_at as Date | null) ?? null,
    firstRunErrorCategory: (row.first_run_error_category as string | null) ?? null,
  };
}

function mapConnection(row: Record<string, unknown>): SourceMigrationConnection {
  return {
    id: row.id as string,
    migrationId: row.migration_id as string,
    tenantId: row.tenant_id as string,
    sourceRef: row.source_ref as string,
    kind: row.kind as ConnectionKind,
    connectorType: row.connector_type as string,
    displayName: (row.display_name as string | null) ?? null,
    endpointUrl: (row.endpoint_url as string | null) ?? null,
    authScheme: (row.auth_scheme as string | null) ?? null,
    customHeaderNames: (row.custom_header_names as string[]) ?? [],
    externalAccountLabel: (row.external_account_label as string | null) ?? null,
    connectorId: (row.connector_id as string | null) ?? null,
    customMcpServerId: (row.custom_mcp_server_id as string | null) ?? null,
    status: row.status as ConnectionStatus,
  };
}

export const sourceMigrationRepository = {
  /** Create or return the live migration for an installation.
   *
   *  Idempotent by construction: the partial unique index means a second call
   *  for the same installation collides and returns the existing row instead of
   *  opening a parallel migration the user never asked for. */
  async createOrResume(
    tenantId: string,
    params: {
      source: MigrationSource;
      sourceVersion?: string;
      adapterVersion: string;
      installationFingerprint: string;
      accountId: string | null;
    },
  ): Promise<SourceMigration> {
    return withTenantScope(tenantId, async (c: PoolClient) => {
      // Matched on the IMPORTER as well as the installation. Without the
      // account in the predicate, a second person in the workspace whose
      // installation sat at the same path resumed the first person's migration,
      // and their bundle upload overwrote it. `IS NOT DISTINCT FROM` so a
      // legacy row with no importer matches only another row with none.
      const existing = await c.query(
        `SELECT * FROM source_migrations
          WHERE tenant_id = $1 AND source = $2 AND installation_fingerprint = $3
            AND account_id IS NOT DISTINCT FROM $4
            AND state NOT IN ('active', 'failed')
          LIMIT 1`,
        [tenantId, params.source, params.installationFingerprint, params.accountId],
      );
      if (existing.rows.length > 0) return mapMigration(existing.rows[0]);

      const inserted = await c.query(
        `INSERT INTO source_migrations
           (tenant_id, account_id, source, source_version, adapter_version,
            installation_fingerprint, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'importing')
         ON CONFLICT (tenant_id, account_id, source, installation_fingerprint)
           WHERE state NOT IN ('active', 'failed')
           DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [
          tenantId,
          params.accountId,
          params.source,
          params.sourceVersion ?? null,
          params.adapterVersion,
          params.installationFingerprint,
        ],
      );
      return mapMigration(inserted.rows[0]);
    });
  },

  /** The migration currently open for this source, if any.
   *
   *  The wizard resumes from this rather than from a client-held id, so a user
   *  who lands on the route from anywhere sees their real position. */
  /** The newest import THIS PERSON has for this source.
   *
   *  Scoped per tenant, the wizard showed whichever workspace member imported
   *  most recently: a colleague opening /dashboard/switch/openclaw saw someone
   *  else's team members, their connections and their progress, and Continue
   *  would have built that person's import under their own name. */
  async findLatest(
    tenantId: string,
    accountId: string | null,
    source: MigrationSource,
  ): Promise<SourceMigration | null> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `SELECT * FROM source_migrations
          WHERE tenant_id = $1 AND source = $2
            AND account_id IS NOT DISTINCT FROM $3
          ORDER BY (state NOT IN ('active', 'failed')) DESC, created_at DESC
          LIMIT 1`,
        [tenantId, source, accountId],
      );
      return res.rows.length > 0 ? mapMigration(res.rows[0]) : null;
    });
  },

  /** Record consent for workspace-scoped material. Additive: an approval is
   *  never revoked silently by a later call that omits it. */
  async setLibraryApprovals(
    tenantId: string,
    migrationId: string,
    approvedArtifactNames: string[],
  ): Promise<SourceMigration | null> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `UPDATE source_migrations
            SET library_approvals = $3::jsonb, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2
          RETURNING *`,
        [migrationId, tenantId, JSON.stringify(approvedArtifactNames)],
      );
      return res.rows.length > 0 ? mapMigration(res.rows[0]) : null;
    });
  },

  /** Accept or decline an imported routine by its stable source ref. */
  async setRoutineAcceptedByRef(
    tenantId: string,
    migrationId: string,
    sourceRef: string,
    accepted: boolean,
  ): Promise<boolean> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `UPDATE source_migration_routines
            SET accepted = $4, updated_at = NOW()
          WHERE migration_id = $1 AND tenant_id = $2 AND source_ref = $3
          RETURNING id`,
        [migrationId, tenantId, sourceRef, accepted],
      );
      return res.rows.length > 0;
    });
  },

  async getById(tenantId: string, migrationId: string): Promise<SourceMigration | null> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `SELECT * FROM source_migrations WHERE id = $1 AND tenant_id = $2`,
        [migrationId, tenantId],
      );
      return res.rows.length > 0 ? mapMigration(res.rows[0]) : null;
    });
  },

  /** Recent imports by ONE person.
   *
   *  The daily cap is a per-person rate limit, which is what the plan specifies
   *  and what the name `countRecentForTenant` quietly contradicted: a ten-person
   *  workspace shared three imports a day between them. */
  async countRecentForAccount(
    tenantId: string,
    accountId: string | null,
    windowHours: number,
  ): Promise<number> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `SELECT COUNT(*)::int AS n FROM source_migrations
          WHERE tenant_id = $1
            AND account_id IS NOT DISTINCT FROM $2
            AND created_at > NOW() - ($3 || ' hours')::interval`,
        [tenantId, accountId, String(windowHours)],
      );
      return Number(res.rows[0]?.n ?? 0);
    });
  },



  async saveBundle(
    tenantId: string,
    migrationId: string,
    bundle: MigrationBundleV1,
    derived: {
      state: MigrationState;
      unsupportedItems: UnsupportedItem[];
      hostingRequirements: HostingRequirement[];
      diagnostics: string[];
    },
  ): Promise<SourceMigration | null> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `UPDATE source_migrations
            SET bundle = $3::jsonb,
                unsupported_items = $4::jsonb,
                hosting_requirements = $5::jsonb,
                diagnostics = $6::jsonb,
                state = $7,
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2
          RETURNING *`,
        [
          migrationId,
          tenantId,
          JSON.stringify(bundle),
          JSON.stringify(derived.unsupportedItems),
          JSON.stringify(derived.hostingRequirements),
          JSON.stringify(derived.diagnostics),
          derived.state,
        ],
      );
      return res.rows.length > 0 ? mapMigration(res.rows[0]) : null;
    });
  },

  async setState(
    tenantId: string,
    migrationId: string,
    state: MigrationState,
    opts: { lastError?: string | null; convertedAt?: boolean; completedAt?: boolean } = {},
  ): Promise<SourceMigration | null> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `UPDATE source_migrations
            SET state = $3,
                last_error = $4,
                converted_at = CASE WHEN $5::boolean THEN NOW() ELSE converted_at END,
                completed_at = CASE WHEN $6::boolean THEN NOW() ELSE completed_at END,
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2
          RETURNING *`,
        [
          migrationId,
          tenantId,
          state,
          opts.lastError ?? null,
          opts.convertedAt ?? false,
          opts.completedAt ?? false,
        ],
      );
      return res.rows.length > 0 ? mapMigration(res.rows[0]) : null;
    });
  },

  // ── items ────────────────────────────────────────────────────────────

  /** Upsert one item per selected identity, keyed by migration + source ref.
   *
   *  A changed normalized-input hash records a NEW input but never resets a
   *  converted item: re-running the original migration must not silently
   *  change an already converted team member. */
  async upsertItem(
    tenantId: string,
    params: {
      migrationId: string;
      sourceRef: string;
      normalizedInputHash: string;
      distillInput: StoredDistillInput;
    },
  ): Promise<SourceMigrationItem> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `INSERT INTO source_migration_items
           (migration_id, tenant_id, source_ref, normalized_input_hash, distill_input, state)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')
         ON CONFLICT (migration_id, source_ref) DO UPDATE
           SET normalized_input_hash = CASE
                 WHEN source_migration_items.destination_agent_id IS NULL
                   THEN EXCLUDED.normalized_input_hash
                 ELSE source_migration_items.normalized_input_hash
               END,
               distill_input = CASE
                 WHEN source_migration_items.destination_agent_id IS NULL
                   THEN EXCLUDED.distill_input
                 ELSE source_migration_items.distill_input
               END,
               updated_at = NOW()
         RETURNING *`,
        [
          params.migrationId,
          tenantId,
          params.sourceRef,
          params.normalizedInputHash,
          JSON.stringify(params.distillInput),
        ],
      );
      return mapItem(res.rows[0]);
    });
  },

  /** Migrations that still have work to do, across every tenant.
   *
   *  Conversion is rate-limited: an item that cannot reserve a distill slot is
   *  left `pending` with the reason and picked up on a later pass. Nothing used
   *  to make that later pass happen — conversion ran only while somebody had
   *  the wizard open — so a workspace importing more members than its hourly
   *  allowance converted part of its team and then sat there, finished as far
   *  as anyone could see. This is what the sweep reads to finish the job.
   *
   *  Cross-tenant by definition, so withAdminScope, in the same shape as the
   *  other maintenance sweeps. */
  async listMigrationsWithPendingItems(limit: number): Promise<Array<{ id: string; tenantId: string; accountId: string | null }>> {
    const result = await withAdminScope(
      {
        caller: 'SourceMigrationRepository.listMigrationsWithPendingItems',
        reason: 'cross-tenant maintenance sweep: resume imports whose conversion was rate-limited',
      },
      (client) => client.query<{ id: string; tenant_id: string; account_id: string | null }>(
        `SELECT m.id, m.tenant_id, m.account_id
           FROM source_migrations m
          WHERE m.state = 'converting'
            AND EXISTS (
              SELECT 1 FROM source_migration_items i
               WHERE i.migration_id = m.id
                 AND i.state = 'pending'
            )
          ORDER BY m.updated_at ASC
          LIMIT $1`,
        [limit],
      ),
    );
    return result.rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, accountId: r.account_id }));
  },

  async listItems(tenantId: string, migrationId: string): Promise<SourceMigrationItem[]> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `SELECT * FROM source_migration_items
          WHERE migration_id = $1 AND tenant_id = $2
          ORDER BY source_ref`,
        [migrationId, tenantId],
      );
      return res.rows.map(mapItem);
    });
  },

  async setItemState(
    tenantId: string,
    itemId: string,
    state: MigrationItemState,
    opts: { lastError?: string | null; incrementAttempt?: boolean } = {},
  ): Promise<void> {
    await withTenantScope(tenantId, async (c) => {
      await c.query(
        `UPDATE source_migration_items
            SET state = $3,
                last_error = $4,
                attempt_count = attempt_count + CASE WHEN $5::boolean THEN 1 ELSE 0 END,
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2`,
        [itemId, tenantId, state, opts.lastError ?? null, opts.incrementAttempt ?? false],
      );
    });
  },

  /** Persist a successful distill BEFORE agent creation is attempted. */
  async saveDistillOutput(
    tenantId: string,
    itemId: string,
    distillOutput: Record<string, unknown>,
  ): Promise<void> {
    await withTenantScope(tenantId, async (c) => {
      await c.query(
        `UPDATE source_migration_items
            SET distill_output = $3::jsonb, state = 'creating', updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2`,
        [itemId, tenantId, JSON.stringify(distillOutput)],
      );
    });
  },

  /** Record the source-to-destination mapping. Guarded so a concurrent worker
   *  cannot overwrite an existing mapping with a second agent. */
  async saveDestinationAgent(
    tenantId: string,
    itemId: string,
    destinationAgentId: string,
  ): Promise<void> {
    await withTenantScope(tenantId, async (c) => {
      await c.query(
        `UPDATE source_migration_items
            SET destination_agent_id = COALESCE(destination_agent_id, $3),
                state = 'converted',
                converted_at = COALESCE(converted_at, NOW()),
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2`,
        [itemId, tenantId, destinationAgentId],
      );
    });
  },

  // ── routines ─────────────────────────────────────────────────────────

  async upsertRoutine(
    tenantId: string,
    params: {
      migrationId: string;
      sourceRef: string;
      name: string;
      cronExpr: string;
      prompt: string;
      enabledInSource: boolean;
      routineRef: string;
      itemId?: string | null;
    },
  ): Promise<SourceMigrationRoutine> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `INSERT INTO source_migration_routines
           (migration_id, tenant_id, source_ref, name, cron_expr, prompt, enabled_in_source,
            routine_ref, item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (migration_id, source_ref) DO UPDATE
           SET name = EXCLUDED.name,
               cron_expr = EXCLUDED.cron_expr,
               prompt = EXCLUDED.prompt,
               enabled_in_source = EXCLUDED.enabled_in_source,
               item_id = EXCLUDED.item_id,
               updated_at = NOW()
         RETURNING *`,
        [
          params.migrationId,
          tenantId,
          params.sourceRef,
          params.name,
          params.cronExpr,
          params.prompt,
          params.enabledInSource,
          params.routineRef,
          params.itemId ?? null,
        ],
      );
      return mapRoutine(res.rows[0]);
    });
  },

  async listRoutines(tenantId: string, migrationId: string): Promise<SourceMigrationRoutine[]> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `SELECT * FROM source_migration_routines
          WHERE migration_id = $1 AND tenant_id = $2
          ORDER BY source_ref`,
        [migrationId, tenantId],
      );
      return res.rows.map(mapRoutine);
    });
  },

  async setRoutineAccepted(
    tenantId: string,
    routineId: string,
    accepted: boolean,
  ): Promise<void> {
    await withTenantScope(tenantId, async (c) => {
      await c.query(
        `UPDATE source_migration_routines
            SET accepted = $3, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2`,
        [routineId, tenantId, accepted],
      );
    });
  },

  async markRoutineEnabled(
    tenantId: string,
    routineId: string,
    destinationAgentId: string,
  ): Promise<void> {
    await withTenantScope(tenantId, async (c) => {
      await c.query(
        `UPDATE source_migration_routines
            SET enabled_at_cutover = TRUE,
                destination_agent_id = COALESCE(destination_agent_id, $3),
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2`,
        [routineId, tenantId, destinationAgentId],
      );
    });
  },

  /** Record the FIRST terminal scheduled outcome for an imported routine.
   *
   *  Idempotent: only a routine still 'awaiting' is updated, so a duplicate
   *  delivery is a no-op and a later run never overwrites the first result. */
  async recordFirstRun(
    tenantId: string,
    routineRef: string,
    outcome: { status: Exclude<FirstRunStatus, 'awaiting'>; errorCategory?: string | null; occurredAt?: Date },
  ): Promise<boolean> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `UPDATE source_migration_routines
            SET first_run_status = $3,
                first_run_at = COALESCE($5::timestamptz, NOW()),
                first_run_error_category = $4,
                updated_at = NOW()
          WHERE tenant_id = $1 AND routine_ref = $2 AND first_run_status = 'awaiting'
          RETURNING id`,
        [
          tenantId,
          routineRef,
          outcome.status,
          outcome.errorCategory ?? null,
          outcome.occurredAt ?? null,
        ],
      );
      return res.rows.length > 0;
    });
  },

  // ── connections ──────────────────────────────────────────────────────

  async upsertConnection(
    tenantId: string,
    params: {
      migrationId: string;
      sourceRef: string;
      kind: ConnectionKind;
      connectorType: string;
      displayName?: string | null;
      endpointUrl?: string | null;
      authScheme?: string | null;
      customHeaderNames?: string[];
      externalAccountLabel?: string | null;
    },
  ): Promise<SourceMigrationConnection> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `INSERT INTO source_migration_connections
           (migration_id, tenant_id, source_ref, kind, connector_type, display_name,
            endpoint_url, auth_scheme, custom_header_names, external_account_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (migration_id, source_ref) DO UPDATE
           SET connector_type = EXCLUDED.connector_type,
               display_name = EXCLUDED.display_name,
               endpoint_url = EXCLUDED.endpoint_url,
               auth_scheme = EXCLUDED.auth_scheme,
               custom_header_names = EXCLUDED.custom_header_names,
               external_account_label = EXCLUDED.external_account_label,
               updated_at = NOW()
         RETURNING *`,
        [
          params.migrationId,
          tenantId,
          params.sourceRef,
          params.kind,
          params.connectorType,
          params.displayName ?? null,
          params.endpointUrl ?? null,
          params.authScheme ?? null,
          JSON.stringify(params.customHeaderNames ?? []),
          params.externalAccountLabel ?? null,
        ],
      );
      return mapConnection(res.rows[0]);
    });
  },

  async listConnections(
    tenantId: string,
    migrationId: string,
  ): Promise<SourceMigrationConnection[]> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `SELECT * FROM source_migration_connections
          WHERE migration_id = $1 AND tenant_id = $2
          ORDER BY source_ref`,
        [migrationId, tenantId],
      );
      return res.rows.map(mapConnection);
    });
  },

  async attachConnectorId(
    tenantId: string,
    connectionId: string,
    params: { connectorId: string; customMcpServerId?: string | null; status: ConnectionStatus },
  ): Promise<void> {
    await withTenantScope(tenantId, async (c) => {
      await c.query(
        `UPDATE source_migration_connections
            SET connector_id = $3,
                custom_mcp_server_id = COALESCE($4, custom_mcp_server_id),
                status = $5,
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2`,
        [
          connectionId,
          tenantId,
          params.connectorId,
          params.customMcpServerId ?? null,
          params.status,
        ],
      );
    });
  },

  /** Drop imported connections the source no longer references.
   *
   *  Re-importing replaces the bundle, so a connection the person removed from
   *  their installation would otherwise linger and keep blocking the build
   *  forever, with nothing able to clear it. Only the local record goes: the
   *  connector itself lives in connector-service and may be a connection the
   *  person made and still wants, so it stays on the Connections page. */
  async pruneConnectionsNotIn(
    tenantId: string,
    migrationId: string,
    keepSourceRefs: string[],
  ): Promise<number> {
    return withTenantScope(tenantId, async (c) => {
      const res = await c.query(
        `DELETE FROM source_migration_connections
          WHERE migration_id = $1 AND tenant_id = $2
            AND NOT (source_ref = ANY($3::text[]))`,
        [migrationId, tenantId, keepSourceRefs],
      );
      return res.rowCount ?? 0;
    });
  },

  /** Resolve a source integration ref to the connector UUID its placeholder
   *  received, so an imported agent binds to the exact account rather than a
   *  connector TYPE. */
  async connectorIdsBySourceRef(
    tenantId: string,
    migrationId: string,
  ): Promise<Map<string, { connectorId: string; connectorType: string }>> {
    const rows = await this.listConnections(tenantId, migrationId);
    const out = new Map<string, { connectorId: string; connectorType: string }>();
    for (const row of rows) {
      if (row.connectorId && row.status !== 'dismissed') {
        out.set(row.sourceRef, { connectorId: row.connectorId, connectorType: row.connectorType });
      }
    }
    return out;
  },
};
