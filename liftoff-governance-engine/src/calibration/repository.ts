// calibration_runs persistence + the current-value lookup.
//
// calibration_runs is FORCE-RLS (app.current_tenant_id), so every write/read here runs inside
// withTenantScope. Cross-tenant enumeration for the weekly sweep reads burn_state (GOV's
// canonical non-RLS tenant registry, same source the usage aggregation sweep uses) — the
// forced trust tables can't be read cross-tenant.

import { pool, withTenantScope } from '../infrastructure/database';
import type { CalibrationRunRow } from './types';
import type { CalibrationStore } from './loop';

export const calibrationStore: CalibrationStore = {
  async currentValue(tenantId, name) {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query<{ applied_value: string | null }>(
        `SELECT applied_value FROM calibration_runs
          WHERE tenant_id = $1 AND constant_name = $2
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, name],
      );
      const v = res.rows[0]?.applied_value;
      return v === undefined || v === null ? null : Number(v);
    });
  },

  async lastPromotedValue(tenantId, name) {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query<{ applied_value: string | null }>(
        `SELECT applied_value FROM calibration_runs
          WHERE tenant_id = $1 AND constant_name = $2 AND outcome = 'promote'
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, name],
      );
      const v = res.rows[0]?.applied_value;
      return v === undefined || v === null ? null : Number(v);
    });
  },

  async recentRuns(tenantId, name, limit) {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query<{
        estimator_output: string | null;
        applied_value: string | null;
        outcome: string;
      }>(
        `SELECT estimator_output, applied_value, outcome FROM calibration_runs
          WHERE tenant_id = $1 AND constant_name = $2
          ORDER BY created_at DESC LIMIT $3`,
        [tenantId, name, limit],
      );
      return res.rows.map((r) => ({
        estimatorOutput: r.estimator_output === null ? null : Number(r.estimator_output),
        appliedValue: r.applied_value === null ? NaN : Number(r.applied_value),
        outcome: r.outcome as CalibrationRunRow['outcome'],
      }));
    });
  },

  async insertRun(row) {
    await withTenantScope(row.tenantId, async (client) => {
      await client.query(
        `INSERT INTO calibration_runs
           (tenant_id, constant_name, window_start, window_end, sample_count,
            estimator_output, applied_value, outcome, guardrail_delta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          row.tenantId,
          row.constantName,
          row.windowStart,
          row.windowEnd,
          row.sampleCount,
          row.estimatorOutput,
          row.appliedValue,
          row.outcome,
          row.guardrailDelta ? JSON.stringify(row.guardrailDelta) : null,
        ],
      );
    });
  },
};

/**
 * The value currently in force for a calibrated constant: the most recent run's applied_value
 * (a promote OR a rollback that reverted it), or `conservativeDefault` before the first run (the
 * cold-start no-op). Reading the in-force value — not the last promote — is what makes an
 * auto-rollback actually take effect.
 */
export async function getCalibratedValue(
  tenantId: string,
  name: string,
  conservativeDefault: number,
): Promise<number> {
  const inForce = await calibrationStore.currentValue(tenantId, name);
  return inForce ?? conservativeDefault;
}

/** Tenants to sweep. burn_state is GOV's non-RLS tenant registry (the usage aggregation sweep
 *  enumerates the same way); forced trust tables cannot be enumerated cross-tenant. */
export async function listCalibrationTenants(): Promise<string[]> {
  const res = await pool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM burn_state`,
  );
  return res.rows.map((r) => r.tenant_id);
}
