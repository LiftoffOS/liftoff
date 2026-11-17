// The request for the person to take over (migration 431), over a fake
// client: the statements' shape and order, and what each function answers.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const scopedQuery = jest.fn();
const scopes: string[] = [];
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: async (tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
    scopes.push(tenantId);
    return fn({ query: (...args: unknown[]) => scopedQuery(...args) });
  },
}));

import {
  INTERVENTION_TTL_MS, answerIntervention, endInterventions, interventionForHold, interventionGateMessage,
  pendingIntervention, requestIntervention,
} from '../interventions';

const sqlOf = (n: number) => String(scopedQuery.mock.calls[n][0]).replace(/\s+/g, ' ').trim();
const row = (over: Record<string, unknown> = {}) => ({
  id: 'req-1', tenant_id: 't', session_id: 'sid', thread_id: 'th', requested_by_invocation_id: null,
  reason: 'sign in to the account', reason_truncated: false, reason_protected_data_omitted: false,
  requested_at: new Date('2026-09-21T21:03:00Z'), status: 'pending', hold_id: null, answered_at: null, ended_at: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  scopes.length = 0;
});

describe('requestIntervention', () => {
  it('expires a stale pending request first, then inserts under the tenant with the reason sanitized', async () => {
    scopedQuery
      .mockResolvedValueOnce({ rowCount: 1 })           // expire
      .mockResolvedValueOnce({ rows: [] })               // no pending
      .mockResolvedValueOnce({ rows: [row()] });         // insert
    const out = await requestIntervention({ tenantId: 't', sessionId: 'sid', threadId: 'th', reason: 'sign in to the account', requestedByInvocationId: 'inv-1' });
    expect(scopes).toEqual(['t']);
    expect(sqlOf(0)).toContain("SET status = 'expired', ended_at = now() WHERE tenant_id = $3 AND session_id = $1 AND status = 'pending' AND requested_at < now() - ($2::int * interval '1 millisecond')");
    expect(scopedQuery.mock.calls[0][1]).toEqual(['sid', INTERVENTION_TTL_MS, 't']);
    expect(sqlOf(2)).toContain('INSERT INTO browser_interventions');
    expect(sqlOf(2)).toContain("ON CONFLICT (session_id) WHERE status = 'pending' DO NOTHING");
    expect(scopedQuery.mock.calls[2][1]).toEqual(['t', 'sid', 'th', 'inv-1', 'sign in to the account', false, false]);
    expect(out).toEqual({ alreadyPending: false, intervention: expect.objectContaining({ id: 'req-1', status: 'pending', reason: 'sign in to the account' }) });
  });

  it('answers alreadyPending with the request that stands, and inserts nothing', async () => {
    scopedQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row()] });
    const out = await requestIntervention({ tenantId: 't', sessionId: 'sid', threadId: 'th', reason: 'another' });
    expect(out.alreadyPending).toBe(true);
    expect(out.intervention.reason).toBe('sign in to the account');
    expect(scopedQuery).toHaveBeenCalledTimes(2);
  });

  it('bounds the reason and says when the sanitizer changed it', async () => {
    scopedQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row()] });
    await requestIntervention({ tenantId: 't', sessionId: 'sid', threadId: null, reason: 'sign in with password: hunter2-synthetic-secret' });
    const params = scopedQuery.mock.calls[2][1] as unknown[];
    expect(String(params[4])).not.toContain('hunter2-synthetic-secret');
    expect(params[6]).toBe(true);
  });
});

describe('pendingIntervention', () => {
  it('expires a stale one on the read and answers the pending one', async () => {
    scopedQuery.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [row()] });
    const out = await pendingIntervention('t', 'sid');
    expect(sqlOf(0)).toContain("SET status = 'expired'");
    expect(out?.id).toBe('req-1');
  });

  it('answers null when none is pending', async () => {
    scopedQuery.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] });
    expect(await pendingIntervention('t', 'sid')).toBeNull();
  });
});

describe('answerIntervention', () => {
  it('runs on the caller\'s own client and stamps the hold that answered', async () => {
    const client = { query: jest.fn(async () => ({ rows: [row({ status: 'answered', hold_id: 'hold-1' })] })) };
    const out = await answerIntervention(client as never, 'sid', 'hold-1');
    expect(scopes).toEqual([]);
    expect(String(client.query.mock.calls[0][0])).toContain("SET status = 'answered', hold_id = $2, answered_at = now(), ended_at = now()");
    expect(client.query.mock.calls[0][1]).toEqual(['sid', 'hold-1']);
    expect(out?.holdId).toBe('hold-1');
  });
});

describe('interventionForHold and endInterventions', () => {
  it('reads the request a hold answered', async () => {
    scopedQuery.mockResolvedValueOnce({ rows: [row({ status: 'answered', hold_id: 'hold-1' })] });
    const out = await interventionForHold('t', 'hold-1');
    expect(sqlOf(0)).toContain('WHERE tenant_id = $2 AND hold_id = $1');
    expect(out?.status).toBe('answered');
  });

  it('withdraws (cancels) the pending request under the tenant and counts what it ended', async () => {
    scopedQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await endInterventions(undefined, 'sid', 'cancelled', 't')).toBe(1);
    expect(scopes).toEqual(['t']);
    expect(sqlOf(0)).toContain("SET status = $2, ended_at = now() WHERE tenant_id = $3 AND session_id = $1 AND status = 'pending'");
    expect(scopedQuery.mock.calls[0][1]).toEqual(['sid', 'cancelled', 't']);
  });

  it('refuses to run with neither a client nor a tenant', async () => {
    await expect(endInterventions(undefined, 'sid', 'cancelled')).rejects.toThrow(/needs a client or a tenant/);
  });
});

describe('the gate sentence', () => {
  it('is the one spelling, with the reason', () => {
    expect(interventionGateMessage('sign in')).toBe(
      'You asked the person to take over the browser (sign in). Until they do, or you withdraw the request with '
      + 'ask_person_to_take_over_browser_session, you can read the browser but not act in it.',
    );
  });
});
