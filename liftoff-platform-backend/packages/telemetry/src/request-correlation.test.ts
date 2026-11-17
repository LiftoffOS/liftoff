import {
  correlationHeadersForOutbound,
  getRequestCorrelation,
  withRequestCorrelation,
  type RequestCorrelation,
} from './request-correlation.js';

describe('request-correlation', () => {
  const baseCorr: RequestCorrelation = {
    traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01',
    requestId: 'req-1',
    tenantId: 'ten-1',
  };

  it('returns empty headers outside a correlation block', () => {
    expect(correlationHeadersForOutbound()).toEqual({});
  });

  it('propagates the same trace_id through nested async work', async () => {
    await withRequestCorrelation(baseCorr, async () => {
      await Promise.resolve();
      const corr = getRequestCorrelation();
      expect(corr?.traceparent).toBe(baseCorr.traceparent);
      const headers = correlationHeadersForOutbound();
      expect(headers['traceparent']).toBe(baseCorr.traceparent);
      expect(headers['x-request-id']).toBe('req-1');
      expect(headers['x-tenant-id']).toBe('ten-1');
    });
  });

  it('omits tenant header when tenantId is null', async () => {
    await withRequestCorrelation({ ...baseCorr, tenantId: null }, async () => {
      const headers = correlationHeadersForOutbound();
      expect(headers['x-tenant-id']).toBeUndefined();
    });
  });

  it('preserves trace_id across multiple async hops (simulated service chain)', async () => {
    // Simulate: platform-backend (hop 1) → billing (hop 2) → platform-backend callback (hop 3).
    // Each hop reads the inbound trace_id, runs nested async work, emits outbound headers.
    const hopTraces: string[] = [];
    await withRequestCorrelation(baseCorr, async () => {
      hopTraces.push(getRequestCorrelation()!.traceparent);
      await new Promise((r) => setImmediate(r));
      // Callee (simulated — uses same AsyncLocalStorage)
      await withRequestCorrelation(
        {
          traceparent: getRequestCorrelation()!.traceparent,
          requestId: 'req-2',
          tenantId: getRequestCorrelation()!.tenantId,
        },
        async () => {
          hopTraces.push(getRequestCorrelation()!.traceparent);
          await new Promise((r) => setImmediate(r));
          // Pub/Sub fan-out — same trace carries over
          await withRequestCorrelation(
            {
              traceparent: getRequestCorrelation()!.traceparent,
              requestId: 'req-3',
              tenantId: getRequestCorrelation()!.tenantId,
            },
            async () => {
              hopTraces.push(getRequestCorrelation()!.traceparent);
            },
          );
        },
      );
    });
    expect(hopTraces).toEqual([baseCorr.traceparent, baseCorr.traceparent, baseCorr.traceparent]);
  });
});
