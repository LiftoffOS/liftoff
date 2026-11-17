/**
 * The review history feeds behind the workspace export.
 *
 * Two properties matter more than the shape: the walk is a composite keyset
 * over (created_at, id), so two rows that share a boundary timestamp lose
 * nothing, and the boundary is `asOf`, applied in SQL, so a row created after
 * the instant the export stamped never reaches the archive. The DTO is its own
 * because `mapApprovalRequest` does `new Date(row.expires_at)` on a nullable
 * column.
 */
const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
  withTenantScope: jest.fn(),
  getPool: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
  getPoolForService: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
}));

jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: { onLateFeedbackFlagged: jest.fn() },
}));
jest.mock('../resolve-and-resume', () => ({ resolveApprovalAndResume: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { HitlEnforcementService, decodeQueueCursor, REVIEW_HISTORY_MAX_LIMIT } from '../service';
import { hitlRouter } from '../router';

const service = new HitlEnforcementService();
const AS_OF = new Date('2026-09-18T21:04:11.318Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('listReviewHistoryApprovals', () => {
  it('reads every status of the tenant up to asOf, oldest first, by (created_at, id)', async () => {
    await service.listReviewHistoryApprovals('t', { asOf: AS_OF });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM hitl_approval_requests r');
    expect(sql).toContain('r.tenant_id = $1');
    expect(sql).not.toMatch(/r\.status\s*=/);
    expect(sql).toContain("COALESCE(r.created_at, 'epoch'::timestamptz) <= $2::timestamptz");
    expect(sql).toContain('ORDER BY COALESCE(r.created_at, \'epoch\'::timestamptz) ASC, r.id ASC');
    expect(params[0]).toBe('t');
    expect(params[1]).toBe(AS_OF);
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(REVIEW_HISTORY_MAX_LIMIT + 1);
  });

  it('selects the columns the status table reads, and the agent name', async () => {
    await service.listReviewHistoryApprovals('t', { asOf: AS_OF });
    const sql = queryMock.mock.calls[0][0] as string;
    for (const col of ['r.status', 'r.decision', 'r.decided_at', 'r.expires_at', 'r.updated_at',
      'r.edited_tool_inputs', 'r.action_summary', 'r.why_summary', 'r.detail', 'r.pending_tool_calls',
      'r.hitl_level', 'r.reason', 'r.rejection_reason', 'r.decided_by']) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain('(SELECT a.name FROM agents a WHERE a.id = r.agent_id) AS agent_name');
  });

  it('pages a two-row set with tied created_at without losing the second row', async () => {
    const tied = '2026-09-01 10:00:00.123456+00';
    queryMock
      .mockResolvedValueOnce({ rows: [
        { id: A, status: 'pending', created_at: new Date('2026-09-01T10:00:00.123Z'), sort_cursor: tied },
        { id: B, status: 'pending', created_at: new Date('2026-09-01T10:00:00.123Z'), sort_cursor: tied },
      ] })
      .mockResolvedValueOnce({ rows: [
        { id: B, status: 'pending', created_at: new Date('2026-09-01T10:00:00.123Z'), sort_cursor: tied },
      ] });

    const page1 = await service.listReviewHistoryApprovals('t', { asOf: AS_OF, limit: 1 });
    expect(page1.items.map((i) => i.id)).toEqual([A]);
    expect(page1.nextCursor).not.toBeNull();
    // The cursor carries the Postgres text timestamp, microseconds intact.
    expect(decodeQueueCursor(page1.nextCursor)).toEqual({ sortAt: tied, kind: 'approval', id: A });

    const page2 = await service.listReviewHistoryApprovals('t', { asOf: AS_OF, limit: 1, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).toEqual([B]);
    expect(page2.nextCursor).toBeNull();
    const [sql, params] = queryMock.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("(COALESCE(r.created_at, 'epoch'::timestamptz), r.id) > ($3::timestamptz, $4::uuid)");
    expect(params[2]).toBe(tied);
    expect(params[3]).toBe(A);
  });

  it('maps a NULL expires_at to null rather than an Invalid Date', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: A, status: 'pending', decision: null, decided_by: null, decided_at: null,
      rejection_reason: null, expires_at: null, updated_at: null, created_at: new Date('2026-09-01T10:00:00Z'),
      hitl_level: 1, reason: 'level_1_gate', pending_tool_calls: [], edited_tool_inputs: null,
      action_summary: null, why_summary: null, detail: null, sort_cursor: '2026-09-01 10:00:00+00', agent_name: 'Code Reviewer',
    }] });
    const { items } = await service.listReviewHistoryApprovals('t', { asOf: AS_OF });
    expect(items[0].expiresAt).toBeNull();
    expect(items[0].updatedAt).toBeNull();
    expect(items[0].decidedAt).toBeNull();
    expect(items[0].createdAt).toBe('2026-09-01T10:00:00.000Z');
    expect(items[0].agentName).toBe('Code Reviewer');
    expect(items[0].hitlLevel).toBe(1);
  });

  it('caps the page size', async () => {
    await service.listReviewHistoryApprovals('t', { asOf: AS_OF, limit: 5000 });
    expect((queryMock.mock.calls[0][1] as unknown[])[4]).toBe(REVIEW_HISTORY_MAX_LIMIT + 1);
  });
});

describe('listReviewHistoryClarifications', () => {
  it('reads only clarification rows, every status, up to asOf, by (created_at, id)', async () => {
    await service.listReviewHistoryClarifications('t', { asOf: AS_OF });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM agent_scheduled_invocations c');
    expect(sql).toContain("c.objective = 'clarification-expiry'");
    expect(sql).not.toMatch(/c\.status\s*=/);
    expect(sql).toContain('c.created_at <= $2::timestamptz');
    expect(sql).toContain('ORDER BY c.created_at ASC, c.id ASC');
    expect(sql).toContain("(c.workflow_resume_payload->'pauseContext'->>'originalQuestion') AS question");
    for (const col of ['c.fires_at', 'c.fired_at', 'c.cancelled_at', 'c.updated_at',
      'c.resolution_kind', 'c.resolved_by', 'c.resolved_by_label', 'c.resolved_at']) {
      expect(sql).toContain(col);
    }
    expect(params[1]).toBe(AS_OF);
  });

  it('pages a tied set with the composite keyset', async () => {
    const tied = '2026-09-02 10:00:00.5+00';
    queryMock
      .mockResolvedValueOnce({ rows: [
        { id: B, status: 'fired', sort_cursor: tied, created_at: new Date() },
        { id: C, status: 'fired', sort_cursor: tied, created_at: new Date() },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: C, status: 'fired', sort_cursor: tied, created_at: new Date() }] });
    const page1 = await service.listReviewHistoryClarifications('t', { asOf: AS_OF, limit: 1 });
    expect(decodeQueueCursor(page1.nextCursor)).toEqual({ sortAt: tied, kind: 'clarification', id: B });
    const page2 = await service.listReviewHistoryClarifications('t', { asOf: AS_OF, limit: 1, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).toEqual([C]);
    const [sql, params] = queryMock.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('(c.created_at, c.id) > ($3::timestamptz, $4::uuid)');
    expect(params[2]).toBe(tied);
    expect(params[3]).toBe(B);
  });

  it('carries the resolution columns through, null when never written', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      id: A, question: 'Which region?', status: 'resume_inflight', fires_at: new Date('2026-09-09T00:00:00Z'),
      fired_at: null, cancelled_at: null, updated_at: new Date('2026-09-08T17:02:00Z'), created_at: new Date('2026-09-08T16:40:00Z'),
      resolution_kind: 'answered', resolved_by: 'acc-1', resolved_by_label: null, resolved_at: new Date('2026-09-08T17:02:00Z'),
      sort_cursor: 'x', agent_name: null,
    }] });
    const { items } = await service.listReviewHistoryClarifications('t', { asOf: AS_OF });
    expect(items[0]).toMatchObject({
      question: 'Which region?', status: 'resume_inflight', resolutionKind: 'answered', resolvedBy: 'acc-1',
      resolvedByLabel: null, resolvedAt: '2026-09-08T17:02:00.000Z', firedAt: null, agentName: null,
    });
  });
});

describe('GET /review-history/*', () => {
  function app(tenantId: string | undefined) {
    const a = express();
    a.use((req, _res, next) => {
      (req as express.Request).ctx = { requestId: 'r', tenantId, operation: 'test' } as express.Request['ctx'];
      next();
    });
    a.use('/api/hitl-enforcement', hitlRouter);
    return a;
  }

  it('400s without a tenant, without asOf, on a malformed asOf and on a bad limit', async () => {
    expect((await request(app(undefined)).get('/api/hitl-enforcement/review-history/approvals').query({ asOf: AS_OF.toISOString() })).status).toBe(400);
    expect((await request(app('t')).get('/api/hitl-enforcement/review-history/approvals')).status).toBe(400);
    expect((await request(app('t')).get('/api/hitl-enforcement/review-history/clarifications').query({ asOf: 'yesterday' })).status).toBe(400);
    expect((await request(app('t')).get('/api/hitl-enforcement/review-history/approvals').query({ asOf: AS_OF.toISOString(), limit: '0' })).status).toBe(400);
    expect((await request(app('t')).get('/api/hitl-enforcement/review-history/clarifications').query({ asOf: AS_OF.toISOString(), limit: 'many' })).status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('serves { items, nextCursor } scoped to the header tenant, and is not swallowed by /approvals/:id', async () => {
    const res = await request(app('t')).get('/api/hitl-enforcement/review-history/approvals')
      .query({ asOf: AS_OF.toISOString(), limit: '50' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('t');
    expect(params[4]).toBe(51);

    const clar = await request(app('t')).get('/api/hitl-enforcement/review-history/clarifications')
      .query({ asOf: AS_OF.toISOString() });
    expect(clar.status).toBe(200);
    expect(clar.body).toEqual({ items: [], nextCursor: null });
  });
});
