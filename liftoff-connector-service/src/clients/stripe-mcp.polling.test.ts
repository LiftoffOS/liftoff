// StripeMCPClient.list() + multi-entity normalizer.
//
// These assertions used to pin `list_payment_intents` / `list_invoices` /
// `list_subscriptions`. Every one of those is `Unknown tool` on the live Stripe
// MCP — the server consolidated onto `stripe_api_read` / `stripe_api_write`
// driven by an operation id. The old expectations passed against a mock while
// the real poll could never have worked, so the tool name is now asserted
// alongside the operation id: a mock that agrees with a server that would
// reject the call is worth nothing.

import { StripeMCPClient } from './stripe-mcp.js';
import { StripeNormalizer } from '../normalizers/stripe.normalizer.js';

function makeClient(toolResult: unknown) {
  const client = new StripeMCPClient({
    tenantId: 't1',
    credentialStore: { get: async () => ({}) } as never,
  });
  // Stub the underlying MCP transport.
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  (client as unknown as { mcpClient: { callTool: unknown } }).mcpClient = {
    callTool: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return { isError: false, content: [{ type: 'text', text: JSON.stringify(toolResult) }] };
    },
  };
  return { client, calls };
}

describe('StripeMCPClient.list', () => {
  it('reads PaymentIntent via GetPaymentIntents with created.gte + cursor', async () => {
    const { client, calls } = makeClient({
      object: 'list',
      data: [{ id: 'pi_1', object: 'payment_intent', amount: 4900, currency: 'usd', status: 'succeeded', created: 1750000000 }],
      has_more: true,
    });
    const res = await client.list('PaymentIntent', { since: new Date('2026-06-26T00:00:00Z'), limit: 50 });

    expect(calls[0].tool).toBe('stripe_api_read');
    expect(calls[0].args.stripe_api_operation_id).toBe('GetPaymentIntents');
    const params = calls[0].args.parameters as { created: { gte: number }; limit: number };
    expect(params.created.gte).toBe(Math.floor(Date.parse('2026-06-26T00:00:00Z') / 1000));
    expect(params.limit).toBe(50);
    expect(res.records[0].id).toBe('pi_1');
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('pi_1');
  });

  it('maps Invoice and Subscription to their verified operation ids', async () => {
    const inv = makeClient({ object: 'list', data: [{ id: 'in_1', object: 'invoice' }], has_more: false });
    await inv.client.list('Invoice', {});
    expect(inv.calls[0].tool).toBe('stripe_api_read');
    expect(inv.calls[0].args.stripe_api_operation_id).toBe('GetInvoices');

    const sub = makeClient({ object: 'list', data: [{ id: 'sub_1', object: 'subscription' }], has_more: false });
    await sub.client.list('Subscription', {});
    expect(sub.calls[0].tool).toBe('stripe_api_read');
    expect(sub.calls[0].args.stripe_api_operation_id).toBe('GetSubscriptions');
  });

  it('addresses a single object by its own path parameter, not a generic id', async () => {
    // /v1/subscriptions/{subscription_exposed_id} — passing `id` silently
    // returns the unfiltered list instead of the object.
    const { client, calls } = makeClient({ id: 'sub_1', object: 'subscription' });
    await client.read('subscription', 'sub_1');
    expect(calls[0].tool).toBe('stripe_api_read');
    expect(calls[0].args.stripe_api_operation_id).toBe('GetSubscriptionsSubscriptionExposedId');
    expect(calls[0].args.parameters).toEqual({ subscription_exposed_id: 'sub_1' });
  });

  it('refuses an operation Stripe does not expose instead of inventing one', async () => {
    // PostPaymentIntents and DeleteCustomersCustomer both answer
    // "Operation is not available" on the live server.
    const { client, calls } = makeClient({});
    const created = await client.create('payment_intent', { amount: 100, currency: 'usd' });
    expect(created.success).toBe(false);
    const deleted = await client.delete('customer', 'cus_1');
    expect(deleted.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('returns empty for an unsupported entity without calling the MCP', async () => {
    const { client, calls } = makeClient({});
    expect((await client.list('Customer')).records).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('StripeNormalizer', () => {
  it('discriminates payment_intent / invoice / subscription by the object field', () => {
    const n = new StripeNormalizer();
    const recs = n.normalize({
      results: [
        { id: 'pi_1', object: 'payment_intent', amount: 4900, currency: 'usd', status: 'succeeded', created: 1750000000 },
        { id: 'in_1', object: 'invoice', amount_due: 4900, currency: 'usd', status: 'open', created: 1750000000 },
        { id: 'sub_1', object: 'subscription', status: 'active', currency: 'usd', current_period_end: 1752600000 },
        { id: 'cus_1', object: 'customer' },
      ],
    });
    expect(recs.map(r => r.entityType)).toEqual(['PaymentIntent', 'Invoice', 'Subscription']);
    expect(recs[0].data.amount).toBe(4900);
    expect(recs[1].data.status).toBe('open');
    expect(recs[2].data.currentPeriodEnd).toBe(new Date(1752600000 * 1000).toISOString());
    expect(recs[0].metadata.source).toBe('stripe');
  });
});
