/**
 * Router-level HTTP status mapping for executeTask outcomes.
 *
 * Regression guard: executeTask short-circuits on the lifecycle check for a
 * PAUSED agent, returning `{ success: false, error: '... is not in ACTIVE
 * state' }`. If the router 200s that, Envoy and operator dashboards see the
 * request as healthy while the caller can see a long stall and a 504.
 *
 * /api/execution/execute therefore returns:
 *   - 409 Conflict when the agent isn't ACTIVE (lifecycle gate)
 *   - 403 Forbidden when admission denies (suspended tenant, credit drain,
 *     governance kill switch)
 *   - 409 (existing behaviour) when an agent is already running
 *   - 200 on success
 */

import express from 'express';
import request from 'supertest';

jest.mock('../service', () => {
  const executeTask = jest.fn();
  const progressWorkflow = jest.fn().mockResolvedValue(undefined);
  return {
    agentExecutionService: { executeTask, progressWorkflow },
  };
});

import { agentExecutionRouter } from '../router';
import { agentExecutionService } from '../service';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/execution', agentExecutionRouter);
  return app;
}

const VALID_BODY = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  agentId: '22222222-2222-2222-2222-222222222222',
  workflowId: '33333333-3333-3333-3333-333333333333',
  taskId: '44444444-4444-4444-4444-444444444444',
  objective: 'say PONG',
};

describe('agentExecutionRouter /execute fast-fail mapping', () => {
  beforeEach(() => {
    (agentExecutionService.executeTask as jest.Mock).mockReset();
    (agentExecutionService.progressWorkflow as jest.Mock).mockReset();
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/execution/execute')
      .send({ tenantId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  it('returns 409 when the agent is not in ACTIVE state', async () => {
    (agentExecutionService.executeTask as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Agent 22222222-2222-2222-2222-222222222222 is not in ACTIVE state',
      toolCallsExecuted: 0,
      reasoningSteps: 0,
    });
    const res = await request(buildApp())
      .post('/api/execution/execute')
      .send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not in ACTIVE state/);
    expect(agentExecutionService.progressWorkflow).not.toHaveBeenCalled();
  });

  it('returns 409 when the agent is already running', async () => {
    (agentExecutionService.executeTask as jest.Mock).mockResolvedValue({
      success: false,
      error: 'agent_already_running',
      toolCallsExecuted: 0,
      reasoningSteps: 0,
    });
    const res = await request(buildApp())
      .post('/api/execution/execute')
      .send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('agent_already_running');
  });

  it('returns 403 when admission denies', async () => {
    (agentExecutionService.executeTask as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Admission denied: tenant_suspended',
      toolCallsExecuted: 0,
      reasoningSteps: 0,
    });
    const res = await request(buildApp())
      .post('/api/execution/execute')
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Admission denied/);
    expect(agentExecutionService.progressWorkflow).not.toHaveBeenCalled();
  });

  it('returns 200 with the result on success', async () => {
    (agentExecutionService.executeTask as jest.Mock).mockResolvedValue({
      success: true,
      output: 'PONG',
      toolCallsExecuted: 0,
      reasoningSteps: 1,
    });
    const res = await request(buildApp())
      .post('/api/execution/execute')
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toBe('PONG');
    expect(agentExecutionService.progressWorkflow).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when executeTask throws', async () => {
    (agentExecutionService.executeTask as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await request(buildApp())
      .post('/api/execution/execute')
      .send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });
});
