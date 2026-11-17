/**
 * R5 BE-R5-006: schema-check readiness probe tests.
 *
 * Validates: version-match → ready; version-mismatch → not ready, retries;
 * max attempts exceeded → not ready (fail open: Cloud Run recycles).
 */
import { pollSchemaUntilReady, isSchemaReady, _resetSchemaReadyForTesting, EXPECTED_SCHEMA_VERSION } from '../schema-check';

class MockPool {
  public queue: Array<{ rows: Array<{ version: number }> } | { throw: Error }> = [];

  async query<T>(_sql: string): Promise<T> {
    const next = this.queue.shift();
    if (!next) {
      return { rows: [] } as unknown as T;
    }
    if ('throw' in next) throw next.throw;
    return next as unknown as T;
  }
}

describe('schema-check readiness', () => {
  beforeEach(() => {
    _resetSchemaReadyForTesting();
  });

  it('becomes ready when the current version matches EXPECTED_SCHEMA_VERSION', async () => {
    const pool = new MockPool();
    pool.queue = [{ rows: [{ version: EXPECTED_SCHEMA_VERSION }] }];
    await pollSchemaUntilReady(pool as unknown as never, { maxAttempts: 1, intervalMs: 0 });
    expect(isSchemaReady()).toBe(true);
  });

  it('does not become ready when version is below expected after maxAttempts', async () => {
    const pool = new MockPool();
    // Fill enough mismatches for 3 attempts
    for (let i = 0; i < 5; i++) {
      pool.queue.push({ rows: [{ version: EXPECTED_SCHEMA_VERSION - 1 }] });
    }
    await pollSchemaUntilReady(pool as unknown as never, { maxAttempts: 3, intervalMs: 0 });
    expect(isSchemaReady()).toBe(false);
  });

  it('tolerates DB errors and retries', async () => {
    const pool = new MockPool();
    pool.queue = [
      { throw: new Error('connection refused') },
      { rows: [{ version: EXPECTED_SCHEMA_VERSION }] },
    ];
    await pollSchemaUntilReady(pool as unknown as never, { maxAttempts: 3, intervalMs: 0 });
    expect(isSchemaReady()).toBe(true);
  });
});
