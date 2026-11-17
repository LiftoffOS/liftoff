import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getCachedFlagNumber } from './sentinel-flags';
import { fetchPlatformVendorBalances } from '../connectors/platform-vendor-balances';

const RUNAWAY_HOURLY_DEFAULT_USD: Record<string, number> = {
  web_deep_research: 25,
};

async function readRunawayThreshold(tool: string): Promise<number> {
  const key = `web_tools_runaway_per_hour_${tool}_value`;
  const v   = await getCachedFlagNumber(key);
  return v !== null && v > 0
    ? v
    : (RUNAWAY_HOURLY_DEFAULT_USD[tool] ?? Infinity);
}

// Operator MTD-spend alert thresholds. Only platform-managed vendors that
// actually bill Liftoff's accounts appear here. The BYOK web-tool vendors
// (firecrawl, anchor, browserbase, webclaw, and tavily and exa when a
// workspace connected its own key) are billed to each tenant's own vendor
// account — `STRICT_WEBTOOL_VENDORS` in `cost-attribution/repository.ts`
// bypasses the OU charge for these rows, so an aggregate spend alert across
// all tenants would not be actionable for Liftoff operators.
//
// OpenAI, Google deep-research and xAI are NOT in the strict-vendor bypass —
// they continue to bill OUs normally — but their MTD pattern hasn't been
// observed yet at meaningful scale. Add explicit entries below once the
// usage volume justifies an alert threshold. A threshold set BEFORE there is
// usage to derive it from is a guess, and a guess that fires on ordinary demand
// gets silenced, which leaves the vendor less protected than having no entry.
const TIER_LIMITS_USD: Record<string, number> = {
  perplexity:  100,   // operator alert threshold; pay-as-you-go, no subscription floor
  // Steel and Browser Use are the BYOK-shaped vendors the platform ALSO holds
  // a key for, so their monthly totals are partly ours to pay. Every other
  // entry on the strict list is funded entirely by the workspace that
  // connected it, which is why they have no threshold here: an alert on
  // someone else's bill is noise.
  //
  // The SUM below is over cost_usd, so it counts BOTH fundings together, and
  // that is deliberate for an operator alert: a spike is worth looking at
  // whoever paid, and the ou_consumed column separates them afterwards.
  //
  // Steel's figure is the same as Browser Use's, not a measured one: the
  // Launch plan bills $0.10 per browser-hour and $10 per GiB of proxy, and
  // it auto-tops-up, so a loop keeps succeeding and nothing but this alert
  // and the runtime's ten-browser ceiling would say so.
  steel: 200,
  browser_use: 200,
  // xAI (web_x_search) is absent for the same reason openai and google are: it
  // is platform-funded, so a threshold WOULD be actionable — there just is no
  // observed usage to set one from. web_x_search went live to every agent with
  // no history at all, and a number picked before the first call is a guess
  // that fires on ordinary demand, gets silenced, and protects nothing after
  // that. A muted alert is worse than an absent one.
  //
  // The runaway case is already bounded, and not by an alert: the runtime caps
  // web_x_search at 500/hr per tenant (~$2.50/hr), which STOPS a loop rather
  // than reporting it afterwards. Auto-reload on the vendor account is why that
  // matters — it keeps calls succeeding, so nothing else interrupts a loop.
};
const ALERT_THRESHOLD_PCT = 80;

/** Browser Use's one-time free-plan credit, in USD.
 *
 *  Their API has no balance endpoint — verified against the docs, the llms.txt
 *  index and the v4 OpenAPI spec, whose only paths are /runs, /sessions,
 *  /workspaces, /browsers and /profiles. So the remaining credit cannot be
 *  read; it can only be derived by subtracting what we have spent from what we
 *  were given.
 *
 *  That derivation is only trustworthy because every session now settles. Until
 *  the reaper was scheduled and the janitor stopped taking rows before it, most
 *  sessions closed without recording a cost, and any total computed from these
 *  rows would have been an undercount of unknown size. */
const BROWSER_USE_PLATFORM_CREDIT_USD = 15;

/** The floors under which the platform's prepaid aggregator balances raise
 *  the operator alert. Locus recharges itself from a saved card, so a balance
 *  under its floor means the card has failed and the dashboard is the only
 *  other place that shows; Vaaya sells packs and never recharges, so its
 *  floor is the reminder to buy one. An empty balance parks every function
 *  on that card at once (the capability path's payment-required cooldown),
 *  which is why this is an alert and not a report. */
const AGGREGATOR_BALANCE_FLOOR_USD: Record<'locus' | 'vaaya', number> = {
  locus: 5,
  vaaya: 2,
};

/** What the platform has left at the aggregators it prepays, from
 *  connector-service (the keys live there). Report-only when funded, an
 *  alert under the floor, and a warning of its own when a figure cannot be
 *  read — silence is the one outcome this must not have. */
async function reportAggregatorBalances(): Promise<void> {
  const balances = await fetchPlatformVendorBalances();
  for (const vendor of ['locus', 'vaaya'] as const) {
    const { usd, error } = balances[vendor];
    if (usd === null) {
      log.warn({ event: 'vendor_balance_unread', vendor, error }, 'vendor_balance_unread');
      continue;
    }
    const floor = AGGREGATOR_BALANCE_FLOOR_USD[vendor];
    if (usd < floor) {
      log.warn({ event: 'vendor_balance_low', vendor, balance_usd: usd, floor_usd: floor }, 'vendor_balance_low');
    } else {
      log.info({ event: 'vendor_balance', vendor, balance_usd: usd, floor_usd: floor }, 'vendor_balance');
    }
  }
}

/** What the platform's own Browser Use key has spent, against the credit.
 *
 *  Deliberately REPORT-ONLY. Nothing here alerts, throttles or degrades, and
 *  nothing changes when the credit runs out: sessions will simply start failing
 *  with the vendor's 402, and that is the accepted behaviour. This exists so the
 *  number is visible before that happens rather than after.
 *
 *  Cumulative, not month-to-date, because the credit is one-time and
 *  non-expiring — a monthly window would reset a total that never resets.
 *
 *  `ou_consumed > 0` is what separates platform-funded rows from a workspace's
 *  own key: a tenant-funded browser_use row takes the strict-vendor bypass and
 *  is written with zero OUs and zero customer cost, precisely so the workspace
 *  is not charged twice for hours it already paid the vendor for. */
async function reportPlatformBrowserCredit(): Promise<void> {
  const { rows } = await withAdminScope(
    {
      caller: 'web-tools.vendor-spend-monitor',
      reason: 'cross-tenant platform browser credit total (no tenant filter)',
    },
    (client) => client.query<{ spent: string | null; sessions: string }>(
      `SELECT SUM(cost_usd) AS spent, COUNT(*) AS sessions
         FROM cost_attribution_events
        WHERE event_type = 'web_tool'
          AND source     = 'tenant_runtime'
          AND connector  = 'browser_use'
          AND ou_consumed > 0`,
    ),
  );
  const spent = parseFloat(rows[0]?.spent ?? '0') || 0;
  const sessions = parseInt(rows[0]?.sessions ?? '0', 10) || 0;
  const remaining = BROWSER_USE_PLATFORM_CREDIT_USD - spent;
  log.info({
    event: 'platform_browser_credit',
    spent_usd: spent,
    remaining_usd: remaining,
    credit_usd: BROWSER_USE_PLATFORM_CREDIT_USD,
    sessions,
    // What a session has actually cost us so far. Proxy egress at $5/GB
    // dominates it — the first measured session was $0.0866, of which $0.0833
    // was 17MB of proxy and only $0.0033 was browser time — so a figure derived
    // from the $0.02/browser-hour rate alone understates it by ~25x.
    mean_session_usd: sessions > 0 ? spent / sessions : 0,
  }, 'platform_browser_credit');
}

export async function monitorVendorSpend(): Promise<void> {

  const result = await withAdminScope({ caller: 'web-tools.vendor-spend-monitor', reason: 'cross-tenant vendor MTD/hourly spend aggregation (no tenant filter)' }, (client) => client.query<{ vendor: string; mtd_cost: string }>(
    `SELECT
       connector AS vendor,
       SUM(cost_usd) AS mtd_cost
     FROM cost_attribution_events
     WHERE event_type  = 'web_tool'
       AND source      = 'tenant_runtime'
       AND occurred_at >= date_trunc('month', now())
     GROUP BY connector`,
  ));
  for (const row of result.rows) {
    const limit = TIER_LIMITS_USD[row.vendor];
    if (limit === undefined) continue;
    const mtdCost = parseFloat(row.mtd_cost);
    if (limit === 0) {
      // Free-tier vendor (e.g. Firecrawl). Dollar denominator is meaningless;
      // skip the percentage alert. If mtd_cost is somehow non-zero, that's
      // either an enhanced-proxy fetch or an out-of-band plan upgrade we
      // forgot to reflect in the constant — surface it as a distinct signal.
      if (mtdCost > 0) {
        log.warn({
          event: 'vendor_spend_unexpected',
          vendor: row.vendor,
          mtd_cost_usd: mtdCost,
        }, 'vendor_spend_unexpected');
      }
      continue;
    }
    const pct = (mtdCost / limit) * 100;
    if (pct >= ALERT_THRESHOLD_PCT) {
      log.warn({
        event: 'vendor_spend_high',
        vendor: row.vendor,
        pct,
        mtd_cost_usd: mtdCost,
        tier_limit_usd: limit,
      }, 'vendor_spend_high');
    }
  }

  // Per-tool runaway. Runs against the 15-min ingester window matched
  // (Phase 0 schedule). The lookback is 1 hour — long enough to absorb
  // a single ingester delay but short enough that a sustained burst
  // alerts quickly.
  const runawayTools = Object.keys(RUNAWAY_HOURLY_DEFAULT_USD);
  if (runawayTools.length === 0) {
    // Nothing to check for runaway, but the reports below still must run.
    // It used to be an early return, which would have silently skipped them.
    await reportPlatformBrowserCredit().catch((err: Error) =>
      log.warn({ err: err.message }, 'platform browser credit report failed'));
    await reportAggregatorBalances().catch((err: Error) =>
      log.warn({ err: err.message }, 'aggregator balance report failed'));
    return;
  }

  const hourly = await withAdminScope({ caller: 'web-tools.vendor-spend-monitor', reason: 'cross-tenant vendor MTD/hourly spend aggregation (no tenant filter)' }, (client) => client.query<{ tool: string; hourly_cost: string }>(
    `SELECT action_type AS tool,
            SUM(cost_usd) AS hourly_cost
       FROM cost_attribution_events
      WHERE event_type  = 'web_tool'
        AND source      = 'tenant_runtime'
        AND action_type = ANY($1)
        AND occurred_at >= NOW() - INTERVAL '1 hour'
      GROUP BY action_type`,
    [runawayTools],
  ));
  for (const row of hourly.rows) {
    const cap  = await readRunawayThreshold(row.tool);
    const cost = parseFloat(row.hourly_cost);
    if (cost >= cap) {
      log.warn({
        event:           'vendor_spend_high',
        scope:           'tool',
        tool:            row.tool,
        hourly_cost_usd: cost,
        hourly_cap_usd:  cap,
      }, 'vendor_spend_high (per-tool runaway)');
    }
  }

  // Report-only, and LAST: it must never displace the alerts above, and adding
  // a query ahead of them shifts every ordered pool mock in their tests.
  await reportPlatformBrowserCredit().catch((err: Error) =>
    log.warn({ err: err.message }, 'platform browser credit report failed'));
  // After the browser credit, and over HTTP rather than the pool, so it
  // shifts none of the ordered pool mocks either.
  await reportAggregatorBalances().catch((err: Error) =>
    log.warn({ err: err.message }, 'aggregator balance report failed'));
}
