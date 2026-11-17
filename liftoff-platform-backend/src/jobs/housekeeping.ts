// The daily housekeeping pass: platform-backend's one Cloud Scheduler job.
//
// Every maintenance route this service owns is listed here
// and run once a day as its own Cloud Task. For work that arms itself (a cost
// pass after spend, a webhook delivery, a tunnel sweep) this is the backstop
// for an arming that was lost; for retention, reconcilers and probes it is
// the cadence. As tasks rather than inline calls, each gets its own deadline,
// retries and log line, and one slow sweep cannot time the rest out. They are
// staggered so they do not all open database connections at once, and named
// by date so a second run of the pass the same day is a no-op.
//
// Routes only. This service's Cloud Run jobs (outbox-ack reconciler, the
// invocation DLQ drain, URL validation, the agent-scheduler audit pair, the
// Apify true-up, pricing sync) keep daily Cloud Scheduler entries of their own:
// a job run is a call to the Cloud Run Admin API, and the control project's
// VPC Service Controls perimeter refuses that call from Cloud Tasks ("Request
// is prohibited by organization's policy") while it admits Cloud Scheduler.
// The monthly allowance reset also keeps its own schedule, because the
// calendar IS its trigger (00:00 on the 1st; a day late would leave annual-plan
// workspaces without their month's allowance). The 15:00 UTC run time is the
// hour the person-facing reminders and invite sweeps already ran at.

import { enqueueMaintenanceTask, type MaintenanceAuth } from '../infrastructure/maintenance-tasks';
import { log } from '../infrastructure/logging';
import { TARGETS } from './maintenance-targets';

export interface HousekeepingEntry {
  path: string;
  auth?: MaintenanceAuth;
  /** UTC day of week (0 = Sunday) the entry runs on; daily when absent. */
  weekday?: number;
}

export function dailyHousekeeping(): HousekeepingEntry[] {
  return [
    // Armed by their events; listed as the backstop.
    TARGETS.costIngest,
    TARGETS.vendorSpendMonitor,
    TARGETS.x402Reload,
    TARGETS.x402Topup,
    TARGETS.x402LowBalance,
    TARGETS.ouMeterRetryDrain,
    TARGETS.outboundWebhooks,
    TARGETS.chatDeliveries,
    TARGETS.strandedProvisioning,
    TARGETS.tunnelTokenGrace,
    TARGETS.tunnelPending,
    TARGETS.tunnelDisconnected,
    // Re-arms the digest chain for the next 09:00 anyone has (digest.ts).
    TARGETS.notificationsTick,
    // Backstops under a primary path that runs inline or over Pub/Sub.
    { path: '/api/internal/embed-knowledge-content', auth: 'callback' },
    { path: '/api/internal/extract-knowledge-content', auth: 'callback' },
    { path: '/api/internal-agents/reconcile-runtime-state', auth: 'oidc' },
    // Polls and probes.
    { path: '/api/internal/sync-dropbox-folders', auth: 'callback' },
    { path: '/api/internal/renew-knowledge-webhooks', auth: 'callback' },
    { path: '/api/internal/external-agents/health-check', auth: 'oidc' },
    { path: '/api/internal/external-agents/refresh-tokens', auth: 'oidc' },
    // Reconciliation and calendar work.
    { path: '/api/internal/ou-meter-reconcile', auth: 'callback' },
    { path: '/api/internal/x402-reconcile', auth: 'callback' },
    { path: '/api/internal/subscription-ending-reminders', auth: 'callback' },
    { path: '/api/internal/invite-expiry-sweep', auth: 'callback' },
    { path: '/api/internal/invite-reminder-sweep', auth: 'callback' },
    { path: '/api/internal/jobs/referral-signup-expiry', auth: 'callback' },
    // Retention.
    { path: '/api/internal/maintenance/expire-agent-messages', auth: 'callback' },
    { path: '/api/internal/maintenance/cleanup-oauth', auth: 'callback' },
    { path: '/api/internal/maintenance/cleanup-slack-event-dedup', auth: 'callback' },
    { path: '/api/internal/maintenance/cleanup-teams-activity-dedup', auth: 'callback' },
    { path: '/api/internal/maintenance/purge-event-deliveries', auth: 'callback' },
    { path: '/api/internal/maintenance/sweep-abandoned-uploads', auth: 'callback' },
    { path: '/api/internal/maintenance/sweep-staged-files', auth: 'callback' },
    { path: '/api/internal/maintenance/sweep-usage-recurrence', auth: 'callback' },
    { path: '/api/internal/maintenance/expire-connector-content', auth: 'callback' },
    { path: '/api/internal/data-management/retention/run-cleanup', auth: 'oidc', weekday: 0 },
  ];
}

const STAGGER_MS = 20_000;

export interface HousekeepingResult {
  day: string;
  enqueued: number;
  alreadyArmed: number;
  failed: string[];
}

/** Enqueue today's entries. Throws when any failed to enqueue, so the
 *  scheduler job reads the pass as failed and its alert fires. */
export async function enqueueDailyHousekeeping(now: Date = new Date()): Promise<HousekeepingResult> {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const today = dailyHousekeeping().filter((e) => e.weekday === undefined || e.weekday === now.getUTCDay());
  const result: HousekeepingResult = { day, enqueued: 0, alreadyArmed: 0, failed: [] };

  for (const [i, entry] of today.entries()) {
    const label = entry.path;
    try {
      const outcome = await enqueueMaintenanceTask({
        path: entry.path,
        auth: entry.auth,
        name: `hk-${day}-${label}`,
        at: new Date(now.getTime() + i * STAGGER_MS),
      });
      if (outcome === 'enqueued') result.enqueued++;
      else if (outcome === 'already-armed') result.alreadyArmed++;
      else result.failed.push(`${label}: unconfigured`);
    } catch (err) {
      result.failed.push(`${label}: ${(err as Error).message}`);
    }
  }

  log.info({ ...result }, 'daily housekeeping enqueued');
  if (result.failed.length > 0) {
    throw new Error(`daily housekeeping: ${result.failed.length} entries not enqueued: ${result.failed.join('; ')}`);
  }
  return result;
}
