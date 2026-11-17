const mockQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  stepKey,
  canonicalJson,
  claimSideEffect,
  resolveSideEffect,
  failSideEffect,
} from '../sideeffect-idempotency';

const base = { tenantId: '11111111-1111-1111-1111-111111111111', triggerKey: 'evt-abc' };

describe('sideeffect-idempotency (§4.2) — stepKey', () => {
  it('canonicalJson is key-order-insensitive', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('same (trigger, tool, args) → same key regardless of arg key order', () => {
    const a = stepKey({ ...base, toolName: 'gmail.send_email', args: { to: 'x', subject: 's' } });
    const b = stepKey({ ...base, toolName: 'gmail.send_email', args: { subject: 's', to: 'x' } });
    expect(a).toBe(b);
  });

  it('different args → different key (a reworded body is a different side effect)', () => {
    const a = stepKey({ ...base, toolName: 'gmail.send_email', args: { body: 'hello' } });
    const b = stepKey({ ...base, toolName: 'gmail.send_email', args: { body: 'hello.' } });
    expect(a).not.toBe(b);
  });

  it('different triggerKey → different key (distinct triggers do not collide)', () => {
    const a = stepKey({ ...base, toolName: 't', args: {} });
    const b = stepKey({ ...base, triggerKey: 'evt-other', toolName: 't', args: {} });
    expect(a).not.toBe(b);
  });
});

describe('sideeffect-idempotency (§4.2) — claimSideEffect', () => {
  beforeEach(() => mockQuery.mockReset());
  const args = { to: 'x' };
  const call = (policy: 'effectively_once' | 'at_most_once') =>
    claimSideEffect({ ...base, toolName: 'gmail.send_email', args, policy });

  it('first delivery → run', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'processing' }] });
    const r = await call('at_most_once');
    expect(r.outcome).toBe('run');
  });

  it('completed → replay with payload from the side table', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT excluded
      .mockResolvedValueOnce({ rows: [{ status: 'completed' }] }) // status lookup
      .mockResolvedValueOnce({ rows: [{ payload: { ok: true, big: 'x'.repeat(10000) } }] }); // side-table
    const r = await call('effectively_once');
    expect(r.outcome).toBe('replay');
    expect((r as { result: unknown }).result).toEqual({ ok: true, big: 'x'.repeat(10000) });
  });

  it('at_most_once + processing (crashed/unknown) → blocked (never re-fire)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'processing' }] });
    const r = await call('at_most_once');
    expect(r.outcome).toBe('blocked');
  });

  it('effectively_once + active processing → blocked (owner finishes it)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'processing' }] });
    const r = await call('effectively_once');
    expect(r.outcome).toBe('blocked');
  });

  it('fail-open: DB error → run', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const r = await call('at_most_once');
    expect(r.outcome).toBe('run');
  });

  it('passes the policy into the claim SQL ($3)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'processing' }] });
    await call('effectively_once');
    expect(mockQuery.mock.calls[0][1][2]).toBe('effectively_once');
  });
});

describe('sideeffect-idempotency (§4.2) — resolve/fail', () => {
  beforeEach(() => mockQuery.mockReset());

  it('resolveSideEffect stores full payload then marks completed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await resolveSideEffect({ tenantId: base.tenantId, stepKey: 'k', result: { big: 'x'.repeat(50000) } });
    expect(mockQuery.mock.calls[0][0]).toMatch(/idempotency_result_payloads/);
    expect(mockQuery.mock.calls[1][0]).toMatch(/status='completed'/);
  });

  it('failSideEffect marks failed with truncated error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await failSideEffect({ tenantId: base.tenantId, stepKey: 'k', error: 'e'.repeat(5000) });
    expect(mockQuery.mock.calls[0][0]).toMatch(/status='failed'/);
    expect((mockQuery.mock.calls[0][1][2] as string).length).toBe(1024);
  });
});
