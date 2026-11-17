// Digest tick: /api/internal/notifications/run-tick, at the top of an hour in
// which some candidate account's clock reads DIGEST_HOUR (09:00). We scan all
// candidate accounts and fire emails for those whose local clock just struck
// it, then arm the next such hour (digest-schedule.ts).

import { getPool, withAdminScope } from '../infrastructure/database';
import { armNextDigest, DIGEST_HOUR } from './digest-schedule';
import { log } from '../infrastructure/logging';
import * as repo from './repository';
import { sendDigestEmail, sendPerformanceRecapEmail } from './email';
import * as providers from '../insights/data-providers';
import type { Account, AccountPreferences } from '../accounts/types';


interface TickResult {
  candidatesScanned: number;
  digestsSent: number;
  perfRecapsSent: number;
  errors: number;
}

interface CandidateRow {
  id: string;
  email: string;
  firstName: string;
  timezone: string;
  preferences: AccountPreferences;
}

export async function runDigestTick(now: Date = new Date()): Promise<TickResult> {
  // SQL prefilter — return any account that could have work this tick:
  //   • is not soft-deleted
  //   • has NOT opted out via cadence='none'
  //   • AND EITHER has at least one undelivered notification row in any
  //     cadence (so we drain stranded rows after a user flips their
  //     cadence preference — daily→weekly etc.) OR is opted into the
  //     Tuesday performance recap.
  //
  // Rationale: cadence is snapshotted on each notification row at enqueue
  // time. The user's CURRENT preference decides what we enqueue going
  // forward; the ROW's cadence decides when the digest worker flushes it.
  // Filtering candidates by current preference here would orphan rows
  // queued under the user's previous preference.
  const pool = getPool();
  const candidatesResult = await pool.query<CandidateRow>(
    `SELECT a.id, a.email, a.first_name AS "firstName", a.timezone, a.preferences
       FROM accounts a
      WHERE a.deleted_at IS NULL
        AND COALESCE(a.preferences->>'notificationFrequency', 'daily') != 'none'
        AND (
          EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.account_id = a.id
               AND n.delivered_at IS NULL
          )
          OR (a.preferences->'notificationTypes'->>'weeklyDigest')::boolean = true
        )`,
  );

  const result: TickResult = {
    candidatesScanned: candidatesResult.rowCount ?? 0,
    digestsSent: 0,
    perfRecapsSent: 0,
    errors: 0,
  };

  for (const acct of candidatesResult.rows) {
    try {
      const tz = acct.timezone || 'America/Los_Angeles';
      const localHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now),
        10,
      );
      if (localHour !== DIGEST_HOUR) continue;

      const localWeekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
      const isTuesday = localWeekday === 'Tue';

      const prefs = (acct.preferences ?? {}) as AccountPreferences;
      const accountForEmail = {
        id: acct.id,
        firstName: acct.firstName,
        email: acct.email,
      } as Account;

      // Daily digest — flush any pending cadence='daily' rows on every
      // tick that fires for this user, regardless of their current cadence
      // preference. This drains rows enqueued before a daily→weekly flip.
      const dailyRows = await repo.fetchPendingForAccount(acct.id, 'daily');
      if (dailyRows.length > 0) {
        await sendDigestEmail(accountForEmail, dailyRows, 'daily');
        await repo.markDelivered(dailyRows.map((r) => r.id));
        result.digestsSent++;
      }

      // Weekly digest — flush any pending cadence='weekly' rows on Tuesday,
      // again irrespective of current preference. Drains rows from a
      // weekly→daily flip on the very next Tuesday.
      if (isTuesday) {
        const weeklyRows = await repo.fetchPendingForAccount(acct.id, 'weekly');
        if (weeklyRows.length > 0) {
          await sendDigestEmail(accountForEmail, weeklyRows, 'weekly');
          await repo.markDelivered(weeklyRows.map((r) => r.id));
          result.digestsSent++;
        }
      }

      // Tuesday performance recap (independent of cadence — gated by the
      // weeklyDigest type toggle). Cadence='none' is already excluded by
      // the SQL prefilter; check defensively for clarity.
      //
      // Order matters: load metrics FIRST, only reserve the dedupe row if
      // we actually have something to send. The prior plan ordering
      // (reserve → check metrics → maybe skip) would burn the reservation
      // on a quiet week and leave the user without a recap if activity
      // arrived later in the same week.
      if (
        prefs.notificationFrequency !== 'none' &&
        prefs.notificationTypes?.weeklyDigest === true &&
        isTuesday
      ) {
        const metrics = await loadPerfMetricsForAccount(acct.id);
        if (metrics.some((m) => m.agentActions + m.completedTasks + m.escalations > 0)) {
          const weekStart = mondayDateInTz(now, tz);
          const reserved = await repo.tryReservePerfRecap(acct.id, weekStart);
          if (reserved) {
            await sendPerformanceRecapEmail(accountForEmail, metrics);
            result.perfRecapsSent++;
          }
        }
      }
    } catch (err) {
      result.errors++;
      log.warn(
        { accountId: acct.id, err: (err as Error).message },
        'digest tick failed for account',
      );
    }
  }
  armNextDigest(candidatesResult.rows.map((r) => r.timezone), now);
  return result;
}

// Returns a UTC-midnight Date representing the local-tz Monday of the current
// ISO week. Used as the stable week-key for perf-recap dedupe. We send on
// Tuesday but key on Monday so the dedupe entry is unambiguous.
//
// Exported so unit tests can verify tz/midnight boundary behavior directly
// (see plan §10a "mondayDateInTz called on a Tuesday near midnight tz
// boundary"); runDigestTick is too high-level to cover that case ergonomically.
export function mondayDateInTz(now: Date, tz: string): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // "2026-05-18"
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon...
  const daysBack = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d;
}

interface PerfMetric {
  tenantName: string;
  agentActions: number;
  completedTasks: number;
  escalations: number;
}

async function loadPerfMetricsForAccount(accountId: string): Promise<PerfMetric[]> {
  // Reuse the existing /insights data providers — they already query the right
  // tables (PB-native) and proxy to tenant-runtime where needed.
  //
  //   • escalations    ← getHitlApprovalStats (PB-local hitl_late_feedback)
  //   • completedTasks ← getInvocationStats   (proxies tenant-runtime)
  //   • agentActions   ← getAuditLogAggregation (PB-local agent_audit_logs)
  const tenants = await withAdminScope(
    { caller: 'notifications.digest.loadPerfMetricsForAccount', reason: 'list tenants for perf recap' },
    (c) =>
      c.query<{ tenant_id: string; tenant_name: string }>(
        `SELECT t.id AS tenant_id, t.name AS tenant_name
           FROM tenant_members tm
           JOIN tenants t ON t.id = tm.tenant_id
          WHERE tm.account_id = $1
          ORDER BY t.name`,
        [accountId],
      ),
  );

  const range = { start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), end: new Date() };

  return Promise.all(
    tenants.rows.map(async (t) => {
      // All three calls in parallel; failures fall back to 0 so a flaky
      // tenant-runtime doesn't kill the whole digest for the whole account.
      const [hitl, invocations, audits] = await Promise.allSettled([
        providers.getHitlApprovalStats(t.tenant_id, range),
        providers.getInvocationStats(t.tenant_id, range),
        providers.getAuditLogAggregation(t.tenant_id, range, 'day'),
      ]);
      return {
        tenantName: t.tenant_name,
        agentActions: audits.status === 'fulfilled' ? audits.value?.totalActions ?? 0 : 0,
        completedTasks: invocations.status === 'fulfilled' ? invocations.value?.invocationCount ?? 0 : 0,
        escalations: hitl.status === 'fulfilled' ? hitl.value?.totalApprovals ?? 0 : 0,
      };
    }),
  );
}
