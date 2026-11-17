// Tenant API Repository
// Per Section 17: Local cache of approved config

import { pool } from '../infrastructure/database';

export class TenantApiRepository {
  // Per Section 4: Stores the latest applied entity_version and discards stale events
  // Per Section 17: Local cache of approved config

  async getCachedEntitlement(tenantId: string): Promise<any> {
    const result = await pool.query(
      `SELECT * FROM cached_entitlements WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows[0] || null;
  }

  async getCachedStatus(tenantId: string): Promise<any> {
    const result = await pool.query(
      `SELECT operational_status FROM cached_entitlements WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows[0] || null;
  }

  async getCachedDeployment(tenantId: string): Promise<any> {
    const result = await pool.query(
      `SELECT * FROM cached_deployments WHERE tenant_id = $1 AND status = 'approved'`,
      [tenantId]
    );
    return result.rows[0] || null;
  }

  async getCachedModelConfig(tenantId: string): Promise<any> {
    const result = await pool.query(
      `SELECT * FROM cached_model_configs WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows[0] || null;
  }

  async getCachedPromptBundle(tenantId: string): Promise<any> {
    const result = await pool.query(
      `SELECT * FROM cached_prompt_bundles WHERE tenant_id = $1 AND status = 'approved'`,
      [tenantId]
    );
    return result.rows[0] || null;
  }

  async getCachedFeatureFlags(tenantId: string): Promise<any> {
    const result = await pool.query(
      `SELECT * FROM cached_feature_flags WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows[0]?.flags || {};
  }

  // Per Section 4: Tenant runtime may pull tenant migration status
  async getCachedMigrationStatus(tenantId: string): Promise<any> {
    const result = await pool.query(
      `SELECT * FROM cached_migration_status WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows[0] || null;
  }

  // updateCachedEntitlement was the only writer of the legacy
  // cached_entitlements.data JSONB blob. Migration 060 dropped that column
  // and the entitlements-client / event subscriber now write all the
  // individual quota columns directly. This method had no callers and was
  // removed alongside the column.
}
