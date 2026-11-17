// src/billing/web-tool-spend-subscriber.ts
//
// Phase 4 of the deep-research-realtime-billing plan. Pub/Sub push
// subscription endpoint for web-tool spend events from tenant-runtime.
// Mirrors the LLM spend-subscriber's auth + ingest pattern but delegates
// to ingestEventWithBuckets directly (so both push + ingester paths
// converge on the same dedup + bucket math + PB-3 refund branch).

import { Router, Request, Response } from 'express';
import { armX402Upkeep } from '../jobs/maintenance-targets';
import { OAuth2Client } from 'google-auth-library';
import { log } from '../infrastructure/logging';
import { ingestEventWithBuckets, resolveAccountIdForTenant } from '../cost-attribution/repository';
import { getRuntimeToInternalMap, toInternalAgentId } from '../internal-agents/runtime-agent-id-map';

const router = Router();
const oauthClient = new OAuth2Client();

const GCP_PROJECT_ID       = process.env.GCP_PROJECT_ID ?? '';
const ENVIRONMENT          = process.env.ENVIRONMENT ?? 'dev';
const PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL ?? '';

const EXPECTED_PUBSUB_SA_EMAIL =
  process.env.WEB_TOOL_PUBSUB_PUSH_SA_EMAIL ??
  `web-tool-pubsub-push-${ENVIRONMENT}@${GCP_PROJECT_ID}.iam.gserviceaccount.com`;

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

/** The agent id a browser session carries when NO agent owns it — a platform
 *  assistant's session.
 *
 *  Mirrors NO_AGENT_SENTINEL in the tenant runtime's browser-sessions/types.ts.
 *  It is a WIRE value, not a local choice: the runtime's web_sessions.agent_id
 *  is UUID NOT NULL, so "no agent" has to be spelled as something, and this is
 *  what it spells. Duplicated rather than imported because the two services
 *  share no module; the value is the nil UUID and cannot drift silently, since
 *  a mismatch shows up immediately as a phantom agent in cost reporting. */


interface WebToolSpendPayload {
  tenantId: string;
  /**
   * Tenant Runtime `agents.id`. `standard-tool-handler.ts` publishes
   * `ctx.agentId` verbatim, which is runtime-space — that file keeps its own
   * runtime->internal helper for exactly this reason. Translate before writing
   * (INV-PB-009).
   */
  agentId?: string;
  /** `internal_agents.id` for `agentId`, resolved by the runtime from its
   *  mapping table. Absent when the agent is unmapped, when no agent owns the
   *  spend, and from a runtime that predates the field. */
  internalAgentId?: string;
  workflowId?: string;
  actionId?: string;
  invocationId?: string;
  threadId?: string | null;
  connector?: string;
  eventType: string;
  /**
   * Which PLATFORM ASSISTANT the spend belongs to, when no agent does:
   * 'liftoff' | 'insights' | 'team_plan'. Absent for a team agent, which
   * agentId identifies.
   *
   * The three share one identity everywhere else — none has an agent row, so
   * every session they open carries the same no-agent sentinel — and without
   * this their browser spend is a single lump nobody can attribute.
   */
  purpose?: string;
  costUsd: number;
  occurredAt: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

router.post('/api/internal/billing/web-tool-event', async (req: Request, res: Response) => {
  try {
    await verifyPubSubOidcToken(req.header('Authorization'));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'billing.web_tool_spend_subscriber: OIDC validation failed');
    res.status(401).send('unauthorized');
    return;
  }

  // Pub/Sub envelope: { message: { data: base64(payload) } }
  let payload: WebToolSpendPayload;
  try {
    const raw = Buffer.from(req.body?.message?.data ?? '', 'base64').toString('utf8');
    payload = JSON.parse(raw);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'billing.web_tool_spend_subscriber: payload decode failed');
    res.status(200).send('ack-malformed'); // ACK so we don't loop
    return;
  }

  try {
    const accountId = await resolveAccountIdForTenant(payload.tenantId);
    if (!accountId) {
      log.warn({ tenant_id: payload.tenantId, idempotency_key: payload.idempotencyKey },
        'billing.web_tool_spend_subscriber: tenant has no account_id; ACKing');
      res.status(200).send('ack-no-account');
      return;
    }

    // PB EVENT_TYPE_MAP collapses every web_* event_type onto 'web_tool'
    // (verified at usage-ledger-ingester.ts:20-33). Mirror that mapping
    // here so both push and ingester paths land identical event_type
    // values — the partial unique index keys on event_type.
    const collapsedEventType = 'web_tool' as const;

    // cost_attribution_events is keyed by internal_agents.id. The runtime
    // sends that id as `internalAgentId` when the agent is mapped, and then
    // nothing needs translating. Otherwise translate its local agents.id;
    // identity-preserving, so an already-internal id passes through untouched
    // and this is safe to re-apply (INV-PB-009). The translation asks the
    // runtime's agent-service, which bills by the instance, so it is the
    // fallback and not the path: every web-tool charge used to wake it.
    //
    // The nil UUID is how the runtime's NOT NULL agent column spells "no
    // agent" — a platform assistant's session. It is NOT an agent here, and
    // `toInternalAgentId` is now what knows that: the check used to live on
    // this line alone, and the backstop ingester, which calls the same
    // translator, therefore kept writing the sentinel into agent_id. Null is
    // the truthful value; `purpose` below says which assistant it was.
    const attributionAgentId = payload.internalAgentId
      ?? toInternalAgentId(await getRuntimeToInternalMap(payload.tenantId), payload.agentId);

    // Whose key paid the vendor, reported by the runtime on the call itself.
    // Only 'platform' changes anything: it moves a steel, browser_use, tavily
    // or exa row off the BYOK bypass and onto the customer-chargeable path. Anything else —
    // absent, or a value a future runtime invents — leaves the row exactly
    // where it has always gone, so an unrecognised string cannot silently
    // start charging a workspace.
    const webToolFunding =
      payload.metadata?.funding === 'platform' ? 'platform' as const : undefined;

    // The platform x402 wallet paid the vendor (the runtime's last web rung,
    // browserbase_x402). Same routing as the feed backstop
    // (usage-ledger-ingester.ts): the wallet-funded branch of
    // ingestEventWithBuckets, one row per call in cost_bucket
    // 'x402_wallet_funded', which is what the on-chain reconciliation sums.
    // This subscriber lands first and the backstop dedups on it, so a row it
    // books elsewhere stays there.
    const x402Funded = payload.metadata?.funding === 'x402_wallet';

    await ingestEventWithBuckets(
      accountId,
      payload.idempotencyKey,
      payload.costUsd,
      {
        tenantId:              payload.tenantId,
        agentId:               attributionAgentId,
        workflowId:            payload.workflowId ?? null,
        actionId:              payload.actionId ?? null,
        threadId:              payload.threadId ?? null,
        invocationId:          payload.invocationId ?? null,
        parentInvocationId:    null,
        connector:             payload.connector ?? null,
        entityType:            null,
        actionType:            payload.eventType,    // e.g. 'web_deep_research'
        // Was hardcoded null. It is the dimension that separates the three
        // platform assistants, and cost_attribution_events already has the
        // column — so this needed no migration, only for someone to pass it.
        purpose:               payload.purpose ?? null,
        eventType:             collapsedEventType,    // 'web_tool'
        source:                'tenant_runtime',
        provider:              null,
        model:                 null,
        inputTokens:           null,
        outputTokens:          null,
        cachedTokens:          null,
        hostingMode:           null,
        correlationConfidence: null,
        occurredAt:            new Date(payload.occurredAt),
        itemId:                null,
        webToolFunding,
        ...(x402Funded
          ? { x402Funded: true, usageQuantity: 1, usageUnit: 'call' as const }
          : {}),
      },
    );
    // Wallet-funded spend drains a wallet that holds a few dollars; arm its
    // upkeep now rather than at a clock (maintenance-targets.ts).
    if (x402Funded) armX402Upkeep();

    res.status(200).send('ok');
  } catch (err) {
    log.error({
      err: (err as Error).message,
      tenant_id: payload.tenantId,
      idempotency_key: payload.idempotencyKey,
    }, 'billing.web_tool_spend_subscriber: ingest failed');
    res.status(500).send('ingest-failed'); // Pub/Sub will retry; DLQ after 5
  }
});

export { router as webToolSpendSubscriberRouter };
