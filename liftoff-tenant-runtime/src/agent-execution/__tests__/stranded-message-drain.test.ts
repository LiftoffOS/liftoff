// J4 — the stranded-message drain.
//
// The bug: a message sent in the last moments of a run is written as a
// `user_message` signal, the loop finishes before its next boundary check, and
// nobody ever reads the row. The person sent something, saw it accepted, and
// nothing happened. These cover the claim semantics, which are where this can
// go wrong in the expensive direction — answering one message twice.

const query = jest.fn();
const executeTask = jest.fn();
const settleWakeViaCallback = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: (...a: unknown[]) => query(...a) }),
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null),
  settleWakeViaCallback: (...a: unknown[]) => settleWakeViaCallback(...a),
}));

/** The drain is a private method; reach it the way the finalize block does. */
function drain(service: any, input: Record<string, unknown>, invocationId: string, threadId?: string) {
  return service.drainStrandedUserMessages(input, invocationId, threadId);
}

let service: any;

const INPUT = { tenantId: 'tenant-1', agentId: 'agent-1', workflowId: 'wf-1', taskId: 'task-1' };

beforeEach(async () => {
  jest.clearAllMocks();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  settleWakeViaCallback.mockResolvedValue({ delivered: true });

  const mod = await import('../service');
  service = mod.agentExecutionService;
  service.executeTask = executeTask;
  executeTask.mockResolvedValue({ success: true, output: 'here is the answer', toolCallsExecuted: 0, reasoningSteps: 0 });
});

describe('claiming', () => {
  it('marks signals consumed in the same statement that reads them', async () => {
    query.mockResolvedValue({ rows: [{ id: 'sig-1', payload: { text: 'one more thing' } }] });
    await drain(service, INPUT, 'inv-1', 'thread-1');

    const [sql] = query.mock.calls[0];
    // Read-then-update in two statements would let a racing finalize answer the
    // same message twice.
    expect(sql).toMatch(/UPDATE agent_invocation_signals/);
    expect(sql).toMatch(/SET consumed_at = NOW\(\)/);
    expect(sql).toMatch(/consumed_at IS NULL/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('only claims this invocation own signals', async () => {
    query.mockResolvedValue({ rows: [{ id: 'sig-1', payload: { text: 'hi' } }] });
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(query.mock.calls[0][1]).toEqual(['inv-1']);
  });

  it('does nothing when there is no thread to answer into', async () => {
    await drain(service, INPUT, 'inv-1', undefined);
    expect(query).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('does nothing when nothing was stranded', async () => {
    query.mockResolvedValue({ rows: [] });
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('ignores a signal with no text', async () => {
    query.mockResolvedValue({ rows: [{ id: 'sig-1', payload: { text: '   ' } }] });
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(executeTask).not.toHaveBeenCalled();
  });
});

describe('answering', () => {
  beforeEach(() => {
    query.mockResolvedValue({
      rows: [{ id: 'sig-1', payload: { text: 'actually make it blue', senderDisplayName: 'Ada' } }],
    });
  });

  it('runs one continuation carrying the message', async () => {
    await drain(service, INPUT, 'inv-1', 'thread-1');

    expect(executeTask).toHaveBeenCalledTimes(1);
    const call = executeTask.mock.calls[0][0];
    expect(call.objective).toContain('actually make it blue');
    expect(call.threadId).toBe('thread-1');
  });

  it('attributes the sender, so the agent knows who redirected it', async () => {
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(executeTask.mock.calls[0][0].objective).toContain('Ada');
  });

  it('keys the continuation on the invocation, so a replayed finalize does not re-run it', async () => {
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(executeTask.mock.calls[0][0].triggerKey).toBe('stranded:inv-1');
  });

  it('answers several stranded messages in one continuation', async () => {
    query.mockResolvedValue({
      rows: [
        { id: 'sig-1', payload: { text: 'first' } },
        { id: 'sig-2', payload: { text: 'second' } },
      ],
    });
    await drain(service, INPUT, 'inv-1', 'thread-1');

    expect(executeTask).toHaveBeenCalledTimes(1);
    const objective = executeTask.mock.calls[0][0].objective as string;
    expect(objective).toContain('first');
    expect(objective).toContain('second');
  });
});

describe('delivery', () => {
  beforeEach(() => {
    query.mockResolvedValue({ rows: [{ id: 'sig-1', payload: { text: 'one more thing' } }] });
  });

  it('delivers through the surface-agnostic settle path', async () => {
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(settleWakeViaCallback).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1', replyText: 'here is the answer' }),
    );
  });

  it('keys delivery on the signal, so one message is delivered once', async () => {
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(settleWakeViaCallback.mock.calls[0][0].wakeId).toBe('stranded:sig-1');
  });

  it('lets the thread decide the channel rather than asserting one', async () => {
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(settleWakeViaCallback.mock.calls[0][0].channel).toBeNull();
  });

  it('delivers nothing when the continuation produced no reply', async () => {
    executeTask.mockResolvedValue({ success: true, output: '', toolCallsExecuted: 0, reasoningSteps: 0 });
    await drain(service, INPUT, 'inv-1', 'thread-1');
    expect(settleWakeViaCallback).not.toHaveBeenCalled();
  });
});

describe('failure', () => {
  it('never throws when the claim fails', async () => {
    query.mockRejectedValue(new Error('db down'));
    await expect(drain(service, INPUT, 'inv-1', 'thread-1')).resolves.toBeUndefined();
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('never throws when the continuation fails', async () => {
    query.mockResolvedValue({ rows: [{ id: 'sig-1', payload: { text: 'hi' } }] });
    executeTask.mockRejectedValue(new Error('engine unavailable'));
    await expect(drain(service, INPUT, 'inv-1', 'thread-1')).resolves.toBeUndefined();
  });

  it('never throws when delivery fails', async () => {
    query.mockResolvedValue({ rows: [{ id: 'sig-1', payload: { text: 'hi' } }] });
    settleWakeViaCallback.mockRejectedValue(new Error('platform unreachable'));
    await expect(drain(service, INPUT, 'inv-1', 'thread-1')).resolves.toBeUndefined();
  });
});
