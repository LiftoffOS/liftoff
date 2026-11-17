// Phase 0: Billing Spend Subscriber
//
// POST /api/internal/billing/spend-event
//
// Pub/Sub push subscription endpoint. Called by GCP Pub/Sub when tenant-runtime
// publishes an invocation.completed event. Validates the OIDC token, resolves
// accountId from tenantId, deduplicates via billing_spend_events, atomically
// converts costUsd → ou_consumed via applyOuConsumption (which also splits into
// up to three buckets and writes customer_cost_usd at the per-bucket rate), and
// fires a real-time Stripe meter event (operating_unit_consumed) so usage
// appears on the invoice.

import { Router, Request, Response } from 'express';
import { armCostIngest } from '../jobs/maintenance-targets';
import { OAuth2Client } from 'google-auth-library';
import { getPool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { insertEvents } from '../cost-attribution/repository';
import { applyOuConsumption, type BucketAssignment } from '../cost-attribution/ou-bucket-service';
import { applyReloadDrain, fireAutoReloadClaim, type AutoReloadClaim } from '../cost-attribution/reload-drain';
import { publishBillingSuspensionChange } from './billing-suspension-publisher';
import { fireOuMeterEvent } from './ou-meter-event';
import { wasRunByokFunded } from '../byok-gateway/usage-recorder';

const router = Router();
const oauthClient = new OAuth2Client();

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? '';
const ENVIRONMENT    = process.env.ENVIRONMENT ?? 'dev';
const PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL ?? '';

// SA email that the Pub/Sub push subscription OIDC token is signed with.
// Must match google_service_account.billing_pubsub_push in Terraform.
const EXPECTED_PUBSUB_SA_EMAIL = process.env.BILLING_PUBSUB_PUSH_SA_EMAIL ?? `billing-pubsub-push-${ENVIRONMENT}@${GCP_PROJECT_ID}.iam.gserviceaccount.com`;

async function verifyPubSubOidcToken(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or malformed Authorization header');
  }
  const token = authHeader.slice(7);
  const audience = PLATFORM_BACKEND_URL || undefined;
  const ticket = await oauthClient.verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error('OIDC token missing email claim');
  if (payload.email !== EXPECTED_PUBSUB_SA_EMAIL) {
    throw new Error(`Unexpected OIDC SA email: ${payload.email}`);
  }
}

interface InvocationCompletedPayload {
  tenantId: string;
  invocationId: string;
  costUsd: number;
  occurredAt: string;
  /**
   * Tenant Runtime's local `agents.id`. Historically the only agent identifier
   * on this payload, which is why `cost_attribution_events.agent_id` accumulated
   * runtime-space ids that never match `internal_agents.id`.
   */
  agentId?: string;
  /**
   * Control-plane `internal_agents.id`, resolved by the Tenant Runtime through
   * `internal_agent_runtime_mapping` before publishing. Preferred whenever
   * present; absent from older publishers and when the agent has no
   * mapping row, in which case we fall back to `agentId` (previous behaviour).
   */
  internalAgentId?: string;
  // Enrichment fields (all optional; null-safe in processing):
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  threadId?: string | null;
  triggeredBy?: string;
  triggerRef?: string | null;
  isReconciliation?: boolean;
}

interface TenantInfo { accountId: string; hostingMode: string | null; }

async function resolveTenantInfo(tenantId: string): Promise<TenantInfo | null> {
  const pool = getPool();
  const result = await pool.query<{ account_id: string; hosting_mode: string | null }>(
    `SELECT account_id, hosting_mode FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (!result.rows[0]) return null;
  return { accountId: result.rows[0].account_id, hostingMode: result.rows[0].hosting_mode };
}

function writeCostAttributionEvent(
  data: InvocationCompletedPayload,
  hostingMode: string | null,
  assignments: BucketAssignment[],
): void {
  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();
  // Batch all bucket rows into one insertEvents call so the writer opens one
  // admin-scope transaction (and one HMAC pool round-trip) instead of N.
  // Prefer the control-plane id so this column stays in one id space (INV-TR-010).
  const attributionAgentId = data.internalAgentId ?? data.agentId ?? null;
  const events = assignments.map((a) => ({
    tenantId:              data.tenantId,
    agentId:               attributionAgentId,
    threadId:              data.threadId ?? null,
    invocationId:          data.invocationId,
    parentInvocationId:    data.triggeredBy === 'agent' ? (data.triggerRef ?? null) : null,
    eventType:             'llm_invocation' as const,
    source:                'tenant_runtime' as const,
    sourceId:              `${data.invocationId}${a.sourceIdSuffix}`,
    provider:              data.provider ?? null,
    model:                 data.model ?? null,
    inputTokens:           data.inputTokens ?? null,
    outputTokens:          data.outputTokens ?? null,
    cachedTokens:          data.cachedTokens ?? null,
    costUsd:               a.costUsd,
    ouConsumed:            a.ouConsumed,
    customerCostUsd:       a.customerCostUsd,
    costBucket:            a.costBucket,
    hostingMode,
    correlationConfidence: (attributionAgentId ? 'direct' : 'unmatched') as 'direct' | 'unmatched',
    occurredAt,
  }));
  insertEvents(events).catch((err: Error) => {
    log.error(
      { error: err.message, invocationId: data.invocationId, bucketCount: events.length },
      'cost-attribution: write from spend-subscriber failed (billing unaffected)',
    );
  });
}

/**
 * The ledger row for a run the customer's own key funded.
 *
 * A separate function from its sibling above rather than a wider
 * BucketAssignment: that type is the OU splitter's own vocabulary, and
 * widening it would let a bucket that consumes no OUs turn up wherever the OU
 * math expects one of its three. There is exactly one row here because there is
 * no split to make — nothing was drawn from any bucket.
 *
 * The token counts are written exactly as they are for a managed call. Every
 * LLM call the platform makes produces a usage record with input and output
 * token counts, whoever's key paid for it: a row that says "we charged nothing
 * for this" is only auditable if it also says what "this" was.
 */
function writeByokCostAttributionEvent(
  data: InvocationCompletedPayload,
  hostingMode: string | null,
): void {
  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();
  const attributionAgentId = data.internalAgentId ?? data.agentId ?? null;
  insertEvents([{
    tenantId:              data.tenantId,
    agentId:               attributionAgentId,
    threadId:              data.threadId ?? null,
    invocationId:          data.invocationId,
    parentInvocationId:    data.triggeredBy === 'agent' ? (data.triggerRef ?? null) : null,
    eventType:             'llm_invocation' as const,
    source:                'tenant_runtime' as const,
    sourceId:              data.invocationId,
    provider:              data.provider ?? null,
    model:                 data.model ?? null,
    inputTokens:           data.inputTokens ?? null,
    outputTokens:          data.outputTokens ?? null,
    cachedTokens:          data.cachedTokens ?? null,
    // Real vendor cost: it is what the customer paid their provider, and it is
    // what a future "your keys covered $X this month" line is computed from.
    costUsd:               data.costUsd,
    ouConsumed:            0,
    customerCostUsd:       0,
    costBucket:            'byok_customer_funded' as const,
    hostingMode,
    correlationConfidence: (attributionAgentId ? 'direct' : 'unmatched') as 'direct' | 'unmatched',
    occurredAt,
  }]).catch((err: Error) => {
    log.error(
      { error: err.message, invocationId: data.invocationId },
      'cost-attribution: BYOK write from spend-subscriber failed (billing unaffected)',
    );
  });
}

async function ensureBillingControlsRow(accountId: string, client: import('pg').PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO billing_controls (account_id, billing_exempt)
     VALUES ($1, COALESCE((SELECT is_internal FROM accounts WHERE id = $1), FALSE))
     ON CONFLICT DO NOTHING`,
    [accountId],
  );
}

export async function processInvocationCompleted(data: InvocationCompletedPayload): Promise<void> {
  const pool = getPool();

  // Reject negative costs at the boundary — corrections route through financial_corrections.
  if (!(data.costUsd >= 0)) {
    log.error({ invocationId: data.invocationId, costUsd: data.costUsd, tenantId: data.tenantId },
      'billing.spend_subscriber: rejecting non-positive cost_usd — use financial_corrections instead');
    return;
  }

  const tenantInfo = await resolveTenantInfo(data.tenantId);
  if (!tenantInfo) {
    log.warn({ tenantId: data.tenantId, invocationId: data.invocationId },
      'billing.spend_subscriber: no account_id for tenant — dropping event');
    return;
  }
  const { accountId, hostingMode } = tenantInfo;

  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();

  // Resolved OUTSIDE the transaction, deliberately: it reads the gateway's
  // request rows under a tenant scope of their own, and nesting that inside
  // this one would need the scope to be re-set on the same connection and would
  // leave the billing_controls FOR UPDATE lock held across the extra read.
  const byokFunded = await wasRunByokFunded(data.tenantId, data.invocationId);

  let stripeCustomerIdForMeter: string | null = null;
  let shouldWriteCostAttribution = false;
  let assignments: BucketAssignment[] = [];
  let autoReloadClaim: AutoReloadClaim | null = null;
  let suspendedNow = false;
  let stopReason: 'zero_prepaid_balance' | 'prepaid_floor' | null = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // RLS: scope this own-transaction to the tenant. All RLS-table access below
    // (billing_spend_events dedup + INSERT, cost_attribution_events dedup) is for
    // this tenant's invocation. FORCE-safe; transaction-local. billing_controls is
    // non-RLS (account-keyed).
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [data.tenantId]);
    await ensureBillingControlsRow(accountId, client);

    // Up-front: snapshot stripe_customer_id only — we need it outside the
    // tx to fire the post-commit Stripe meter event. billing_mode and the
    // auto_reload_* fields are read inside applyReloadDrain (under the same
    // FOR UPDATE lock acquired by applyOuConsumption); duplicating them here
    // would just be dead code.
    const ctrlRow = await client.query<{ stripe_customer_id: string | null; billing_exempt: boolean }>(
      `SELECT stripe_customer_id, billing_exempt FROM billing_controls WHERE account_id = $1`,
      [accountId],
    );
    const ctrl = ctrlRow.rows[0];
    if (!ctrl) {
      await client.query('ROLLBACK');
      log.warn({ accountId }, 'billing.spend_subscriber: no billing_controls — dropping');
      return;
    }

    // ── BYOK: the customer's own key already paid the vendor ──────────────
    //
    // Leaving this on the ordinary path would charge them a second time for
    // the same tokens, starting the moment the first key is saved. Doing
    // nothing here is not neutral; it is a double charge.
    //
    // The gateway is the authority on which key served the run, so the answer
    // is read from its request rows. A run it never served answers false and
    // everything below runs exactly as it does today. So does a run that fell
    // back to the managed key mid-turn: Liftoff's key paid for part of it, and
    // section 6 is explicit that a fallback turn bills as normal consumption.
    if (byokFunded) {
      // Ledger row only: cost_usd is real (the customer paid their provider
      // that), ou_consumed and customer_cost_usd are zero, and no counter
      // moves. Written to billing_spend_events as well as
      // cost_attribution_events so runtime-ingester's cross-ledger dedup still
      // sees this invocation and cannot re-ingest it onto the charged path.
      const r = await client.query(
        `INSERT INTO billing_spend_events
           (invocation_id, tenant_id, account_id, cost_usd, ou_consumed,
            customer_cost_usd, cost_bucket, agent_id, occurred_at)
         VALUES ($1, $2, $3, $4, 0, 0, 'byok_customer_funded', $5, $6)
         ON CONFLICT DO NOTHING`,
        [data.invocationId, data.tenantId, accountId, data.costUsd,
         data.internalAgentId ?? data.agentId ?? null, occurredAt],
      );
      await client.query('COMMIT');
      if ((r.rowCount ?? 0) > 0) writeByokCostAttributionEvent(data, hostingMode);
      // No reload drain, no Stripe meter, no auto-reload. Nothing was charged,
      // so there is nothing to drain, meter or top up.
      return;
    }

    // applyOuConsumption: atomic FOR UPDATE on billing_controls, then dedup
    // check against BOTH ledgers under the same lock, then counter increment
    // + bucket split. Returns 1-3 BucketAssignments (one per non-zero bucket)
    // — or [] if duplicate redelivery (counter untouched).
    //
    // Cross-source dedup: this checks both billing_spend_events (spend-subscriber's
    // own ledger) AND cost_attribution_events (the ledger runtime-ingester writes
    // to when it backstops the same invocation). Without the cost_attribution_events
    // check, a runtime-ingester pass that wrote first would not show up in our
    // dedup, and we'd double-increment the counter. See repository.ingestEventWithBuckets
    // for the symmetric check on the ingester side.
    assignments = await applyOuConsumption(client, accountId, data.costUsd, {
      isDuplicate: async (c) => {
        // Match plain invocationId AND any /included|/precommit|/reload sibling
        // suffix produced by a multi-bucket split on the original delivery.
        const r = await c.query(
          `SELECT 1
             WHERE EXISTS (
               SELECT 1 FROM billing_spend_events
                WHERE invocation_id = $1 OR invocation_id LIKE $1 || '/%'
             )
                OR EXISTS (
               SELECT 1 FROM cost_attribution_events
                WHERE source = 'tenant_runtime'
                  AND event_type = 'llm_invocation'
                  AND (source_id = $1 OR source_id LIKE $1 || '/%')
             )
            LIMIT 1`,
          [data.invocationId],
        );
        return (r.rowCount ?? 0) > 0;
      },
    });
    if (assignments.length === 0) {
      await client.query('COMMIT');
      return;     // unprovisioned tenant OR duplicate redelivery — counter unchanged
    }

    // Idempotent ledger inserts — one row per bucket assignment.
    let anyNew = false;
    for (const a of assignments) {
      const r = await client.query(
        `INSERT INTO billing_spend_events
           (invocation_id, tenant_id, account_id, cost_usd, ou_consumed,
            customer_cost_usd, cost_bucket, agent_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [`${data.invocationId}${a.sourceIdSuffix}`, data.tenantId, accountId,
         a.costUsd, a.ouConsumed, a.customerCostUsd, a.costBucket,
         // Control-plane id preferred — same id-space rule as the attribution
         // event written above (INV-TR-010).
         data.internalAgentId ?? data.agentId ?? null, occurredAt],
      );
      if ((r.rowCount ?? 0) > 0) anyNew = true;
    }
    if (!anyNew) {
      await client.query('COMMIT');
      return; // duplicate Pub/Sub delivery — counter unaffected because applyOuConsumption
              // already ran; but in practice the dedup happens earlier at the outbox layer.
    }

    // Pre-pay drain: shared with ingester paths via applyReloadDrain so the
    // wallet debit + suspension flag fire for ANY source of reload-bucket
    // consumption, not just tenant_runtime. Real-time path opts in to firing
    // auto-reload post-commit (we have a clean post-tx hook here that the
    // ingester paths don't).
    const drain = await applyReloadDrain(client, accountId, assignments, { fireAutoReload: true });
    autoReloadClaim = drain.autoReloadClaim;
    suspendedNow = drain?.suspendedNow === true;
    stopReason = drain?.stopReason ?? null;

    // Exempt accounts (internal) fire no meter event. Everything
    // above this line already ran — the OU counter incremented, the buckets
    // split and drained, the ledger rows are written — so the dashboards stay
    // truthful about what the account actually consumed. Only the step that
    // puts usage on a Stripe invoice is skipped, and an exempt account can have
    // a stripe_customer_id (it does have a real subscription), which is exactly
    // why the gate is the explicit flag and not the absence of a customer id.
    if (ctrl.stripe_customer_id && !ctrl.billing_exempt) {
      stripeCustomerIdForMeter = ctrl.stripe_customer_id;
    } else if (ctrl.billing_exempt) {
      log.info(
        { accountId, invocationId: data.invocationId, costUsd: data.costUsd, billingExempt: true },
        'billing.spend_subscriber: meter event skipped — account is billing_exempt (buckets and ledger unaffected)',
      );
    }
    shouldWriteCostAttribution = true;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Stripe meter event firing — fire-and-forget. Failures are logged in the
  // helper; we additionally mark the spend event as metered only on success
  // so the billing-init backfill picks up any failures on the next pass.
  if (stripeCustomerIdForMeter) {
    const stripeCustomerId = stripeCustomerIdForMeter;
    const invocationId = data.invocationId;
    void fireOuMeterEvent({
      stripeCustomerId,
      costUsd: data.costUsd,
      identifier: invocationId,
      occurredAt,
    }).then((ok) => {
      if (!ok) return;
      return withTenantScope(data.tenantId, (client) => client.query(
          `UPDATE billing_spend_events SET stripe_metered_at = NOW() WHERE invocation_id = $1`,
          [invocationId],
        ))
        .catch((err: Error) =>
          log.warn(
            { error: err.message, invocationId, accountId },
            'billing.spend_subscriber: mark-metered update failed',
          ),
        );
    });
  }

  // The account just ran out: this charge took the prepaid balance below
  // zero and suspended it inside the transaction. Every tenant under it hears
  // now, not on the runtime's next refresh.
  if (suspendedNow) {
    void publishBillingSuspensionChange(accountId, 'suspended', stopReason ?? 'zero_prepaid_balance');
  }

  // Auto-reload trigger — fire-and-forget post-commit. The claim is only
  // produced by applyReloadDrain when it's safe to fire (threshold breached,
  // cooldown elapsed, customer + amount present); the fields are non-null by
  // construction here.
  if (autoReloadClaim) {
    fireAutoReloadClaim(autoReloadClaim, accountId, data.tenantId, 'billing.spend_subscriber');
  }

  // Cost-attribution write — gains the assignments parameter so it writes one
  // cost_attribution_events row per BucketAssignment, matching billing_spend_events.
  if (shouldWriteCostAttribution) writeCostAttributionEvent(data, hostingMode, assignments);
}

router.post('/api/internal/billing/spend-event', async (req: Request, res: Response): Promise<void> => {
  try {
    await verifyPubSubOidcToken(req.headers.authorization);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'billing.spend_subscriber: OIDC validation failed');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // Decode Pub/Sub push message envelope
  const message = req.body?.message;
  if (!message?.data) {
    res.status(400).json({ error: 'missing_message_data' });
    return;
  }

  let data: InvocationCompletedPayload;
  try {
    data = JSON.parse(Buffer.from(message.data, 'base64').toString());
  } catch {
    res.status(400).json({ error: 'invalid_message_data' });
    return;
  }

  if (!data.tenantId || !data.invocationId) {
    res.status(400).json({ error: 'missing_required_fields' });
    return;
  }

  try {
    await processInvocationCompleted(data);
    // A run finished: its sandbox, ledger and governance spend reach this
    // service only through the cost pass's feeds, so arm the pass.
    armCostIngest({ tenantId: data.tenantId });
    res.status(200).json({ ok: true });
  } catch (err) {
    log.error({ err: (err as Error).message, invocationId: data.invocationId }, 'billing.spend_subscriber: processing failed');
    // Return 500 — Pub/Sub will retry
    res.status(500).json({ error: 'processing_failed' });
  }
});

export { router as billingSpendSubscriberRouter };
