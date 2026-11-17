// Soft Delete Infrastructure
// Per Section 7: Consistent soft deletes across all entities

import { pool } from './database';

// Soft delete interface that all entities should implement
export interface SoftDeletable {
  id: string;
  deletedAt: Date | null;
  deletedBy: string | null;
}

// Options for soft delete queries
export interface SoftDeleteQueryOptions {
  includeDeleted?: boolean;
}

// Base repository mixin for soft delete functionality
export abstract class SoftDeleteRepository<T extends SoftDeletable> {
  abstract readonly tableName: string;
  abstract mapRow(row: any): T;

  // Soft delete a record
  async softDelete(id: string, deletedBy: string): Promise<void> {
    await pool.query(
      `UPDATE ${this.tableName}
       SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id, deletedBy]
    );
  }

  // Restore a soft-deleted record
  async restore(id: string): Promise<void> {
    await pool.query(
      `UPDATE ${this.tableName}
       SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  // Find by ID (excludes deleted by default)
  async findById(id: string, options: SoftDeleteQueryOptions = {}): Promise<T | null> {
    const deletedFilter = options.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const result = await pool.query(
      `SELECT * FROM ${this.tableName} WHERE id = $1 ${deletedFilter}`,
      [id]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  // Find all (excludes deleted by default)
  async findAll(options: SoftDeleteQueryOptions = {}): Promise<T[]> {
    const deletedFilter = options.includeDeleted ? '' : 'WHERE deleted_at IS NULL';
    const result = await pool.query(
      `SELECT * FROM ${this.tableName} ${deletedFilter} ORDER BY created_at DESC`
    );
    return result.rows.map(this.mapRow);
  }

  // Find deleted records only
  async findDeleted(): Promise<T[]> {
    const result = await pool.query(
      `SELECT * FROM ${this.tableName} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
    );
    return result.rows.map(this.mapRow);
  }

  // Permanently delete a record (use with caution)
  async hardDelete(id: string): Promise<void> {
    await pool.query(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [id]
    );
  }

  // Bulk soft delete
  async bulkSoftDelete(ids: string[], deletedBy: string): Promise<number> {
    const result = await pool.query(
      `UPDATE ${this.tableName}
       SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
       WHERE id = ANY($1) AND deleted_at IS NULL`,
      [ids, deletedBy]
    );
    return result.rowCount || 0;
  }

  // Count active records
  async countActive(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) FROM ${this.tableName} WHERE deleted_at IS NULL`
    );
    return parseInt(result.rows[0].count, 10);
  }

  // Count deleted records
  async countDeleted(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) FROM ${this.tableName} WHERE deleted_at IS NOT NULL`
    );
    return parseInt(result.rows[0].count, 10);
  }

  // Helper for building WHERE clauses with soft delete filter
  protected buildWhereClause(
    conditions: string[],
    options: SoftDeleteQueryOptions = {}
  ): string {
    const allConditions = [...conditions];
    if (!options.includeDeleted) {
      allConditions.push('deleted_at IS NULL');
    }
    return allConditions.length > 0 ? `WHERE ${allConditions.join(' AND ')}` : '';
  }
}

// SQL migration helper for adding soft delete columns
export const SOFT_DELETE_COLUMNS = `
  deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  deleted_by TEXT DEFAULT NULL
`;

// SQL migration to add soft delete to existing table
export function generateAddSoftDeleteMigration(tableName: string): string {
  return `
    ALTER TABLE ${tableName}
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS deleted_by TEXT DEFAULT NULL;

    CREATE INDEX IF NOT EXISTS idx_${tableName}_deleted_at
    ON ${tableName} (deleted_at)
    WHERE deleted_at IS NULL;
  `;
}

// Tables that should have soft deletes
export const SOFT_DELETE_TABLES = [
  'tenants',
  'agents',
  'agent_instructions',
  'connectors',
  'model_registry',
  'prompt_registry',
  'validator_hooks',
  'meter_definitions',
  'overage_rules',
  'workflows',
  'workflow_tasks',
  'child_tasks',
  'actions',
];

// Generate full migration for all tables
export function generateFullSoftDeleteMigration(): string {
  return SOFT_DELETE_TABLES.map(generateAddSoftDeleteMigration).join('\n');
}
