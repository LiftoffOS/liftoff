// Shared Chat Rate Limiter
//
// PostgreSQL-backed per-tenant + per-user rate limiting for LLM-backed chat
// surfaces. Extracted from src/insights/rate-limiter.ts so the insights chat
// and the CAIO workforce-planning chat (Phase 3) share one implementation
// instead of duplicate check/increment/rollback logic.
//
// Each chat surface supplies its own event table via `tableName` so the two
// workloads don't throttle each other - a user burning through insights
// shouldn't block their planning work and vice versa. The tables MUST have
// the columns `tenant_id UUID`, `account_id UUID`, and `created_at TIMESTAMPTZ`
// and an UPDATE-triggered id primary key (see migrations 074 + 086 for the
// canonical shape).
//
// The check-and-increment is a single atomic CTE: insert one row, then count
// the windows that now include it. If any limit is exceeded we rollback the
// insert. This avoids the classic TOCTOU race between count and increment.
//
// Fails open: if the database query fails, the request is allowed through
// and the error is logged. Better to let a request slip past a failing rate
// limiter than to block all chat traffic when the ledger query hiccups.
//
// That trade only holds for a transient database fault. A bad ARGUMENT is a
// caller bug, and fail-open would mean the surface simply has no rate limit for
// as long as the bug lives — so the table name and both identifiers are
// validated up front and throw. See `requireUuid`.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

// RLS note (FORCE census — dynamic-table class): the ledger tables are named at
// runtime via `tableName` (ALLOWED_TABLES). Four of the five are RLS-enabled
// (insights_/distill_/agent_chat_/event_source_rate_limit_events); the queries
// carry tenantId, so both the check-and-increment and the rollback run under
// withTenantScope. A literal-table census cannot see `FROM ${table}`.

/**
 * Default window caps. Applied equally to insights and team-plan for now.
 * Override via `limits` on a per-call-site basis if a workload needs tighter
 * or looser caps than the default.
 */
export const DEFAULT_CHAT_RATE_LIMITS = {
  tenant: {
    maxPerMinute: 20,
    maxPerHour: 120,
    maxPerDay: 500,
  },
  user: {
    maxPerMinute: 5,
    maxPerHour: 30,
    maxPerDay: 100,
  },
} as const;

export interface ChatRateLimitWindowUsage {
  minute: number;
  hour: number;
  day: number;
}

export interface ChatRateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  remaining: ChatRateLimitWindowUsage;
}

export interface ChatRateLimitCaps {
  tenant: {
    maxPerMinute: number;
    maxPerHour: number;
    maxPerDay: number;
  };
  user: {
    maxPerMinute: number;
    maxPerHour: number;
    maxPerDay: number;
  };
}

export interface ChatRateLimitOptions {
  /** Name of the ledger table for this chat surface. Table MUST have the
   *  three columns `id`, `tenant_id`, `account_id`, `created_at`. */
  tableName: string;
  tenantId: string;
  accountId: string;
  /** Override the default window caps. */
  limits?: ChatRateLimitCaps;
}

/**
 * Allowed table names. Hardcoded so `tableName` can be interpolated into
 * the SQL without risking injection - the list is reviewed when a new chat
 * surface is added. Using a bare param for a table name is not valid SQL,
 * and quoting identifiers at runtime risks escaping bugs.
 */
const ALLOWED_TABLES = new Set([
  'insights_rate_limit_events',
  'liftoff_rate_limit_events',
  'team_plan_rate_limit_events',
  'distill_rate_limit_events',
  'agent_chat_rate_limit_events',
  'event_source_rate_limit_events',  // per-source webhook rate limit (migration 218)
]);

function requireAllowedTable(name: string): void {
  if (!ALLOWED_TABLES.has(name)) {
    throw new Error(
      `Chat rate limiter: refusing to use unknown table "${name}". ` +
        `Allowed tables: ${[...ALLOWED_TABLES].join(', ')}`,
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both identifiers are written to `UUID NOT NULL` columns. Anything else is a
 * caller bug, and it must not be reported as a database fault.
 *
 * The distinction matters because of what the catch below does. Failing open on
 * a database hiccup is a deliberate availability trade; failing open on a
 * malformed argument is a rate limiter that is permanently switched off. The
 * distill surface passed a Firebase uid here from the day it shipped, so every
 * insert raised `invalid input syntax for type uuid`, and every request took the
 * fail-open branch — an unlimited, unmetered path into the most expensive LLM
 * call in the product, reported once per request as a database error nobody read
 * as a caller bug.
 *
 * Throwing puts that class of mistake in front of the developer who wrote it,
 * the same way an unknown table name already does.
 */
function requireUuid(label: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(
      `Chat rate limiter: ${label} must be a UUID, received "${value}". ` +
        'The ledger columns are UUID; a Firebase uid or other identifier here ' +
        'would disable rate limiting for this surface.',
    );
  }
}

async function atomicCheckAndIncrement(
  table: string,
  tenantId: string,
  accountId: string,
): Promise<{
  tenantUsage: ChatRateLimitWindowUsage;
  userUsage: ChatRateLimitWindowUsage;
}> {
  const now = new Date();
  const minuteAgo = new Date(now.getTime() - 60 * 1000);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Atomic CTE: insert first, then count windows (including the new row)
  // so the check and the increment cannot race.
  const result = await withTenantScope(tenantId, (client) => client.query(
    `WITH inserted AS (
       INSERT INTO ${table} (tenant_id, account_id)
       VALUES ($1, $2)
       RETURNING created_at
     )
     SELECT
       (SELECT COUNT(*) FROM ${table} WHERE tenant_id = $1 AND created_at >= $3) as tenant_minute,
       (SELECT COUNT(*) FROM ${table} WHERE tenant_id = $1 AND created_at >= $4) as tenant_hour,
       (SELECT COUNT(*) FROM ${table} WHERE tenant_id = $1 AND created_at >= $5) as tenant_day,
       (SELECT COUNT(*) FROM ${table} WHERE account_id = $2 AND created_at >= $3) as user_minute,
       (SELECT COUNT(*) FROM ${table} WHERE account_id = $2 AND created_at >= $4) as user_hour,
       (SELECT COUNT(*) FROM ${table} WHERE account_id = $2 AND created_at >= $5) as user_day`,
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

async function rollbackLastEvent(
  table: string,
  tenantId: string,
  accountId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `DELETE FROM ${table}
     WHERE id = (
       SELECT id FROM ${table}
       WHERE tenant_id = $1 AND account_id = $2
       ORDER BY created_at DESC
       LIMIT 1
     )`,
    [tenantId, accountId],
  ));
}

function checkLimits(
  usage: ChatRateLimitWindowUsage,
  limits: ChatRateLimitCaps['tenant'],
): { exceeded: boolean; retryAfter: number; remaining: ChatRateLimitWindowUsage } {
  if (usage.minute > limits.maxPerMinute) {
    return {
      exceeded: true,
      retryAfter: 60 - new Date().getSeconds(),
      remaining: {
        minute: 0,
        hour: Math.max(0, limits.maxPerHour - usage.hour),
        day: Math.max(0, limits.maxPerDay - usage.day),
      },
    };
  }

  if (usage.hour > limits.maxPerHour) {
    return {
      exceeded: true,
      retryAfter: (60 - new Date().getMinutes()) * 60,
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - usage.minute),
        hour: 0,
        day: Math.max(0, limits.maxPerDay - usage.day),
      },
    };
  }

  if (usage.day > limits.maxPerDay) {
    const now = new Date();
    const endOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
    );
    return {
      exceeded: true,
      retryAfter: Math.floor((endOfDay.getTime() - now.getTime()) / 1000),
      remaining: {
        minute: Math.max(0, limits.maxPerMinute - usage.minute),
        hour: Math.max(0, limits.maxPerHour - usage.hour),
        day: 0,
      },
    };
  }

  return {
    exceeded: false,
    retryAfter: 0,
    remaining: {
      minute: limits.maxPerMinute - usage.minute,
      hour: limits.maxPerHour - usage.hour,
      day: limits.maxPerDay - usage.day,
    },
  };
}

/**
 * Atomically check and increment rate limits for a chat surface. The caller
 * supplies its own ledger table name (via `tableName`) so different surfaces
 * have independent limits.
 *
 * Returns `allowed: true` with remaining-window info on success. On failure
 * returns `allowed: false` with the retry-after hint. If the database query
 * fails entirely, fails open (returns allowed: true) and logs the error.
 */
export async function checkAndIncrementChatRateLimit(
  options: ChatRateLimitOptions,
): Promise<ChatRateLimitResult> {
  requireAllowedTable(options.tableName);
  const limits = options.limits ?? DEFAULT_CHAT_RATE_LIMITS;
  const { tableName, tenantId, accountId } = options;

  // Outside the try on purpose: a malformed identifier must not reach the
  // fail-open catch, which would turn the caller's bug into silent unlimited
  // access.
  requireUuid('tenantId', tenantId);
  requireUuid('accountId', accountId);

  try {
    const { tenantUsage, userUsage } = await atomicCheckAndIncrement(
      tableName,
      tenantId,
      accountId,
    );

    const tenantCheck = checkLimits(tenantUsage, limits.tenant);
    if (tenantCheck.exceeded) {
      await rollbackLastEvent(tableName, tenantId, accountId);
      return {
        allowed: false,
        retryAfter: tenantCheck.retryAfter,
        remaining: tenantCheck.remaining,
      };
    }

    const userCheck = checkLimits(userUsage, limits.user);
    if (userCheck.exceeded) {
      await rollbackLastEvent(tableName, tenantId, accountId);
      return {
        allowed: false,
        retryAfter: userCheck.retryAfter,
        remaining: userCheck.remaining,
      };
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
      {
        tableName,
        tenantId,
        accountId,
        error: (error as Error).message,
      },
      'Chat rate limit check failed - failing open',
    );
    return {
      allowed: true,
      remaining: {
        minute: limits.user.maxPerMinute,
        hour: limits.user.maxPerHour,
        day: limits.user.maxPerDay,
      },
    };
  }
}
