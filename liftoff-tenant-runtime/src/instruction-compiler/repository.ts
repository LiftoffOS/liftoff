// Instruction Compiler Repository
// Per Section 9: Persist compiled instructions with version tracking

import { pool } from '../infrastructure/database';
import {
  CompiledInstructionEntity,
  CompiledInstruction,
  ValidationResult,
  Preview,
  InstructionStatus,
} from './types';
import { v4 as uuidv4 } from 'uuid';

export class InstructionRepository {
  async create(
    tenantId: string,
    agentId: string,
    instruction: CompiledInstruction,
  ): Promise<CompiledInstructionEntity> {
    const id = uuidv4();

    // Get next version for this agent
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(version), 0) + 1 as next_version
       FROM compiled_instructions
       WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, agentId]
    );
    const version = versionResult.rows[0].next_version;

    const result = await pool.query(
      `INSERT INTO compiled_instructions
       (id, tenant_id, agent_id, version, status, instruction, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'draft', $5, NOW(), NOW())
       RETURNING *`,
      [id, tenantId, agentId, version, JSON.stringify(instruction)]
    );

    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<CompiledInstructionEntity | null> {
    const result = await pool.query(
      `SELECT * FROM compiled_instructions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async findByAgentId(
    tenantId: string,
    agentId: string,
    status?: InstructionStatus
  ): Promise<CompiledInstructionEntity[]> {
    let query = `SELECT * FROM compiled_instructions
                 WHERE tenant_id = $1 AND agent_id = $2`;
    const params: (string | InstructionStatus)[] = [tenantId, agentId];

    if (status) {
      query += ` AND status = $3`;
      params.push(status);
    }

    query += ` ORDER BY version DESC`;

    const result = await pool.query(query, params);
    return result.rows.map(this.mapRow);
  }

  async findActiveByAgentId(
    tenantId: string,
    agentId: string
  ): Promise<CompiledInstructionEntity | null> {
    const result = await pool.query(
      `SELECT * FROM compiled_instructions
       WHERE tenant_id = $1 AND agent_id = $2 AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
      [tenantId, agentId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async updateValidation(
    id: string,
    validationResult: ValidationResult
  ): Promise<void> {
    await pool.query(
      `UPDATE compiled_instructions
       SET validation_result = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(validationResult)]
    );
  }

  async updatePreview(id: string, preview: Preview): Promise<void> {
    await pool.query(
      `UPDATE compiled_instructions
       SET preview = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(preview)]
    );
  }

  async submitForApproval(id: string): Promise<void> {
    await pool.query(
      `UPDATE compiled_instructions
       SET status = 'pending_approval', updated_at = NOW()
       WHERE id = $1 AND status = 'draft'`,
      [id]
    );
  }

  async approve(id: string, approvedBy: string): Promise<void> {
    await pool.query(
      `UPDATE compiled_instructions
       SET status = 'approved', approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'pending_approval'`,
      [id, approvedBy]
    );
  }

  async reject(id: string, rejectedBy: string, reason: string): Promise<void> {
    await pool.query(
      `UPDATE compiled_instructions
       SET status = 'rejected', rejection_reason = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'pending_approval'`,
      [id, rejectedBy, reason]
    );
  }

  async activate(id: string, tenantId: string, agentId: string): Promise<void> {
    // Start a transaction to deactivate any currently active version
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Deactivate any currently active instruction for this agent
      await client.query(
        `UPDATE compiled_instructions
         SET status = 'archived', updated_at = NOW()
         WHERE tenant_id = $1 AND agent_id = $2 AND status = 'active'`,
        [tenantId, agentId]
      );

      // Activate the new version
      await client.query(
        `UPDATE compiled_instructions
         SET status = 'active', activated_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'approved'`,
        [id]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async archive(id: string): Promise<void> {
    await pool.query(
      `UPDATE compiled_instructions
       SET status = 'archived', updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  }

  private mapRow(row: any): CompiledInstructionEntity {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      version: row.version,
      status: row.status,
      instruction: typeof row.instruction === 'string'
        ? JSON.parse(row.instruction)
        : row.instruction,
      validationResult: row.validation_result
        ? (typeof row.validation_result === 'string'
            ? JSON.parse(row.validation_result)
            : row.validation_result)
        : null,
      preview: row.preview
        ? (typeof row.preview === 'string'
            ? JSON.parse(row.preview)
            : row.preview)
        : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      approvedAt: row.approved_at ? new Date(row.approved_at) : null,
      approvedBy: row.approved_by,
      activatedAt: row.activated_at ? new Date(row.activated_at) : null,
      rejectionReason: row.rejection_reason,
    };
  }
}
