// Feature Flag Repository
// Per Section 1: Control plane owns feature flags

import type { PoolClient } from 'pg';
import { getPool } from '../infrastructure/database';
import { FeatureFlag, CreateFlagInput, UpdateFlagInput } from './types';

export class FeatureFlagRepository {
  async findAll(): Promise<FeatureFlag[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM feature_flags ORDER BY key`
    );
    return result.rows.map(this.mapRow);
  }

  async findById(id: string): Promise<FeatureFlag | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM feature_flags WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByKey(key: string): Promise<FeatureFlag | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM feature_flags WHERE key = $1`,
      [key]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async create(input: CreateFlagInput): Promise<FeatureFlag> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO feature_flags (key, name, description, enabled, tenant_overrides, value_num)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.key, input.name, input.description, input.enabled,
        JSON.stringify({}),
        input.valueNum ?? null,
      ]
    );
    return this.mapRow(result.rows[0]);
  }

  async update(id: string, input: UpdateFlagInput): Promise<FeatureFlag> {
    const pool = getPool();

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(input.description);
    }
    if (input.enabled !== undefined) {
      updates.push(`enabled = $${paramIndex++}`);
      values.push(input.enabled);
    }
    if (input.tenantOverrides !== undefined) {
      updates.push(`tenant_overrides = $${paramIndex++}`);
      values.push(JSON.stringify(input.tenantOverrides));
    }
    if (input.valueNum !== undefined) {
      updates.push(`value_num = $${paramIndex++}`);
      values.push(input.valueNum);
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE feature_flags SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    return this.mapRow(result.rows[0]);
  }

  async delete(id: string): Promise<void> {
    const pool = getPool();
    await pool.query(`DELETE FROM feature_flags WHERE id = $1`, [id]);
  }

  // Atomic tenant-override mutations. jsonb_set / `- key` update exactly the one
  // tenant's slot in a single statement, so two concurrent overrides for different
  // tenants cannot drop each other (unlike a read-modify-write of the whole JSON).
  // Run inside mutateAndPublishEvent's transaction via the passed client.
  async setTenantOverrideInTx(
    client: PoolClient,
    flagKey: string,
    tenantId: string,
    enabled: boolean,
  ): Promise<FeatureFlag | null> {
    const result = await client.query(
      `UPDATE feature_flags
          SET tenant_overrides = jsonb_set(COALESCE(tenant_overrides, '{}'::jsonb), ARRAY[$2], to_jsonb($3::boolean)),
              updated_at = NOW()
        WHERE key = $1
        RETURNING *`,
      [flagKey, tenantId, enabled],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async removeTenantOverrideInTx(
    client: PoolClient,
    flagKey: string,
    tenantId: string,
  ): Promise<FeatureFlag | null> {
    const result = await client.query(
      `UPDATE feature_flags
          SET tenant_overrides = COALESCE(tenant_overrides, '{}'::jsonb) - $2,
              updated_at = NOW()
        WHERE key = $1
        RETURNING *`,
      [flagKey, tenantId],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private mapRow(row: Record<string, unknown>): FeatureFlag {
    return {
      id: row.id as string,
      key: row.key as string,
      name: row.name as string,
      description: row.description as string,
      enabled: row.enabled as boolean,
      valueNum: row.value_num !== null && row.value_num !== undefined ? Number(row.value_num) : null,
      tenantOverrides: (row.tenant_overrides as Record<string, boolean>) || {},
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
