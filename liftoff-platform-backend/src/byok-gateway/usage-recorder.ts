// The per-call usage record, and the one question the ledger asks of it.
//
// STATED AS AN INVARIANT, because that is what it is:
//
//   Every LLM call the platform makes produces a usage record with input and
//   output token counts, whoever's key paid for it. No exceptions.
//
// This is a property of the platform, not a feature of BYOK. BYOK is only the
// first thing to test it, because it is the first time the paying account is
// not ours. Using the customer's key changes WHO PAYS for the tokens. It changes
// nothing about whether we count them.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { GatewayMode } from './token-store';
import type { GatewayTokenUsage } from './vendor-adapters';

export type ServedBy = 'byok' | 'managed';

export interface GatewayRequestRecord {
  tenantId: string;
  invocationId: string;
  vendor: string;
  agentId: string | null;
  purpose: string | null;
  /** Whose key SERVED this request. */
  servedBy: ServedBy;
  /**
   * Whose key the SESSION was opened to spend, which is a different question.
   *
   * `servedBy: 'managed'` alone cannot answer it. On a BYOK session it means the
   * turn fell back; on a managed-primary session it means nothing happened. A run
   * holds more than one session under one invocation id, so a customer-funded
   * turn can sit beside a managed row from a coding session it spawned — and
   * `wasRunByokFunded` would read that as a fallback and bill the turn in full.
   */
  sessionMode: GatewayMode;
  usage: GatewayTokenUsage;
  statusCode: number;
}

/**
 * Open a request's record BEFORE its response is forwarded.
 *
 * Two phases rather than one write at the end, and the reason is a race the
 * one-write version could not win. The ledger asks "was this run BYOK-funded?"
 * when the run's completion event arrives, and that answer is a COUNT over these
 * rows. A row written after the last byte reaches the client is a row that can
 * land after the run has finished, been published, and been settled — and a
 * short count reads as "not BYOK", which bills a turn the customer already paid
 * their provider for.
 *
 * `served_by` is known before the first byte goes out: the key that will serve
 * the request has already been chosen by the time this is called. Token counts
 * are not, so they are filled in by `completeGatewayRequest` once the response
 * has been read. The count the ledger reads is correct from the moment the
 * response starts.
 *
 * Returns the row id, or null when the insert failed — in which case the caller
 * falls back to a single write at the end. Never throws: bookkeeping must not
 * turn a working customer turn into a failed one.
 */
export async function beginGatewayRequest(
  record: Omit<GatewayRequestRecord, 'usage' | 'statusCode'>,
): Promise<string | null> {
  try {
    return await withTenantScope(record.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO byok_gateway_requests
           (tenant_id, invocation_id, vendor, agent_id, purpose, served_by,
            session_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          record.tenantId,
          record.invocationId,
          record.vendor,
          record.agentId,
          record.purpose,
          record.servedBy,
          // Written HERE, in the row the ledger's count reads, and before the
          // first byte goes out. A session mode filled in later by the UPDATE
          // would leave the funding question answerable from a row that does not
          // yet say which question to ask.
          record.sessionMode,
        ],
      );
      return result.rows[0]?.id ?? null;
    });
  } catch (error) {
    log.error(
      {
        event: 'byok_usage_record_open_failed',
        tenantId: record.tenantId,
        invocationId: record.invocationId,
        vendor: record.vendor,
        error: (error as Error).message,
      },
      'BYOK gateway could not open a usage row before forwarding; falling back to a single write',
    );
    return null;
  }
}

/**
 * Fill in what only the finished response knows: the token counts and the
 * vendor's status.
 *
 * Never throws, for the same reason as its sibling — and the row it is updating
 * already carries the field the ledger reads, so a failure here costs the token
 * counts rather than the billing decision.
 */
export async function completeGatewayRequest(
  id: string,
  tenantId: string,
  usage: GatewayTokenUsage,
  statusCode: number,
): Promise<void> {
  try {
    await withTenantScope(tenantId, async (client) => {
      await client.query(
        `UPDATE byok_gateway_requests
            SET model = $3, input_tokens = $4, output_tokens = $5,
                cached_tokens = $6, cache_read_tokens = $7,
                cache_write_tokens = $8, reasoning_tokens = $9,
                vendor_cost_usd = $10, status_code = $11
          WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          id,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.reasoningTokens,
          usage.vendorCostUsd,
          statusCode,
        ],
      );
    });
  } catch (error) {
    log.error(
      {
        event: 'byok_usage_record_complete_failed',
        tenantId,
        requestId: id,
        error: (error as Error).message,
      },
      'BYOK gateway could not record token counts for a served request',
    );
  }
}

/**
 * Write one request's record in a single statement.
 *
 * For the paths that never forward a response — a decline the gateway cannot
 * substitute for, an upstream it could not reach — where there is no race to
 * lose, and as the fallback when `beginGatewayRequest` could not open a row.
 *
 * Never throws. A gateway that 500s because its bookkeeping failed would turn a
 * successful customer turn into a failed one, and the response has already gone
 * out by the time this runs. A failure here is logged loudly instead: it means
 * the invariant above was missed for one call, which is worth an alert and is
 * not worth the turn.
 */
export async function recordGatewayRequest(record: GatewayRequestRecord): Promise<void> {
  try {
    await withTenantScope(record.tenantId, async (client) => {
      await client.query(
        `INSERT INTO byok_gateway_requests
           (tenant_id, invocation_id, vendor, model, agent_id, purpose,
            served_by, session_mode, input_tokens, output_tokens, cached_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens,
            vendor_cost_usd, status_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16)`,
        [
          record.tenantId,
          record.invocationId,
          record.vendor,
          record.usage.model,
          record.agentId,
          record.purpose,
          record.servedBy,
          record.sessionMode,
          record.usage.inputTokens,
          record.usage.outputTokens,
          record.usage.cachedTokens,
          record.usage.cacheReadTokens,
          record.usage.cacheWriteTokens,
          record.usage.reasoningTokens,
          record.usage.vendorCostUsd,
          record.statusCode,
        ],
      );
    });
  } catch (error) {
    log.error(
      {
        event: 'byok_usage_record_failed',
        tenantId: record.tenantId,
        invocationId: record.invocationId,
        vendor: record.vendor,
        error: (error as Error).message,
      },
      'BYOK gateway could not record a usage row — the token-accounting invariant was missed for this call',
    );
  }
}

/**
 * Was this whole run funded by the customer's key?
 *
 * True only when the gateway served at least one request for the run and EVERY
 * one of them went out on the customer's key. A single managed row means the
 * turn fell back — Liftoff's key paid for part of it — and section 6 is explicit
 * that a fallback turn bills as normal customer consumption.
 *
 * The granularity is the run rather than the request because that is the
 * granularity the fallback decision has: a declined key falls back for the turn
 * in flight, not for one HTTP call inside it.
 *
 * ORDERING THIS DEPENDS ON. Every request row for a run must exist before the
 * run's completion event is processed here, or this reads a short list and
 * answers "not BYOK" — which bills a turn the customer already paid their
 * provider for, the one outcome this whole design exists to prevent.
 *
 * That is a guarantee rather than a margin, and `beginGatewayRequest` is what
 * makes it one: the row is committed BEFORE the gateway forwards the first byte
 * of the response, so the run cannot have finished, published, and settled
 * before its own rows are visible. Token counts arrive afterwards by UPDATE and
 * are not part of this answer.
 *
 * Keep it that way. Deferring the insert to the end of the request — onto a
 * queue, into a batch, or into fire-and-forget past the handler — reintroduces
 * the race, and the failure it produces is a silent double charge on one turn.
 */
/** The run behind a billing id. The runtime bills a completion under its
 *  invocation id, and the continuation of a run that paused for a person and
 *  resumed under `<invocation>:resume:<pause>` — its own completion, billed
 *  once, beside the paused half's. The gateway recorded every request of
 *  that run, both halves, under the run's own id, so the answer to "did the
 *  customer's key pay for this?" is read under that id whichever half asks.
 *  The `/` sibling suffix is the bucket split of one event and is removed the
 *  same way. */
export function runIdOfBillingId(billingId: string): string {
  return billingId.split(':')[0].split('/')[0];
}

export async function wasRunByokFunded(
  tenantId: string,
  invocationId: string,
): Promise<boolean> {
  if (!invocationId) return false;
  const runId = runIdOfBillingId(invocationId);
  try {
    return await withTenantScope(tenantId, async (client) => {
      const result = await client.query<{ total: string; byok: string }>(
        // ONLY THE BYOK SESSIONS' ROWS. A managed-primary session's row is not a
        // fallback and never was a customer's key — it exists so the gateway
        // could count tokens on a run Liftoff was always paying for. Counted in
        // `total`, it would make every such row read as a fallback and bill a
        // genuinely customer-funded turn in full.
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE served_by = 'byok')::text AS byok
           FROM byok_gateway_requests
          WHERE tenant_id = $1 AND invocation_id = $2
            AND session_mode = 'byok'`,
        [tenantId, runId],
      );
      const row = result.rows[0];
      if (!row) return false;
      const total = Number(row.total);
      const byok = Number(row.byok);
      return total > 0 && total === byok;
    });
  } catch (error) {
    // Fail toward charging. A read failure that answered "BYOK" would zero-rate
    // a call nobody has evidence was BYOK-funded, and an unbilled call is
    // harder to discover than an over-billed one — the customer reports the
    // second and nobody reports the first.
    log.warn(
      { tenantId, invocationId, error: (error as Error).message },
      'byok: could not read gateway requests for run; billing as ordinary consumption',
    );
    return false;
  }
}

/**
 * What the gateway saw on the wire for one run, summed.
 *
 * THIS IS WHAT MAKES THE CAPTURE BILLABLE, and it deliberately does not bill
 * anything itself. The invocation stays the single billing record: the runtime
 * reads this at turn end and prefers it over the engine's own self-report, the
 * way it already prefers a vendor-reported charge over a rate-table estimate. No
 * second billing path means no double-charge risk and no change to the dedup.
 *
 * Summed across the run's requests and NOT presented as one request. A run's
 * requests are many, and the rate bands in `pricing-tiers.ts` key off a SINGLE
 * request's prompt size (INV-PB-013's sibling: never price a SUM against a
 * threshold). The caller uses these totals for the counts a rate band does not
 * gate — the cache write and the reasoning breakdown — and prices them at the
 * rate its own dominant request already resolved.
 *
 * `requests` is how a caller tells "the gateway saw nothing for this run" from
 * "the gateway saw a run that spent nothing". Zero requests means this run never
 * came through the door, and the caller must keep the engine's numbers.
 *
 * `incomplete` is the other half of the same honesty. A row is opened BEFORE the
 * response is forwarded and its token counts arrive afterwards by UPDATE, which
 * is deliberate (see `beginGatewayRequest`) and means a caller reading the moment
 * its turn ends can catch the last request mid-flight. Counting its zeroes as the
 * answer would under-report the run by exactly one request, silently and
 * systematically — so the count is reported and the caller waits.
 */
export interface GatewayRunUsage {
  requests: number;
  incomplete: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** What the vendor said it charged, summed over the requests that said.
   *
   *  Null when no request reported one, which is every direct-API vendor. */
  vendorCostUsd: number | null;
  /**
   * How many requests reported a cost, and the reason a caller cannot use the sum
   * without it.
   *
   * A sum over SOME of a run's requests is not the run's charge, and preferring a
   * partial sum over a full token reconstruction would under-bill by whatever the
   * silent requests cost. Equal to `requests` means the sum is complete and IS the
   * money; anything less means fall back to the tokens.
   */
  vendorCostRequests: number;
}

export async function sumGatewayUsageForRun(
  tenantId: string,
  invocationId: string,
  /**
   * Only the requests served at or after this instant.
   *
   * A RUN CAN BILL MORE THAN ONCE. A turn that pauses for a person bills the
   * paused half, then bills its continuation separately, and every gateway row
   * for BOTH halves was written under the run's own id — so an unbounded sum
   * handed to the continuation contains the paused half's requests, which the
   * paused half has already been charged for. The continuation would then be
   * asked to explain a shortfall against tokens it never spent, and the run would
   * be billed twice for them.
   *
   * The caller's own half started at a known instant, and that is the bound.
   * Omitted, this is the whole run — which is correct for a run that bills once,
   * and is what `wasRunByokFunded` deliberately asks.
   */
  since?: Date,
): Promise<GatewayRunUsage> {
  const empty: GatewayRunUsage = {
    requests: 0,
    incomplete: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    vendorCostUsd: null,
    vendorCostRequests: 0,
  };
  if (!invocationId) return empty;
  // The same id-normalisation `wasRunByokFunded` does, and for the same reason:
  // a continuation bills under `<invocation>:resume:<pause>` while every gateway
  // row for both halves was written under the run's own id.
  const runId = runIdOfBillingId(invocationId);
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query<{
      requests: string;
      incomplete: string;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_write_tokens: string | null;
      reasoning_tokens: string | null;
      vendor_cost_usd: string | null;
      vendor_cost_requests: string;
    }>(
      // `status_code IS NULL` is exactly "opened and not yet completed":
      // `beginGatewayRequest` inserts without one and `completeGatewayRequest`
      // sets it in the same statement as the counts, and the single-write path
      // always carries one. So it identifies a row whose zeroes are absence
      // rather than a free call.
      `SELECT COUNT(*)::text                        AS requests,
              COUNT(*) FILTER (WHERE status_code IS NULL)::text AS incomplete,
              COALESCE(SUM(input_tokens), 0)::text  AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)::text  AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
              COALESCE(SUM(reasoning_tokens), 0)::text   AS reasoning_tokens,
              -- SUM over NULLs is NULL, not 0, and that is wanted: it says no
              -- request reported a charge. The count beside it is what tells a
              -- partial sum from a complete one.
              SUM(vendor_cost_usd)::text                 AS vendor_cost_usd,
              COUNT(vendor_cost_usd)::text               AS vendor_cost_requests
         FROM byok_gateway_requests
        WHERE tenant_id = $1 AND invocation_id = $2
          AND ($3::timestamptz IS NULL OR occurred_at >= $3::timestamptz)`,
      [tenantId, runId, since ?? null],
    );
    const row = result.rows[0];
    if (!row) return empty;
    return {
      requests: Number(row.requests) || 0,
      incomplete: Number(row.incomplete) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      cacheReadTokens: Number(row.cache_read_tokens) || 0,
      cacheWriteTokens: Number(row.cache_write_tokens) || 0,
      reasoningTokens: Number(row.reasoning_tokens) || 0,
      vendorCostUsd: row.vendor_cost_usd === null ? null : Number(row.vendor_cost_usd) || null,
      vendorCostRequests: Number(row.vendor_cost_requests) || 0,
    };
  });
}

/**
 * Drop request rows older than the retention window.
 *
 * The table is append-only and one row per LLM call, so it grows with the busiest
 * thing the platform does. The rows stop being load-bearing once the run they
 * describe has been ingested into cost_attribution_events, which happens within
 * minutes; the window is long enough to survive an ingester outage and a
 * weekend, and short enough that the table stays a working set rather than an
 * archive. The ledger keeps the durable record.
 */
export async function pruneGatewayRequests(
  tenantId: string,
  retentionDays = 30,
): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `DELETE FROM byok_gateway_requests
        WHERE tenant_id = $1
          AND occurred_at < NOW() - ($2 || ' days')::interval`,
      [tenantId, String(retentionDays)],
    );
    return result.rowCount ?? 0;
  });
}

/** Drop expired and revoked tokens once they can no longer authenticate
 *  anything. Same reasoning as the request sweep: a spent credential is not a
 *  record worth keeping. */
export async function pruneGatewayTokens(
  tenantId: string,
  retentionDays = 7,
): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `DELETE FROM byok_gateway_tokens
        WHERE tenant_id = $1
          AND expires_at < NOW() - ($2 || ' days')::interval`,
      [tenantId, String(retentionDays)],
    );
    return result.rowCount ?? 0;
  });
}
