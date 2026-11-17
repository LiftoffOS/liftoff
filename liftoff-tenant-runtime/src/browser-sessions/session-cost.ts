// What a pane browser cost, recorded when the session settles.
//
// Every other web tool bills per CALL: the handler has the vendor's figure in
// hand the moment the call returns, and publishes it there. A pane session is
// not a call. It is opened once, driven for minutes by navigate/screenshot/
// run_browser_task, and closed later by a person, by the reaper, or by tenant
// teardown. None of those operations knows what the session cost.
//
// So the settled figure exists in exactly one moment: the stop. That is where
// this records it, and it is why none of the pane tool handlers carry billing
// code — adding it there would charge per navigation for a window already paid
// for.
//
// Before this existed the pane path recorded nothing at all, for ANY vendor. A
// workspace could run a browser for ten minutes a day, every day, and its cost
// reporting would show zero. It became urgent when the platform took a Browser
// Use key, because those hours are ours to pay and the funding rule had nothing
// to act on, but it was always wrong.
//
// Vendor-general on purpose. The three vendors that can own a pane report cost
// three different ways — Browser Use settles browser time plus proxy egress on
// stop, Anchor reports credits against the session, Browserbase bills by the
// hour — so each client converts its own figures to USD and hands them here.
// The LEDGER shape is identical for all three, which is what makes "what did
// this team spend on browsers" answerable at all.

import { logger } from '../infrastructure/logging';
import { getPool } from '../infrastructure/database';
import { publishWebToolEvent } from '../integrations/web-fetch/event-publisher';
import { usageLedgerService } from '../usage-ledger/service';
import type { WebToolFunding } from '../integrations/web-fetch/types';

/** The event_type both ledgers carry for a pane session.
 *
 *  Distinct from the per-call web_* types on purpose: this row is a SESSION,
 *  and reporting it as `web_fetch_advanced` would put minutes of browser time
 *  under a tool nobody called. The control plane maps it alongside the others
 *  (EVENT_TYPE_MAP in usage-ledger-ingester.ts) and collapses it to the
 *  `web_tool` event_type like every sibling. */
export const BROWSER_SESSION_EVENT_TYPE = 'browser_session';

/** Deterministic across every path that can settle the same session.
 *
 *  A session can be stopped by the agent's web_session_close and then swept by
 *  the reaper moments later, and both settle the SAME vendor session. Keyed on
 *  the vendor and its session id so the second one dedups in the control plane
 *  rather than billing the window twice. */
export function sessionCostIdempotencyKey(vendor: string, vendorSessionId: string): string {
  return `${vendor}_session:${vendorSessionId}`;
}

export interface Attribution {
  agentId: string | null;
  threadId: string | null;
  /** The run that owned the session, when a run rather than a thread did. */
  invocationId?: string | null;
  /** Which platform assistant owned the session, when no agent did. Null for a
   *  team agent's session, which `agentId` identifies. */
  assistant?: string | null;
  /** Whether a `web_sessions` row was found at all. A row with no agent is
   *  attributable — it belongs to a platform assistant and to the tenant. NO
   *  row is not, and the two must not be confused: refusing the first would
   *  drop exactly the cost this attribution exists to record. */
  found?: boolean;
}

async function attributionFor(
  tenantId: string,
  vendorSessionId: string,
): Promise<Attribution> {
  const { rows } = await getPool().query<{
    agent_id: string | null; thread_id: string | null; invocation_id: string | null; vendor_metadata: unknown;
  }>(
    `SELECT agent_id, thread_id, invocation_id, vendor_metadata FROM web_sessions
      WHERE tenant_id = $1 AND vendor_session_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, vendorSessionId],
  );
  const row = rows[0];
  if (!row) return { agentId: null, threadId: null, invocationId: null, assistant: null, found: false };
  const meta = (row.vendor_metadata ?? {}) as Record<string, unknown>;
  const assistant = typeof meta['assistant'] === 'string' ? meta['assistant'] : null;
  // The sentinel is returned AS IT IS STORED, deliberately.
  //
  // Mapping it to null here looks tidier and breaks the usage ledger:
  // usage_events.agent_id is NOT NULL, the insert would fail, and the failure
  // is already wrapped in a .catch that logs a warning — so the backstop feed
  // would go silently missing for exactly the sessions this work is about.
  // (strictNullChecks is off in this repo, so the compiler would not have said
  // a word either.)
  //
  // Turning "no agent" into a reporting decision belongs to the control plane,
  // which owns the per-agent report and is the only side that knows the id
  // space it wants. It receives `assistant` alongside and maps the sentinel to
  // null there.
  return {
    agentId: row.agent_id ?? null, threadId: row.thread_id ?? null,
    invocationId: row.invocation_id ?? null, assistant, found: true,
  };
}

/**
 * Record a settled pane session against the tenant, once.
 *
 * Writes BOTH ledgers, because both reach billing and they are not
 * alternatives: `publishWebToolEvent` is the real-time path and the usage
 * ledger is the poll the control plane backstops it with. A figure on only one
 * of them means the charge depends on which path arrives first.
 *
 * Refuses to record a session with no settled instant. A vendor reports a final
 * cost only once the session has ended; before that the figures are a running
 * estimate or an upfront reservation, not a bill. Publishing one would charge a
 * workspace for minutes it never used AND burn the idempotency key against the
 * real figure arriving later. A session we cannot settle is logged under a
 * greppable event instead, which is the honest answer: the money was spent and
 * we do not know how much.
 */
export async function recordSettledSessionCost(args: {
  vendor: string;
  tenantId: string;
  vendorSessionId: string;
  /** The vendor's own settled figure in USD, or null when it could not be read. */
  costUsd: number | null;
  /** When the vendor says the session ended. Null when it has not, or is unknown. */
  settledAt: Date | null;
  funding: WebToolFunding;
  /** Anything the vendor reports that a person or an auditor would want beside
   *  the number: browser time versus proxy egress, credits, duration. */
  breakdown?: Record<string, unknown>;
  /** Attribution for a session that has no `web_sessions` row to read it from.
   *
   *  One case needs it: a spawn that created a browser at the vendor and then
   *  abandoned it, because the vendor handed back nothing we could drive. The
   *  row is never written, so the lookup below finds nothing — but the vendor
   *  still charged for the window it opened, and the caller knows exactly whose
   *  it was. */
  attribution?: Attribution;
}): Promise<void> {
  const { vendor, tenantId, vendorSessionId, costUsd, settledAt, funding } = args;

  // Not just null: any non-finite figure. A vendor that sends money as a JSON
  // string turns `a + b` into a concatenation, which becomes NaN at the first
  // arithmetic downstream — and NaN travels a long way looking fine. Published,
  // it reaches the control plane's bucket allocator, which computes
  // `!(NaN > 0)`, assigns nothing, and ACKs with a 200. The session then bills
  // nobody and nothing anywhere reports a problem. Refusing here is what turns
  // that into a log line somebody can find.
  if (costUsd === null || !Number.isFinite(costUsd) || settledAt === null
      || Number.isNaN(settledAt.getTime())) {
    logger.warn({
      tenant_id: tenantId,
      vendor,
      vendor_session_id: vendorSessionId,
      funding,
      cost_usd: costUsd,
      event: 'browser_session_cost_unsettled',
    }, 'browser session could not be settled; its cost is unrecorded');
    return;
  }

  const attribution = args.attribution ?? await attributionFor(tenantId, vendorSessionId);
  const { agentId, threadId } = attribution;
  const invocationId = attribution.invocationId ?? null;
  const assistant = attribution.assistant ?? null;

  // NO ROW is what makes a session unattributable — it predates this tenant's
  // data or belongs to another. A row with NO AGENT is a different thing
  // entirely: it is a platform assistant's session, it belongs to this tenant,
  // and refusing it here would drop the exact cost this function exists to
  // record. `found` distinguishes them; a caller-supplied attribution is
  // trusted, since it comes from a spawn that knows whose it was.
  const attributable = attribution.found !== false || args.attribution !== undefined;
  if (!attributable) {
    logger.warn({
      tenant_id: tenantId,
      vendor,
      vendor_session_id: vendorSessionId,
      cost_usd: costUsd,
      event: 'browser_session_cost_unattributed',
    }, 'browser session has no web_sessions row; cost not recorded');
    return;
  }

  const idempotencyKey = sessionCostIdempotencyKey(vendor, vendorSessionId);
  // The vendor's own settled instant, not now(). Two settle attempts read the
  // same ended session and must produce the same occurred_at, because the
  // control plane's uniqueness index for these rows is
  // (source, source_id, event_type, occurred_at) and a drifting timestamp would
  // slip a duplicate past it.
  const occurredAt = settledAt.toISOString();
  const breakdown = args.breakdown ?? {};

  await usageLedgerService.recordUsage({
    tenantId,
    agentId,
    workflowId: null,
    actionId: null,
    eventType: BROWSER_SESSION_EVENT_TYPE,
    credits: 1,
    metadata: {
      tool_name: BROWSER_SESSION_EVENT_TYPE,
      // The owning thread, so the backstop-ingested row attributes like the
      // real-time event below. A pane session spans invocations, so thread is
      // its key; a run-owned session has no thread and its run is the key.
      thread_id: threadId,
      ...(invocationId ? { invocation_id: invocationId } : {}),
      vendor,
      vendor_session_id: vendorSessionId,
      // Which assistant, when no agent owned the session. In metadata because
      // that is this ledger's extension point and agent_id cannot hold it.
      ...(assistant ? { assistant } : {}),
      cost_micros: Math.round(costUsd * 1_000_000),
      idempotency_key: idempotencyKey,
      // Whose key paid the vendor. Both ledgers carry it because BOTH reach
      // billing: this feed is what the control plane's usage-ledger ingester
      // polls as a backstop, and the event below is the real-time path.
      funding,
      ...breakdown,
    },
  }).catch((err: Error) => logger.warn(
    { err: err.message, vendor, vendor_session_id: vendorSessionId },
    'Non-fatal: browser session usage tracking failed',
  ));

  await publishWebToolEvent({
    tenantId,
    agentId,
    threadId,
    ...(assistant ? { purpose: assistant } : {}),
    connector: vendor,
    eventType: BROWSER_SESSION_EVENT_TYPE,
    costUsd,
    occurredAt,
    idempotencyKey,
    metadata: { vendor_session_id: vendorSessionId, funding, ...breakdown },
  });

  logger.info({
    tenant_id: tenantId,
    agent_id: agentId,
    assistant,
    vendor,
    vendor_session_id: vendorSessionId,
    cost_usd: costUsd,
    funding,
    event: 'browser_session_settled',
  }, 'browser session settled and recorded');
}
