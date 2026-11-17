// Sandbox Rate Limiter
// Enforces per-agent, per-tenant, and per-sandbox rate limits.
// Resolved: SE-014 — no rate limiting on sandbox creation or shell_exec calls.

import { getPoolForService } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { DEFAULT_SANDBOX_RATE_LIMITS, SandboxRateLimits } from './types';

const pool = getPoolForService('default');

export class SandboxRateLimiter {
  private readonly limits: SandboxRateLimits;

  // In-memory counters for per-sandbox exec rate limiting (short-lived, per-instance)
  private readonly execCounts = new Map<string, { count: number; windowStart: number }>();

  constructor(limits?: Partial<SandboxRateLimits>) {
    this.limits = { ...DEFAULT_SANDBOX_RATE_LIMITS, ...limits };
  }

  /**
   * Check if a new sandbox can be created for this agent/tenant.
   * Queries sandbox_state for active sandboxes.
   */
  async checkCreationAllowed(tenantId: string, agentId: string): Promise<{ allowed: boolean; reason?: string }> {
    // Check per-agent concurrent limit
    const agentResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM sandbox_state
       WHERE tenant_id = $1 AND agent_id = $2
       AND status NOT IN ('destroyed', 'error')`,
      [tenantId, agentId],
    );
    const agentCount = parseInt(agentResult.rows[0].cnt, 10);
    if (agentCount >= this.limits.maxConcurrentPerAgent) {
      return {
        allowed: false,
        reason: `Agent has ${agentCount} active sandbox(es), limit is ${this.limits.maxConcurrentPerAgent}`,
      };
    }

    // Check per-tenant concurrent limit
    const tenantResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM sandbox_state
       WHERE tenant_id = $1
       AND status NOT IN ('destroyed', 'error')`,
      [tenantId],
    );
    const tenantCount = parseInt(tenantResult.rows[0].cnt, 10);
    if (tenantCount >= this.limits.maxConcurrentPerTenant) {
      return {
        allowed: false,
        reason: `Tenant has ${tenantCount} active sandbox(es), limit is ${this.limits.maxConcurrentPerTenant}`,
      };
    }

    // Check per-tenant hourly creation rate
    const hourlyResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM sandbox_state
       WHERE tenant_id = $1
       AND created_at > NOW() - INTERVAL '1 hour'`,
      [tenantId],
    );
    const hourlyCount = parseInt(hourlyResult.rows[0].cnt, 10);
    if (hourlyCount >= this.limits.maxCreationsPerHourPerTenant) {
      return {
        allowed: false,
        reason: `Tenant created ${hourlyCount} sandbox(es) in the last hour, limit is ${this.limits.maxCreationsPerHourPerTenant}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if an exec call is allowed for this sandbox (per-minute rate limit).
   * Uses in-memory counters — acceptable because rate limiting is per-instance.
   */
  checkExecAllowed(sandboxId: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute window

    const entry = this.execCounts.get(sandboxId);
    if (!entry || now - entry.windowStart > windowMs) {
      // New window
      this.execCounts.set(sandboxId, { count: 1, windowStart: now });
      return { allowed: true };
    }

    if (entry.count >= this.limits.maxExecPerMinutePerSandbox) {
      log.warn({
        message: 'Sandbox exec rate limit exceeded',
        sandboxId,
        count: entry.count,
        limit: this.limits.maxExecPerMinutePerSandbox,
      });
      return {
        allowed: false,
        reason: `Sandbox has ${entry.count} exec calls in the last minute, limit is ${this.limits.maxExecPerMinutePerSandbox}`,
      };
    }

    entry.count++;
    return { allowed: true };
  }

  /**
   * Clean up rate limit state for a destroyed sandbox.
   */
  clearSandbox(sandboxId: string): void {
    this.execCounts.delete(sandboxId);
  }
}
