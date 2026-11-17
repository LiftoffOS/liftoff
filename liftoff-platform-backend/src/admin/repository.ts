// Admin Repository
// Per Section 15: Platform kill switches

import { getPool } from '../infrastructure/database';

export interface PlatformStatus {
  id: string;
  globalWritesFrozen: boolean;
  updatedAt: Date;
}

export interface DisabledConnector {
  id: string;
  connectorType: string;
  disabledAt: Date;
  disabledBy: string;
}

export interface DisabledWorkflowType {
  id: string;
  workflowType: string;
  disabledAt: Date;
  disabledBy: string;
}

export class AdminRepository {
  // Platform status operations
  async getPlatformStatus(): Promise<PlatformStatus> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM platform_status WHERE id = 'global'`
    );
    if (!result.rows[0]) {
      // Initialize if not exists
      await pool.query(
        `INSERT INTO platform_status (id, global_writes_frozen)
         VALUES ('global', false)
         ON CONFLICT (id) DO NOTHING`
      );
      return {
        id: 'global',
        globalWritesFrozen: false,
        updatedAt: new Date(),
      };
    }
    return this.mapPlatformStatusRow(result.rows[0]);
  }

  async setGlobalWritesFrozen(frozen: boolean): Promise<PlatformStatus> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO platform_status (id, global_writes_frozen, updated_at)
       VALUES ('global', $1, NOW())
       ON CONFLICT (id)
       DO UPDATE SET global_writes_frozen = $1, updated_at = NOW()
       RETURNING *`,
      [frozen]
    );
    return this.mapPlatformStatusRow(result.rows[0]);
  }

  // Disabled connectors operations
  async getDisabledConnectors(): Promise<DisabledConnector[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM disabled_connectors ORDER BY disabled_at DESC`
    );
    return result.rows.map(this.mapDisabledConnectorRow);
  }

  async isConnectorDisabled(connectorType: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM disabled_connectors WHERE connector_type = $1`,
      [connectorType]
    );
    return result.rows.length > 0;
  }

  async disableConnector(connectorType: string, disabledBy: string): Promise<DisabledConnector> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO disabled_connectors (connector_type, disabled_by)
       VALUES ($1, $2)
       ON CONFLICT (connector_type)
       DO UPDATE SET disabled_at = NOW(), disabled_by = $2
       RETURNING *`,
      [connectorType, disabledBy]
    );
    return this.mapDisabledConnectorRow(result.rows[0]);
  }

  async enableConnector(connectorType: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM disabled_connectors WHERE connector_type = $1`,
      [connectorType]
    );
  }

  // Disabled workflow types operations
  async getDisabledWorkflowTypes(): Promise<DisabledWorkflowType[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM disabled_workflow_types ORDER BY disabled_at DESC`
    );
    return result.rows.map(this.mapDisabledWorkflowTypeRow);
  }

  async isWorkflowTypeDisabled(workflowType: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM disabled_workflow_types WHERE workflow_type = $1`,
      [workflowType]
    );
    return result.rows.length > 0;
  }

  async disableWorkflowType(workflowType: string, disabledBy: string): Promise<DisabledWorkflowType> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO disabled_workflow_types (workflow_type, disabled_by)
       VALUES ($1, $2)
       ON CONFLICT (workflow_type)
       DO UPDATE SET disabled_at = NOW(), disabled_by = $2
       RETURNING *`,
      [workflowType, disabledBy]
    );
    return this.mapDisabledWorkflowTypeRow(result.rows[0]);
  }

  async enableWorkflowType(workflowType: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM disabled_workflow_types WHERE workflow_type = $1`,
      [workflowType]
    );
  }

  private mapPlatformStatusRow(row: Record<string, unknown>): PlatformStatus {
    return {
      id: row.id as string,
      globalWritesFrozen: row.global_writes_frozen as boolean,
      updatedAt: row.updated_at as Date,
    };
  }

  private mapDisabledConnectorRow(row: Record<string, unknown>): DisabledConnector {
    return {
      id: row.id as string,
      connectorType: row.connector_type as string,
      disabledAt: row.disabled_at as Date,
      disabledBy: row.disabled_by as string,
    };
  }

  private mapDisabledWorkflowTypeRow(row: Record<string, unknown>): DisabledWorkflowType {
    return {
      id: row.id as string,
      workflowType: row.workflow_type as string,
      disabledAt: row.disabled_at as Date,
      disabledBy: row.disabled_by as string,
    };
  }
}
