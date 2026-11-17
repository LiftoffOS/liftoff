// Public inbound endpoint: POST /v1/:token (on webhooks.example.com)
//
// Mounted with express.raw({ type: '*/*', limit: '1mb' }) so HMAC verification
// gets the raw bytes. Per-request pipeline (matches inbound-webhook plan §2):
//
//   1. Lookup source by url_token under admin scope; 404 if missing/disabled.
//   2. Enter withTenantScope(tenant_id).
//   3. Per-source + per-tenant rate-limit check FIRST. The plan §6.6 short-
//      circuit: an attacker spraying bad-signature or oversize requests is
//      capped before we touch event_deliveries.
//   4. Size cap (defense-in-depth on top of express limit).
//   5. HMAC verify if source.hmac_required.
//   6. Parse + scrub envelope.
//   7. Content filter (per-source toggleable).
//   8. INSERT delivery row with ON CONFLICT (source_id, event_id) DO NOTHING.
//      Conflict ⇒ 200 duplicate, no dispatch.
//   9. Daily run budget check (if set).
//  10. Resolve active trigger rules.
//  11. For each match: enqueue outbox row + inline-publish. Collect outbox
//      event_ids. Update the delivery row with outbox_event_ids and either
//      'accepted' or 'dispatch_failed' depending on success.
//  12. Return 202.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { log } from './log-scrubber';
import { enqueueControlPlaneOutbox, publishControlPlaneOutboxRowInline } from '../events/outbox';
import { adminLookupByToken, type InboundSourceLookup } from './service';
import { parseAndSanitizeEnvelope, type CanonicalEnvelope } from './envelope';
import { classifyContent } from './content-filter';
import { verifySignature } from './signing';
import { checkAndIncrementWebhookRateLimit } from './rate-limiter';

export const eventSourcesInboundRouter = Router();

const DEFAULT_TENANT_CEILING = 1000;       // requests/min across all sources
const HEADER_VALUE_CAP_BYTES = 4 * 1024;

type DeliveryStatus =
  | 'accepted'
  | 'duplicate'
  | 'dispatch_failed'
  | 'rejected_signature'
  | 'rejected_rate'
  | 'rejected_size'
  | 'rejected_disabled'
  | 'rejected_no_active_rule'
  | 'rejected_unsafe_content'
  | 'rejected_tenant_ceiling'
  | 'rejected_budget_exceeded';

function filteredHeaders(req: Request): Record<string, string> {
  const drop = new Set(['authorization', 'cookie', 'x-liftoff-signature']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (drop.has(key)) continue;
    if (typeof v === 'string') {
      out[key] = v.length > HEADER_VALUE_CAP_BYTES ? v.slice(0, HEADER_VALUE_CAP_BYTES) : v;
    } else if (Array.isArray(v)) {
      out[key] = v.join(',').slice(0, HEADER_VALUE_CAP_BYTES);
    }
  }
  return out;
}

interface RecordDeliveryInput {
  client: PoolClient;
  source: InboundSourceLookup;
  envelope: CanonicalEnvelope | null;
  rawBody: Buffer;
  bodySha256: string;
  bodyBytes: number;
  headers: Record<string, string>;
  signature: string | null;
  signatureValid: boolean;
  status: DeliveryStatus;
  unsafeMatches: string[];
  contentRedacted: boolean;
  matchedRuleIds: string[];
  outboxEventIds: string[];
}

async function recordDelivery(input: RecordDeliveryInput): Promise<string | null> {
  const eventId = input.envelope?.event_id ?? null;
  const r = await input.client.query<{ id: string }>(
    `INSERT INTO event_deliveries (
       source_id, tenant_id, event_id, event_type,
       request_headers, request_body, request_body_bytes, request_body_sha256,
       signature, signature_valid, status,
       unsafe_content_matches, content_redacted,
       matched_rule_ids, outbox_event_ids
     )
     VALUES (
       $1, $2, $3, $4,
       $5::jsonb, $6, $7, $8,
       $9, $10, $11,
       $12, $13,
       $14, $15
     )
     ON CONFLICT (source_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.source.sourceId,
      input.source.tenantId,
      eventId,
      input.envelope?.event_type ?? null,
      JSON.stringify(input.headers),
      input.source.piiHashMode ? null : input.rawBody,
      input.bodyBytes,
      input.bodySha256,
      input.signature,
      input.signatureValid,
      input.status,
      input.unsafeMatches,
      input.contentRedacted,
      input.matchedRuleIds,
      input.outboxEventIds,
    ],
  );
  return r.rows[0]?.id ?? null;
}

interface TenantCaps {
  maxPerMinute: number;
  dailyRunBudget: number | null;
}

async function loadTenantCaps(client: PoolClient, tenantId: string): Promise<TenantCaps> {
  const r = await client.query<{
    max_requests_per_minute: number;
    daily_run_budget: number | null;
  }>(
    `SELECT max_requests_per_minute, daily_run_budget
     FROM tenant_webhook_caps WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  return {
    maxPerMinute: row?.max_requests_per_minute ?? DEFAULT_TENANT_CEILING,
    dailyRunBudget: row?.daily_run_budget ?? null,
  };
}

interface TriggerRuleMatch {
  ruleId: string;
  agentId: string;
}

async function resolveRules(
  client: PoolClient,
  tenantId: string,
  sourceId: string,
  eventType: string,
): Promise<TriggerRuleMatch[]> {
  const r = await client.query<{ rule_id: string; agent_id: string }>(
    `SELECT r.id as rule_id, r.agent_id
     FROM event_trigger_rules r
     JOIN internal_agents a ON a.id = r.agent_id
     WHERE r.tenant_id = $1
       AND r.source_id = $2
       AND r.enabled = TRUE
       AND (r.event_type_pattern = '*' OR r.event_type_pattern = $3)
       AND a.tenant_id = $1
       AND a.status = 'active'
       AND a.deleted_at IS NULL`,
    [tenantId, sourceId, eventType],
  );
  return r.rows.map((row) => ({ ruleId: row.rule_id, agentId: row.agent_id }));
}

/**
 * For each matched rule, enqueue an outbox row and attempt inline publish.
 * Returns the event_ids collected for the delivery row. Dispatch failures
 * are logged but don't throw — the caller marks the delivery row
 * 'dispatch_failed' if zero events succeed.
 */
async function dispatchToRules(opts: {
  source: InboundSourceLookup;
  envelope: CanonicalEnvelope;
  matches: TriggerRuleMatch[];
  deliveryId: string;
  contentRedacted: boolean;
}): Promise<string[]> {
  const dispatched: string[] = [];
  for (const match of opts.matches) {
    try {
      // One outbox row per matched rule. We include deliveryId in entity_id
      // so two rules + same delivery don't collide on
      // control_plane_outbox's UNIQUE (entity_type, entity_id, event_type)
      // dedup index.
      const compositeEntityId = `${opts.source.sourceId}:${match.ruleId}:${opts.deliveryId}`;

      const rowRef = await withAdminScope(
        {
          caller: 'event-sources.inbound-router.dispatch',
          reason: 'enqueue event.custom_received outbox row',
        },
        (client) => enqueueControlPlaneOutbox(client, {
          tenantId: opts.source.tenantId,
          entityType: 'event_trigger_rule',
          entityId: compositeEntityId,
          eventType: 'event.custom_received',
          entityVersion: null,
          payload: {
            // Plan §4 wire shape: trustLevel + harvestEligible at the top
            // level so subscribers (incl. harvest service) can filter
            // without reaching into a nested data object.
            tenantId: opts.source.tenantId,
            agentId: match.agentId,
            trustLevel: 'untrusted_inbound',
            harvestEligible: false,
            sourceId: opts.source.sourceId,
            sourceName: opts.source.sourceName,
            triggerRuleId: match.ruleId,
            deliveryId: opts.deliveryId,
            event: {
              eventId: opts.envelope.event_id,
              eventType: opts.envelope.event_type,
              occurredAt: opts.envelope.occurred_at,
              subject: opts.envelope.subject ?? null,
              actor: opts.envelope.actor ?? null,
              data: opts.envelope.data ?? null,
              contentRedacted: opts.contentRedacted,
            },
            receivedAt: new Date().toISOString(),
          },
        }),
      );
      // Best-effort inline publish; failures are picked up by the outbox
      // worker. Either way the row is durable on disk before we proceed.
      try {
        await publishControlPlaneOutboxRowInline(rowRef);
      } catch (err) {
        log.warn(
          {
            sourceId: opts.source.sourceId,
            tenantId: opts.source.tenantId,
            deliveryId: opts.deliveryId,
            outboxId: rowRef.outboxId,
            error: (err as Error).message,
          },
          'inline outbox publish failed; worker will retry',
        );
      }
      dispatched.push(rowRef.eventId);
    } catch (err) {
      log.error(
        {
          error: (err as Error).message,
          sourceId: opts.source.sourceId,
          tenantId: opts.source.tenantId,
          deliveryId: opts.deliveryId,
          ruleId: match.ruleId,
        },
        'Failed to enqueue event.custom_received outbox row',
      );
    }
  }
  return dispatched;
}

async function updateDeliveryDispatch(
  tenantId: string,
  deliveryId: string,
  outboxEventIds: string[],
  status: DeliveryStatus,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE event_deliveries
     SET outbox_event_ids = $1, status = $2
     WHERE id = $3 AND tenant_id = $4`,
    [outboxEventIds, status, deliveryId, tenantId],
  ));
}

eventSourcesInboundRouter.post('/:token', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  const token = req.params.token;
  const bodyBytes = rawBody.length;
  const bodySha256 = crypto.createHash('sha256').update(rawBody).digest('hex');

  // ── Step 1: Admin-scope lookup. Always 404 on miss/paused. ──────────────
  const source = await adminLookupByToken(token);
  if (!source) {
    res.sendStatus(404);
    return;
  }

  // The inbound pipeline up through delivery-row INSERT runs in a single
  // tenant-scope transaction. Dispatch (outbox enqueue + inline publish) is
  // performed AFTER this tx commits because the outbox table requires admin
  // scope. The delivery row is updated separately to record outbox ids.
  type PipelineOutcome =
    | { kind: 'reject'; status: number; body?: unknown; headers?: Record<string, string> }
    | { kind: 'duplicate'; eventId: string }
    | { kind: 'no_rules'; eventId: string }
    | { kind: 'budget_exceeded'; eventId: string }
    | {
        kind: 'dispatch';
        deliveryId: string;
        envelope: CanonicalEnvelope;
        matches: TriggerRuleMatch[];
        contentRedacted: boolean;
      };
  let pipelineOutcome: PipelineOutcome;

  try {
    pipelineOutcome = await withTenantScope(source.tenantId, async (client) => {
      const headers = filteredHeaders(req);

      // ── Step 3: Rate limit FIRST (plan §6.6 pre-DB short-circuit). ──────
      // We do this BEFORE inserting into event_deliveries so a flood of
      // bad-signature / oversize requests doesn't fill the audit table.
      const caps = await loadTenantCaps(client, source.tenantId);
      const rl = await checkAndIncrementWebhookRateLimit({
        client,
        tenantId: source.tenantId,
        sourceId: source.sourceId,
        sourceLimitPerMinute: source.rateLimitPerMinute,
        tenantLimitPerMinute: caps.maxPerMinute,
      });
      if (!rl.allowed) {
        const status: DeliveryStatus = rl.reason ?? 'rejected_rate';
        await recordDelivery({
          client, source, envelope: null, rawBody: Buffer.alloc(0), bodyBytes, bodySha256,
          headers, signature: null, signatureValid: false,
          status, unsafeMatches: [], contentRedacted: false,
          matchedRuleIds: [], outboxEventIds: [],
        });
        return {
          kind: 'reject' as const,
          status: 429,
          body: { error: status === 'rejected_tenant_ceiling' ? 'Tenant rate limit exceeded' : 'Rate limit exceeded' },
          headers: { 'Retry-After': String(rl.retryAfter ?? 60) },
        };
      }

      // ── Step 4: Size cap. ───────────────────────────────────────────────
      if (bodyBytes > source.maxPayloadBytes) {
        await recordDelivery({
          client, source, envelope: null, rawBody: Buffer.alloc(0), bodyBytes, bodySha256,
          headers, signature: null, signatureValid: false,
          status: 'rejected_size', unsafeMatches: [], contentRedacted: false,
          matchedRuleIds: [], outboxEventIds: [],
        });
        return { kind: 'reject' as const, status: 413, body: { error: 'Payload too large' } };
      }

      // ── Step 5: HMAC verification (when required). ─────────────────────
      const signatureHeader = req.headers['x-liftoff-signature'] as string | undefined;
      let signatureValid = false;
      if (source.hmacRequired) {
        const result = verifySignature(rawBody, signatureHeader, source.signingSecret);
        signatureValid = result.valid;
        if (!result.valid) {
          await recordDelivery({
            client, source, envelope: null, rawBody, bodyBytes, bodySha256,
            headers, signature: signatureHeader ?? null, signatureValid: false,
            status: 'rejected_signature', unsafeMatches: [], contentRedacted: false,
            matchedRuleIds: [], outboxEventIds: [],
          });
          log.warn(
            { sourceId: source.sourceId, tenantId: source.tenantId },
            'Inbound webhook: invalid signature',
          );
          return { kind: 'reject' as const, status: 401, body: { error: 'Invalid signature' } };
        }
      } else {
        signatureValid = true;
      }

      // ── Step 6: Parse + scrub envelope. ────────────────────────────────
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const { envelope, contentRedacted } = parseAndSanitizeEnvelope({
        rawBody, idempotencyKey,
      });

      // ── Step 7: Content filter. ────────────────────────────────────────
      if (source.contentFilterEnabled) {
        const cf = classifyContent(envelope);
        if (cf.blocked) {
          await recordDelivery({
            client, source, envelope, rawBody, bodyBytes, bodySha256,
            headers, signature: signatureHeader ?? null, signatureValid,
            status: 'rejected_unsafe_content', unsafeMatches: cf.matched,
            contentRedacted, matchedRuleIds: [], outboxEventIds: [],
          });
          return {
            kind: 'reject' as const,
            status: 422,
            body: { error: 'Unsafe content', matched: cf.matched },
          };
        }
      }

      // ── Step 8: Idempotency / dedup BEFORE budget + rule resolution. ───
      // Plan §2 ordering: insert the delivery row, ON CONFLICT short-
      // circuit to duplicate. Anything that follows (budget, rules)
      // requires a NEW row.
      const deliveryId = await recordDelivery({
        client, source, envelope, rawBody, bodyBytes, bodySha256,
        headers, signature: signatureHeader ?? null, signatureValid,
        status: 'accepted', unsafeMatches: [], contentRedacted,
        matchedRuleIds: [], outboxEventIds: [],
      });
      if (deliveryId === null) {
        return { kind: 'duplicate' as const, eventId: envelope.event_id };
      }

      // ── Step 9: Daily budget check. ────────────────────────────────────
      if (caps.dailyRunBudget !== null) {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text as count FROM event_deliveries
           WHERE tenant_id = $1 AND status = 'accepted' AND received_at >= $2
             AND id <> $3`,
          [source.tenantId, dayAgo, deliveryId],
        );
        const dispatched = parseInt(r.rows[0]?.count ?? '0', 10);
        if (dispatched >= caps.dailyRunBudget) {
          await client.query(
            `UPDATE event_deliveries SET status = 'rejected_budget_exceeded'
             WHERE id = $1 AND tenant_id = $2`,
            [deliveryId, source.tenantId],
          );
          return {
            kind: 'budget_exceeded' as const,
            eventId: envelope.event_id,
          };
        }
      }

      // ── Step 10: Resolve active trigger rules. ─────────────────────────
      const matches = await resolveRules(client, source.tenantId, source.sourceId, envelope.event_type);
      if (matches.length === 0) {
        await client.query(
          `UPDATE event_deliveries SET status = 'rejected_no_active_rule'
           WHERE id = $1 AND tenant_id = $2`,
          [deliveryId, source.tenantId],
        );
        return { kind: 'no_rules' as const, eventId: envelope.event_id };
      }

      // Persist matched_rule_ids so operators can see them even if
      // dispatch fails later.
      await client.query(
        `UPDATE event_deliveries
         SET matched_rule_ids = $1
         WHERE id = $2 AND tenant_id = $3`,
        [matches.map((m) => m.ruleId), deliveryId, source.tenantId],
      );
      // Bump last_event_at on the source.
      await client.query(
        `UPDATE event_sources SET last_event_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [source.sourceId, source.tenantId],
      );

      return {
        kind: 'dispatch' as const,
        deliveryId,
        envelope,
        matches,
        contentRedacted,
      };
    });
  } catch (err) {
    log.error(
      { error: (err as Error).message, token: '[redacted]' },
      'Inbound webhook: unhandled error inside tenant tx',
    );
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal error' });
    }
    return;
  }

  // ── Tenant tx committed; respond/dispatch based on outcome. ─────────────

  if (pipelineOutcome.kind === 'reject') {
    if (pipelineOutcome.headers) {
      for (const [k, v] of Object.entries(pipelineOutcome.headers)) res.setHeader(k, v);
    }
    res.status(pipelineOutcome.status).json(pipelineOutcome.body ?? null);
    return;
  }

  if (pipelineOutcome.kind === 'duplicate') {
    res.status(200).json({
      eventId: pipelineOutcome.eventId,
      status: 'duplicate',
      triggered: 0,
    });
    return;
  }

  if (pipelineOutcome.kind === 'no_rules') {
    res.status(200).json({
      eventId: pipelineOutcome.eventId,
      status: 'accepted',
      triggered: 0,
    });
    return;
  }

  if (pipelineOutcome.kind === 'budget_exceeded') {
    res.status(200).json({
      eventId: pipelineOutcome.eventId,
      status: 'accepted',
      triggered: 0,
      budgetExceeded: true,
    });
    return;
  }

  // ── Step 11: Dispatch. ─────────────────────────────────────────────────
  const outboxEventIds = await dispatchToRules({
    source,
    envelope: pipelineOutcome.envelope,
    matches: pipelineOutcome.matches,
    deliveryId: pipelineOutcome.deliveryId,
    contentRedacted: pipelineOutcome.contentRedacted,
  });

  // Mark dispatch outcome on the delivery row. If ZERO rules survived
  // dispatch, status flips to 'dispatch_failed' so operators see the
  // partial-failure case. If at least one succeeded, status stays
  // 'accepted' and outbox_event_ids is set.
  const finalStatus: DeliveryStatus =
    outboxEventIds.length === 0 ? 'dispatch_failed' : 'accepted';
  try {
    await updateDeliveryDispatch(
      source.tenantId,
      pipelineOutcome.deliveryId,
      outboxEventIds,
      finalStatus,
    );
  } catch (err) {
    log.error(
      { error: (err as Error).message, deliveryId: pipelineOutcome.deliveryId },
      'Failed to update delivery row after dispatch',
    );
  }

  res.status(202).json({
    eventId: pipelineOutcome.envelope.event_id,
    status: finalStatus === 'dispatch_failed' ? 'dispatch_failed' : 'accepted',
    triggered: outboxEventIds.length,
  });
});
