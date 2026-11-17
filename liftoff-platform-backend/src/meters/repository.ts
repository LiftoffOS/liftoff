// Meter Repository
// Per Section 13: Control plane owns meter definitions

import { getPool } from '../infrastructure/database';
import { MeterDefinition, CreateMeterInput, UpdateMeterInput } from './types';

export class MeterRepository {
  async findAll(): Promise<MeterDefinition[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM meter_definitions ORDER BY name ASC`
    );
    return result.rows.map(this.mapRow);
  }

  async findById(id: string): Promise<MeterDefinition | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM meter_definitions WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByName(name: string): Promise<MeterDefinition | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM meter_definitions WHERE name = $1`,
      [name]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByStripeMeterId(stripeMeterId: string): Promise<MeterDefinition | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM meter_definitions WHERE stripe_meter_id = $1`,
      [stripeMeterId]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async create(input: CreateMeterInput): Promise<MeterDefinition> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO meter_definitions (name, stripe_meter_id, unit, aggregation_type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.name, input.stripeMeterId || null, input.unit, input.aggregationType]
    );
    return this.mapRow(result.rows[0]);
  }

  async update(id: string, input: UpdateMeterInput): Promise<MeterDefinition> {
    const pool = getPool();
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.stripeMeterId !== undefined) {
      setClauses.push(`stripe_meter_id = $${paramIndex++}`);
      values.push(input.stripeMeterId);
    }
    if (input.unit !== undefined) {
      setClauses.push(`unit = $${paramIndex++}`);
      values.push(input.unit);
    }
    if (input.aggregationType !== undefined) {
      setClauses.push(`aggregation_type = $${paramIndex++}`);
      values.push(input.aggregationType);
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE meter_definitions SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (!result.rows[0]) {
      throw new Error(`Meter definition not found: ${id}`);
    }

    return this.mapRow(result.rows[0]);
  }

  async delete(id: string): Promise<void> {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM meter_definitions WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      throw new Error(`Meter definition not found: ${id}`);
    }
  }

  private mapRow(row: Record<string, unknown>): MeterDefinition {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) || '',
      stripeMeterId: row.stripe_meter_id as string | null,
      unit: row.unit as string,
      aggregationType: row.aggregation_type as 'sum' | 'max' | 'last' | 'count',
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
