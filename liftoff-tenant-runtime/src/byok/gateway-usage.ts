// What the gateway actually saw on the wire for a run, read back at turn end.
//
// THE ENGINE IS NOT ALWAYS A RELIABLE WITNESS TO ITS OWN SPEND. Two engines here
// report a summary that cannot be priced from:
//
//   opencode    reasoning tokens, split out of the completion count it publishes.
//               Its own `part.cost` is no independent check — it is derived from
//               the same figure.
//   gemini-cli  thinking and tool-prompt tokens. Its `stats` expose `total`,
//               `input` and `output` and never `thoughts` or `tool`, so the
//               residual cannot be split between the input and output rates.
//
// Both figures are on the vendor's own response, and the gateway is the one
// component that reads it. This is how they reach the row that bills — and, on
// every other engine, a second witness to counts the runtime otherwise carries
// through enumerations of its own.
//
// It is a PREFERENCE, not a second billing path. The invocation stays the single
// billing record: `priceRunSteps` already prefers a vendor-reported charge over a
// rate-table estimate, and this is the same move one layer down. No new ledger
// row, no change to the dedup logic, no double-charge risk.

import { logger } from '../infrastructure/logging';
import { getPlatformCallbackClient } from '../platform-callback/client';

export interface GatewayRunUsage {
  /** How many requests the gateway served for this run.
   *
   *  THE FIELD THAT DECIDES EVERYTHING DOWNSTREAM. Zero means this run never came
   *  through the door, and the engine's own numbers are all there is — which is
   *  the normal case for any run whose provider has no gateway session. Without
   *  it a caller cannot tell "the gateway saw nothing" from "the gateway saw a
   *  run that spent nothing", and getting that backwards replaces real counts
   *  with zeroes. */
  requests: number;
  /** How many of those requests had not finished being written yet.
   *
   *  The gateway opens a row BEFORE it forwards the response and fills the token
   *  counts in afterwards, deliberately — the ledger's funding question is a
   *  count over these rows and has to be answerable before the run can settle. The
   *  consequence here is a race this side has to respect: a turn ending the
   *  instant its last response completes can read that row's zeroes. Counting
   *  them would under-report the run by exactly one request, every time, in the
   *  direction this whole change exists to correct. */
  incomplete: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Separate money from the read: Anthropic bills a write at 1.25x input
   *  against a read's 0.1x, and reports `input_tokens` exclusive of both. */
  cacheWriteTokens: number;
  /** A BREAKDOWN of `outputTokens`, never an addition to it. Every vendor bills
   *  reasoning at the completion rate, and `outputTokens` above is already the
   *  billable total by the vendor's own arithmetic. */
  reasoningTokens: number;
  /**
   * WHAT THE VENDOR SAYS IT CHARGED, summed over the requests that said.
   *
   * Null when none did, which is every direct-API vendor: they publish a price
   * list, not a per-call charge. Null means "price this from the rate table" and
   * never "this was free".
   *
   * On a gateway-served model it is the only figure that can be right. One model
   * is served by many endpoints at different prices, and the listed slug rate is
   * short by whatever premium the endpoint that actually took the request charges
   * — a turn whose tokens reconstructed to $0.01411360 was charged $0.01853990.
   * No token count sees that spread.
   */
  vendorCostUsd: number | null;
  /**
   * How many requests reported a cost, and the reason the sum is unusable without
   * it.
   *
   * A sum over SOME of a run's requests is not the run's charge. Preferring a
   * partial sum over a complete token reconstruction would under-bill by whatever
   * the silent requests cost, so the sum is only taken as the money when this
   * equals `requests`.
   */
  vendorCostRequests: number;
}

/** How long a finished turn waits for its own numbers.
 *
 *  One indexed read over a handful of rows. Short, because the turn is over and
 *  the work is done: past this the engine's own counts are what the invocation
 *  records, which is exactly what it recorded before this existed. */
const USAGE_READ_TIMEOUT_MS = 4_000;

/** How long to give a request the gateway had not finished writing.
 *
 *  The write it is waiting on is one UPDATE that the gateway issues immediately
 *  after the last byte reaches the client, so this is generously long for it.
 *  ONE retry and no more: a row still unwritten after this is a row whose write
 *  failed, and the gateway logs that loudly on its own side. Spinning would trade
 *  a one-request under-count for a stalled turn, which is a worse deal. */
const PENDING_WRITE_GRACE_MS = 750;

/**
 * The gateway's totals for this run, or null to keep the engine's own numbers.
 *
 * Null for every failure and for every run the control plane cannot be reached
 * for. That asymmetry is deliberate: an unreadable answer must leave the
 * invocation exactly as the engine reported it, never zeroed. Under-counting a
 * turn is the defect this whole change exists to fix, and replacing real counts
 * with a failed read's zeroes would be the same defect introduced by the cure.
 */
export async function readGatewayRunUsage(
  tenantId: string,
  invocationId: string,
  /**
   * The start of the caller's own HALF of the run.
   *
   * A RUN CAN BILL MORE THAN ONCE, and this is what keeps a correction from
   * becoming a duplicate. A turn that pauses for a person bills the paused half
   * and then bills its continuation separately, while every gateway row for both
   * halves is written under the run's own id — so an unbounded sum handed to the
   * continuation contains requests the paused half has already been charged for,
   * and the difference it would be asked to explain is tokens it never spent.
   */
  since?: Date,
): Promise<GatewayRunUsage | null> {
  const first = await readOnce(tenantId, invocationId, since);
  // A request the gateway had not finished writing. Wait once, then take what is
  // there: an unwritten row is a failed write, which the gateway reports on its
  // own side, and a second read is the whole of what this side can usefully do.
  if (first && first.incomplete > 0) {
    await new Promise((resolve) => setTimeout(resolve, PENDING_WRITE_GRACE_MS));
    const second = await readOnce(tenantId, invocationId, since);
    if (second) {
      if (second.incomplete > 0) {
        logger.warn(
          {
            tenantId,
            invocationId,
            incomplete: second.incomplete,
            requests: second.requests,
          },
          'byok: gateway rows for this run are still unwritten; its counts are short by them',
        );
      }
      return second;
    }
  }
  return first;
}

async function readOnce(
  tenantId: string,
  invocationId: string,
  since?: Date,
): Promise<GatewayRunUsage | null> {
  if (!tenantId || !invocationId) return null;
  const client = getPlatformCallbackClient();
  if (!client) return null;

  try {
    const query = new URLSearchParams({
      tenantId,
      invocationId,
      ...(since ? { since: since.toISOString() } : {}),
    }).toString();
    const resp = await client.fetch('platform', `/api/internal/byok/session/usage?${query}`, {
      method: 'GET',
      breakerKey: 'platform:byok-session-usage',
      signal: AbortSignal.timeout(USAGE_READ_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // INFO rather than WARN for a 503, because the control plane saying "I
      // could not read this" is the designed answer to a failed read and the
      // caller's response to it is correct. Anything else is contract drift and
      // is worth a warning: a 404 here means the route moved, and the symptom
      // would be every run silently keeping the counts this exists to replace.
      logger[resp.status === 503 ? 'info' : 'warn'](
        { tenantId, invocationId, status: resp.status },
        'byok: gateway usage could not be read; keeping the engine own counts',
      );
      return null;
    }
    const body = (await resp.json()) as Partial<GatewayRunUsage> | null;
    if (!body || typeof body.requests !== 'number') return null;
    return {
      requests: n(body.requests),
      incomplete: n(body.incomplete),
      inputTokens: n(body.inputTokens),
      outputTokens: n(body.outputTokens),
      cacheReadTokens: n(body.cacheReadTokens),
      cacheWriteTokens: n(body.cacheWriteTokens),
      reasoningTokens: n(body.reasoningTokens),
      // NULL is meaningful here and a coerced zero is not: it says no request
      // reported a charge, which is the normal answer for a direct-API vendor.
      vendorCostUsd: typeof body.vendorCostUsd === 'number'
        && Number.isFinite(body.vendorCostUsd) && body.vendorCostUsd > 0
        ? body.vendorCostUsd
        : null,
      vendorCostRequests: n(body.vendorCostRequests),
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, invocationId },
      'byok: gateway usage read failed; keeping the engine own counts',
    );
    return null;
  }
}

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
