// Autonomous Loop Controller
// Chains multiple agent invocations for long-running tasks.
// Each iteration: execute → check if done → pass context forward → repeat.
// Budget and iteration limits enforced across the chain.

import { v4 as uuid } from 'uuid';
import { getPoolForService } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const pool = getPoolForService('default');

// ─── Types ──────────────────────────────────────────────────────────────────

export type LoopStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

export interface LoopConfig {
  tenantId: string;
  agentId: string;
  objective: string;
  maxIterations: number;
  cooldownMs: number;
  budgetCredits: number;
  sandboxId?: string;
  triggeredBy: string;
}

export interface LoopState {
  id: string;
  tenantId: string;
  agentId: string;
  objective: string;
  status: LoopStatus;
  iterationCount: number;
  maxIterations: number;
  cooldownMs: number;
  budgetCredits: number;
  usedCredits: number;
  sandboxId: string | null;
  lastInvocationId: string | null;
  lastOutcome: string | null;
  lastOutputSummary: string | null;
  stopReason: string | null;
  triggeredBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IterationResult {
  invocationId: string;
  outcome: 'success' | 'error' | 'escalated';
  outputSummary: string | null;
  creditsUsed: number;
  shouldContinue: boolean;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class AutonomousLoopController {
  /**
   * Start a new autonomous loop.
   */
  async startLoop(config: LoopConfig): Promise<LoopState> {
    const id = uuid();

    await pool.query(
      `INSERT INTO autonomous_loop_states
        (id, tenant_id, agent_id, objective, status, iteration_count, max_iterations,
         cooldown_ms, budget_credits, used_credits, sandbox_id, triggered_by)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6, $7, 0, $8, $9)`,
      [id, config.tenantId, config.agentId, config.objective,
       config.maxIterations, config.cooldownMs, config.budgetCredits,
       config.sandboxId ?? null, config.triggeredBy],
    );

    log.info({
      message: 'Autonomous loop started',
      loopId: id,
      agentId: config.agentId,
      maxIterations: config.maxIterations,
      budgetCredits: config.budgetCredits,
    });

    return this.getLoop(id);
  }

  /**
   * Record the result of an iteration and determine whether to continue.
   * Called after each agent invocation completes.
   */
  async recordIteration(loopId: string, result: IterationResult): Promise<{ shouldContinue: boolean; nextCooldownMs: number }> {
    const loop = await this.getLoop(loopId);

    if (loop.status !== 'running' && loop.status !== 'pending') {
      return { shouldContinue: false, nextCooldownMs: 0 };
    }

    const newIteration = loop.iterationCount + 1;
    const newUsedCredits = loop.usedCredits + result.creditsUsed;

    // Check stop conditions
    let shouldContinue = result.shouldContinue;
    let stopReason: string | null = null;
    let newStatus: LoopStatus = 'running';

    if (newIteration >= loop.maxIterations) {
      shouldContinue = false;
      stopReason = `Max iterations reached (${loop.maxIterations})`;
      newStatus = 'completed';
    } else if (newUsedCredits >= loop.budgetCredits) {
      shouldContinue = false;
      stopReason = `Budget exhausted (${newUsedCredits}/${loop.budgetCredits} credits)`;
      newStatus = 'completed';
    } else if (result.outcome === 'escalated') {
      shouldContinue = false;
      stopReason = 'Agent escalated to human';
      newStatus = 'paused';
    } else if (result.outcome === 'error' && !result.shouldContinue) {
      stopReason = 'Agent reported error';
      newStatus = 'failed';
    } else if (!result.shouldContinue) {
      stopReason = 'Agent reported task complete';
      newStatus = 'completed';
    }

    await pool.query(
      `UPDATE autonomous_loop_states
       SET iteration_count = $2, used_credits = $3, last_invocation_id = $4,
           last_outcome = $5, last_output_summary = $6, stop_reason = $7,
           status = $8, updated_at = NOW()
       WHERE id = $1`,
      [loopId, newIteration, newUsedCredits, result.invocationId,
       result.outcome, result.outputSummary, stopReason, newStatus],
    );

    log.info({
      message: 'Loop iteration recorded',
      loopId,
      iteration: newIteration,
      outcome: result.outcome,
      shouldContinue,
      stopReason,
      creditsUsed: newUsedCredits,
    });

    return { shouldContinue, nextCooldownMs: loop.cooldownMs };
  }

  /**
   * Mark a running loop as 'running' before executing an iteration.
   */
  async markRunning(loopId: string): Promise<void> {
    await pool.query(
      `UPDATE autonomous_loop_states SET status = 'running', updated_at = NOW() WHERE id = $1`,
      [loopId],
    );
  }

  /**
   * Stop a loop (user-initiated via Slack "stop" command).
   */
  async stopLoop(loopId: string, reason?: string): Promise<void> {
    await pool.query(
      `UPDATE autonomous_loop_states
       SET status = 'stopped', stop_reason = $2, updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'running', 'paused')`,
      [loopId, reason ?? 'User requested stop'],
    );

    log.info({ message: 'Loop stopped', loopId, reason });
  }

  /**
   * Resume a paused loop.
   */
  async resumeLoop(loopId: string): Promise<void> {
    await pool.query(
      `UPDATE autonomous_loop_states
       SET status = 'pending', stop_reason = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'paused'`,
      [loopId],
    );
  }

  /**
   * Get loop state by ID.
   */
  async getLoop(loopId: string): Promise<LoopState> {
    const result = await pool.query(
      `SELECT * FROM autonomous_loop_states WHERE id = $1`,
      [loopId],
    );

    if (result.rows.length === 0) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    return this.mapRow(result.rows[0]);
  }

  /**
   * Get active loop for an agent (at most one active loop per agent).
   */
  async getActiveLoop(tenantId: string, agentId: string): Promise<LoopState | null> {
    const result = await pool.query(
      `SELECT * FROM autonomous_loop_states
       WHERE tenant_id = $1 AND agent_id = $2 AND status IN ('pending', 'running', 'paused')
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, agentId],
    );

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Find loops that need their next iteration executed.
   * Used by the loop scheduler to pick up work.
   */
  async findLoopsNeedingExecution(): Promise<LoopState[]> {
    const result = await pool.query(
      `SELECT * FROM autonomous_loop_states
       WHERE status = 'pending'
       OR (status = 'running' AND updated_at < NOW() - INTERVAL '1 millisecond' * cooldown_ms)
       ORDER BY updated_at ASC
       LIMIT 10`,
    );

    return result.rows.map((r: Record<string, unknown>) => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): LoopState {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      agentId: row.agent_id as string,
      objective: row.objective as string,
      status: row.status as LoopStatus,
      iterationCount: parseInt(row.iteration_count as string, 10),
      maxIterations: parseInt(row.max_iterations as string, 10),
      cooldownMs: parseInt(row.cooldown_ms as string, 10),
      budgetCredits: parseInt(row.budget_credits as string, 10),
      usedCredits: parseInt(row.used_credits as string, 10),
      sandboxId: row.sandbox_id as string | null,
      lastInvocationId: row.last_invocation_id as string | null,
      lastOutcome: row.last_outcome as string | null,
      lastOutputSummary: row.last_output_summary as string | null,
      stopReason: row.stop_reason as string | null,
      triggeredBy: row.triggered_by as string,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
