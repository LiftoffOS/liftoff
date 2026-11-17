// Stop on a run that can no longer hear it.
//
// The abort signal is read by the engine at a step boundary. A run hung in one
// await never reaches one, so the signal alone left it open forever. When the
// run is already past the stalled-run reconciler's human thresholds, Stop closes
// it with the reconciler's own close; otherwise the signal is the whole answer.

import express from 'express';
import request from 'supertest';

const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const AGENT_ID = '70a549d8-4fe7-4586-923d-b08995c53566';
const THREAD_ID = '2ce701e1-c6ab-45b9-adb0-cc0c2d68fc3d';
const INVOCATION_ID = '32a30744-7d39-4896-85ab-dcd03cfde702';

const order: string[] = [];
const fakePool = {
  query: jest.fn(async (sql: string) => {
    // Liveness is READ from the turn lock now (INV-PB-018), so a Stop reaches the
    // invocations lookup only while something is heartbeating the thread. A run
    // hung in one await — the case this file is about — is still live by that
    // measure: its heartbeat timer is a separate setTimeout and keeps firing while
    // the SDK call blocks, which is exactly why the abort signal, not the lock, is
    // what the engine has to consume.
    if (/FROM chat_turn_locks/i.test(sql)) {
      return { rows: [{ acquired_by_invocation_id: INVOCATION_ID }] };
    }
    if (/FROM invocations/i.test(sql)) return { rows: [{ id: INVOCATION_ID }] };
    if (/INSERT INTO agent_invocation_signals/i.test(sql)) order.push('signal');
    return { rows: [] };
  }),
};

const mockClose = jest.fn();
jest.mock('../../scheduling/stalled-run-reconciler', () => ({
  closeStalledHumanRuns: (...a: unknown[]) => {
    order.push('close');
    return mockClose(...a);
  },
}));
jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => fakePool }));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: jest.fn(async (_t: string, id: string) => id),
  resolveRuntimeAgentIdStrict: jest.fn(async (_t: string, id: string) => id),
  resolveInternalAgentId: jest.fn(async (_t: string, id: string) => id),
}));
jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../startup/schema-check', () => ({ isSchemaReady: () => true }));

import { chatTurnRouter } from '../chat-turn-handler';

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(chatTurnRouter);
  return a;
}
const stop = () => request(app()).post(`/${AGENT_ID}/stop`).send({ tenantId: TENANT_ID, threadId: THREAD_ID });

describe('POST /:agentId/stop falls back to the stalled-run close', () => {
  const prev = process.env.STALLED_RUN_RECONCILER_ENABLED;
  beforeEach(() => {
    order.length = 0;
    mockClose.mockReset();
    process.env.STALLED_RUN_RECONCILER_ENABLED = '1';
  });
  afterAll(() => { process.env.STALLED_RUN_RECONCILER_ENABLED = prev; });

  it('closes a run already past the thresholds, after writing the signal it consumes', async () => {
    mockClose.mockResolvedValue({ closed: 1, idled: 1 });
    const res = await stop();
    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'abort', closedStalledRun: true });
    expect(mockClose).toHaveBeenCalledWith(TENANT_ID, { invocationId: INVOCATION_ID });
    expect(order).toEqual(['signal', 'close']);
  });

  it('leaves a run inside the thresholds to the signal', async () => {
    mockClose.mockResolvedValue({ closed: 0, idled: 0 });
    const res = await stop();
    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'abort' });
  });

  it('a failed close never fails the Stop', async () => {
    mockClose.mockRejectedValue(new Error('db down'));
    const res = await stop();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'abort' });
  });

  it('the bare "stop" message path gets the same fallback', async () => {
    mockClose.mockResolvedValue({ closed: 1, idled: 0 });
    const res = await request(app())
      .post(`/${AGENT_ID}/chat-turn`)
      .send({
        tenantId: TENANT_ID, agentId: AGENT_ID, threadId: THREAD_ID,
        invocationId: '00000000-0000-4000-8000-000000000001',
        channelHint: 'web', userId: 'u1', userDisplayName: 'Tester', userRole: 'member',
        userMessage: 'stop',
      });
    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'abort', closedStalledRun: true });
  });

  it('with the reconciler off, Stop is only the signal', async () => {
    process.env.STALLED_RUN_RECONCILER_ENABLED = '0';
    const res = await stop();
    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'abort' });
    expect(mockClose).not.toHaveBeenCalled();
  });
});
