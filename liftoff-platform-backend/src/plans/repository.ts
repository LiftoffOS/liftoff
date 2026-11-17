// Plan Repository
// Per Section 13: Control plane owns plans

import { getPool } from '../infrastructure/database';
import { Plan, CreatePlanInput, UpdatePlanInput } from './types';
import { randomUUID } from 'crypto';

export class PlanRepository {
  async findAll(): Promise<Plan[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, name, description, stripe_price_id, included_credits,
              overage_allowed, overage_rate, status, created_at, updated_at
       FROM plans
       ORDER BY created_at DESC`
    );

    return result.rows.map(this.mapRow);
  }

  async findActive(): Promise<Plan[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, name, description, stripe_price_id, included_credits,
              overage_allowed, overage_rate, status, created_at, updated_at
       FROM plans
       WHERE status = 'active'
       ORDER BY included_credits ASC`
    );

    return result.rows.map(this.mapRow);
  }

  async findById(id: string): Promise<Plan | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, name, description, stripe_price_id, included_credits,
              overage_allowed, overage_rate, status, created_at, updated_at
       FROM plans
       WHERE id = $1`,
      [id]
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByStripePriceId(stripePriceId: string): Promise<Plan | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, name, description, stripe_price_id, included_credits,
              overage_allowed, overage_rate, status, created_at, updated_at
       FROM plans
       WHERE stripe_price_id = $1`,
      [stripePriceId]
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async create(input: CreatePlanInput): Promise<Plan> {
    const pool = getPool();
    const id = randomUUID();

    const result = await pool.query(
      `INSERT INTO plans (
        id, name, description, stripe_price_id, included_credits,
        overage_allowed, overage_rate, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW())
      RETURNING *`,
      [
        id,
        input.name,
        input.description,
        input.stripePriceId,
        input.includedCredits,
        input.overageAllowed,
        input.overageRate,
      ]
    );

    return this.mapRow(result.rows[0]);
  }

  async update(id: string, input: UpdatePlanInput): Promise<Plan> {
    const pool = getPool();
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(input.description);
    }
    if (input.stripePriceId !== undefined) {
      setClauses.push(`stripe_price_id = $${paramIndex++}`);
      values.push(input.stripePriceId);
    }
    if (input.includedCredits !== undefined) {
      setClauses.push(`included_credits = $${paramIndex++}`);
      values.push(input.includedCredits);
    }
    if (input.overageAllowed !== undefined) {
      setClauses.push(`overage_allowed = $${paramIndex++}`);
      values.push(input.overageAllowed);
    }
    if (input.overageRate !== undefined) {
      setClauses.push(`overage_rate = $${paramIndex++}`);
      values.push(input.overageRate);
    }
    if (input.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE plans SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (!result.rows[0]) {
      throw new Error(`Plan not found: ${id}`);
    }

    return this.mapRow(result.rows[0]);
  }

  async archive(id: string): Promise<Plan> {
    return this.update(id, { status: 'archived' });
  }

  private mapRow(row: Record<string, unknown>): Plan {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      stripePriceId: row.stripe_price_id as string,
      includedCredits: row.included_credits as number,
      overageAllowed: row.overage_allowed as boolean,
      overageRate: row.overage_rate as number,
      status: row.status as 'active' | 'archived',
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
