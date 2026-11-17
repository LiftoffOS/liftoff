// Route test for POST /api/tasks/child-execution — the Cloud Tasks receiver that
// runs one DAG child and reports its terminal status back to the coordinator.
// Thin wrapper, but the wiring matters: success/paused/escalated → completeChildTask,
// everything else → failChildTask, an in-flight duplicate short-circuits to 200,
// and the completion counter fires with the right status label.

import express from 'express';
import request from 'supertest';

jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: {
    executeTask: jest.fn(),
    progressWorkflow: jest.fn(),
  },
}));
jest.mock('../../infrastructure/oidc', () => ({
  verifyOidcToken: jest.fn().mockResolvedValue(true), // Cloud Tasks OIDC accepted
}));
jest.mock('../../coordinator/service', () => ({
  CoordinatorService: jest.fn().mockImplementation(() => ({
    completeChildTask: jest.fn().mockResolvedValue(undefined),
    failChildTask: jest.fn().mockResolvedValue(undefined),
    expireGraphIfStuck: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { cloudTasksHandler } from '../cloud-tasks-handler';
import { agentExecutionService } from '../../agent-execution/service';
import { CoordinatorService } from '../../coordinator/service';
import * as metrics from '../../observability/runtime-extensions-metrics';

const executeTask = agentExecutionService.executeTask as jest.Mock;
const MockCoordinator = CoordinatorService as unknown as jest.Mock;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', cloudTasksHandler);
  return app;
}

const BASE = { tenantId: 't1', agentId: 'a1', objective: 'do the thing', childTaskId: 'c1' };
const coordInstance = () => MockCoordinator.mock.results[0]?.value;

describe('POST /api/tasks/child-execution', () => {
  beforeEach(() => jest.clearAllMocks());

  it('400s when childTaskId is missing', async () => {
    const res = await request(makeApp())
      .post('/api/tasks/child-execution')
      .send({ tenantId: 't1', agentId: 'a1', objective: 'x' });
    expect(res.status).toBe(400);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('completes the child + fires the completed counter on success', async () => {
    executeTask.mockResolvedValue({ success: true, output: { answer: 42 } });
    const inc = jest.spyOn(metrics.child_task_completed_total, 'inc').mockImplementation(() => {});

    const res = await request(makeApp()).post('/api/tasks/child-execution').send(BASE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ childTaskId: 'c1', success: true });
    expect(coordInstance().completeChildTask).toHaveBeenCalledWith('c1', { answer: 42 });
    expect(coordInstance().failChildTask).not.toHaveBeenCalled();
    expect(inc).toHaveBeenCalledWith({ tenant_id: 't1', status: 'completed' });
  });

  it('treats a paused child as a completion (parent fan-in owns the pause)', async () => {
    executeTask.mockResolvedValue({ success: false, paused: true });
    const res = await request(makeApp()).post('/api/tasks/child-execution').send(BASE);
    expect(res.status).toBe(200);
    expect(coordInstance().completeChildTask).toHaveBeenCalledTimes(1);
    expect(coordInstance().failChildTask).not.toHaveBeenCalled();
  });

  it('fails the child on an error result', async () => {
    executeTask.mockResolvedValue({ success: false, error: 'boom' });
    const inc = jest.spyOn(metrics.child_task_completed_total, 'inc').mockImplementation(() => {});

    const res = await request(makeApp()).post('/api/tasks/child-execution').send(BASE);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(coordInstance().failChildTask).toHaveBeenCalledWith('c1', 'boom');
    expect(coordInstance().completeChildTask).not.toHaveBeenCalled();
    expect(inc).toHaveBeenCalledWith({ tenant_id: 't1', status: 'failed' });
  });

  it('short-circuits an in-flight duplicate delivery without mutating the child', async () => {
    executeTask.mockResolvedValue({ success: false, error: 'duplicate_delivery_in_flight' });

    const res = await request(makeApp()).post('/api/tasks/child-execution').send(BASE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deduplicated: true });
    const inst = coordInstance();
    if (inst) {
      expect(inst.completeChildTask).not.toHaveBeenCalled();
      expect(inst.failChildTask).not.toHaveBeenCalled();
    }
  });

  it('500s (Cloud Tasks retry) when executeTask throws', async () => {
    executeTask.mockRejectedValue(new Error('db exploded'));
    const res = await request(makeApp()).post('/api/tasks/child-execution').send(BASE);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db exploded');
  });
});
