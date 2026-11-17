// Subscription Repository
// Per Section 13: Stripe subscriptions for commercial plan

import { getPool } from '../infrastructure/database';
import { Subscription } from './types';

export interface CreateSubscriptionData {
  accountId: string;
  planId: string;
  stripeSubscriptionId: string;
  status: string;
}

export interface UpdateSubscriptionData {
  status?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
}

export class SubscriptionRepository {
  async create(input: CreateSubscriptionData): Promise<Subscription> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO subscriptions (account_id, plan_id, stripe_subscription_id, status, version)
       VALUES ($1, $2, $3, $4, 1)
       RETURNING *`,
      [input.accountId, input.planId, input.stripeSubscriptionId, input.status]
    );
    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<Subscription | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM subscriptions WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByStripeId(stripeSubscriptionId: string): Promise<Subscription | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM subscriptions WHERE stripe_subscription_id = $1`,
      [stripeSubscriptionId]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByStripeCustomerId(customerId: string): Promise<Subscription | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM subscriptions WHERE stripe_customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [customerId]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByAccountId(accountId: string): Promise<Subscription[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM subscriptions WHERE account_id = $1 ORDER BY created_at DESC`,
      [accountId]
    );
    return result.rows.map(this.mapRow);
  }

  async findActiveByAccountId(accountId: string): Promise<Subscription | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM subscriptions WHERE account_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [accountId]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async updateStatus(id: string, status: string): Promise<Subscription> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE subscriptions SET status = $2, version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (!result.rows[0]) {
      throw new Error(`Subscription not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async updateByStripeId(stripeSubscriptionId: string, data: UpdateSubscriptionData): Promise<Subscription> {
    const pool = getPool();
    const updates: string[] = ['updated_at = NOW()', 'version = version + 1'];
    const values: unknown[] = [];
    let paramCount = 1;

    if (data.status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(data.status);
    }
    if (data.currentPeriodStart !== undefined) {
      updates.push(`current_period_start = $${paramCount++}`);
      values.push(data.currentPeriodStart);
    }
    if (data.currentPeriodEnd !== undefined) {
      updates.push(`current_period_end = $${paramCount++}`);
      values.push(data.currentPeriodEnd);
    }

    values.push(stripeSubscriptionId);

    const result = await pool.query(
      `UPDATE subscriptions SET ${updates.join(', ')} WHERE stripe_subscription_id = $${paramCount} RETURNING *`,
      values
    );

    if (!result.rows[0]) {
      throw new Error(`Subscription not found for Stripe ID: ${stripeSubscriptionId}`);
    }
    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: Record<string, unknown>): Subscription {
    return {
      id: row.id as string,
      accountId: row.account_id as string,
      planId: row.plan_id as string,
      stripeSubscriptionId: row.stripe_subscription_id as string,
      status: row.status as string,
      version: row.version as number,
      currentPeriodStart: row.current_period_start as Date,
      currentPeriodEnd: row.current_period_end as Date,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
