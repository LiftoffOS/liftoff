// Webhook rate-limiter atomic CTE tests. The implementation lives in
// src/event-sources/rate-limiter.ts and is exercised by the inbound-router
// integration test; here we cover the limiter's per-source vs per-tenant
// dispatch logic in isolation.

import { checkAndIncrementWebhookRateLimit } from '../rate-limiter';

type Bucket = { tenant_id: string; account_id: string; created_at: Date };

function makeClient(bucket: Bucket[], opts: { breakOnInsert?: boolean } = {}) {
  const nextId = 1;
  return {
    bucket,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('WITH inserted AS')) {
        if (opts.breakOnInsert) throw new Error('boom');
        const [tenantId, sourceId, minuteAgo] = params as [string, string, Date];
        bucket.push({ tenant_id: tenantId, account_id: sourceId, created_at: new Date() });
        const tenantCount = bucket.filter(
          (r) => r.tenant_id === tenantId && r.created_at >= minuteAgo,
        ).length;
        const sourceCount = bucket.filter(
          (r) => r.account_id === sourceId && r.created_at >= minuteAgo,
        ).length;
        return {
          rows: [{ tenant_count: String(tenantCount), source_count: String(sourceCount) }],
          rowCount: 1,
        };
      }
      if (s.startsWith('DELETE FROM event_source_rate_limit_events')) {
        const [tenantId, sourceId] = params as [string, string];
        for (let i = bucket.length - 1; i >= 0; i--) {
          const r = bucket[i];
          if (r.tenant_id === tenantId && r.account_id === sourceId) {
            bucket.splice(i, 1);
            break;
          }
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    nextId,
  };
}

describe('checkAndIncrementWebhookRateLimit', () => {
  const T = 'tenant-1';
  const S = 'source-1';

  it('allows requests below both caps', async () => {
    const client = makeClient([]);
    const result = await checkAndIncrementWebhookRateLimit({
      client: client as never,
      tenantId: T, sourceId: S,
      sourceLimitPerMinute: 5, tenantLimitPerMinute: 100,
    });
    expect(result.allowed).toBe(true);
    expect(client.bucket).toHaveLength(1);
  });

  it('rolls back the insert on source-limit breach', async () => {
    const bucket: Bucket[] = [];
    // Pre-fill 5 rows for the source — about to be the 6th.
    for (let i = 0; i < 5; i++) {
      bucket.push({ tenant_id: T, account_id: S, created_at: new Date() });
    }
    const client = makeClient(bucket);
    const result = await checkAndIncrementWebhookRateLimit({
      client: client as never,
      tenantId: T, sourceId: S,
      sourceLimitPerMinute: 5, tenantLimitPerMinute: 100,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('rejected_rate');
    expect(typeof result.retryAfter).toBe('number');
    // Net effect: 5 pre-filled rows, +1 inserted, -1 rolled back = 5.
    expect(client.bucket).toHaveLength(5);
  });

  it('rolls back the insert on tenant-ceiling breach (tenant check precedes source check)', async () => {
    const bucket: Bucket[] = [];
    // Tenant has 10 rows from other sources; source has 0.
    for (let i = 0; i < 10; i++) {
      bucket.push({ tenant_id: T, account_id: `other-source-${i}`, created_at: new Date() });
    }
    const client = makeClient(bucket);
    const result = await checkAndIncrementWebhookRateLimit({
      client: client as never,
      tenantId: T, sourceId: S,
      sourceLimitPerMinute: 100, tenantLimitPerMinute: 10,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('rejected_tenant_ceiling');
    expect(client.bucket).toHaveLength(10);
  });

  it('fails OPEN when the query throws', async () => {
    const client = makeClient([], { breakOnInsert: true });
    const result = await checkAndIncrementWebhookRateLimit({
      client: client as never,
      tenantId: T, sourceId: S,
      sourceLimitPerMinute: 5, tenantLimitPerMinute: 5,
    });
    expect(result.allowed).toBe(true);
  });
});
