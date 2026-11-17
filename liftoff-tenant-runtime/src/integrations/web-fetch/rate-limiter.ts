const LIMITS_PER_HOUR: Record<string, number> = {
  web_fetch_advanced:    200,
  web_extract:           50,
  web_task:              10,
  web_research:          5,
  web_diff:              20,
  web_identity_connect:  10,
  web_session_save:      10,
};

export class WebToolRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  checkRateLimit(
    tenantId: string,
    agentId: string,
    toolName: string,
  ): { ok: boolean; resetAt?: number } {
    const limit = LIMITS_PER_HOUR[toolName];
    if (!limit) return { ok: true };
    const key = `${tenantId}:${agentId}:${toolName}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      this.buckets.set(key, { count: 1, resetAt: now + 3_600_000 });
      return { ok: true };
    }
    if (bucket.count >= limit) {
      return { ok: false, resetAt: bucket.resetAt };
    }
    bucket.count++;
    return { ok: true };
  }

  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [k, b] of this.buckets) {
      if (b.resetAt < now) { this.buckets.delete(k); pruned++; }
    }
    return pruned;
  }
}

export const webToolRateLimiter = new WebToolRateLimiter();
