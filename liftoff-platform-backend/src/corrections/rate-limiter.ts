// Correction Rate Limiter
// Per implementation plan: Rate limiting logic for correction operations

import { correctionRepository } from './repository';
import { RateLimitCheckResult } from './types';

/**
 * Check if a tenant is within rate limits for corrections.
 *
 * Superseded in production by checkAndIncrementRateLimit (BE-001, atomic);
 * kept underscore-prefixed for its tests only.
 */
export async function _checkRateLimit(tenantId: string): Promise<RateLimitCheckResult> {
  const limits = await correctionRepository.getRateLimits(tenantId);

  // Get current usage for each window
  const [minuteUsage, hourUsage, dayUsage] = await Promise.all([
    correctionRepository.getRateUsage(tenantId, 'minute'),
    correctionRepository.getRateUsage(tenantId, 'hour'),
    correctionRepository.getRateUsage(tenantId, 'day'),
  ]);

  // Check minute limit
  if (minuteUsage >= limits.maxPerMinute) {
    const secondsIntoMinute = new Date().getSeconds();
    return {
      allowed: false,
      retryAfter: 60 - secondsIntoMinute,
      remaining: {
        minute: 0,
        hour: Math.max(0, limits.maxPerHour - hourUsage),
        day: Math.max(0, limits.maxPerDay - dayUsage),
      },
    };
  }

  // Check hour limit
  if (hourUsage >= limits.maxPerHour) {
    const minutesIntoHour = new Date().getMinutes();
    return {
      allowed: false,
      retryAfter: (60 - minutesIntoHour) * 60,
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - minuteUsage),
        hour: 0,
        day: Math.max(0, limits.maxPerDay - dayUsage),
      },
    };
  }

  // Check day limit
  if (dayUsage >= limits.maxPerDay) {
    const now = new Date();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const secondsUntilEndOfDay = Math.floor((endOfDay.getTime() - now.getTime()) / 1000);

    return {
      allowed: false,
      retryAfter: secondsUntilEndOfDay,
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - minuteUsage),
        hour: Math.max(0, limits.maxPerHour - hourUsage),
        day: 0,
      },
    };
  }

  return {
    allowed: true,
    remaining: {
      minute: limits.maxPerMinute - minuteUsage,
      hour: limits.maxPerHour - hourUsage,
      day: limits.maxPerDay - dayUsage,
    },
  };
}

/**
 * Increment rate usage counters for a tenant
 * Should be called after a correction is successfully requested
 */
export async function incrementRateUsage(tenantId: string): Promise<void> {
  await correctionRepository.incrementRateUsage(tenantId);
}

/**
 * Check rate limit for bulk corrections
 * Checks if the total count would exceed limits
 */
export async function checkBulkRateLimit(
  tenantId: string,
  count: number
): Promise<RateLimitCheckResult> {
  const limits = await correctionRepository.getRateLimits(tenantId);

  const [minuteUsage, hourUsage, dayUsage] = await Promise.all([
    correctionRepository.getRateUsage(tenantId, 'minute'),
    correctionRepository.getRateUsage(tenantId, 'hour'),
    correctionRepository.getRateUsage(tenantId, 'day'),
  ]);

  // Check if bulk would exceed minute limit
  if (minuteUsage + count > limits.maxPerMinute) {
    const secondsIntoMinute = new Date().getSeconds();
    return {
      allowed: false,
      retryAfter: 60 - secondsIntoMinute,
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - minuteUsage),
        hour: Math.max(0, limits.maxPerHour - hourUsage),
        day: Math.max(0, limits.maxPerDay - dayUsage),
      },
    };
  }

  // Check if bulk would exceed hour limit
  if (hourUsage + count > limits.maxPerHour) {
    const minutesIntoHour = new Date().getMinutes();
    return {
      allowed: false,
      retryAfter: (60 - minutesIntoHour) * 60,
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - minuteUsage),
        hour: Math.max(0, limits.maxPerHour - hourUsage),
        day: Math.max(0, limits.maxPerDay - dayUsage),
      },
    };
  }

  // Check if bulk would exceed day limit
  if (dayUsage + count > limits.maxPerDay) {
    const now = new Date();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const secondsUntilEndOfDay = Math.floor((endOfDay.getTime() - now.getTime()) / 1000);

    return {
      allowed: false,
      retryAfter: secondsUntilEndOfDay,
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - minuteUsage),
        hour: Math.max(0, limits.maxPerHour - hourUsage),
        day: Math.max(0, limits.maxPerDay - dayUsage),
      },
    };
  }

  return {
    allowed: true,
    remaining: {
      minute: limits.maxPerMinute - minuteUsage - count,
      hour: limits.maxPerHour - hourUsage - count,
      day: limits.maxPerDay - dayUsage - count,
    },
  };
}

/**
 * BE-001: Atomically check and increment rate usage
 * Eliminates TOCTOU race condition between check and increment
 */
export async function checkAndIncrementRateLimit(tenantId: string): Promise<RateLimitCheckResult> {
  // Get limits once at the start
  const limits = await correctionRepository.getRateLimits(tenantId);
  const result = await correctionRepository.checkAndIncrementRateUsage(tenantId);

  if (!result.allowed) {
    const secondsIntoMinute = new Date().getSeconds();

    return {
      allowed: false,
      retryAfter: 60 - secondsIntoMinute,
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - result.usage.minute),
        hour: Math.max(0, limits.maxPerHour - result.usage.hour),
        day: Math.max(0, limits.maxPerDay - result.usage.day),
      },
    };
  }

  return {
    allowed: true,
    remaining: {
      minute: limits.maxPerMinute - result.usage.minute,
      hour: limits.maxPerHour - result.usage.hour,
      day: limits.maxPerDay - result.usage.day,
    },
  };
}

/**
 * BE-001: Atomically check and increment bulk rate usage
 */
export async function checkAndIncrementBulkRateLimit(
  tenantId: string,
  count: number
): Promise<RateLimitCheckResult> {
  // Get limits once at the start
  const limits = await correctionRepository.getRateLimits(tenantId);
  const result = await correctionRepository.checkAndIncrementBulkRateUsage(tenantId, count);

  if (!result.allowed) {
    const secondsIntoMinute = new Date().getSeconds();

    return {
      allowed: false,
      retryAfter: 60 - secondsIntoMinute,
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - result.usage.minute),
        hour: Math.max(0, limits.maxPerHour - result.usage.hour),
        day: Math.max(0, limits.maxPerDay - result.usage.day),
      },
    };
  }

  return {
    allowed: true,
    remaining: {
      minute: limits.maxPerMinute - result.usage.minute,
      hour: limits.maxPerHour - result.usage.hour,
      day: limits.maxPerDay - result.usage.day,
    },
  };
}
