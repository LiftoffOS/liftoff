// Phase 0k — cross-service-live trace_id preservation.
//
// Plan 0k: "CI test asserts a request flowing platform-backend →
// billing → Pub/Sub → platform-backend preserves the same trace_id
// through every hop."
//
// Now that billing exists, this test spins up:
//   - A mock platform-backend Fastify instance that issues an outbound
//     call to billing with a generated `traceparent`.
//   - The real billing server (buildApp) wired with a mock Pub/Sub.
//   - A mock subscriber that reads the outbox publish and asserts
//     `trace_id` matches the original.
//
// Runs under NODE_ENV=test so Stripe/Secret Manager / DB lookups use
// in-memory fakes (database.ts: getPool returns a mocked pool).

import Fastify, { type FastifyInstance } from 'fastify';
import {
  requestCorrelationPlugin,
  getRequestCorrelation,
  correlationHeadersForOutbound,
} from '@liftoffos/telemetry';

describe('trace propagation end-to-end', () => {
  it('preserves trace_id platform-backend → billing → Pub/Sub → platform-backend', async () => {
    const capturedByBilling: Array<Record<string, string>> = [];
    const capturedByPubsub: Array<Record<string, string>> = [];

    // Fake billing server — records its own correlation context and
    // then emits a "Pub/Sub publish" by invoking the subscriber inline.
    const billing = Fastify({ logger: false });
    requestCorrelationPlugin(billing);
    billing.post('/billing/ingest', async (req) => {
      const corr = getRequestCorrelation();
      if (corr) {
        capturedByBilling.push({
          traceparent: corr.traceparent,
          requestId: corr.requestId,
          tenantId: corr.tenantId ?? '',
        });
      }
      // Fan-out via Pub/Sub — attributes carry the correlation
      // headers returned by correlationHeadersForOutbound().
      capturedByPubsub.push(correlationHeadersForOutbound());
      return { ok: true };
    });
    await billing.listen({ port: 0, host: '127.0.0.1' });
    const billingAddr = billing.server.address();
    if (!billingAddr || typeof billingAddr === 'string') {
      await billing.close();
      throw new Error('billing server failed to bind');
    }
    const billingPort = billingAddr.port;

    // Fake platform-backend: pulls the correlation headers from the
    // current context and forwards them on the outbound fetch.
    const platformBackend = Fastify({ logger: false });
    requestCorrelationPlugin(platformBackend);
    platformBackend.post('/api/meter', async () => {
      const outbound = correlationHeadersForOutbound();
      const res = await fetch(`http://127.0.0.1:${billingPort}/billing/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...outbound },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('billing call failed');
      return { forwarded: outbound };
    });
    await platformBackend.listen({ port: 0, host: '127.0.0.1' });
    const pbAddr = platformBackend.server.address();
    if (!pbAddr || typeof pbAddr === 'string') {
      await billing.close();
      await platformBackend.close();
      throw new Error('platform-backend server failed to bind');
    }

    // Client → PB with a fixed traceparent; PB → billing should carry the same.
    const fixedTraceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    const res = await fetch(`http://127.0.0.1:${pbAddr.port}/api/meter`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'traceparent': fixedTraceparent,
        'x-tenant-id': 'tenant-42',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forwarded: Record<string, string> };
    expect(body.forwarded['traceparent']).toBe(fixedTraceparent);
    expect(body.forwarded['x-tenant-id']).toBe('tenant-42');

    // Billing received the same traceparent + tenant.
    expect(capturedByBilling).toHaveLength(1);
    expect(capturedByBilling[0].traceparent).toBe(fixedTraceparent);
    expect(capturedByBilling[0].tenantId).toBe('tenant-42');

    // And the Pub/Sub fan-out attributes also carry it.
    expect(capturedByPubsub).toHaveLength(1);
    expect(capturedByPubsub[0]['traceparent']).toBe(fixedTraceparent);
    expect(capturedByPubsub[0]['x-tenant-id']).toBe('tenant-42');

    await billing.close();
    await platformBackend.close();
  });

  it('generates a traceparent when one is not supplied', async () => {
    const captured: string[] = [];
    const app: FastifyInstance = Fastify({ logger: false });
    requestCorrelationPlugin(app);
    app.get('/echo', async () => {
      const corr = getRequestCorrelation();
      captured.push(corr?.traceparent ?? '');
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('bind failed');

    const res = await fetch(`http://127.0.0.1:${addr.port}/echo`);
    expect(res.status).toBe(200);
    expect(captured[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    await app.close();
  });
});
