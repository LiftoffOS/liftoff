// Rate Limiter with Token Bucket Algorithm
// Per Section 20 Phase 5: Stronger quota enforcement with burst handling

import { pool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export interface TokenBucketConfig {
  capacity: number;         // Maximum tokens (burst capacity)
  refillRate: number;       // Tokens added per second
  refillInterval: number;   // Milliseconds between refills
}

export interface RateLimitResult {
  allowed: boolean;
  remainingTokens: number;
  resetAt: Date;
  retryAfterMs?: number;
}

export interface RateLimitKey {
  tenantId: string;
  bucketType: 'actions' | 'workflows' | 'connector_writes' | 'api_requests';
  resourceId?: string; // Optional: agentId, connectorId, etc.
}

// Default configurations for different bucket types
const DEFAULT_CONFIGS: Record<string, TokenBucketConfig> = {
  actions: {
    capacity: 120,        // Can burst up to 120 actions
    refillRate: 60,       // Refills 60 tokens per second (sustained rate)
    refillInterval: 1000, // Refill every second
  },
  workflows: {
    capacity: 20,         // Can burst up to 20 workflows
    refillRate: 10,       // Refills 10 tokens per minute
    refillInterval: 6000, // Refill every 6 seconds
  },
  connector_writes: {
    capacity: 60,         // Can burst up to 60 writes
    refillRate: 30,       // Refills 30 tokens per minute
    refillInterval: 2000, // Refill every 2 seconds
  },
  api_requests: {
    capacity: 1000,       // Can burst up to 1000 requests
    refillRate: 100,      // Refills 100 tokens per second
    refillInterval: 1000, // Refill every second
  },
};

export class RateLimiter {
  private localCache: Map<string, { tokens: number; lastRefill: number }> = new Map();

  // Per Section 20 Phase 5: Token bucket rate limiting with burst support
  async checkRateLimit(key: RateLimitKey, tokensRequired: number = 1): Promise<RateLimitResult> {
    const config = await this.getConfig(key);
    const cacheKey = this.getCacheKey(key);

    // Get or create bucket state
    let bucket = this.localCache.get(cacheKey);
    const now = Date.now();

    if (!bucket) {
      // Initialize with full capacity
      bucket = {
        tokens: config.capacity,
        lastRefill: now,
      };
    } else {
      // Refill tokens based on elapsed time
      const elapsedMs = now - bucket.lastRefill;
      const refillCycles = Math.floor(elapsedMs / config.refillInterval);

      if (refillCycles > 0) {
        const tokensToAdd = refillCycles * (config.refillRate * config.refillInterval / 1000);
        bucket.tokens = Math.min(config.capacity, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;
      }
    }

    // Check if we have enough tokens
    if (bucket.tokens >= tokensRequired) {
      bucket.tokens -= tokensRequired;
      this.localCache.set(cacheKey, bucket);

      // Persist to database periodically for durability
      this.persistBucketState(key, bucket.tokens, bucket.lastRefill);

      return {
        allowed: true,
        remainingTokens: Math.floor(bucket.tokens),
        resetAt: new Date(bucket.lastRefill + config.refillInterval),
      };
    }

    // Calculate retry after
    const tokensNeeded = tokensRequired - bucket.tokens;
    const refillCyclesNeeded = Math.ceil(tokensNeeded / (config.refillRate * config.refillInterval / 1000));
    const retryAfterMs = refillCyclesNeeded * config.refillInterval;

    logger.warn('Rate limit exceeded', {
      tenantId: key.tenantId,
      bucketType: key.bucketType,
      remainingTokens: bucket.tokens,
      tokensRequired,
      retryAfterMs,
    });

    return {
      allowed: false,
      remainingTokens: Math.floor(bucket.tokens),
      resetAt: new Date(now + retryAfterMs),
      retryAfterMs,
    };
  }

  // Get multiple rate limit statuses at once
  async checkMultipleRateLimits(keys: RateLimitKey[]): Promise<Map<string, RateLimitResult>> {
    const results = new Map<string, RateLimitResult>();

    for (const key of keys) {
      results.set(this.getCacheKey(key), await this.checkRateLimit(key));
    }

    return results;
  }

  // Load bucket state from database on startup
  async loadBucketState(key: RateLimitKey): Promise<void> {
    const cacheKey = this.getCacheKey(key);

    const result = await pool.query(
      `SELECT tokens, last_refill_at FROM rate_limit_buckets
       WHERE tenant_id = $1 AND bucket_type = $2 AND resource_id = $3`,
      [key.tenantId, key.bucketType, key.resourceId || null]
    );

    if (result.rows.length > 0) {
      this.localCache.set(cacheKey, {
        tokens: parseFloat(result.rows[0].tokens),
        lastRefill: new Date(result.rows[0].last_refill_at).getTime(),
      });
    }
  }

  // Persist bucket state to database (for durability across restarts)
  private async persistBucketState(
    key: RateLimitKey,
    tokens: number,
    lastRefill: number
  ): Promise<void> {
    // Only persist periodically to reduce DB load
    const now = Date.now();
    const persistKey = `persist:${this.getCacheKey(key)}`;
    const lastPersist = this.localCache.get(persistKey);

    if (lastPersist && now - lastPersist.lastRefill < 5000) {
      return; // Don't persist more than once every 5 seconds
    }

    this.localCache.set(persistKey, { tokens: 0, lastRefill: now });

    try {
      await pool.query(
        `INSERT INTO rate_limit_buckets (tenant_id, bucket_type, resource_id, tokens, last_refill_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, bucket_type, resource_id)
         DO UPDATE SET tokens = $4, last_refill_at = $5`,
        [key.tenantId, key.bucketType, key.resourceId || null, tokens, new Date(lastRefill)]
      );
    } catch (error) {
      // Non-critical, just log
      logger.debug('Failed to persist rate limit state', { error, key });
    }
  }

  private async getConfig(key: RateLimitKey): Promise<TokenBucketConfig> {
    // Check for tenant-specific overrides
    const result = await pool.query(
      `SELECT capacity, refill_rate, refill_interval_ms FROM rate_limit_configs
       WHERE tenant_id = $1 AND bucket_type = $2`,
      [key.tenantId, key.bucketType]
    );

    if (result.rows.length > 0) {
      return {
        capacity: result.rows[0].capacity,
        refillRate: result.rows[0].refill_rate,
        refillInterval: result.rows[0].refill_interval_ms,
      };
    }

    // Fall back to defaults
    return DEFAULT_CONFIGS[key.bucketType] || DEFAULT_CONFIGS.api_requests;
  }

  private getCacheKey(key: RateLimitKey): string {
    return `${key.tenantId}:${key.bucketType}:${key.resourceId || 'default'}`;
  }

  // Clear rate limit for testing or admin override
  async clearRateLimit(key: RateLimitKey): Promise<void> {
    const cacheKey = this.getCacheKey(key);
    this.localCache.delete(cacheKey);

    await pool.query(
      `DELETE FROM rate_limit_buckets
       WHERE tenant_id = $1 AND bucket_type = $2 AND resource_id = $3`,
      [key.tenantId, key.bucketType, key.resourceId || null]
    );
  }
}

export const rateLimiter = new RateLimiter();
