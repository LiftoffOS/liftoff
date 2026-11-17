// Agent Repository
// Per Section 8: Every transition is audit-logged

import { pool } from '../infrastructure/database';
import { normalizeMemoryScope } from '../memory/scope';
import { Agent, AgentLifecycle, AgentRuntimeStatus, CreateAgentInput, TriggerConfig } from './types';

export class AgentRepository {
  async create(input: CreateAgentInput): Promise<Agent> {
    // Per Section 8: Agents start in DRAFT lifecycle state
    const result = await pool.query(
      `INSERT INTO agents (tenant_id, name, lifecycle, runtime_status)
       VALUES ($1, $2, 'DRAFT', 'IDLE') RETURNING *`,
      [input.tenantId, input.name]
    );
    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<Agent | null> {
    const result = await pool.query(`SELECT * FROM agents WHERE id = $1`, [id]);
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async updateLifecycle(id: string, lifecycle: AgentLifecycle): Promise<void> {
    // Use a dedicated client for the transaction — pool.query() doesn't pin connections
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current state for audit
      const current = await client.query(`SELECT lifecycle FROM agents WHERE id = $1`, [id]);

      // Update lifecycle
      await client.query(
        `UPDATE agents SET lifecycle = $2, updated_at = NOW() WHERE id = $1`,
        [id, lifecycle]
      );

      // Audit log
      await client.query(
        `INSERT INTO agent_audit_log (agent_id, field, old_value, new_value)
         VALUES ($1, 'lifecycle', $2, $3)`,
        [id, current.rows[0]?.lifecycle, lifecycle]
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async updateRuntimeStatus(id: string, status: AgentRuntimeStatus): Promise<void> {
    await pool.query(
      `UPDATE agents SET runtime_status = $2, updated_at = NOW() WHERE id = $1`,
      [id, status]
    );
  }

  // Phase 5: Add updateTriggerConfig method
  async updateTriggerConfig(
    id: string,
    triggerConfig: TriggerConfig | null
  ): Promise<void> {
    await pool.query(
      `UPDATE agents SET trigger_config = $1, updated_at = NOW() WHERE id = $2`,
      [triggerConfig ? JSON.stringify(triggerConfig) : null, id]
    );
  }

  // BE-007: Update mapRow to parse JSON fields
  private mapRow(row: any): Agent {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      instructionId: row.instruction_id,
      lifecycle: row.lifecycle,
      runtimeStatus: row.runtime_status,
      agentType: row.agent_type || 'agent',
      hitlLevel: row.hitl_level ?? 3,
      modelConfig: typeof row.model_config === 'string'
        ? JSON.parse(row.model_config)
        : row.model_config || {},
      execConfig: typeof row.exec_config === 'string'
        ? JSON.parse(row.exec_config)
        : row.exec_config || {},
      // See memory/scope.ts.
      memoryScope: normalizeMemoryScope(row.memory_scope),
      // Parse trigger_config JSON (BE-007)
      triggerConfig: row.trigger_config
        ? (typeof row.trigger_config === 'string'
            ? JSON.parse(row.trigger_config)
            : row.trigger_config)
        : null,
      systemPrompt: row.system_prompt || '',
      userInstructions: row.user_instructions || '',
      entityVersion: row.entity_version ?? 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
