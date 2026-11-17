// Rate Limit Middleware
// Per Section 20 Phase 5: Rate limiting at API gateway level

import { Request, Response, NextFunction } from 'express';
import { rateLimiter, RateLimitKey } from '../admission/rate-limiter';
import { logger } from '../infrastructure/logging';

export interface RateLimitMiddlewareOptions {
  bucketType: 'actions' | 'workflows' | 'connector_writes' | 'api_requests';
  tokensRequired?: number;
  keyExtractor?: (req: Request) => RateLimitKey;
  onRateLimited?: (req: Request, res: Response, result: any) => void;
}

// Create rate limit middleware for a specific resource type
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions) {
  const {
    bucketType,
    tokensRequired = 1,
    keyExtractor = defaultKeyExtractor(bucketType),
    onRateLimited = defaultOnRateLimited,
  } = options;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const key = keyExtractor(req);

      const result = await rateLimiter.checkRateLimit(key, tokensRequired);

      // Add rate limit headers
      res.set('X-RateLimit-Limit', String(result.remainingTokens + tokensRequired));
      res.set('X-RateLimit-Remaining', String(result.remainingTokens));
      res.set('X-RateLimit-Reset', result.resetAt.toISOString());

      if (!result.allowed) {
        onRateLimited(req, res, result);
        return;
      }

      next();
    } catch (error) {
      logger.error('Rate limit middleware error', { error });
      // Fail open - allow request on error
      next();
    }
  };
}

function defaultKeyExtractor(bucketType: string) {
  return (req: Request): RateLimitKey => {
    // Extract tenant ID from various sources
    const tenantId =
      req.headers['x-tenant-id'] as string ||
      req.params.tenantId ||
      req.body?.tenantId ||
      req.query.tenantId as string ||
      'unknown';

    // Extract resource ID for more granular limiting
    const resourceId = req.headers['x-agent-id'] as string || req.params.agentId;

    return {
      tenantId,
      bucketType: bucketType as any,
      resourceId,
    };
  };
}

function defaultOnRateLimited(req: Request, res: Response, result: any): void {
  res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));

  logger.warn('Request rate limited', {
    tenantId: req.headers['x-tenant-id'],
    path: req.path,
    retryAfterMs: result.retryAfterMs,
    remainingTokens: result.remainingTokens,
  });

  res.status(429).json({
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Please retry after the specified time.',
    retryAfterMs: result.retryAfterMs,
    retryAfter: Math.ceil(result.retryAfterMs / 1000),
    resetAt: result.resetAt.toISOString(),
  });
}

// Pre-configured middleware for common use cases
export const actionRateLimitMiddleware = createRateLimitMiddleware({
  bucketType: 'actions',
  tokensRequired: 1,
});

export const workflowRateLimitMiddleware = createRateLimitMiddleware({
  bucketType: 'workflows',
  tokensRequired: 1,
});

export const connectorWriteRateLimitMiddleware = createRateLimitMiddleware({
  bucketType: 'connector_writes',
  tokensRequired: 1,
});

export const apiRequestRateLimitMiddleware = createRateLimitMiddleware({
  bucketType: 'api_requests',
  tokensRequired: 1,
});

// Sliding window rate limiter for more precise control
export function createSlidingWindowMiddleware(
  windowMs: number,
  maxRequests: number,
  keyExtractor?: (req: Request) => string
) {
  const windowStore = new Map<string, { count: number; startTime: number }>();

  return async function slidingWindowMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const key = keyExtractor
      ? keyExtractor(req)
      : `${req.headers['x-tenant-id'] || 'unknown'}:${req.path}`;

    const now = Date.now();
    let window = windowStore.get(key);

    if (!window || now - window.startTime > windowMs) {
      // Start new window
      window = { count: 1, startTime: now };
    } else {
      window.count++;
    }

    windowStore.set(key, window);

    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - window.count)));
    res.set('X-RateLimit-Reset', new Date(window.startTime + windowMs).toISOString());

    if (window.count > maxRequests) {
      const retryAfterMs = windowMs - (now - window.startTime);
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));

      logger.warn('Sliding window rate limit exceeded', {
        key,
        count: window.count,
        maxRequests,
        retryAfterMs,
      });

      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please retry after the specified time.',
        retryAfterMs,
        retryAfter: Math.ceil(retryAfterMs / 1000),
      });
      return;
    }

    next();
  };
}

// Cleanup expired windows periodically
setInterval(() => {
  // This would clean up the window store in a real implementation
  // For production, use Redis or similar for distributed rate limiting
}, 60000);
