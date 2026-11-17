// CAIO chat rate limiter.
//
// Per-tenant + per-user throttle for the workforce-planning chat, backed by
// team_plan_rate_limit_events (migration 002).
//
// WHY THIS EXISTS NOW
// -------------------
// The table has existed since migration 002 with exactly the shape the
// platform-backend limiter wants, and platform-backend's shared limiter has
// carried 'team_plan_rate_limit_events' on its allow-list all along, but the
// call site never came across with the extraction: chat-stream-router.ts held
// only `const _TEAM_PLAN_RATE_LIMIT_TABLE = '...'`, unused, its underscore
// added later by a lint pass. So the CAIO chat has run with no limit of any
// kind. That was survivable while the surface refused unpaid tenants outright.
// It is not survivable now that it serves them: CAIO planning is classified
// platform_overhead in cost-attribution, meaning Liftoff absorbs the spend, so
// an unthrottled surface is unthrottled spend on our side of the ledger.
//
// WHY A LOCAL COPY AND NOT THE SHARED ONE
// ---------------------------------------
// platform-backend's src/common/chat-rate-limiter.ts is the reference for this
// file, but it cannot be imported: it queries platform-backend's own database
// (liftoff_control_plane) and this service runs against a different database
// (workforce) on the same instance. The ledger table lives here, so the query
// has to run here.
//
// Two deliberate simplifications over the reference:
//   * No ALLOWED_TABLES set. The reference takes the table name as an argument
//     and interpolates it into SQL, so it needs an allow-list to stop
//     injection. Here the table is a module constant and never comes from a
//     caller, so there is nothing to validate.
//   * No `limits` override parameter. One surface, one set of caps. Add the
//     parameter when a second caller needs different ones.
//
// FAIL-OPEN, AND THE ONE THING THAT MUST NOT
// ------------------------------------------
// A database fault fails open: better to let a turn through than to take the
// whole surface down because the ledger hiccuped. A malformed identifier does
// NOT fail open — see requireUuid. That distinction is load-bearing and is
// carried over deliberately; the reference documents a surface that passed a
// Firebase uid into these UUID columns and therefore had no rate limit at all
// from the day it shipped, reported once per request as a database error that
// nobody read as a caller bug. This service takes account_id straight off an
// x-account-id header, so it is exactly the shape of caller that makes that
// mistake.

import { withTenantContext } from '../infrastructure/rls.js';
import { log } from '../infrastructure/logging.js';

const TEAM_PLAN_RATE_LIMIT_TABLE = 'team_plan_rate_limit_events';

/** Window caps, matching platform-backend's DEFAULT_CHAT_RATE_LIMITS so the
 *  CAIO chat throttles on the same curve as the Liftoff and insights chats. */
export const TEAM_PLAN_RATE_LIMITS = {
  tenant: { maxPerMinute: 20, maxPerHour: 120, maxPerDay: 500 },
  user: { maxPerMinute: 5, maxPerHour: 30, maxPerDay: 100 },
} as const;

export interface RateLimitWindowUsage {
  minute: number;
  hour: number;
  day: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the exceeded window rolls over. Only set when denied. */
  retryAfter?: number;
  remaining: RateLimitWindowUsage;
}

interface Caps {
  maxPerMinute: number;
  maxPerHour: number;
  maxPerDay: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both identifiers are written to `UUID NOT NULL` columns. Anything else is a
 * caller bug and must not be reported as a database fault, because the catch
 * below fails open: a malformed argument would silently switch this limiter
 * off for as long as the bug lived. Throwing puts it in front of whoever wrote
 * it.
 */
function requireUuid(label: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(
      `CAIO rate limiter: ${label} must be a UUID, received "${value}". ` +
        'The ledger columns are UUID; a Firebase uid or other identifier here ' +
        'would disable rate limiting for this surface.',
    );
  }
}

/**
 * Insert one event and count every window in the same statement, so the check
 * and the increment cannot race. The inserted row is included in the counts,
 * which is why the comparisons below are `>` and not `>=`.
 */
async function atomicCheckAndIncrement(
  tenantId: string,
  accountId: string,
): Promise<{ tenantUsage: RateLimitWindowUsage; userUsage: RateLimitWindowUsage }> {
  const now = Date.now();
  const minuteAgo = new Date(now - 60 * 1000);
  const hourAgo = new Date(now - 60 * 60 * 1000);
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const result = await withTenantContext(tenantId, (client) => client.query(
    `WITH inserted AS (
       INSERT INTO ${TEAM_PLAN_RATE_LIMIT_TABLE} (tenant_id, account_id)
       VALUES ($1, $2)
       RETURNING created_at
     )
     SELECT
       (SELECT COUNT(*) FROM ${TEAM_PLAN_RATE_LIMIT_TABLE} WHERE tenant_id = $1 AND created_at >= $3) AS tenant_minute,
       (SELECT COUNT(*) FROM ${TEAM_PLAN_RATE_LIMIT_TABLE} WHERE tenant_id = $1 AND created_at >= $4) AS tenant_hour,
       (SELECT COUNT(*) FROM ${TEAM_PLAN_RATE_LIMIT_TABLE} WHERE tenant_id = $1 AND created_at >= $5) AS tenant_day,
       (SELECT COUNT(*) FROM ${TEAM_PLAN_RATE_LIMIT_TABLE} WHERE account_id = $2 AND created_at >= $3) AS user_minute,
       (SELECT COUNT(*) FROM ${TEAM_PLAN_RATE_LIMIT_TABLE} WHERE account_id = $2 AND created_at >= $4) AS user_hour,
       (SELECT COUNT(*) FROM ${TEAM_PLAN_RATE_LIMIT_TABLE} WHERE account_id = $2 AND created_at >= $5) AS user_day`,
    [tenantId, accountId, minuteAgo, hourAgo, dayAgo],
  ));

  const row = result.rows[0];
  return {
    tenantUsage: {
      minute: parseInt(row.tenant_minute, 10) || 0,
      hour: parseInt(row.tenant_hour, 10) || 0,
      day: parseInt(row.tenant_day, 10) || 0,
    },
    userUsage: {
      minute: parseInt(row.user_minute, 10) || 0,
      hour: parseInt(row.user_hour, 10) || 0,
      day: parseInt(row.user_day, 10) || 0,
    },
  };
}

/** Undo the speculative insert when the turn is refused, so a denied request
 *  does not itself count against the window it was denied by. */
async function rollbackLastEvent(tenantId: string, accountId: string): Promise<void> {
  await withTenantContext(tenantId, (client) => client.query(
    `DELETE FROM ${TEAM_PLAN_RATE_LIMIT_TABLE}
      WHERE id = (
        SELECT id FROM ${TEAM_PLAN_RATE_LIMIT_TABLE}
         WHERE tenant_id = $1 AND account_id = $2
         ORDER BY created_at DESC
         LIMIT 1
      )`,
    [tenantId, accountId],
  ));
}

/** retryAfter counts to the next window boundary, not a full window, so a
 *  caller denied at 59 seconds past the minute waits one second. */
function checkLimits(
  usage: RateLimitWindowUsage,
  caps: Caps,
): { exceeded: boolean; retryAfter: number; remaining: RateLimitWindowUsage } {
  const now = new Date();

  if (usage.minute > caps.maxPerMinute) {
    return {
      exceeded: true,
      retryAfter: 60 - now.getSeconds(),
      remaining: {
        minute: 0,
        hour: Math.max(0, caps.maxPerHour - usage.hour),
        day: Math.max(0, caps.maxPerDay - usage.day),
      },
    };
  }

  if (usage.hour > caps.maxPerHour) {
    return {
      exceeded: true,
      retryAfter: (60 - now.getMinutes()) * 60,
      remaining: {
        minute: Math.max(0, caps.maxPerMinute - usage.minute),
        hour: 0,
        day: Math.max(0, caps.maxPerDay - usage.day),
      },
    };
  }

  if (usage.day > caps.maxPerDay) {
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    return {
      exceeded: true,
      retryAfter: Math.floor((endOfDay.getTime() - now.getTime()) / 1000),
      remaining: {
        minute: Math.max(0, caps.maxPerMinute - usage.minute),
        hour: Math.max(0, caps.maxPerHour - usage.hour),
        day: 0,
      },
    };
  }

  return {
    exceeded: false,
    retryAfter: 0,
    remaining: {
      minute: caps.maxPerMinute - usage.minute,
      hour: caps.maxPerHour - usage.hour,
      day: caps.maxPerDay - usage.day,
    },
  };
}

/**
 * Atomically check and increment the CAIO chat rate limit.
 *
 * Throws on a malformed tenantId/accountId. Fails open (allowed: true) on a
 * database fault.
 */
export async function checkAndIncrementTeamPlanRateLimit(
  tenantId: string,
  accountId: string,
): Promise<RateLimitResult> {
  // Outside the try on purpose: a malformed identifier must not reach the
  // fail-open catch, which would turn a caller bug into silent unlimited
  // access.
  requireUuid('tenantId', tenantId);
  requireUuid('accountId', accountId);

  try {
    const { tenantUsage, userUsage } = await atomicCheckAndIncrement(tenantId, accountId);

    const tenantCheck = checkLimits(tenantUsage, TEAM_PLAN_RATE_LIMITS.tenant);
    if (tenantCheck.exceeded) {
      await rollbackLastEvent(tenantId, accountId);
      return { allowed: false, retryAfter: tenantCheck.retryAfter, remaining: tenantCheck.remaining };
    }

    const userCheck = checkLimits(userUsage, TEAM_PLAN_RATE_LIMITS.user);
    if (userCheck.exceeded) {
      await rollbackLastEvent(tenantId, accountId);
      return { allowed: false, retryAfter: userCheck.retryAfter, remaining: userCheck.remaining };
    }

    return {
      allowed: true,
      remaining: {
        minute: Math.min(tenantCheck.remaining.minute, userCheck.remaining.minute),
        hour: Math.min(tenantCheck.remaining.hour, userCheck.remaining.hour),
        day: Math.min(tenantCheck.remaining.day, userCheck.remaining.day),
      },
    };
  } catch (error) {
    log.error(
      { tenantId, accountId, error: (error as Error).message },
      'CAIO rate limit check failed - failing open',
    );
    return {
      allowed: true,
      remaining: {
        minute: TEAM_PLAN_RATE_LIMITS.user.maxPerMinute,
        hour: TEAM_PLAN_RATE_LIMITS.user.maxPerHour,
        day: TEAM_PLAN_RATE_LIMITS.user.maxPerDay,
      },
    };
  }
}
