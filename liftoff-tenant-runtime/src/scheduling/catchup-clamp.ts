// F4b — deciding whether a tick that arrived late is still worth running.
//
// Kept out of the handler so it can be tested as what it is: pure arithmetic
// over a cron expression and two timestamps, with no OIDC or database graph
// dragged in behind it.

/** F4b — how far past its scheduled time a tick may still be worth running.
 *
 *  Cloud Scheduler retries a missed tick under its own attemptDeadline, so a
 *  long outage ends with a burst of stale ticks arriving together. For a
 *  monitor-shaped routine that is worse than useless: it reports on a window
 *  that has already closed, several times over.
 *
 *  Half the period, clamped to [2 minutes, 2 hours] — the same shape Hermes
 *  uses. Half, because a tick that is more than half a period late is closer to
 *  the NEXT tick than to its own.
 */
const MIN_CATCHUP_MS = 2 * 60 * 1000;
const MAX_CATCHUP_MS = 2 * 60 * 60 * 1000;

/** Approximate period of a cron expression, or null when it is not one of the
 *  shapes we can read confidently.
 *
 *  Deliberately NOT a cron parser: a wrong period here would clamp a legitimate
 *  tick, and pulling in a parser to serve one heuristic is a poor trade. These
 *  are the shapes the distiller actually emits; anything else falls back to the
 *  maximum window, which errs toward running the tick. */
export function estimateCronPeriodMs(cronExpr: string | undefined): number | null {
  if (!cronExpr) return null;
  const f = cronExpr.trim().split(/\s+/);
  if (f.length < 5) return null;
  const [min, hour, dom, , dow] = f;

  // */N * * * *  — every N minutes
  const everyNMin = /^\*\/(\d+)$/.exec(min);
  if (everyNMin && hour === '*') return Number(everyNMin[1]) * 60_000;

  // M * * * *  — hourly at minute M
  if (/^\d+$/.test(min) && hour === '*') return 60 * 60_000;

  // M H/N * * *  — every N hours
  const everyNHour = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(min) && everyNHour) return Number(everyNHour[1]) * 60 * 60_000;

  // M H * * *  — daily; M H * * D — weekly
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    if (dow && dow !== '*') return 7 * 24 * 60 * 60_000;
    if (dom && dom !== '*') return 30 * 24 * 60 * 60_000;
    return 24 * 60 * 60_000;
  }
  return null;
}

export function catchupWindowMs(periodMs: number | null): number {
  if (!periodMs || periodMs <= 0) return MAX_CATCHUP_MS;
  return Math.min(MAX_CATCHUP_MS, Math.max(MIN_CATCHUP_MS, Math.floor(periodMs / 2)));
}

/** Cloud Scheduler stamps the intended fire time on the request. When absent
 *  (a manual run, an older job) there is nothing to be late against. */
export function tickAgeMs(headerValue: string | undefined, now: Date): number | null {
  if (!headerValue) return null;
  const scheduled = Date.parse(headerValue);
  if (Number.isNaN(scheduled)) return null;
  return now.getTime() - scheduled;
}
