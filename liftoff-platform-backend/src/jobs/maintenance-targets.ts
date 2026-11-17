// What each maintenance arming aims at, and the arms the request paths call.
//
// Kept apart from the handlers (and importing nothing heavy) because the arms
// are called from hot paths — the spend push handlers, the LLM usage writer,
// the notification enqueue — and the housekeeping list names the same targets.
// The auth is what the route's own check expects (see maintenance-tasks.ts);
// every task also carries the scheduler SA's OIDC token.

import { armDue, armWatch, type MaintenanceAuth } from '../infrastructure/maintenance-tasks';

export interface RouteTarget {
  path: string;
  auth?: MaintenanceAuth;
}

export const TARGETS = {
  costIngest: { path: '/api/internal/jobs/cost-attribution-ingest', auth: 'callback' },
  vendorSpendMonitor: { path: '/api/internal/jobs/vendor-spend-monitor', auth: 'callback' },
  x402Reload: { path: '/api/internal/x402-reload', auth: 'callback' },
  x402Topup: { path: '/api/internal/x402-topup', auth: 'callback' },
  x402LowBalance: { path: '/api/internal/x402-low-balance', auth: 'callback' },
  ouMeterRetryDrain: { path: '/api/internal/ou-meter-retry-drain', auth: 'callback' },
  outboundWebhooks: { path: '/api/internal/maintenance/drain-outbound-webhooks', auth: 'callback' },
  chatDeliveries: { path: '/api/internal/maintenance/sweep-chat-deliveries', auth: 'callback' },
  strandedProvisioning: { path: '/api/internal/maintenance/sweep-stranded-provisioning', auth: 'callback' },
  notificationsTick: { path: '/api/internal/notifications/run-tick', auth: 'callback' },
  tunnelTokenGrace: { path: '/api/internal/tunnels/sweep-token-grace', auth: 'tunnel' },
  tunnelPending: { path: '/api/internal/tunnels/sweep-pending', auth: 'tunnel' },
  tunnelDisconnected: { path: '/api/internal/tunnels/sweep-disconnected', auth: 'tunnel' },
} as const satisfies Record<string, RouteTarget>;

/**
 * Spend happened somewhere: run the cost pass soon.
 *
 * The pass pulls every source's feed (each tenant runtime, governance,
 * developer-proxy, this service's own LLM calls), debits wallets, stops a
 * workspace at zero, and fires auto-reloads. It ran every hour whether or not
 * anything had been spent, and its feed pulls woke every tenant runtime each
 * time. Now every spend signal arms it, one task per 10-minute bucket, so a
 * workspace out of credit is stopped ~10 minutes after the spend rather than
 * within the hour, and nothing runs when nothing was spent. The vendor spend
 * monitor reads the same spend, so it rides the same signal.
 *
 * Each signal reads only the feed its spend lands in. The runtime feeds are
 * served by the tenant runtime's agent-service, which bills by the instance,
 * so a pass that read every workspace's runtime because this service made a
 * model call woke it, and kept it billing, while nothing ran there:
 *   - 'platform': this service's own model calls, in its own llm_usage_log.
 *   - 'developer-proxy': usage recorded in developer-proxy's database.
 *   - a workspace's finished run: its runtime, sandbox and ledger feeds and
 *     its governance actions, which reach this service only through them.
 * The daily pass reads every feed for every workspace.
 */
export type CostSpendSource = 'platform' | 'developer-proxy' | { tenantId: string };

export function armCostIngest(source: CostSpendSource): void {
  if (source === 'platform') {
    armWatch('cost-ingest-platform', { ...TARGETS.costIngest, body: { sources: ['platformLlm'] } }, 2 * 60 * 1000);
  } else if (source === 'developer-proxy') {
    armWatch('cost-ingest-developer-proxy', { ...TARGETS.costIngest, body: { sources: ['developer_proxy'] } }, 2 * 60 * 1000);
  } else {
    armWatch(`cost-ingest-tenant-${source.tenantId}`, {
      ...TARGETS.costIngest,
      body: { sources: ['runtime', 'sandbox', 'usageLedger', 'governance'], tenantId: source.tenantId },
    }, 2 * 60 * 1000);
  }
  armWatch('vendor-spend-monitor', TARGETS.vendorSpendMonitor, 3 * 60 * 1000);
}

/** The x402 wallet paid a vendor: it holds a few dollars, and a reload that
 *  waits for a clock leaves every x402 tool failing until it comes. Reload
 *  first (treasury → wallet), then top the treasury up and check balances. */
export function armX402Upkeep(): void {
  armWatch('x402-reload', TARGETS.x402Reload, 60 * 1000);
  armWatch('x402-topup', TARGETS.x402Topup, 5 * 60 * 1000);
  armWatch('x402-low-balance', TARGETS.x402LowBalance, 12 * 60 * 1000);
}

/** A meter event failed to reach Stripe and was parked for retry. */
export function armOuMeterRetry(): void {
  armWatch('ou-meter-retry', TARGETS.ouMeterRetryDrain, 5 * 60 * 1000);
}

/** An outbound webhook was queued: deliver it now, not at the next clock. */
export function armOutboundWebhooks(): void {
  armWatch('outbound-webhooks', TARGETS.outboundWebhooks, 30 * 1000);
}

/** A retry is due at `at` (the earliest next_attempt_at). */
export function armOutboundWebhooksAt(at: Date): void {
  armDue('outbound-webhooks', TARGETS.outboundWebhooks, at);
}

/** A reply's delivery was recorded; the sweep re-posts one still pending
 *  after 10 minutes, so look just after that. */
export function armChatDeliverySweep(): void {
  armWatch('chat-deliveries', TARGETS.chatDeliveries, 11 * 60 * 1000);
}

/** A team-provisioning run started; the sweep rolls back one still pending
 *  after 30 minutes with no live lease. */
export function armStrandedProvisioningSweep(): void {
  armWatch('stranded-provisioning', TARGETS.strandedProvisioning, 31 * 60 * 1000);
}

/** A tunnel token was rotated; the previous one stops working at `expiresAt`. */
export function armTunnelTokenGrace(expiresAt: Date): void {
  armDue('tunnel-token-grace', TARGETS.tunnelTokenGrace, new Date(expiresAt.getTime() + 30 * 1000));
}

/** A tunnel deployment was created; one still pending after 10 minutes is removed. */
export function armTunnelPendingSweep(): void {
  armWatch('tunnel-pending', TARGETS.tunnelPending, 11 * 60 * 1000);
}

/** A tunnel heartbeat arrived. The check armed by the LAST one finds the
 *  tunnel silent and marks it disconnected. */
export function armTunnelDisconnectedSweep(): void {
  armWatch('tunnel-disconnected', TARGETS.tunnelDisconnected, 2 * 60 * 1000);
}

/** The digest tick for `at` (top of the hour someone's clock reads 09:00). */
export function armDigestTick(at: Date): void {
  armDue('digest', TARGETS.notificationsTick, new Date(at.getTime() + 60 * 1000));
}
