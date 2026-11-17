// Sandbox Usage Repository
// Writes to sandbox_usage_log and atomically increments invocations.sandbox_cost_credits.
// Resolved: DE-004 — transactional guarantee, DE-012 — idempotency key, DE-011 — running counter.

import { getPoolForService } from '../infrastructure/database';
import { SandboxUsageRecord } from './types';
import { log } from '../infrastructure/logging';

const pool = getPoolForService('default');

export class SandboxUsageRepository {
  /**
   * Record sandbox usage and atomically increment the invocation running counter.
   * Single transaction: insert usage log + increment sandbox_cost_credits.
   * Idempotent via ON CONFLICT DO NOTHING on idempotency_key.
   */
  async recordUsage(record: SandboxUsageRecord): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert usage log with idempotency key (Resolved: DE-012)
      const insertResult = await client.query(
        `INSERT INTO sandbox_usage_log
          (tenant_id, invocation_id, agent_id, sandbox_id, phase, tool_name,
           cpu_millis, memory_mb_seconds, egress_bytes, wall_clock_ms,
           credits_consumed, template, exit_code, idempotency_key, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
         ON CONFLICT (idempotency_key, timestamp) DO NOTHING`,
        [
          record.tenantId,
          record.invocationId,
          record.agentId,
          record.sandboxId,
          record.phase,
          record.toolName,
          record.cpuMillis,
          record.memoryMbSeconds,
          record.egressBytes,
          record.wallClockMs,
          record.creditsConsumed,
          record.template,
          record.exitCode,
          record.idempotencyKey,
        ],
      );

      // Only increment running counter if the insert actually happened
      // (not a duplicate via ON CONFLICT DO NOTHING)
      if (insertResult.rowCount && insertResult.rowCount > 0) {
        // Atomically increment running counter on invocation (Resolved: DE-011)
        await client.query(
          `UPDATE invocations
           SET sandbox_cost_credits = sandbox_cost_credits + $1
           WHERE id = $2`,
          [record.creditsConsumed, record.invocationId],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      log.error({
        message: 'Failed to record sandbox usage',
        invocationId: record.invocationId,
        sandboxId: record.sandboxId,
        error: (err as Error).message,
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get total credits consumed by a sandbox.
   */
  async getTotalCredits(sandboxId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COALESCE(SUM(credits_consumed), 0) as total
       FROM sandbox_usage_log WHERE sandbox_id = $1`,
      [sandboxId],
    );
    return parseInt(result.rows[0].total, 10);
  }
}
