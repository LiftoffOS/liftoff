// Maintenance scheduler jobs
// Called by Cloud Scheduler via OIDC (Cloud Run validates) + X-Service-Auth static token.
// Auth: PLATFORM_CALLBACK_TOKEN — same token as platform-tools-router.
//
// Routes:
//   POST /expire-agent-messages       — daily at 02:00 UTC
//   POST /expire-connector-content    — daily, iterates active tenants
//   POST /sweep-abandoned-uploads     — daily; inbound media nobody ever sent
//   POST /prune-byok-gateway          — daily; BYOK gateway request + token rows

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { teamProvisioningService } from '../team-provisioning/service';
import { pruneGatewayRequests, pruneGatewayTokens } from '../byok-gateway/usage-recorder';
import { monitorVendorBalances } from './vendor-balance-monitor';
import { purgeSoftDeleted } from './purge-soft-deleted';

export const maintenanceRouter = Router();

// A team-provisioning run stuck 'pending' this long past creation with no live worker
// lease is stranded and gets compensated. Matches the service's TERMINAL_DEADLINE.
const PROVISIONING_TERMINAL_DEADLINE_MS = 30 * 60_000;

function validateServiceAuth(req: Request, res: Response): boolean {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  const expectedToken = process.env.PLATFORM_CALLBACK_TOKEN;

  if (!expectedToken) {
    res.status(500).json({ error: 'Service authentication not configured' });
    return false;
  }

  const isValid =
    serviceToken &&
    Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken));

  if (!isValid) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return false;
  }

  return true;
}

// POST /ou-report — REMOVED.
//
// A daily job that computed cumulative OUs per account and wrote a snapshot to
// stripe_usage_reports for reconciliation against Stripe. It never wrote one:
// it ordered by a column the table does not have, and the failing SELECT sat
// before the INSERT, so the table could never receive a row.
//
// It was also redundant. getOperatingUnitsForPeriod computes the same figure
// for any window from billing_spend_events, which is append-only and never
// purged, and already serves two live endpoints. A daily snapshot of a
// derivable quantity, stored as INTEGER against a NUMERIC(18,3) source, was a
// lossy copy rather than a second source of truth.
//
// What it was meant to enable -- comparing our ledger against Stripe's meter --
// needs no snapshot table; both sides already exist. That reconciler is being
// built separately. The Cloud Scheduler job was removed from Terraform first.

// Compensate team-provisioning runs stranded 'pending' past the terminal deadline.
// Discovers affected tenants cross-tenant (admin scope), then runs the per-tenant sweep
// (which is idempotent — compensation retries until every role is compensated).
// Read the platform vendor balances (Saperly wallet, Hunter credits/searches)
// and WARN on any that is low — several vendors do not auto-reload, so this is
// the signal to top up before capability runs start failing closed.
// POST /purge-soft-deleted — hard-delete soft-deleted rows past the grace
// period. The SECOND way this runs, never the only one: startPurgeWorker runs
// it in-process on every instance and cannot be switched off. This route is
// for forcing a pass now, and for `?dryRun=true`, which reports what would go
// without deleting anything.
maintenanceRouter.post('/purge-soft-deleted', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const dryRun = req.query.dryRun === 'true';
    const days = req.query.olderThanDays !== undefined
      ? Number(req.query.olderThanDays)
      : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days < 1)) {
      res.status(400).json({ error: 'olderThanDays must be a number of days >= 1' });
      return;
    }
    const summary = await purgeSoftDeleted({ dryRun, olderThanDays: days });
    res.json(summary);
  } catch (error) {
    log.error({ error: (error as Error).message }, 'purge-soft-deleted failed');
    res.status(500).json({ error: 'purge failed' });
  }
});

maintenanceRouter.post('/monitor-vendor-balances', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const balances = await monitorVendorBalances();
    return res.json({ success: true, balances });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'monitor-vendor-balances failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

maintenanceRouter.post('/sweep-stranded-provisioning', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const strandedTenants = await withAdminScope(
      { caller: 'maintenance.sweep-stranded-provisioning', reason: 'cross-tenant stranded provisioning discovery' },
      (client) => client.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM team_provisioning_runs
          WHERE status = 'pending'
            AND created_at < NOW() - ($1::int * INTERVAL '1 millisecond')`,
        [PROVISIONING_TERMINAL_DEADLINE_MS],
      ),
    );
    let compensated = 0;
    for (const row of strandedTenants.rows) {
      compensated += await teamProvisioningService.sweepStrandedRuns(row.tenant_id);
    }
    log.info({ tenants: strandedTenants.rows.length, compensated }, 'sweep-stranded-provisioning: completed');
    return res.json({ success: true, tenants: strandedTenants.rows.length, compensated });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'sweep-stranded-provisioning failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

maintenanceRouter.post('/expire-agent-messages', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const result = await withAdminScope(
      { caller: 'maintenance.expire-agent-messages', reason: 'cross-tenant scheduled expiry' },
      (client) => client.query(
        `UPDATE agent_messages SET status = 'expired'
         WHERE status = 'pending' AND expires_at < NOW()`,
      ),
    );
    const expiredCount = result.rowCount ?? 0;

    log.info({ expiredCount }, 'expire-agent-messages: completed');
    return res.json({ success: true, expiredCount });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'expire-agent-messages failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// slack_event_dedup grows unbounded — one row per inbound Slack event. The
// event_id values are unique per Slack event, so we only need to retain rows
// long enough to dedup retries. Slack retries an event up to 3 times in the
// first ~3 seconds and gives up after ~1 minute. A 7-day retention is safely
// past that with plenty of buffer for backfills, while keeping the index small.
maintenanceRouter.post('/cleanup-slack-event-dedup', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    // slack_event_dedup has no tenant_id (global dedup table); admin scope
    // matches the maintenance/cross-tenant character of the cleanup.
    const result = await withAdminScope(
      { caller: 'maintenance.cleanup-slack-event-dedup', reason: 'global TTL cleanup' },
      (client) => client.query(
        `DELETE FROM slack_event_dedup WHERE received_at < NOW() - INTERVAL '7 days'`,
      ),
    );
    const deletedCount = result.rowCount ?? 0;
    log.info({ deletedCount }, 'cleanup-slack-event-dedup: completed');
    return res.json({ success: true, deletedCount });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'cleanup-slack-event-dedup: failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Inbound chat media that no message ever carried.
//
// Every other artifact in generated_files is owned by a message written in the
// same call that stored it, so it cannot be orphaned. An upload can: the bytes
// land while the person is still typing, and the message that would reference
// them is sent later, or never — a closed tab, a changed mind, a draft
// abandoned mid-sentence. Without this the bucket accumulates those forever,
// indistinguishable from real artifacts, and a person's picture stays stored
// long after they decided not to send it.
maintenanceRouter.post('/sweep-abandoned-uploads', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const { sweepAbandonedUploads } = await import('../media/inbound');
    const result = await sweepAbandonedUploads();
    return res.json({ success: true, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'sweep-abandoned-uploads: failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Staged files nobody published.
//
// A file can now be written without being shown: what a custom API answered
// with, or bytes a producer put down before knowing whether they mattered.
// Those carry a lifetime, and presenting one clears it. This removes the rest,
// so the store does not fill with files that were fetched on a model's behalf
// and never reached a person.
//
// Its own route rather than a branch of the one above: that one is about a
// PERSON's upload no message claimed, and this is about a PRODUCER's staged
// bytes. Two different predicates for two different facts.
maintenanceRouter.post('/sweep-staged-files', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const { sweepStagedFiles } = await import('../generated-files/sweep-staged');
    const result = await sweepStagedFiles();
    return res.json({ success: true, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'sweep-staged-files: failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// teams_activity_dedup grows unbounded — one row per inbound Teams Activity.
// Same rationale as slack_event_dedup: retain only long enough to dedup
// Bot Framework re-deliveries. 7-day retention with buffer; global (no tenant_id).
maintenanceRouter.post('/cleanup-teams-activity-dedup', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const result = await withAdminScope(
      { caller: 'maintenance.cleanup-teams-activity-dedup', reason: 'global TTL cleanup' },
      (client) => client.query(
        `DELETE FROM teams_activity_dedup WHERE received_at < NOW() - INTERVAL '7 days'`,
      ),
    );
    const deletedCount = result.rowCount ?? 0;
    log.info({ deletedCount }, 'cleanup-teams-activity-dedup: completed');
    return res.json({ success: true, deletedCount });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'cleanup-teams-activity-dedup: failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// event_deliveries grows once per inbound webhook request. The 30-day
// retention window is enough for the UI to surface "last 5 deliveries" and
// for support to reconstruct an incident, while keeping the table size
// bounded. Admin-scope because the cleanup intentionally crosses tenants.
maintenanceRouter.post('/purge-event-deliveries', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const result = await withAdminScope(
      { caller: 'maintenance.purge-event-deliveries', reason: 'cross-tenant 30-day TTL purge' },
      (client) => client.query(
        `DELETE FROM event_deliveries WHERE received_at < NOW() - INTERVAL '30 days'`,
      ),
    );
    const deletedCount = result.rowCount ?? 0;
    log.info({ deletedCount }, 'purge-event-deliveries: completed');
    return res.json({ success: true, deletedCount });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'purge-event-deliveries: failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// C1: redeliver chat replies whose delivery never completed.
//
// A turn that ran, produced a reply, and then failed to post it leaves an
// obligation row behind. The worker's own retry covers the common case; this
// covers the one it cannot — the process died, so no retry is coming. Only
// touches rows that have been sitting untouched for a while, so a live
// delivery is never raced.
// P1.3 trigger 2 — offer to automate something the person keeps asking for.
// Daily: recurrence is measured over a 30-day window, so a tighter cadence
// would only re-scan the same pattern and burn LLM calls to reach the same
// dedup-key latch.
maintenanceRouter.post('/sweep-usage-recurrence', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const tenantsResult = await withAdminScope(
      { caller: 'maintenance.sweep-usage-recurrence', reason: 'list active tenants for the recurring-ask sweep' },
      (client) => client.query<{ id: string }>(`SELECT id FROM tenants WHERE status = 'active'`),
    );

    const { runUsageRecurrenceSweep } = await import('../agent-chat/usage-recurrence');
    let scanned = 0;
    for (const row of tenantsResult.rows) {
      const r = await runUsageRecurrenceSweep(row.id).catch((err) => {
        log.warn({ tenantId: row.id, error: (err as Error).message }, 'usage-recurrence: tenant sweep failed');
        return { scanned: 0 };
      });
      scanned += r.scanned;
    }

    log.info({ tenants: tenantsResult.rows.length, scanned }, 'sweep-usage-recurrence: completed');
    return res.json({ tenants: tenantsResult.rows.length, scanned });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'sweep-usage-recurrence: failed');
    return res.status(500).json({ error: 'Sweep failed' });
  }
});

// Outbound webhooks — the single worker.
//
// A lifecycle event enqueues one row and returns; this is the only thing that
// ever opens a socket to a customer endpoint. Out of band on purpose: a
// receiver that hangs for its full timeout costs a slice of this sweep, and
// nothing else. Nothing a run does waits on any of it.
//
// One pass is bounded (batch size x per-delivery timeout), and claims use
// SKIP LOCKED, so a slow pass overlapping its successor delivers a disjoint set
// rather than sending the same event twice.
maintenanceRouter.post('/drain-outbound-webhooks', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const { drainOutboundWebhooks, nextOutboundAttemptAt } = await import('../event-sources/outbound-webhooks');
    const adminScope = <T>(fn: unknown) => withAdminScope<T>(
      { caller: 'maintenance.drain-outbound-webhooks', reason: 'claim due outbound webhook deliveries across tenants' },
      fn as never,
    );
    const result = await drainOutboundWebhooks({ withAdminScope: adminScope as never });
    // Come back when the earliest remaining delivery (a retry's backoff) is due.
    const next = await nextOutboundAttemptAt({ withAdminScope: adminScope as never });
    if (next) {
      const { armOutboundWebhooksAt } = await import('../jobs/maintenance-targets');
      armOutboundWebhooksAt(next);
    }
    log.info({ ...result, nextAttemptAt: next?.toISOString() ?? null }, 'drain-outbound-webhooks: completed');
    return res.json(result);
  } catch (err) {
    log.error({ error: (err as Error).message }, 'drain-outbound-webhooks: failed');
    return res.status(500).json({ error: 'Drain failed' });
  }
});

maintenanceRouter.post('/sweep-chat-deliveries', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const tenantsResult = await withAdminScope(
      { caller: 'maintenance.sweep-chat-deliveries', reason: 'list active tenants for cross-tenant delivery sweep' },
      (client) => client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE status = 'active'`,
      ),
    );

    const { sweepTenantDeliveries } = await import('../agent-chat/delivery-sweep');
    let considered = 0;
    let delivered = 0;
    let failed = 0;
    for (const row of tenantsResult.rows) {
      const result = await sweepTenantDeliveries(row.id);
      considered += result.considered;
      delivered += result.delivered;
      failed += result.failed;
    }

    log.info({ considered, delivered, failed }, 'sweep-chat-deliveries: completed');
    return res.json({ considered, delivered, failed });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'sweep-chat-deliveries: failed');
    return res.status(500).json({ error: 'Sweep failed' });
  }
});

maintenanceRouter.post('/expire-connector-content', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    // Fetch all active tenant IDs (RLS-on table — admin scope required).
    const tenantsResult = await withAdminScope(
      { caller: 'maintenance.expire-connector-content', reason: 'list active tenants for cross-tenant sweep' },
      (client) => client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE status = 'active'`,
      ),
    );
    const tenantIds = tenantsResult.rows.map((r) => r.id);

    let successCount = 0;
    let failCount = 0;

    for (const tenantId of tenantIds) {
      try {
        await tenantRuntimeClient.expireConnectorContentForTenant(tenantId);
        successCount++;
      } catch (err) {
        failCount++;
        log.warn(
          { tenantId, error: (err as Error).message },
          'expire-connector-content: failed for tenant',
        );
      }
    }

    log.info({ successCount, failCount, total: tenantIds.length }, 'expire-connector-content: completed');
    return res.json({ success: true, successCount, failCount, total: tenantIds.length });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'expire-connector-content: failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /prune-byok-gateway — daily BYOK gateway hygiene ──
//
// Two append-only tables, both written on the hot path of the busiest thing the
// platform does: one row per LLM request the gateway served, and one row per
// per-run credential minted. Neither is the durable record — the request rows
// stop being load-bearing once the run they describe has been ingested into
// cost_attribution_events, which happens within minutes, and a token is dead the
// moment it expires. The ledger keeps what has to be kept.
//
// The request window is long enough to survive an ingester outage and a weekend;
// the token window is shorter because an expired credential authenticates
// nothing and is not evidence of anything the request rows do not already say.
maintenanceRouter.post('/prune-byok-gateway', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const tenantsResult = await withAdminScope(
      { caller: 'maintenance.prune-byok-gateway', reason: 'list active tenants for cross-tenant sweep' },
      (client) => client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE status = 'active'`,
      ),
    );

    let requestsPruned = 0;
    let tokensPruned = 0;
    let failed = 0;
    for (const row of tenantsResult.rows) {
      try {
        requestsPruned += await pruneGatewayRequests(row.id);
        tokensPruned += await pruneGatewayTokens(row.id);
      } catch (err) {
        failed++;
        log.warn(
          { tenantId: row.id, error: (err as Error).message },
          'prune-byok-gateway: failed for tenant',
        );
      }
    }

    log.info({ requestsPruned, tokensPruned, failed }, 'prune-byok-gateway: completed');
    return res.json({ success: true, requestsPruned, tokensPruned, failed });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'prune-byok-gateway: failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /cleanup-oauth — daily OAuth + chat-run hygiene (plan v6.1) ──
//
// The sweep touches only rows the request paths never write, by an hour's
// margin: every request-path write on these tables carries its liveness
// predicate (tokens and codes `expires_at > NOW()`, consent requests
// LIVE_PREDICATE in src/oauth/grant-lifecycle.ts), and the sweep deletes only
// rows dead for an hour or more, so a sweep statement and a request statement
// never wait on each other. The hour is the consent park window's outer
// bound: a request is parked only while live, so it dies by
// `expires_at + 60 min`, and a sweep at `expires_at + 1 hour` can no longer
// remove a parked request the person is about to approve.
//
// Sweeps (all bounded by expiry semantics, never touching live credentials):
//   - setup_tokens past expiry (NO sweep existed before this — verified)
//   - oauth_authorization_requests an hour past expiry or consumption
//   - oauth_authorization_codes an hour past expiry or use
//   - oauth_device_codes an hour past expiry, whatever their outcome
//   - oauth_access_tokens an hour past expiry or revoked >7d
//   - oauth_refresh_tokens an hour past ORIGINAL expiry (rotation tombstones
//     live at least until then — replay detection depends on it) or revoked >7d
//   - oauth_clients with no grant and no use in 30d
//   - mcp_chat_runs: running past lease → failed('worker_lost');
//     queued >10 min → failed('never_claimed')
maintenanceRouter.post('/cleanup-oauth', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const counts = await withAdminScope(
      {
        caller: 'maintenance.cleanup-oauth',
        reason: 'cross-tenant expiry sweep of OAuth + chat-run tables',
        actor: 'cloud-scheduler',
      },
      async (client) => {
        const out: Record<string, number> = {};
        const del = async (label: string, sql: string): Promise<void> => {
          const r = await client.query(sql);
          out[label] = r.rowCount ?? 0;
        };

        await del('setupTokens', `DELETE FROM setup_tokens WHERE expires_at < NOW() - INTERVAL '1 day'`);
        await del('authRequests', `DELETE FROM oauth_authorization_requests WHERE expires_at < NOW() - INTERVAL '1 hour' OR consumed_at < NOW() - INTERVAL '1 hour'`);
        await del('authCodes', `DELETE FROM oauth_authorization_codes WHERE expires_at < NOW() - INTERVAL '1 hour' OR used_at < NOW() - INTERVAL '1 hour'`);
        // Device codes outlive every outcome by an hour: a tool still polling
        // past approval, denial or expiry must read access_denied or
        // expired_token, not a vanished row (RFC 8628 §3.5).
        await del('deviceCodes', `DELETE FROM oauth_device_codes WHERE expires_at < NOW() - INTERVAL '1 hour'`);
        await del('accessTokens', `DELETE FROM oauth_access_tokens WHERE expires_at < NOW() - INTERVAL '1 hour' OR revoked_at < NOW() - INTERVAL '7 days'`);
        await del('refreshTokens', `DELETE FROM oauth_refresh_tokens WHERE expires_at < NOW() - INTERVAL '1 hour' OR revoked_at < NOW() - INTERVAL '7 days'`);
        await del('staleClients', `DELETE FROM oauth_clients c
           WHERE c.created_at < NOW() - INTERVAL '30 days'
             AND (c.last_used_at IS NULL OR c.last_used_at < NOW() - INTERVAL '30 days')
             AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)`);

        const lost = await client.query(
          `UPDATE mcp_chat_runs SET status = 'failed', error_code = 'worker_lost', completed_at = NOW()
           WHERE status = 'running' AND lease_expires_at < NOW()`,
        );
        out.workerLostRuns = lost.rowCount ?? 0;
        const unclaimed = await client.query(
          `UPDATE mcp_chat_runs SET status = 'failed', error_code = 'never_claimed', completed_at = NOW()
           WHERE status = 'queued' AND created_at < NOW() - INTERVAL '10 minutes'`,
        );
        out.neverClaimedRuns = unclaimed.rowCount ?? 0;

        return out;
      },
    );

    log.info(counts, 'cleanup-oauth: completed');
    return res.json({ success: true, ...counts });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'cleanup-oauth: failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});
