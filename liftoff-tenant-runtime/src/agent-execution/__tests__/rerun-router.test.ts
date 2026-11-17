// ADR-030: tests for the "Run again" endpoint guardrails + enqueue.

import request from 'supertest';
import express from 'express';

jest.mock('../../invocations/service', () => ({
  invocationsService: { getRerunSource: jest.fn() },
}));
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: jest.fn().mockResolvedValue({ taskName: 't', scheduleKey: 's', contextRef: null }),
}));

import { rerunRouter } from '../rerun-router';
import { invocationsService } from '../../invocations/service';
import { enqueueAgentExecution } from '../../infrastructure/cloud-tasks';

const getRerunSource = invocationsService.getRerunSource as jest.Mock;
const enqueue = enqueueAgentExecution as jest.Mock;

const TOKEN = 'test-service-token';
const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';
const INV = '00000000-0000-0000-0000-0000000000cc';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/agents', rerunRouter);
  return app;
}

function post() {
  return request(buildApp())
    .post(`/api/internal/agents/${AGENT}/invocations/${INV}/rerun`)
    .set('X-Service-Auth', TOKEN)
    .set('X-Tenant-Id', TENANT);
}

const okSource = {
  id: INV,
  agentId: AGENT,
  triggeredBy: 'cron' as const,
  outcome: 'error' as const,
  parentInvocationId: null,
  replayInput: { objective: 'do the thing', threadId: null, chainDepth: 0 },
};

beforeAll(() => {
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = TOKEN;
});

beforeEach(() => {
  getRerunSource.mockReset();
  enqueue.mockClear();
});

describe('POST /api/internal/agents/:agentId/invocations/:invocationId/rerun', () => {
  it('401 without service auth', async () => {
    const res = await request(buildApp())
      .post(`/api/internal/agents/${AGENT}/invocations/${INV}/rerun`)
      .set('X-Tenant-Id', TENANT);
    expect(res.status).toBe(401);
  });

  it('400 without X-Tenant-Id', async () => {
    const res = await request(buildApp())
      .post(`/api/internal/agents/${AGENT}/invocations/${INV}/rerun`)
      .set('X-Service-Auth', TOKEN);
    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404 when invocation not found', async () => {
    getRerunSource.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('422 when outcome is not error', async () => {
    getRerunSource.mockResolvedValue({ ...okSource, outcome: 'success' });
    const res = await post();
    expect(res.status).toBe(422);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // An escalated run has ENDED, having asked a person to clear something.
  // Retrying once they have is the entire point of the ask, and it was the one
  // outcome the guard refused — 264 of this tenant's escalated runs carried a
  // captured replay_input and could not be re-run.
  it('re-runs an escalated run, which is the case that most obviously wants it', async () => {
    getRerunSource.mockResolvedValue({ ...okSource, outcome: 'escalated' });
    const res = await post();
    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalled();
  });

  // Audit outcome collapses escalated/gated/paused into one value, but the
  // INVOCATION outcome does not, and this guard reads the invocation. A paused
  // or gated run is still live and resumes on its own once a person decides;
  // re-running one would duplicate the work rather than retry it.
  it.each(['paused', 'gated'])('refuses a %s run, which has not ended', async (outcome) => {
    getRerunSource.mockResolvedValue({ ...okSource, outcome });
    const res = await post();
    expect(res.status).toBe(422);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('422 when replay_input is missing', async () => {
    getRerunSource.mockResolvedValue({ ...okSource, replayInput: null });
    const res = await post();
    expect(res.status).toBe(422);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('422 when the run is a delegated child (has parent)', async () => {
    getRerunSource.mockResolvedValue({ ...okSource, parentInvocationId: 'parent-inv' });
    const res = await post();
    expect(res.status).toBe(422);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('422 when triggered_by is human (chat)', async () => {
    getRerunSource.mockResolvedValue({ ...okSource, triggeredBy: 'human' });
    const res = await post();
    expect(res.status).toBe(422);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('422 when triggered_by is agent (delegation/self-scheduled)', async () => {
    getRerunSource.mockResolvedValue({ ...okSource, triggeredBy: 'agent' });
    const res = await post();
    expect(res.status).toBe(422);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('202 for an inbound-webhook run — trigger is threaded so trust is preserved', async () => {
    const trigger = { kind: 'custom_event', trustLevel: 'untrusted_inbound' };
    getRerunSource.mockResolvedValue({
      ...okSource,
      triggeredBy: 'event',
      replayInput: { ...okSource.replayInput, trigger },
    });
    const res = await post();
    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][2]).toEqual(expect.objectContaining({ trigger }));
  });

  it('replays inputData (reactive event payload) verbatim', async () => {
    const inputData = { subscriptionId: 's1', event: { data: { id: 'deal-9' } } };
    getRerunSource.mockResolvedValue({
      ...okSource,
      triggeredBy: 'event',
      replayInput: { ...okSource.replayInput, inputData },
    });
    const res = await post();
    expect(res.status).toBe(202);
    expect(enqueue.mock.calls[0][2]).toEqual(expect.objectContaining({ inputData }));
  });

  it('413 when the replay payload exceeds the Cloud Tasks size budget', async () => {
    getRerunSource.mockResolvedValue({
      ...okSource,
      triggeredBy: 'event',
      replayInput: { ...okSource.replayInput, inputData: { blob: 'x'.repeat(720 * 1024) } },
    });
    const res = await post();
    expect(res.status).toBe(413);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('202 and enqueues a fresh cron re-run with lineage', async () => {
    getRerunSource.mockResolvedValue(okSource);
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [tenantArg, agentArg, opts] = enqueue.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(agentArg).toBe(AGENT);
    expect(opts).toEqual(
      expect.objectContaining({
        objective: 'do the thing',
        triggeredBy: 'cron',
        triggeredByLabel: `rerun_of:${INV}`,
        rerunOfInvocationId: INV,
        contextRef: `rerun-${INV}`,
      }),
    );
  });

  // Clicking "Run again" is a NEW human action, so the person who
  // clicked is this run's trigger. rerun_of_invocation_id carries the lineage
  // back to the run it replaces.
  it('attributes the re-run to the member who clicked', async () => {
    getRerunSource.mockResolvedValue({
      ...okSource,
      replayInput: { ...okSource.replayInput, triggeredByUserId: 'original-scheduler-user' },
    });
    const res = await post().send({ triggeredByUserId: 'clicker-account-1' });
    expect(res.status).toBe(202);
    expect(enqueue.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        triggeredByUserId: 'clicker-account-1',
        rerunOfInvocationId: INV,
      }),
    );
  });

  it('falls back to the replayed attribution when the caller sends none', async () => {
    getRerunSource.mockResolvedValue({
      ...okSource,
      replayInput: { ...okSource.replayInput, triggeredByUserId: 'original-user' },
    });
    const res = await post();
    expect(res.status).toBe(202);
    expect(enqueue.mock.calls[0][2]).toEqual(
      expect.objectContaining({ triggeredByUserId: 'original-user' }),
    );
  });

  it('ignores a non-string triggeredByUserId rather than enqueuing it', async () => {
    getRerunSource.mockResolvedValue(okSource);
    const res = await post().send({ triggeredByUserId: { not: 'a string' } });
    expect(res.status).toBe(202);
    expect(enqueue.mock.calls[0][2]).toEqual(
      expect.objectContaining({ triggeredByUserId: undefined }),
    );
  });

  it('202 for event-triggered runs', async () => {
    getRerunSource.mockResolvedValue({ ...okSource, triggeredBy: 'event' });
    const res = await post();
    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][2]).toEqual(
      expect.objectContaining({ triggeredBy: 'event' }),
    );
  });
});
