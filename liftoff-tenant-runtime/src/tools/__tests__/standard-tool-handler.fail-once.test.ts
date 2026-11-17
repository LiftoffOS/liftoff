// B.1 — __fail_once__ test-only tool unit tests.
//
// The tool exists to verify the transient-retry wrapper actually retries
// a failed dispatch — the only way to test that end-to-end without standing
// up a real flaky vendor. So it MUST:
//   1. Be gated on TEST_HARNESS_FAILTOOL=1 (never registers in prod).
//   2. Pull tenant/invocation from ctx (the LLM can't supply them).
//   3. Return a transient: true + retryAfterMs on the FIRST call per
//      (tenant, invocation) so runToolWithTransientRetry will retry.
//   4. Return success on the SECOND call so the wrapper surfaces a
//      passing outcome.

import {
  executeStandardTool,
  StandardToolContext,
  __resetFailOnceForTests,
} from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  invocationId: 'inv-1',
  memoryScope: { writableLayers: [], readableLayers: [] },
  traceId: 'trace-1',
};

beforeEach(() => {
  __resetFailOnceForTests();
});

describe('__fail_once__ — environment gate', () => {
  beforeEach(() => {
    delete process.env.TEST_HARNESS_FAILTOOL;
  });

  it('returns disabled when TEST_HARNESS_FAILTOOL is unset (prod default)', async () => {
    const r = await executeStandardTool('__fail_once__', {}, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/disabled/);
  });

  it('still returns disabled when TEST_HARNESS_FAILTOOL is any other value', async () => {
    process.env.TEST_HARNESS_FAILTOOL = '0';
    const r = await executeStandardTool('__fail_once__', {}, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/disabled/);
  });
});

describe('__fail_once__ — fail-then-succeed sequence (TEST_HARNESS_FAILTOOL=1)', () => {
  beforeEach(() => {
    process.env.TEST_HARNESS_FAILTOOL = '1';
  });

  afterEach(() => {
    delete process.env.TEST_HARNESS_FAILTOOL;
  });

  it('first call returns transient failure (so wrapper retries)', async () => {
    const r = await executeStandardTool('__fail_once__', {}, ctx) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.transient).toBe(true);
    expect(r.retryAfterMs).toBe(50);
  });

  it('second call (same tenant+invocation) succeeds', async () => {
    await executeStandardTool('__fail_once__', {}, ctx);
    const r = await executeStandardTool('__fail_once__', {}, ctx);
    expect(r?.success).toBe(true);
    expect((r?.result as { retried: boolean }).retried).toBe(true);
  });

  it('different invocation scopes get their own first-call failure', async () => {
    await executeStandardTool('__fail_once__', {}, { ...ctx, invocationId: 'inv-A' });
    const r = await executeStandardTool('__fail_once__', {}, { ...ctx, invocationId: 'inv-B' });
    // inv-B is on its FIRST call → should fail transiently
    expect(r?.success).toBe(false);
    expect((r as Record<string, unknown>).transient).toBe(true);
  });

  it('reads tenantId + invocationId from ctx, not payload (B1-3 fix)', async () => {
    // Payload args are ignored; ctx is the source of truth.
    const r = await executeStandardTool('__fail_once__', {
      tenant_id: 'wrong-tenant',
      invocation_id: 'wrong-inv',
    }, ctx) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.transient).toBe(true);
    // Same ctx + payload-overrides-ignored → second call still tied to ctx scope
    const r2 = await executeStandardTool('__fail_once__', { tenant_id: 'wrong-tenant' }, ctx);
    expect(r2?.success).toBe(true);
  });

  it('surfaces a defensive error if ctx is missing invocationId', async () => {
    const noInvCtx: StandardToolContext = { ...ctx, invocationId: undefined };
    const r = await executeStandardTool('__fail_once__', {}, noInvCtx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/missing tenantId or invocationId/);
  });
});
