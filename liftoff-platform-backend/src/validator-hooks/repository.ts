// Validator Hook Repository
// Per Section 17: Validator hook versions

import { pool } from '../infrastructure/database';
import {
  ValidatorHook,
  ValidatorHookVersion,
  ValidatorHookStatus,
  ValidatorHookConfig,
  CreateValidatorHookInput,
} from './types';
import { randomUUID } from 'crypto';

export class ValidatorHookRepository {
  async findAll(tenantId?: string): Promise<ValidatorHook[]> {
    let query = `SELECT * FROM validator_hooks`;
    const params: string[] = [];

    if (tenantId) {
      query += ` WHERE tenant_id = $1`;
      params.push(tenantId);
    }

    query += ` ORDER BY name ASC`;

    const result = await pool.query(query, params);
    return result.rows.map(this.mapRow);
  }

  async findById(id: string, tenantId?: string): Promise<ValidatorHook | null> {
    const query = tenantId
      ? `SELECT * FROM validator_hooks WHERE id = $1 AND tenant_id = $2`
      : `SELECT * FROM validator_hooks WHERE id = $1`;
    const params = tenantId ? [id, tenantId] : [id];
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async findByTenantAndName(tenantId: string, name: string): Promise<ValidatorHook | null> {
    const result = await pool.query(
      `SELECT * FROM validator_hooks WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async findActive(tenantId: string): Promise<ValidatorHook[]> {
    const result = await pool.query(
      `SELECT * FROM validator_hooks WHERE tenant_id = $1 AND status = 'active' ORDER BY name`,
      [tenantId]
    );

    return result.rows.map(this.mapRow);
  }

  async findByType(tenantId: string, type: string): Promise<ValidatorHook[]> {
    const result = await pool.query(
      `SELECT * FROM validator_hooks WHERE tenant_id = $1 AND type = $2 ORDER BY name`,
      [tenantId, type]
    );

    return result.rows.map(this.mapRow);
  }

  async create(input: CreateValidatorHookInput): Promise<ValidatorHook> {
    const id = randomUUID();

    const result = await pool.query(
      `INSERT INTO validator_hooks
       (id, tenant_id, name, description, type, version, status, config, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'draft', $6, $7, NOW(), NOW())
       RETURNING *`,
      [
        id,
        input.tenantId,
        input.name,
        input.description,
        input.type,
        JSON.stringify(input.config),
        input.createdBy,
      ]
    );

    // Also create the first version
    await this.createVersion(id, 1, input.config, input.createdBy, 'Initial version');

    return this.mapRow(result.rows[0]);
  }

  async update(
    id: string,
    config: ValidatorHookConfig,
    changeLog: string,
    updatedBy: string
  ): Promise<ValidatorHook> {
    // Get current version
    const current = await this.findById(id);
    if (!current) {
      throw new Error(`Validator hook ${id} not found`);
    }

    const newVersion = current.version + 1;

    const result = await pool.query(
      `UPDATE validator_hooks
       SET config = $2, version = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify(config), newVersion]
    );

    // Create new version record
    await this.createVersion(id, newVersion, config, updatedBy, changeLog);

    return this.mapRow(result.rows[0]);
  }

  async updateStatus(id: string, status: ValidatorHookStatus): Promise<ValidatorHook> {
    let additionalFields = '';
    if (status === 'active') {
      additionalFields = ', activated_at = NOW()';
    } else if (status === 'deprecated') {
      additionalFields = ', deprecated_at = NOW()';
    }

    const result = await pool.query(
      `UPDATE validator_hooks
       SET status = $2, updated_at = NOW()${additionalFields}
       WHERE id = $1
       RETURNING *`,
      [id, status]
    );

    return this.mapRow(result.rows[0]);
  }

  async delete(id: string): Promise<void> {
    await pool.query(`DELETE FROM validator_hooks WHERE id = $1`, [id]);
  }

  // Version management

  async findVersions(hookId: string): Promise<ValidatorHookVersion[]> {
    const result = await pool.query(
      `SELECT * FROM validator_hook_versions WHERE hook_id = $1 ORDER BY version DESC`,
      [hookId]
    );

    return result.rows.map(this.mapVersionRow);
  }

  async findVersion(hookId: string, version: number): Promise<ValidatorHookVersion | null> {
    const result = await pool.query(
      `SELECT * FROM validator_hook_versions WHERE hook_id = $1 AND version = $2`,
      [hookId, version]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapVersionRow(result.rows[0]);
  }

  private async createVersion(
    hookId: string,
    version: number,
    config: ValidatorHookConfig,
    createdBy: string,
    changeLog: string
  ): Promise<ValidatorHookVersion> {
    const id = randomUUID();

    const result = await pool.query(
      `INSERT INTO validator_hook_versions
       (id, hook_id, version, config, status, created_at, created_by, change_log)
       VALUES ($1, $2, $3, $4, 'draft', NOW(), $5, $6)
       RETURNING *`,
      [id, hookId, version, JSON.stringify(config), createdBy, changeLog]
    );

    return this.mapVersionRow(result.rows[0]);
  }

  async rollbackToVersion(hookId: string, version: number, rolledBackBy: string): Promise<ValidatorHook> {
    const targetVersion = await this.findVersion(hookId, version);
    if (!targetVersion) {
      throw new Error(`Version ${version} not found for hook ${hookId}`);
    }

    // Create a new version with the old config
    return this.update(
      hookId,
      targetVersion.config,
      `Rolled back to version ${version}`,
      rolledBackBy
    );
  }

  private mapRow(row: any): ValidatorHook {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      description: row.description,
      type: row.type,
      version: row.version,
      status: row.status,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      activatedAt: row.activated_at ? new Date(row.activated_at) : null,
      deprecatedAt: row.deprecated_at ? new Date(row.deprecated_at) : null,
      createdBy: row.created_by,
    };
  }

  private mapVersionRow(row: any): ValidatorHookVersion {
    return {
      id: row.id,
      hookId: row.hook_id,
      version: row.version,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      status: row.status,
      createdAt: new Date(row.created_at),
      createdBy: row.created_by,
      changeLog: row.change_log,
    };
  }
}
