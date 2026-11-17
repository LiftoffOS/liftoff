// Phase 1d — RPC handlers for liftoff-billing. Plan 1d:
// "Real implementations for every RPC in 0a. ReportUsage is idempotent
// on (tenant_id, user_id, vendor, request_id) — duplicate calls are
// no-ops. Ported from platform-backend/src/billing/, with pg queries
// rewritten for the new DB."
//
// Each handler wraps its DB work in `withBillingTenant(tenantId, fn)`
// so RLS is always bound. See plan 0h for the withTenantContext
// contract.

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { enqueueOutboxEvent, type EventEnvelope } from '@liftoffos/outbox';
import { withBillingTenant, getPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';
import { OU_METER_EVENT_NAME } from '../infrastructure/metronome-client.js';

export interface SubscriptionView {
  id: string;
  tenantId: string;
  stripeSubscriptionId: string;
  status: string;
  planId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
}

// ── GetSubscription ──────────────────────────────────────────────────
export async function getSubscription(tenantId: string): Promise<{
  subscription: SubscriptionView | null;
  planId: string | null;
  creditBalance: { availableCents: bigint; reservedCents: bigint; asOf: Date } | null;
}> {
  return withBillingTenant(tenantId, async (client) => {
    const sub = await client.query<{
      id: string;
      tenant_id: string;
      stripe_subscription_id: string;
      status: string;
      plan_id: string;
      current_period_start: Date;
      current_period_end: Date;
      cancel_at_period_end: boolean;
      canceled_at: Date | null;
    }>(
      `SELECT id, tenant_id, stripe_subscription_id, status, plan_id,
              current_period_start, current_period_end,
              cancel_at_period_end, canceled_at
       FROM subscriptions
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId],
    );

    const s = sub.rows[0];

    return {
      subscription: s
        ? {
            id: s.id,
            tenantId: s.tenant_id,
            stripeSubscriptionId: s.stripe_subscription_id,
            status: s.status,
            planId: s.plan_id,
            currentPeriodStart: s.current_period_start,
            currentPeriodEnd: s.current_period_end,
            cancelAtPeriodEnd: s.cancel_at_period_end,
            canceledAt: s.canceled_at,
          }
        : null,
      planId: s?.plan_id ?? null,
      creditBalance: null,
    };
  });
}

// ── ReportUsage ──────────────────────────────────────────────────────
export interface ReportUsageInput {
  tenantId: string;
  userId: string | null;
  vendor: string;
  requestId: string;
  eventType: string;
  quantity: bigint;
  occurredAt: Date;
  costMicros: bigint | null;
  agentId: string | null;
  actionId: string | null;
}

export async function reportUsage(input: ReportUsageInput, stripe: Stripe): Promise<{
  meterEventId: string;
  created: boolean;
}> {
  const result = await withBillingTenant(input.tenantId, async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM meter_events
       WHERE tenant_id = $1 AND
             (user_id IS NOT DISTINCT FROM $2) AND
             vendor = $3 AND request_id = $4`,
      [input.tenantId, input.userId, input.vendor, input.requestId],
    );
    if (existing.rows.length > 0) {
      return { meterEventId: existing.rows[0].id, created: false };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO meter_events
         (tenant_id, user_id, vendor, request_id, quantity, event_type, occurred_at, cost_micros,
          agent_id, action_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        input.tenantId,
        input.userId,
        input.vendor,
        input.requestId,
        String(input.quantity),
        input.eventType,
        input.occurredAt,
        input.costMicros === null ? null : String(input.costMicros),
        input.agentId,
        input.actionId,
      ],
    );
    const meterEventId = inserted.rows[0].id;

    // Enqueue outbox event — downstream consumers (byok usage
    // reconciliation, cost attribution, analytics) pick it up
    // via @liftoffos/outbox publisher.
    const env: EventEnvelope<{
      meterEventId: string;
      vendor: string;
      requestId: string;
      quantity: string;
      costMicros: string | null;
    }> = {
      eventId: randomUUID(),
      eventType: 'billing.meter.usage_recorded',
      schemaVersion: 1,
      tenantId: input.tenantId,
      occurredAt: input.occurredAt,
      sourceService: 'liftoff-billing',
      traceId: null,
      payload: {
        meterEventId,
        vendor: input.vendor,
        requestId: input.requestId,
        quantity: String(input.quantity),
        costMicros: input.costMicros === null ? null : String(input.costMicros),
      },
    };
    await enqueueOutboxEvent(client, env);
    return { meterEventId, created: true };
  });

  // Fire-and-forget Stripe meter event AFTER the local transaction commits.
  // Local meter_events insert is authoritative for cost attribution.
  if (result.created) {
    void ingestToStripe(input, stripe);
  }

  return result;
}

// Resolves stripe_customer_id and sends an OU meter event to Stripe.
// Runs outside any transaction. Failures emit a retry outbox event.
async function ingestToStripe(input: ReportUsageInput, stripe: Stripe): Promise<void> {
  // rls-fence: allow — internal lookup outside RLS context
  const pool = await getPool();
  const { rows } = await pool.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM subscriptions
     WHERE tenant_id = $1 AND status IN ('active','trialing','past_due','incomplete')
     ORDER BY updated_at DESC LIMIT 1`,
    [input.tenantId],
  );
  const stripeCustomerId = rows[0]?.stripe_customer_id;
  if (!stripeCustomerId) return;

  try {
    await stripe.billing.meterEvents.create({
      event_name: OU_METER_EVENT_NAME,
      payload: {
        value: String(input.quantity),
        stripe_customer_id: stripeCustomerId,
      },
      identifier: input.requestId,
      timestamp: Math.floor(input.occurredAt.getTime() / 1000),
    });
  } catch (err) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await enqueueOutboxEvent(client, {
        eventId: randomUUID(),
        eventType: 'billing.stripe_usage.ingest_failed',
        schemaVersion: 1,
        tenantId: input.tenantId,
        occurredAt: input.occurredAt,
        sourceService: 'liftoff-billing',
        traceId: null,
        payload: {
          requestId: input.requestId,
          quantity: String(input.quantity),
          error: (err as Error).message,
        },
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
}

// ── ListInvoices ─────────────────────────────────────────────────────
export interface InvoiceView {
  id: string;
  stripeInvoiceId: string;
  status: string;
  amountDueCents: bigint;
  amountPaidCents: bigint;
  taxCents: bigint;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  issuedAt: Date;
  paidAt: Date | null;
}

export async function listInvoices(
  tenantId: string,
  opts: {
    pageSize: number;
    pageToken: string | null;
    statusFilter: string | null;
    issuedAfter: Date | null;
    issuedBefore: Date | null;
  },
): Promise<{ invoices: InvoiceView[]; nextPageToken: string | null }> {
  return withBillingTenant(tenantId, async (client) => {
    const cursor = opts.pageToken ? parsePageToken(opts.pageToken) : null;
    const { rows } = await client.query<{
      id: string;
      stripe_invoice_id: string;
      status: string;
      amount_due_cents: string;
      amount_paid_cents: string;
      tax_cents: string;
      currency: string;
      period_start: Date;
      period_end: Date;
      issued_at: Date;
      paid_at: Date | null;
    }>(
      `SELECT id, stripe_invoice_id, status,
              amount_due_cents, amount_paid_cents, tax_cents,
              currency, period_start, period_end, issued_at, paid_at
       FROM invoices
       WHERE tenant_id = $1
         AND ($2::text IS NULL OR status::text = $2)
         AND ($3::timestamptz IS NULL OR issued_at >= $3)
         AND ($4::timestamptz IS NULL OR issued_at <= $4)
         AND ($5::timestamptz IS NULL OR issued_at < $5)
       ORDER BY issued_at DESC
       LIMIT $6`,
      [
        tenantId,
        opts.statusFilter,
        opts.issuedAfter,
        opts.issuedBefore,
        cursor,
        opts.pageSize + 1,
      ],
    );
    const overflow = rows.length > opts.pageSize;
    const slice = overflow ? rows.slice(0, opts.pageSize) : rows;
    const nextPageToken = overflow ? buildPageToken(slice[slice.length - 1].issued_at) : null;
    return {
      invoices: slice.map((r) => ({
        id: r.id,
        stripeInvoiceId: r.stripe_invoice_id,
        status: r.status,
        amountDueCents: BigInt(r.amount_due_cents),
        amountPaidCents: BigInt(r.amount_paid_cents),
        taxCents: BigInt(r.tax_cents),
        currency: r.currency,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        issuedAt: r.issued_at,
        paidAt: r.paid_at,
      })),
      nextPageToken,
    };
  });
}

function buildPageToken(issuedAt: Date): string {
  // HMAC-signed cursor so it can't be forged client-side.
  const config = loadConfig();
  const key = config.BILLING_SERVICE_TOKEN_SECRET;
  const payload = issuedAt.toISOString();
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function parsePageToken(token: string): Date {
  const decoded = Buffer.from(token, 'base64url').toString('utf-8');
  const [payload, sig] = decoded.split(':');
  const config = loadConfig();
  const expected = createHmac('sha256', config.BILLING_SERVICE_TOKEN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('invalid_page_token');
  }
  return new Date(payload);
}

// ── CreateCheckoutSession ───────────────────────────────────────────
export async function createCheckoutSession(
  stripe: Stripe,
  tenantId: string,
  input: { planId: string; successUrl: string; cancelUrl: string; promoCode: string | null; stripeCustomerId?: string },
): Promise<{ stripeSessionId: string; checkoutUrl: string; expiresAt: Date }> {
  return withBillingTenant(tenantId, async (client) => {
    const plan = await client.query<{ stripe_price_id: string }>(
      `SELECT stripe_price_id FROM plans WHERE id = $1 AND active = TRUE`,
      [input.planId],
    );
    if (plan.rows.length === 0) {
      throw new Error(`plan_not_found:${input.planId}`);
    }
    const session = await stripe.checkout.sessions.create({
      customer: input.stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: plan.rows[0].stripe_price_id, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: tenantId,
      metadata: { tenant_id: tenantId, plan_id: input.planId },
      ...(input.promoCode ? { discounts: [{ promotion_code: input.promoCode }] } : {}),
    });
    if (!session.id || !session.url) {
      throw new Error('stripe_checkout_create_failed');
    }
    return {
      stripeSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: new Date((session.expires_at ?? Date.now() / 1000 + 1800) * 1000),
    };
  });
}

// ── ReplayEvents ─────────────────────────────────────────────────────
export async function* replayEvents(
  consumerId: string,
  since: Date,
  eventTypes: string[] | null,
): AsyncGenerator<EventEnvelope, void, unknown> {
  // rls-fence: allow
  const pool = await getPool();
  const { rows } = await pool.query<{
    event_id: string;
    event_type: string;
    schema_version: number;
    tenant_id: string;
    occurred_at: Date;
    source_service: string;
    trace_id: string | null;
    payload: unknown;
  }>(
    `SELECT event_id, event_type, schema_version, tenant_id,
            occurred_at, source_service, trace_id, payload
     FROM outbox_events
     WHERE published_at IS NOT NULL
       AND occurred_at >= $1
       AND ($2::text[] IS NULL OR event_type = ANY($2))
     ORDER BY occurred_at ASC`,
    [since, eventTypes],
  );
  for (const r of rows) {
    yield {
      eventId: r.event_id,
      eventType: r.event_type,
      schemaVersion: r.schema_version,
      tenantId: r.tenant_id,
      occurredAt: r.occurred_at,
      sourceService: r.source_service,
      traceId: r.trace_id,
      payload: r.payload,
    };
  }
  // Observability: record replay consumer activity for audit.
  await pool.query(
    `INSERT INTO billing_audit_log (tenant_id, action, target_ref, payload_json, row_hash)
     VALUES ($1::uuid, 'replay_events', $2, $3, encode(digest(random()::text, 'sha256'),'hex'))`,
    ['00000000-0000-0000-0000-000000000000', consumerId, JSON.stringify({ since, eventTypes })],
  ).catch(() => {});
}
