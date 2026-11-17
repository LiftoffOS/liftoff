// Defer-on-contention unit tests (plan: "Fix: inbound connector events silently
// dropped on per-agent lock contention").
//
// executeTask() funnels every inbound run through executeTaskInner, which takes a
// per-agent row lock. On contention it returns { error: 'agent_already_running' }.
// When the caller passed onConflict:'defer' + a triggerKey, executeTask must
// durably re-enqueue the run via Cloud Tasks (deferOnContention) instead of
// dropping it. These tests exercise that branch by mocking the run-idempotency
// ledger, the Cloud Tasks primitive, and the metrics sink, and by forcing
// executeTaskInner to report lock contention.

import { createHash } from 'crypto';

const mockClaim = jest.fn();
const mockComplete = jest.fn();
const mockFail = jest.fn();
jest.mock('../run-idempotency', () => ({
  claimAgentRun: (...a: unknown[]) => mockClaim(...a),
  completeAgentRun: (...a: unknown[]) => mockComplete(...a),
  failAgentRun: (...a: unknown[]) => mockFail(...a),
}));

const mockEnqueue = jest.fn();
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: (...a: unknown[]) => mockEnqueue(...a),
}));

const mockIncCounter = jest.fn();
jest.mock('../../memory/metrics', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { agentExecutionService } from '../service';
import type { ExecuteTaskInput, TaskExecutionResult } from '../types';

const CONTENDED: TaskExecutionResult = {
  success: false,
  error: 'agent_already_running',
  toolCallsExecuted: 0,
  reasoningSteps: 0,
};

const tenantId = '11111111-1111-1111-1111-111111111111';
const agentId = '22222222-2222-2222-2222-222222222222';
const triggerKey = 'evt:e1:22222222-2222-2222-2222-222222222222';

function baseInput(overrides: Partial<ExecuteTaskInput> = {}): ExecuteTaskInput {
  return {
    tenantId,
    agentId,
    workflowId: '33333333-3333-3333-3333-333333333333',
    taskId: '44444444-4444-4444-4444-444444444444',
    objective: 'Process incoming event',
    triggerKey,
    ...overrides,
  };
}

beforeEach(() => {
  mockClaim.mockReset().mockResolvedValue({ outcome: 'run' });
  mockComplete.mockReset().mockResolvedValue(undefined);
  mockFail.mockReset().mockResolvedValue(undefined);
  mockEnqueue.mockReset().mockResolvedValue({ taskName: 't', scheduleKey: 'defer-1', contextRef: null });
  mockIncCounter.mockReset();
  // jest.config sets restoreMocks:true, which restores spies before every test —
  // so the executeTaskInner spy must be (re)installed here, not in beforeAll.
  // Default: the inner run loses the per-agent lock.
  jest.spyOn(agentExecutionService as unknown as { executeTaskInner: unknown }, 'executeTaskInner')
    .mockResolvedValue(CONTENDED);
});

describe('deferOnContention', () => {
  it('defers a first-generation contended run via Cloud Tasks and returns deferred:true', async () => {
    const res = await agentExecutionService.executeTask(baseInput({ onConflict: 'defer', inputData: { foo: 'bar' } }));

    expect(res.deferred).toBe(true);
    expect(res.error).toBe('deferred');
    expect(res.success).toBe(false);

    // Ledger reset FIRST so the re-enqueued retry can reclaim the row.
    expect(mockFail).toHaveBeenCalledWith({ tenantId, triggerKey, error: 'deferred_lock_contention' });

    // Re-enqueued to the dedicated receiver, carrying the full payload.
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [enqTenant, enqAgent, opts] = mockEnqueue.mock.calls[0];
    expect(enqTenant).toBe(tenantId);
    expect(enqAgent).toBe(agentId);
    expect(opts.receiverPath).toBe('/api/tasks/deferred-execution');
    expect(opts.scheduleKey).toBe('defer-1');
    // contextRef is the collision-safe, bounded hash of the triggerKey.
    expect(opts.contextRef).toBe(createHash('sha256').update(triggerKey).digest('hex').slice(0, 16));
    expect(opts.scheduleTime).toBeInstanceOf(Date);
    expect(opts.receiverBody.deferAttempt).toBe(1);
    expect(opts.receiverBody.onConflict).toBe('defer');
    expect(opts.receiverBody.triggerKey).toBe(triggerKey);
    expect(opts.receiverBody.inputData).toEqual({ foo: 'bar' });

    expect(mockIncCounter).toHaveBeenCalledWith(
      'event_execution_deferred_total',
    );
    // NOT dead-lettered.
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('increments the defer generation on each re-enqueue (deferAttempt n → n+1)', async () => {
    await agentExecutionService.executeTask(baseInput({ onConflict: 'defer', deferAttempt: 4 }));
    const opts = mockEnqueue.mock.calls[0][2];
    expect(opts.receiverBody.deferAttempt).toBe(5);
    expect(opts.scheduleKey).toBe('defer-5');
  });

  it('dead-letters loudly once the defer budget is exhausted (no enqueue)', async () => {
    // MAX_DEFER_ATTEMPTS = 15 → an incoming attempt of 15 becomes 16 > max.
    const res = await agentExecutionService.executeTask(baseInput({ onConflict: 'defer', deferAttempt: 15 }));

    expect(res.error).toBe('dropped_after_max_defer');
    expect(res.deferred).toBeUndefined();

    // Terminal so no stale-reclaim loop, and surfaced via a metric + error log.
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, triggerKey, result: expect.objectContaining({ error: 'agent_already_running' }) }),
    );
    expect(mockIncCounter).toHaveBeenCalledWith(
      'event_execution_dropped_total',
    );
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('surfaces a Cloud Tasks enqueue failure loudly (metric) and does not report deferred', async () => {
    mockEnqueue.mockRejectedValue(new Error('cloud tasks unavailable'));

    const res = await agentExecutionService.executeTask(baseInput({ onConflict: 'defer' }));

    expect(res.error).toBe('defer_enqueue_failed');
    expect(res.deferred).toBeUndefined();
    expect(mockIncCounter).toHaveBeenCalledWith(
      'event_execution_defer_enqueue_failed_total',
    );
    // The deferred metric must NOT fire on the failure path.
    expect(mockIncCounter).not.toHaveBeenCalledWith('event_execution_deferred_total', expect.anything());
  });

  it('refuses to enqueue an over-budget payload and surfaces it loudly instead of silently dropping', async () => {
    // Push the receiverBody past the 700 KB raw-JSON guard.
    const bigInputData = { blob: 'x'.repeat(800 * 1024) };

    const res = await agentExecutionService.executeTask(baseInput({ onConflict: 'defer', inputData: bigInputData }));

    expect(res.error).toBe('defer_payload_too_large');
    expect(res.deferred).toBeUndefined();
    expect(mockIncCounter).toHaveBeenCalledWith(
      'event_execution_defer_payload_too_large_total',
    );
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('leaves the interactive path unchanged when onConflict is unset (returns agent_already_running, no defer)', async () => {
    const res = await agentExecutionService.executeTask(baseInput()); // no onConflict

    expect(res.error).toBe('agent_already_running');
    expect(res.deferred).toBeUndefined();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockIncCounter).not.toHaveBeenCalledWith('event_execution_deferred_total', expect.anything());
    // The generic run-level ledger still records the failed run for retry.
    expect(mockFail).toHaveBeenCalledWith({ tenantId, triggerKey, error: 'agent_already_running' });
  });
});
