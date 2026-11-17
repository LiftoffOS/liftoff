// Register a Stripe webhook endpoint on the tenant's OWN Stripe account, at the
// moment they connect.
//
// WHY PER CONNECTION. Stripe authenticates here by DCR against
// access.stripe.com/mcp, so a tenant grants our dynamically-registered client
// access to their own account rather than becoming a connected account on a
// platform. `connect: true` — one platform endpoint receiving everyone's events
// — has nothing to attach to. Each connection gets its own endpoint, addressed
// by its connector id, and its own signing secret.
//
// WHY AT ALL. Stripe exposes no modified-since filter on any list endpoint and
// its MCP has no events feed, so the poll carries CREATIONS ONLY. Without this,
// `invoice.updated` and `subscription.updated` can never fire.
//
// The secret is returned exactly once, at creation. It goes into the connector's
// Secret Manager blob alongside the token; it is never written to
// `connectors.config`, which is ordinary readable JSONB.

import { logger } from '../infra/logging.js';

const MCP_URL = 'https://mcp.stripe.com/';

/**
 * Events enabled on the endpoint.
 *
 * Keep in step with `entityTypeForStripeEvent`: an event enabled here but
 * unmapped there is delivered and silently dropped; mapped there but not enabled
 * here simply never arrives.
 */
export const STRIPE_WEBHOOK_EVENTS = [
  'invoice.created',
  'invoice.updated',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
];

interface McpEnvelope {
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  error?: { message?: string };
}

async function callStripeTool(
  accessToken: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const raw = await res.text();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`unparseable stripe mcp response (HTTP ${res.status})`);
  const body = JSON.parse(match[0]) as McpEnvelope;
  if (body.error) throw new Error(body.error.message ?? 'stripe mcp error');
  if (body.result?.isError) {
    throw new Error(body.result.content?.[0]?.text?.slice(0, 200) ?? 'stripe tool error');
  }
  return JSON.parse(body.result?.content?.find((c) => c.type === 'text')?.text ?? '{}') as Record<string, unknown>;
}

/**
 * Create the endpoint and return its signing secret, or null when it could not
 * be created.
 *
 * Null rather than throw: the connection itself is fine without a webhook — the
 * poll still delivers creations and every MCP tool still works — so a failure
 * here must not fail the OAuth callback and leave the user with no connector at
 * all. It degrades to poll-only, loudly.
 *
 * UNVERIFIED AGAINST A REAL GRANT: the DCR flow grants scope `mcp`, and whether
 * that scope may create a webhook endpoint could not be tested without
 * completing a browser authorization. If Stripe refuses, this logs
 * `stripe_webhook_registration_failed` with the vendor's own message and the
 * connector works without update events.
 */
export async function registerStripeWebhook(input: {
  tenantId: string;
  connectorId: string;
  accessToken: string;
}): Promise<string | null> {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) {
    logger.error({ connector_id: input.connectorId }, 'stripe_webhook_registration_no_backend_url');
    return null;
  }
  const url = `${backendUrl.replace(/\/$/, '')}/api/connectors/stripe/webhook/${input.connectorId}`;

  try {
    const created = await callStripeTool(input.accessToken, 'stripe_api_write', {
      stripe_api_operation_id: 'PostWebhookEndpoints',
      parameters: {
        url,
        enabled_events: STRIPE_WEBHOOK_EVENTS,
        description: 'LiftoffOS connector events',
      },
    });
    const secret = typeof created.secret === 'string' ? created.secret : undefined;
    if (!secret) {
      logger.error(
        { tenant_id: input.tenantId, connector_id: input.connectorId, endpoint_id: created.id },
        'stripe_webhook_registration_returned_no_secret',
      );
      return null;
    }
    logger.info(
      { tenant_id: input.tenantId, connector_id: input.connectorId, endpoint_id: created.id },
      'stripe_webhook_registered',
    );
    return secret;
  } catch (err) {
    logger.error(
      { tenant_id: input.tenantId, connector_id: input.connectorId, err: (err as Error).message },
      'stripe_webhook_registration_failed',
    );
    return null;
  }
}
