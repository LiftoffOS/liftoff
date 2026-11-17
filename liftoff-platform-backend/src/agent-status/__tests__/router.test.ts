import express from 'express';
import request from 'supertest';

const mockGetAgentStatus = jest.fn();

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getAgentStatus: (...args: unknown[]) => mockGetAgentStatus(...args) },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { agentStatusRouter } from '../router';

function makeApp() {
  const app = express();
  app.use('/agent-status', agentStatusRouter);
  return app;
}

const baseStatus = {
  invocationId: 'inv-1',
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  agentName: 'Test Agent',
  status: 'running' as const,
  currentTurn: 1,
  maxTurns: 10,
  phase: 'executing' as const,
  startedAt: new Date().toISOString(),
  elapsedMs: 2500,
  isTerminal: false,
  currentTool: 'search',
  recentEvents: [],
  pendingApprovalId: null,
  lastError: null,
};

describe('agentStatusRouter', () => {
  beforeEach(() => {
    mockGetAgentStatus.mockReset();
  });

  it('GET /:tenantId/:invocationId proxies JSON response from tenant-runtime', async () => {
    mockGetAgentStatus.mockResolvedValueOnce(baseStatus);
    const res = await request(makeApp()).get('/agent-status/tenant-1/inv-1');
    expect(res.status).toBe(200);
    expect(res.body.invocationId).toBe('inv-1');
    expect(mockGetAgentStatus).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      invocationId: 'inv-1',
      format: 'json',
    });
  });

  it('returns 404 when tenant-runtime says invocation does not exist', async () => {
    mockGetAgentStatus.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get('/agent-status/tenant-1/missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invocation not found');
  });

  it('forwards format=text and returns plain text content-type', async () => {
    mockGetAgentStatus.mockResolvedValueOnce('inv      inv-1\nagent    Test (running)');
    const res = await request(makeApp()).get('/agent-status/tenant-1/inv-1?format=text');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('inv-1');
    expect(mockGetAgentStatus).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      invocationId: 'inv-1',
      format: 'text',
    });
  });

  it('coerces unknown format values to json (no injection of arbitrary format)', async () => {
    mockGetAgentStatus.mockResolvedValueOnce(baseStatus);
    await request(makeApp()).get('/agent-status/tenant-1/inv-1?format=xml');
    expect(mockGetAgentStatus).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      invocationId: 'inv-1',
      format: 'json',
    });
  });

  it('returns 502 when upstream throws', async () => {
    mockGetAgentStatus.mockRejectedValueOnce(new Error('runtime down'));
    const res = await request(makeApp()).get('/agent-status/tenant-1/inv-1');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('runtime down');
  });
});
