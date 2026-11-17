// Structured Logging
//
// Wraps pino for structured JSON logging. Exports:
//   log   - standard leveled logger (debug/info/warn/error)
//   logAudit - audit-trail logger that writes to pino at info level with
//              a fixed `audit: true` field so log sinks can route to a
//              separate audit stream.

import pino from 'pino';

export const log = pino({
  name: 'liftoff-workforce-service',
  level: process.env['LOG_LEVEL'] ?? 'info',
  ...(process.env['NODE_ENV'] === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }
    : {}),
});

/**
 * Write an audit-trail log entry. These are always at `info` level with
 * `audit: true` so they can be routed to a dedicated sink.
 *
 * @param action  - Dot-separated action name, e.g. `workforce_plans.approved`.
 * @param subject - Who performed the action: `{ tenantId, userId? }`.
 * @param data    - Structured data relevant to the action.
 */
export function logAudit(
  action: string,
  subject: { tenantId: string; userId?: string; accountId?: string },
  data: Record<string, unknown>,
): void {
  log.info(
    {
      audit: true,
      action,
      tenantId: subject.tenantId,
      userId: subject.userId ?? subject.accountId,
      ...data,
    },
    action,
  );
}
