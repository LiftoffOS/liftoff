// Telling a customer's own system what happened.
//
// The inverse of the inbound event sources: those let a customer's system poke
// a team member, this lets a team member's lifecycle reach a customer's system.
//
// One rule shapes everything here — an outbound call must never be able to
// slow down, block, or fail a run. So `enqueueLifecycleEvent` writes one row
// and returns, and a single worker drains the queue out of band. A customer
// endpoint that hangs for thirty seconds costs a worker pass, never a tool
// call. Nothing in this file is ever awaited by a run.
//
// The rest is the consequences of that rule plus the two hazards a customer-
// supplied URL brings:
//
//   * SSRF. The URL is checked against the shared guard when it is registered
//     AND again immediately before every send, because a hostname that resolved
//     publicly on Tuesday can be re-pointed at an internal address on Wednesday.
//   * A dead endpoint filling the table. The queue is capped per tenant, so one
//     customer's broken receiver cannot become everybody's disk.
//
// Signing reuses the inbound convention exactly — `X-Liftoff-Signature:
// t=<unix>,v1=<hex>` over `${t}.${body}`. One format in both directions means a
// customer writes one verifier, and it means our own docs cannot disagree with
// themselves.

import crypto from 'crypto';
import { armOutboundWebhooks } from '../jobs/maintenance-targets';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { assertPublicUrl, BlockedUrlError } from '../common/url-guard';
import { decryptSecret, encryptSecret } from './secret-encryption';

/** Lifecycle moments a customer endpoint can subscribe to.
 *
 *  Deliberately a short, closed list. Every entry is a promise to keep sending
 *  that shape, and a firehose of everything the platform does would be both a
 *  data-egress question and an interface nobody could depend on. */
export const OUTBOUND_EVENT_TYPES = [
  'run.completed',
  'run.failed',
  'approval.requested',
  'approval.decided',
  'agent.paused',
] as const;

export type OutboundEventType = typeof OUTBOUND_EVENT_TYPES[number];

export function isOutboundEventType(v: string): v is OutboundEventType {
  return (OUTBOUND_EVENT_TYPES as readonly string[]).includes(v);
}

/** Open deliveries a tenant may have queued at once.
 *
 *  Past this, new events are dropped with a log rather than queued. Dropping is
 *  the right failure: the alternative is an unbounded table driven entirely by
 *  how broken somebody else's endpoint is, and a customer whose receiver has
 *  been down long enough to bank ten thousand events does not want them all at
 *  once when it comes back. */
export const MAX_QUEUED_PER_TENANT = Number(process.env.OUTBOUND_WEBHOOK_QUEUE_CAP ?? 1_000);

/** Attempts before a delivery is abandoned. */
export const MAX_DELIVERY_ATTEMPTS = Number(process.env.OUTBOUND_WEBHOOK_MAX_ATTEMPTS ?? 5);

/** Consecutive failures before the endpoint itself is switched off. A receiver
 *  that has failed this many times in a row is not having a bad minute. */
export const MAX_ENDPOINT_FAILURES = Number(process.env.OUTBOUND_WEBHOOK_MAX_ENDPOINT_FAILURES ?? 20);

/** How long to wait on a customer endpoint. Short: we are not doing them a
 *  favour by holding a worker open, and a receiver that cannot acknowledge in
 *  ten seconds should be queueing on its own side. */
export const DELIVERY_TIMEOUT_MS = Number(process.env.OUTBOUND_WEBHOOK_TIMEOUT_MS ?? 10_000);

/** How long a claimed delivery stays invisible to another pass.
 *
 *  Comfortably longer than one pass can take (batch size x per-delivery
 *  timeout), so an overlapping pass never picks up work still in flight. Short
 *  enough that a worker killed mid-pass does not strand its batch for long. */
export const CLAIM_LEASE_MS = Number(process.env.OUTBOUND_WEBHOOK_CLAIM_LEASE_MS ?? 15 * 60_000);

/** Deliveries one worker pass will attempt. Bounded so a pass has a predictable
 *  ceiling on wall-clock time. */
export const WORKER_BATCH = Number(process.env.OUTBOUND_WEBHOOK_BATCH ?? 50);

/** Exponential, capped. Doubling forever would put a retry a week out, which is
 *  indistinguishable from dropping it but keeps the row. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

// ── Signing ──────────────────────────────────────────────────────────────────

export interface SignedRequest {
  header: string;
  body: string;
}

/**
 * Sign a body the way the inbound verifier expects.
 *
 * The timestamp is inside the signed material, not merely alongside it — a
 * signature that does not cover its own timestamp can be replayed forever with
 * a fresh one pasted on.
 */
export function signOutboundBody(
  body: string,
  secret: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): SignedRequest {
  const mac = crypto.createHmac('sha256', secret)
    .update(`${nowEpochSeconds}.${body}`)
    .digest('hex');
  return { header: `t=${nowEpochSeconds},v1=${mac}`, body };
}

/** A fresh signing secret. Returned once, at registration, and never readable
 *  again — the column stores it encrypted and no read path decrypts it for a
 *  caller. */
export function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ── Registration ─────────────────────────────────────────────────────────────

export interface OutboundWebhook {
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  createdAt: string;
}

export async function registerWebhook(input: {
  tenantId: string;
  url: string;
  eventTypes: string[];
}): Promise<{ webhook: OutboundWebhook; secret: string }> {
  // Checked here as well as at send time. Refusing at registration is what
  // makes the mistake visible to the person making it, rather than surfacing
  // later as a delivery that silently never happens.
  await assertPublicUrl(input.url, { allowHttp: false });

  const eventTypes = input.eventTypes.filter(isOutboundEventType);
  const secret = generateSigningSecret();

  const row = await withTenantScope(input.tenantId, async (client) => {
    const res = await client.query<{
      id: string; url: string; event_types: string[]; enabled: boolean;
      disabled_reason: string | null; consecutive_failures: number;
      last_success_at: Date | null; created_at: Date;
    }>(
      `INSERT INTO outbound_webhooks (tenant_id, url, secret_enc, event_types)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, event_types, enabled, disabled_reason,
                 consecutive_failures, last_success_at, created_at`,
      [input.tenantId, input.url, encryptSecret(secret), eventTypes],
    );
    return res.rows[0];
  });

  logger.info(
    { tenantId: input.tenantId, webhookId: row.id, eventTypes },
    'outbound webhook registered; it stays disabled until somebody turns it on',
  );

  return {
    webhook: {
      id: row.id,
      url: row.url,
      eventTypes: row.event_types,
      enabled: row.enabled,
      disabledReason: row.disabled_reason,
      consecutiveFailures: row.consecutive_failures,
      lastSuccessAt: row.last_success_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    },
    // The only time this is ever returned. Storing it decryptable to a read
    // endpoint would make every future read a copy of the customer's secret.
    secret,
  };
}

export async function listWebhooks(tenantId: string): Promise<OutboundWebhook[]> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{
      id: string; url: string; event_types: string[]; enabled: boolean;
      disabled_reason: string | null; consecutive_failures: number;
      last_success_at: Date | null; created_at: Date;
    }>(
      // Note the absent secret_enc. There is no read path for it.
      `SELECT id, url, event_types, enabled, disabled_reason,
              consecutive_failures, last_success_at, created_at
         FROM outbound_webhooks WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      url: r.url,
      eventTypes: r.event_types,
      enabled: r.enabled,
      disabledReason: r.disabled_reason,
      consecutiveFailures: r.consecutive_failures,
      lastSuccessAt: r.last_success_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    }));
  });
}

/**
 * Turn an endpoint on or off.
 *
 * Enabling re-validates the URL and clears any platform-set disable reason.
 * Re-validating matters: an endpoint the platform switched off because its
 * hostname started resolving to an internal address must not come back just
 * because somebody clicked enable.
 */
export async function setWebhookEnabled(
  tenantId: string,
  webhookId: string,
  enabled: boolean,
): Promise<boolean> {
  if (enabled) {
    const url = await withTenantScope(tenantId, async (client) => {
      const res = await client.query<{ url: string }>(
        `SELECT url FROM outbound_webhooks WHERE id = $1 AND tenant_id = $2`,
        [webhookId, tenantId],
      );
      return res.rows[0]?.url ?? null;
    });
    if (!url) return false;
    await assertPublicUrl(url, { allowHttp: false });
  }

  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `UPDATE outbound_webhooks
          SET enabled = $3,
              disabled_reason = CASE WHEN $3 THEN NULL ELSE disabled_reason END,
              consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures END,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [webhookId, tenantId, enabled],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

export async function deleteWebhook(tenantId: string, webhookId: string): Promise<boolean> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `DELETE FROM outbound_webhooks WHERE id = $1 AND tenant_id = $2`,
      [webhookId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

/**
 * Queue one lifecycle event for every endpoint that wants it.
 *
 * This is the function a run calls, and it is the reason the rest of the file
 * looks the way it does: it does exactly one INSERT per interested endpoint and
 * then returns. It never opens a socket, never waits on anybody's server, and
 * never throws — a failure to notify an external system is not a reason for a
 * run to fail.
 */
export async function enqueueLifecycleEvent(input: {
  tenantId: string;
  eventType: OutboundEventType;
  payload: Record<string, unknown>;
}): Promise<{ queued: number }> {
  try {
    return await withTenantScope(input.tenantId, async (client) => {
      const open = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM outbound_webhook_deliveries
          WHERE tenant_id = $1 AND status IN ('pending', 'failed')`,
        [input.tenantId],
      );
      if (Number(open.rows[0]?.count ?? 0) >= MAX_QUEUED_PER_TENANT) {
        // Said out loud rather than silently discarded. A queue that stopped
        // accepting work looks identical to nothing having happened.
        logger.warn(
          { tenantId: input.tenantId, eventType: input.eventType, cap: MAX_QUEUED_PER_TENANT },
          'outbound webhook queue is full; dropping this event rather than growing the table',
        );
        return { queued: 0 };
      }

      const res = await client.query<{ id: string }>(
        `INSERT INTO outbound_webhook_deliveries (tenant_id, webhook_id, event_type, payload)
         SELECT $1, w.id, $2, $3::jsonb
           FROM outbound_webhooks w
          WHERE w.tenant_id = $1
            AND w.enabled = true
            AND $2 = ANY(w.event_types)
         RETURNING id`,
        [input.tenantId, input.eventType, JSON.stringify(input.payload)],
      );
      // Deliver now: the drain is armed by the queueing, not by a clock.
      if ((res.rowCount ?? 0) > 0) armOutboundWebhooks();
      return { queued: res.rowCount ?? 0 };
    });
  } catch (err) {
    logger.warn(
      { tenantId: input.tenantId, eventType: input.eventType, error: (err as Error).message },
      'outbound webhook enqueue failed (non-fatal — the run is unaffected)',
    );
    return { queued: 0 };
  }
}

// ── The worker ───────────────────────────────────────────────────────────────

interface DueDelivery {
  id: string;
  tenant_id: string;
  webhook_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  /** When the EVENT happened, not when this attempt is being made. Signed into
   *  the body so retries are byte-identical. */
  created_at: Date;
  url: string;
  secret_enc: Buffer;
}

/**
 * Drain one batch.
 *
 * Claims with `FOR UPDATE SKIP LOCKED` so two passes overlapping — a slow one
 * and its successor — deliver disjoint sets rather than the same event twice.
 * Runs cross-tenant under an admin scope because a queue worker is exactly the
 * shape of job that has no tenant of its own; each delivery is then handled in
 * its own tenant scope.
 */
export async function drainOutboundWebhooks(deps: {
  withAdminScope: <T>(fn: (client: { query: (...a: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> }) => Promise<T>) => Promise<T>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{ attempted: number; delivered: number; abandoned: number }> {
  const doFetch = deps.fetchImpl ?? fetch;
  // Claim by LEASE, not by row lock.
  //
  // `SELECT … FOR UPDATE SKIP LOCKED` holds its lock only until the enclosing
  // transaction ends — which here is before a single delivery has been
  // attempted. Two overlapping passes would each select the same due rows and
  // each POST them, and this cron fires every minute while a pass can run for
  // the batch size times the per-delivery timeout. Duplicate webhooks to a
  // customer are exactly what a delivery system must not do by accident.
  //
  // So the claim is a WRITE: pushing `next_attempt_at` past the lease makes the
  // rows invisible to the next pass. A worker that dies mid-delivery simply
  // lets the lease expire and the rows come back — at-least-once, which is the
  // right guarantee here, and every request carries a stable delivery id the
  // receiver can deduplicate on.
  const due = await deps.withAdminScope(async (client) => {
    const res = await client.query(
      `UPDATE outbound_webhook_deliveries d
          SET next_attempt_at = NOW() + ($2 || ' milliseconds')::interval
         FROM outbound_webhooks w
        WHERE w.id = d.webhook_id
          AND d.id IN (
            SELECT d2.id
              FROM outbound_webhook_deliveries d2
              JOIN outbound_webhooks w2 ON w2.id = d2.webhook_id
             WHERE d2.status IN ('pending', 'failed')
               AND d2.next_attempt_at <= NOW()
               AND w2.enabled = true
             ORDER BY d2.next_attempt_at ASC
             LIMIT $1
             FOR UPDATE OF d2 SKIP LOCKED
          )
      RETURNING d.id, d.tenant_id, d.webhook_id, d.event_type, d.payload, d.attempts,
                d.created_at, w.url, w.secret_enc`,
      [WORKER_BATCH, String(CLAIM_LEASE_MS)],
    );
    return res.rows as DueDelivery[];
  });

  let delivered = 0;
  let abandoned = 0;

  for (const row of due) {
    const outcome = await attemptDelivery(row, doFetch);
    if (outcome === 'delivered') delivered++;
    if (outcome === 'abandoned') abandoned++;
  }

  return { attempted: due.length, delivered, abandoned };
}

/** When the earliest queued delivery is next due, or null when nothing is
 *  queued. The drain route arms itself for it, so a retry backoff is honoured
 *  without a clock polling the table. */
export async function nextOutboundAttemptAt(deps: {
  withAdminScope: <T>(fn: (client: { query: (...a: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>) => Promise<T>;
}): Promise<Date | null> {
  return deps.withAdminScope(async (client) => {
    const { rows } = await client.query(
      `SELECT MIN(next_attempt_at) AS next FROM outbound_webhook_deliveries
        WHERE status IN ('pending', 'failed')`,
    );
    const next = (rows[0] as { next: Date | string | null } | undefined)?.next;
    return next ? new Date(next) : null;
  });
}

async function attemptDelivery(
  row: DueDelivery,
  doFetch: typeof fetch,
): Promise<'delivered' | 'retry' | 'abandoned'> {
  const attempts = row.attempts + 1;

  // Re-checked immediately before the send, not only at registration. A
  // hostname that resolved publicly when it was registered can be re-pointed at
  // an internal address afterwards, and this is the last moment we can refuse.
  try {
    await assertPublicUrl(row.url, { allowHttp: false });
  } catch (err) {
    const reason = err instanceof BlockedUrlError
      ? 'the endpoint resolves to a private address'
      : (err as Error).message;
    await disableEndpoint(row.tenant_id, row.webhook_id, reason);
    await settleDelivery(row.tenant_id, row.id, 'abandoned', attempts, reason, null);
    logger.error(
      { tenantId: row.tenant_id, webhookId: row.webhook_id, reason },
      'outbound webhook disabled: its URL no longer points anywhere we may send to',
    );
    return 'abandoned';
  }

  // Byte-identical on every attempt.
  //
  // `createdAt` is the delivery's OWN creation time, not the moment of this
  // attempt. Stamping the attempt time here would make each retry a different
  // body — so a receiver deduplicating on the payload, or on a hash of it,
  // would treat three retries of one event as three events, which is precisely
  // the failure at-least-once delivery is supposed to be survivable against.
  //
  // The SIGNATURE still changes per attempt, and must: it covers a fresh
  // timestamp so the receiver's replay window accepts it. Identical body,
  // fresh signature, stable delivery id — that is the combination a customer
  // can actually deduplicate on.
  const body = JSON.stringify({
    id: row.id,
    type: row.event_type,
    createdAt: row.created_at.toISOString(),
    data: row.payload,
  });

  let secret: string;
  try {
    secret = decryptSecret(row.secret_enc);
  } catch (err) {
    await disableEndpoint(row.tenant_id, row.webhook_id, 'signing secret could not be read');
    await settleDelivery(row.tenant_id, row.id, 'abandoned', attempts, (err as Error).message, null);
    return 'abandoned';
  }

  const signed = signOutboundBody(body, secret);

  try {
    const res = await doFetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Liftoff-Signature': signed.header,
        'X-Liftoff-Event': row.event_type,
        'X-Liftoff-Delivery': row.id,
      },
      body: signed.body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (res.ok) {
      await settleDelivery(row.tenant_id, row.id, 'delivered', attempts, null, res.status);
      await recordEndpointSuccess(row.tenant_id, row.webhook_id);
      return 'delivered';
    }

    // A 4xx that is not 429 means the receiver understood and refused. Retrying
    // a refusal is how a broken integration becomes a sustained load on
    // somebody else's server.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    const terminal = permanent || attempts >= MAX_DELIVERY_ATTEMPTS;
    await settleDelivery(
      row.tenant_id, row.id, terminal ? 'abandoned' : 'failed', attempts,
      `HTTP ${res.status}`, res.status,
    );
    await recordEndpointFailure(row.tenant_id, row.webhook_id);
    return terminal ? 'abandoned' : 'retry';
  } catch (err) {
    const terminal = attempts >= MAX_DELIVERY_ATTEMPTS;
    await settleDelivery(
      row.tenant_id, row.id, terminal ? 'abandoned' : 'failed', attempts,
      (err as Error).message, null,
    );
    await recordEndpointFailure(row.tenant_id, row.webhook_id);
    return terminal ? 'abandoned' : 'retry';
  }
}

async function settleDelivery(
  tenantId: string,
  deliveryId: string,
  status: 'delivered' | 'failed' | 'abandoned',
  attempts: number,
  error: string | null,
  statusCode: number | null,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE outbound_webhook_deliveries
          SET status = $3,
              attempts = $4,
              last_error = $5,
              last_status_code = $6,
              next_attempt_at = CASE WHEN $3 = 'failed'
                                     THEN NOW() + ($7 || ' milliseconds')::interval
                                     ELSE next_attempt_at END,
              delivered_at = CASE WHEN $3 = 'delivered' THEN NOW() ELSE delivered_at END
        WHERE id = $1 AND tenant_id = $2`,
      [deliveryId, tenantId, status, attempts, error?.slice(0, 500) ?? null, statusCode, String(backoffMs(attempts))],
    ),
  ).catch((err: Error) => logger.warn(
    { tenantId, deliveryId, error: err.message },
    'outbound webhook delivery could not be settled',
  ));
}

async function recordEndpointSuccess(tenantId: string, webhookId: string): Promise<void> {
  // Any success clears the streak. An endpoint that comes back should not stay
  // one failure away from being switched off.
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE outbound_webhooks
          SET consecutive_failures = 0, last_success_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [webhookId, tenantId],
    ),
  ).catch(() => undefined);
}

async function recordEndpointFailure(tenantId: string, webhookId: string): Promise<void> {
  const disabled = await withTenantScope(tenantId, async (client) => {
    // Counted and decided in ONE statement: reading the count and then writing
    // it back races two workers into disabling nothing.
    const res = await client.query<{ consecutive_failures: number; enabled: boolean }>(
      `UPDATE outbound_webhooks
          SET consecutive_failures = consecutive_failures + 1,
              enabled = CASE WHEN consecutive_failures + 1 >= $3 THEN false ELSE enabled END,
              disabled_reason = CASE WHEN consecutive_failures + 1 >= $3
                                     THEN 'too many consecutive delivery failures'
                                     ELSE disabled_reason END,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2
        RETURNING consecutive_failures, enabled`,
      [webhookId, tenantId, MAX_ENDPOINT_FAILURES],
    );
    return res.rows[0];
  }).catch(() => null);

  if (disabled && disabled.enabled === false) {
    logger.error(
      { tenantId, webhookId, consecutiveFailures: disabled.consecutive_failures },
      'outbound webhook disabled after repeated delivery failures',
    );
  }
}

async function disableEndpoint(tenantId: string, webhookId: string, reason: string): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE outbound_webhooks
          SET enabled = false, disabled_reason = $3, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [webhookId, tenantId, reason],
    ),
  ).catch(() => undefined);
}
