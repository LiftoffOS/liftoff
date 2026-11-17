// The usage writer against the REAL schema: migration 506's partial unique
// index and the insert's `ON CONFLICT (call_id) WHERE call_id IS NOT NULL`
// run together. A mocked client can show the statement was issued, never
// that PostgreSQL accepts the conflict target — which is exactly what the
// bare `ON CONFLICT (call_id)` would have failed at runtime.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     src/llm/__tests__/usage-tracker.integration.test.ts

import { Pool, type PoolClient } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

let testPool: Pool | null = null;
jest.mock('../../infrastructure/database', () => ({
  getPool: () => testPool,
  withAdminScope: async (_opts: unknown, fn: (client: PoolClient) => Promise<unknown>) => {
    const client = await (testPool as Pool).connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  },
}));
jest.mock('../client', () => ({ llmClient: { onUsage: jest.fn() } }));

import { writeUsageEvent } from '../usage-tracker';

describeFn('usage-tracker / writeUsageEvent against the real schema', () => {
  beforeAll(() => {
    testPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => {
    await testPool?.query(`DELETE FROM llm_usage_log WHERE call_id LIKE 'it-506-%' OR purpose = 'it_506_null_call_id'`);
    await testPool?.end();
  });

  const base = {
    timestamp: new Date(),
    provider: 'typesafe' as const,
    model: 'jev-1.13.0',
    inputTokens: 10,
    outputTokens: 1,
    success: true,
  };

  it('two inserts with one call_id → one row', async () => {
    const callId = `it-506-${Date.now()}`;
    await writeUsageEvent({ ...base, callId, attempts: 1, context: { purpose: 'tool_classification' } });
    await writeUsageEvent({ ...base, callId, attempts: 2, context: { purpose: 'tool_classification' } });
    const rows = await testPool!.query(`SELECT attempts FROM llm_usage_log WHERE call_id = $1`, [callId]);
    expect(rows.rowCount).toBe(1);
    // The first write stands; the retry is a no-op.
    expect(rows.rows[0].attempts).toBe(1);
  });

  it('a NULL call_id never conflicts', async () => {
    await writeUsageEvent({ ...base, context: { purpose: 'it_506_null_call_id' } });
    await writeUsageEvent({ ...base, context: { purpose: 'it_506_null_call_id' } });
    const rows = await testPool!.query(`SELECT count(*)::int AS n FROM llm_usage_log WHERE purpose = 'it_506_null_call_id'`);
    expect(rows.rows[0].n).toBe(2);
  });

  it('stores attempts and the vendor request id', async () => {
    const callId = `it-506-v-${Date.now()}`;
    await writeUsageEvent({ ...base, callId, attempts: 2, vendorRequestId: 'req_abc', context: { purpose: 'tool_classification' } });
    const rows = await testPool!.query(`SELECT attempts, vendor_request_id FROM llm_usage_log WHERE call_id = $1`, [callId]);
    expect(rows.rows[0]).toEqual({ attempts: 2, vendor_request_id: 'req_abc' });
  });
});
