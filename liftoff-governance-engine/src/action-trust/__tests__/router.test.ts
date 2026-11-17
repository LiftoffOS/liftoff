// action-trust router: GET (A1 decisions-derived TrustResult | 404 | 400 | 500) +
// POST /decisions (insert + validation).

jest.mock('../service', () => ({ getTrust: jest.fn() }));
jest.mock('../repository', () => ({ insertDecisions: jest.fn() }));
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: unknown) => unknown) => fn({}),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { actionTrustRouter } from '../router';
import { getTrust } from '../service';
import { insertDecisions } from '../repository';

const mockGetTrust = getTrust as jest.Mock;
const mockInsert = insertDecisions as jest.Mock;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/governance/action-trust', actionTrustRouter);
  return a;
}

describe('action-trust router', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET returns the A1 decisions-derived TrustResult (incl. distinctApprovers)', async () => {
    mockGetTrust.mockResolvedValue({ tier: 'auto', runs: 40, passRate: 0.95, distinctApprovers: 3 });
    const res = await request(app()).get('/api/governance/action-trust?tenantId=t&agentId=a&actionClass=send_email');
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('auto');
    expect(res.body.distinctApprovers).toBe(3);
    expect(mockGetTrust).toHaveBeenCalledWith('t', 'a', 'send_email');
  });

  it('GET → 404 when there is no calibrated tier for the triple', async () => {
    mockGetTrust.mockResolvedValue(null);
    const res = await request(app()).get('/api/governance/action-trust?tenantId=t&agentId=a&actionClass=send_email');
    expect(res.status).toBe(404);
  });

  it('GET → 400 when a query param is missing', async () => {
    const res = await request(app()).get('/api/governance/action-trust?tenantId=t&agentId=a');
    expect(res.status).toBe(400);
    expect(mockGetTrust).not.toHaveBeenCalled();
  });

  it('GET → 500 (not throws) when the service rejects', async () => {
    mockGetTrust.mockRejectedValue(new Error('boom'));
    const res = await request(app()).get('/api/governance/action-trust?tenantId=t&agentId=a&actionClass=send_email');
    expect(res.status).toBe(500);
  });

  it('POST inserts a decisions batch and returns { inserted }', async () => {
    mockInsert.mockResolvedValue(2);
    const res = await request(app())
      .post('/api/governance/action-trust/decisions')
      .send({
        tenantId: 't', agentId: 'a', gateReason: 'sensitive_work', approvalId: 'appr-1',
        decisions: [
          { actionClass: 'send_email', decision: 'approved', decidedBy: 'u', decidedAt: '2026-07-23T00:00:00Z', sourceKey: 'appr-1:send_email' },
          { actionClass: 'delete_file', decision: 'rejected', decidedBy: 'u', decidedAt: '2026-07-23T00:00:00Z', sourceKey: 'appr-1:delete_file' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(2);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('POST → 400 when both approvalId and feedbackId present', async () => {
    const res = await request(app())
      .post('/api/governance/action-trust/decisions')
      .send({
        tenantId: 't', agentId: 'a', gateReason: 'x', approvalId: 'appr-1', feedbackId: 'fb-1',
        decisions: [{ actionClass: 'c', decision: 'approved', decidedBy: 'u', decidedAt: 'now', sourceKey: 'appr-1:c' }],
      });
    expect(res.status).toBe(400);
  });

  it('POST → 400 when a sourceKey does not equal <id>:<actionClass>', async () => {
    const res = await request(app())
      .post('/api/governance/action-trust/decisions')
      .send({
        tenantId: 't', agentId: 'a', gateReason: 'x', approvalId: 'appr-1',
        decisions: [{ actionClass: 'c', decision: 'approved', decidedBy: 'u', decidedAt: 'now', sourceKey: 'WRONG:c' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sourceKey_mismatch');
  });
});
