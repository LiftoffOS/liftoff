/**
 * B4: the operator dashboard's one route that crosses into the tenant runtime.
 *
 * Every other route on this dashboard reads the control-plane database, which
 * is why `system_internal` escalations were visible to nobody: they correctly
 * left the customer queue, and no internal surface replaced it. This is that
 * surface, so the things worth pinning are that it validates its inputs rather
 * than passing junk down, and that it reaches the runtime at all.
 */
import express from 'express';
import request from 'supertest';

const listOperatorEscalationRecordsMock = jest.fn();

// The whole router sits behind platform-admin auth, which is correct and is
// exercised by that middleware's own tests. Standing it in here keeps these
// cases about the route's own behaviour, and the final case below proves the
// guard is still mounted.
let adminAllowed = true;
jest.mock('../../admin/middleware', () => ({
  adminAuthMiddleware: (req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (!adminAllowed) return res.status(401).json({ error: 'Unauthorized' });
    next();
  },
}));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    listOperatorEscalationRecords: (...args: unknown[]) =>
      listOperatorEscalationRecordsMock(...args),
  },
}));

import { operatorDashboardRouter } from '../router';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/operator', operatorDashboardRouter);
  return a;
}

beforeEach(() => {
  listOperatorEscalationRecordsMock.mockReset();
  listOperatorEscalationRecordsMock.mockResolvedValue([]);
});

describe('GET /tenants/:tenantId/operator-records', () => {
  it('returns the runtime records for that tenant', async () => {
    listOperatorEscalationRecordsMock.mockResolvedValue([
      { id: 'esc-1', tenantId: 't1', agentId: 'a', reason: 'connector unreachable',
        status: 'pending', createdAt: '2026-08-01T10:00:00.000Z', resolvedAt: null,
        occurrenceCount: 2 },
    ]);

    const res = await request(app()).get('/api/operator/tenants/t1/operator-records');

    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].id).toBe('esc-1');
    expect(listOperatorEscalationRecordsMock).toHaveBeenCalledWith('t1', {
      status: undefined,
      limit: undefined,
    });
  });

  it('passes a valid status and limit through', async () => {
    await request(app())
      .get('/api/operator/tenants/t1/operator-records?status=resolved&limit=10');

    expect(listOperatorEscalationRecordsMock).toHaveBeenCalledWith('t1', {
      status: 'resolved',
      limit: 10,
    });
  });

  it('rejects a status it does not have rather than quietly ignoring it', async () => {
    const res = await request(app())
      .get('/api/operator/tenants/t1/operator-records?status=everything');

    expect(res.status).toBe(400);
    expect(listOperatorEscalationRecordsMock).not.toHaveBeenCalled();
  });

  it('rejects a limit that is not a positive integer', async () => {
    for (const bad of ['0', '-5', 'lots']) {
      listOperatorEscalationRecordsMock.mockClear();
      const res = await request(app())
        .get(`/api/operator/tenants/t1/operator-records?limit=${bad}`);

      expect(res.status).toBe(400);
      expect(listOperatorEscalationRecordsMock).not.toHaveBeenCalled();
    }
  });

  it('does not shadow the tenant health route', async () => {
    // /tenants/:tenantId is registered above this one, so a path with a
    // trailing segment must still reach here rather than being swallowed.
    const res = await request(app()).get('/api/operator/tenants/t1/operator-records');
    expect(res.status).toBe(200);
    expect(listOperatorEscalationRecordsMock).toHaveBeenCalled();
  });

  it('stays behind platform-admin auth', async () => {
    // These records name broken connectors and internal failures across
    // tenants. The guard is the reason it is safe to expose them at all.
    adminAllowed = false;
    try {
      const res = await request(app()).get('/api/operator/tenants/t1/operator-records');
      expect(res.status).toBe(401);
      expect(listOperatorEscalationRecordsMock).not.toHaveBeenCalled();
    } finally {
      adminAllowed = true;
    }
  });
});
