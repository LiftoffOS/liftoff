// Integration test: standard-tool audit dispatch issues the expected
// INSERT INTO audit_logs SQL with the right bound parameters on each
// newly-covered path. Field-mapping invariants are pinned by
// standard-tool-emitter.test.ts; this file pins the wire SQL itself.

// We capture the SQL + bound params the audit/service.ts module issues
// against its tenant-scoped transaction client. Mocking withTenantScope
// lets us intercept the txnClient.query call (the actual INSERT INTO
// audit_logs SQL) without booting Postgres.
const mockTxnQuery = jest.fn().mockResolvedValue({ rows: [] });
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [] });

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
    await fn({ query: mockTxnQuery });
  }),
}));

// Mock the redaction layer at the value level so we observe the raw SQL
// + bound params rather than redacted JSON strings.
jest.mock('@liftoffos/proto-gen/dist/redaction', () => ({
  redactPii: (s: string) => s,
  redactPiiWithCounters: (s: string) => ({ text: s, counters: {} }),
  redactPiiDeep: (v: unknown) => v,
  REDACTION_VERSION: '1.0.0-test',
}));

import { emitStandardToolAudit } from '../../audit/standard-tool-emitter';

beforeEach(() => {
  mockTxnQuery.mockClear();
  mockPoolQuery.mockClear();
  delete process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED;
});

afterEach(() => {
  delete process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED;
});

/** Returns the (sql, params) tuple from the most recent INSERT INTO audit_logs call. */
function lastInsert(): { sql: string; params: unknown[] } {
  const calls = mockTxnQuery.mock.calls.filter(c => /INSERT INTO audit_logs/i.test(c[0]));
  if (calls.length === 0) {
    throw new Error('No INSERT INTO audit_logs SQL was issued via the tenant-scoped client');
  }
  return { sql: calls[calls.length - 1][0] as string, params: calls[calls.length - 1][1] as unknown[] };
}

describe('standard-tool audit emits INSERT INTO audit_logs', () => {
  it('memory_save: emits INSERT with action=memory_save + outcome=success', async () => {
    await emitStandardToolAudit({
      tenantId: 't-1',
      agentId: 'a-1',
      invocationId: 'i-1',
      action: 'memory_save',
      inputArgs: { content: 'remember this' },
      success: true,
      durationMs: 5,
    });
    const { sql, params } = lastInsert();
    expect(sql).toMatch(/INSERT INTO audit_logs/i);
    // Action ($7) is the 7th positional parameter per audit/service.ts.
    expect(params[6]).toBe('memory_save');
    // Outcome ($10) is the 10th.
    expect(params[9]).toBe('success');
  });

  it('web_research: emits INSERT with action=web_research', async () => {
    await emitStandardToolAudit({
      tenantId: 't-1',
      agentId: 'a-1',
      invocationId: 'i-1',
      action: 'web_research',
      inputArgs: { query: 'vector dbs' },
      success: true,
      durationMs: 12,
    });
    expect(lastInsert().params[6]).toBe('web_research');
  });

  it('search outer audit: emits INSERT with action=search', async () => {
    await emitStandardToolAudit({
      tenantId: 't-1',
      agentId: 'a-1',
      invocationId: 'i-1',
      action: 'search',
      inputArgs: { query: 'q' },
      success: true,
      durationMs: 30,
    });
    expect(lastInsert().params[6]).toBe('search');
  });

  it('search sub-dispatch: emits INSERT with action=<alias>__search', async () => {
    await emitStandardToolAudit({
      tenantId: 't-1',
      agentId: 'a-1',
      invocationId: 'i-1',
      action: 'github__search',
      inputArgs: { query: 'q' },
      success: false,
      error: 'no search action on github',
      errorCode: 'search_sub_dispatch_error',
      durationMs: 15,
    });
    const { params } = lastInsert();
    expect(params[6]).toBe('github__search');
    expect(params[9]).toBe('error');
    expect(params[10]).toBe('search_sub_dispatch_error');
  });

  it('error outcome: outputSummary carries the error message (truncated to 500)', async () => {
    await emitStandardToolAudit({
      tenantId: 't-1',
      agentId: 'a-1',
      invocationId: 'i-1',
      action: 'memory_save',
      inputArgs: { content: 'x' },
      success: false,
      error: 'memory_save failed: quota exceeded',
      durationMs: 8,
    });
    const { params } = lastInsert();
    // output_summary ($9) carries the error message.
    expect(params[8]).toContain('quota exceeded');
  });

  it('kill switch: no INSERT when AUDIT_LOG_STANDARD_TOOLS_DISABLED=1', async () => {
    process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED = '1';
    await emitStandardToolAudit({
      tenantId: 't-1',
      agentId: 'a-1',
      action: 'memory_save',
      inputArgs: {},
      success: true,
      durationMs: 1,
    });
    expect(mockTxnQuery).not.toHaveBeenCalled();
  });

  it('passes invocation_id through to audit_logs.invocation_id', async () => {
    await emitStandardToolAudit({
      tenantId: 't-1',
      agentId: 'a-1',
      invocationId: 'inv-123',
      action: 'memory_save',
      inputArgs: {},
      success: true,
      durationMs: 1,
    });
    // invocation_id ($5) is the 5th positional parameter.
    expect(lastInsert().params[4]).toBe('inv-123');
  });
});
