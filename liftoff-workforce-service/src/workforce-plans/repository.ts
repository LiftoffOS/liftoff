// Workforce Plans Repository
//
// Raw SQL CRUD over the `workforce_plans` table (migration 085). The service
// layer wraps this with lifecycle state-machine validation; this repository
// only enforces tenant isolation and soft-delete filtering.
//
// Permission model:
//   The platform has a single workforce plan namespace per tenant. Any
//   tenant member can read plans (the dashboard's plan list view); only
//   owners/admins can mutate them. Permission enforcement lives in the
//   router via the existing tenantMembersService.getMembership() flow.
//
// Pagination is cursor-based on (status, updated_at DESC). The cursor is
// the ISO `updated_at` timestamp of the last row on the previous page.
//
// RLS:
//   Every tenant-scoped query runs inside withTenantContext(), which sets
//   app.current_tenant_id as a session-local GUC so RLS policies on
//   workforce_plans can enforce tenant isolation at the DB level.
//   findStuckProvisioningPlans and softDeletePlan are internal/background
//   operations that bypass RLS and use getPool() directly.

import { getPool } from '../infrastructure/database.js';
import { withTenantContext } from '../infrastructure/rls.js';
import type {
  CreateWorkforcePlanInput,
  ListWorkforcePlansOptions,
  OrgChart,
  PaginatedWorkforcePlans,
  ProvisionedSpecRef,
  UpdateWorkforcePlanInput,
  WorkforcePlan,
  WorkforcePlanAgentSpec,
  WorkforcePlanStatus,
} from './types.js';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

// ── Row mapping ────────────────────────────────────────────────────────

function parseAgents(raw: unknown): WorkforcePlanAgentSpec[] {
  if (Array.isArray(raw)) return raw as WorkforcePlanAgentSpec[];
  if (raw == null) return [];
  // jsonb columns come back as parsed JS already, but defensively handle
  // the string case in case any pg client setting changes.
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonb<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

function parseProvisionedSpecs(raw: unknown): ProvisionedSpecRef[] {
  if (!Array.isArray(raw)) {
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ProvisionedSpecRef[]) : [];
      } catch {
        return [];
      }
    }
    return [];
  }
  return raw as ProvisionedSpecRef[];
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string');
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapPlanRow(row: Record<string, unknown>): WorkforcePlan {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    accountId: row.account_id as string,
    title: (row.title as string | null) ?? null,
    status: row.status as WorkforcePlanStatus,
    agents: parseAgents(row.agents),
    orgChart: parseJsonb<OrgChart>(row.org_chart),
    threadId: (row.thread_id as string | null) ?? null,
    approvedBy: (row.approved_by as string | null) ?? null,
    approvedAt: row.approved_at ? (row.approved_at as Date).toISOString() : null,
    launchOnCompletion: row.launch_on_completion === true,
    rejectedReason: (row.rejected_reason as string | null) ?? null,
    revision: row.revision as number,
    lastProvisionedSpecs: parseProvisionedSpecs(row.last_provisioned_specs),
    removedSpecIds: parseStringArray(row.removed_spec_ids),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

// ── Create ─────────────────────────────────────────────────────────────

export async function createPlan(input: CreateWorkforcePlanInput): Promise<WorkforcePlan> {
  return withTenantContext(input.tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO workforce_plans (
         tenant_id, account_id, title, agents, org_chart, thread_id
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       RETURNING *`,
      [
        input.tenantId,
        input.accountId,
        input.title ?? null,
        JSON.stringify(input.agents ?? []),
        input.orgChart ? JSON.stringify(input.orgChart) : null,
        input.threadId ?? null,
      ],
    );
    return mapPlanRow(result.rows[0]);
  });
}

// ── Read ───────────────────────────────────────────────────────────────

/**
 * Fetch one plan by id with tenant isolation. Returns null if the plan
 * doesn't exist, is deleted, or belongs to a different tenant. Cross-tenant
 * lookups are intentionally indistinguishable from "not found" so we never
 * confirm the existence of foreign plan ids.
 */
export async function getPlan(planId: string, tenantId: string): Promise<WorkforcePlan | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM workforce_plans
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [planId, tenantId],
    );
    if (result.rows.length === 0) return null;
    return mapPlanRow(result.rows[0]);
  });
}

export async function listPlans(
  tenantId: string,
  options: ListWorkforcePlansOptions = {},
): Promise<PaginatedWorkforcePlans> {
  return withTenantContext(tenantId, async (client) => {
    const limit = Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const cursor = options.cursor ?? null;

    const params: Array<string | number | Date> = [tenantId];
    let sql = `
      SELECT * FROM workforce_plans
      WHERE tenant_id = $1
        AND deleted_at IS NULL
    `;

    if (options.status) {
      params.push(options.status);
      sql += ` AND status = $${params.length}`;
    }

    if (cursor) {
      params.push(new Date(cursor));
      sql += ` AND updated_at < $${params.length}`;
    }

    params.push(limit + 1);
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;

    const result = await client.query(sql, params);
    const hasMore = result.rows.length > limit;
    const plans = result.rows.slice(0, limit).map(mapPlanRow);

    return {
      plans,
      nextCursor: hasMore && plans.length > 0 ? plans[plans.length - 1].updatedAt : null,
      hasMore,
    };
  });
}

// ── Update ─────────────────────────────────────────────────────────────

/**
 * Apply a patch to a plan's mutable fields. Caller must have already
 * validated that the plan is in a status that allows updates (draft only).
 * This function doesn't enforce that — see service.ts.
 *
 * Returns the updated row, or null if the plan was not found / not visible.
 */
export async function updatePlanFields(
  planId: string,
  tenantId: string,
  patch: UpdateWorkforcePlanInput,
): Promise<WorkforcePlan | null> {
  return withTenantContext(tenantId, async (client) => {
    const updates: string[] = [];
    const params: Array<string | number | Date | null> = [];

    if (patch.title !== undefined) {
      params.push(patch.title);
      updates.push(`title = $${params.length}`);
    }
    if (patch.agents !== undefined) {
      params.push(JSON.stringify(patch.agents));
      updates.push(`agents = $${params.length}::jsonb`);
    }
    if (patch.orgChart !== undefined) {
      params.push(patch.orgChart ? JSON.stringify(patch.orgChart) : null);
      updates.push(`org_chart = $${params.length}::jsonb`);
    }
    if (patch.threadId !== undefined) {
      params.push(patch.threadId);
      updates.push(`thread_id = $${params.length}`);
    }

    if (updates.length === 0) {
      // No-op update — return the existing row within the same client.
      const result = await client.query(
        `SELECT * FROM workforce_plans
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [planId, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapPlanRow(result.rows[0]);
    }

    updates.push(`updated_at = NOW()`);

    params.push(planId);
    const planIdIdx = params.length;
    params.push(tenantId);
    const tenantIdIdx = params.length;

    const result = await client.query(
      `UPDATE workforce_plans
       SET ${updates.join(', ')}
       WHERE id = $${planIdIdx} AND tenant_id = $${tenantIdIdx} AND deleted_at IS NULL
       RETURNING *`,
      params,
    );

    if (result.rows.length === 0) return null;
    return mapPlanRow(result.rows[0]);
  });
}

/**
 * Persist agent spec changes from the HRBP Agent during provisioning. This
 * is called repeatedly as each spec moves through pending -> provisioning ->
 * completed/failed. Distinct from updatePlanFields() because it doesn't
 * enforce a draft-only check.
 */
export async function updatePlanAgents(
  planId: string,
  tenantId: string,
  agents: WorkforcePlanAgentSpec[],
): Promise<WorkforcePlan | null> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE workforce_plans
       SET agents = $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [planId, tenantId, JSON.stringify(agents)],
    );
    if (result.rows.length === 0) return null;
    return mapPlanRow(result.rows[0]);
  });
}

// ── Lifecycle transitions ──────────────────────────────────────────────

/**
 * Atomically transition a plan from one status to another. Returns the
 * updated row, or null if the row was not found OR the current status did
 * not match `expectedStatus` (concurrent modification protection).
 *
 * Optional fields:
 *   - approvedBy / approvedAt: set when transitioning to `approved`
 *   - rejectedReason: set when transitioning back to draft via reject
 *   - bumpRevision: set true when reopening a completed plan to draft, so
 *     amendments are tracked via the revision counter
 */
export async function transitionStatus(
  planId: string,
  tenantId: string,
  expectedStatus: WorkforcePlanStatus | WorkforcePlanStatus[],
  newStatus: WorkforcePlanStatus,
  options: {
    approvedBy?: string | null;
    /** Recorded with the approval: the answer to launch now or leave as drafts. */
    launchOnCompletion?: boolean;
    rejectedReason?: string | null;
    bumpRevision?: boolean;
  } = {},
): Promise<WorkforcePlan | null> {
  return withTenantContext(tenantId, async (client) => {
    const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];

    const setClauses: string[] = ['status = $4', 'updated_at = NOW()'];
    const params: Array<string | string[] | Date | boolean | null> = [planId, tenantId, expected, newStatus];

    if (options.approvedBy !== undefined) {
      params.push(options.approvedBy);
      setClauses.push(`approved_by = $${params.length}`);
      setClauses.push(`approved_at = NOW()`);
    }
    if (options.launchOnCompletion !== undefined) {
      params.push(options.launchOnCompletion);
      setClauses.push(`launch_on_completion = $${params.length}`);
    }
    if (options.rejectedReason !== undefined) {
      params.push(options.rejectedReason);
      setClauses.push(`rejected_reason = $${params.length}`);
    }
    if (options.bumpRevision) {
      setClauses.push(`revision = revision + 1`);
    }

    const result = await client.query(
      `UPDATE workforce_plans
       SET ${setClauses.join(', ')}
       WHERE id = $1
         AND tenant_id = $2
         AND status = ANY($3)
         AND deleted_at IS NULL
       RETURNING *`,
      params,
    );

    if (result.rows.length === 0) return null;
    return mapPlanRow(result.rows[0]);
  });
}

/**
 * Persist the HRBP Agent's re-provisioning snapshot: `lastProvisionedSpecs`
 * (written at the end of a successful run) and `removedSpecIds` (written
 * at the start of a run when specs from the previous snapshot are no
 * longer in the current agents array). Both columns default to empty so
 * callers can update either independently.
 */
export async function updatePlanProvisioningSnapshot(
  planId: string,
  tenantId: string,
  snapshot: {
    lastProvisionedSpecs?: ProvisionedSpecRef[];
    removedSpecIds?: string[];
  },
): Promise<WorkforcePlan | null> {
  return withTenantContext(tenantId, async (client) => {
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: Array<string | string[] | Date> = [planId, tenantId];

    if (snapshot.lastProvisionedSpecs !== undefined) {
      params.push(JSON.stringify(snapshot.lastProvisionedSpecs));
      setClauses.push(`last_provisioned_specs = $${params.length}::jsonb`);
    }
    if (snapshot.removedSpecIds !== undefined) {
      params.push(JSON.stringify(snapshot.removedSpecIds));
      setClauses.push(`removed_spec_ids = $${params.length}::jsonb`);
    }

    // If only `updated_at` is in setClauses, neither field was provided -
    // no-op, return the existing row within the same client.
    if (setClauses.length === 1) {
      const result = await client.query(
        `SELECT * FROM workforce_plans
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [planId, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapPlanRow(result.rows[0]);
    }

    const result = await client.query(
      `UPDATE workforce_plans
       SET ${setClauses.join(', ')}
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapPlanRow(result.rows[0]);
  });
}

// ── Stuck-plan recovery ────────────────────────────────────────────────

/**
 * Find plans in `provisioning` status whose last update is older than
 * `staleAfterMs` milliseconds. Used by the startup stuck-plan resumer to
 * pick up any provisioning runs whose per-spec Cloud Tasks exhausted
 * their retries (or where the approve handler crashed after the status
 * transition but before all per-spec tasks were enqueued).
 *
 * Returns {planId, tenantId} tuples only - callers fetch the full plan
 * themselves and re-enqueue per-spec tasks via Cloud Tasks (deterministic
 * task names dedupe duplicates), which keeps the resumer's memory
 * footprint O(1) even with many stuck plans.
 *
 * A genuine cross-tenant read, so it cannot go through withTenantContext — the
 * sweep has no single tenant to scope to. A SELECT on the raw pool does not
 * bypass RLS; it matches zero rows on every run. The bypass lives in one named, granted place: the SECURITY DEFINER function
 * from migration 015, which runs as the table owner. See that migration for what
 * breaks it (switching workforce_plans to FORCE row security).
 */
export async function findStuckProvisioningPlans(
  staleAfterMs: number,
  limit = 100,
): Promise<Array<{ planId: string; tenantId: string }>> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT plan_id, tenant_id
     FROM workforce_find_stuck_provisioning_plans($1::int, $2::int)`,
    [Math.floor(staleAfterMs / 1000), limit],
  );
  return result.rows.map(row => ({
    planId: row.plan_id as string,
    tenantId: row.tenant_id as string,
  }));
}

// ── Soft delete ────────────────────────────────────────────────────────

/**
 * Soft-delete a plan.
 *
 * The raw pool does not bypass RLS: workforce_plans' policy reads
 * app.current_tenant_id, which is unset on a pool connection, so an UPDATE there
 * matches zero rows and every delete returns false having changed nothing. It has a tenant id, so it belongs in
 * withTenantContext like the rest of the file. INV-WF-001.
 */
export async function softDeletePlan(planId: string, tenantId: string): Promise<boolean> {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE workforce_plans
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [planId, tenantId],
    );
    return (result.rowCount ?? 0) > 0;
  });
}
