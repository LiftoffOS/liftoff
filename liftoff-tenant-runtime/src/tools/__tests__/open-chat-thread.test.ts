// `open_chat_thread` — a team with no connector still has somewhere to deliver.
//
// It rides the machinery escalation already uses, and differs in the one way
// that matters: escalation is a terminal marker that ends the run and stamps
// status='escalated', which the reflection engine counts as a run that got
// stuck. A delivered checklist is neither stuck nor finished-with-the-run, so
// this is a tool a graph dispatches mid-workflow, labelled 'delivery'.

const openEscalationThread = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null),
  openEscalationThread: (...a: unknown[]) => openEscalationThread(...a),
}));

const resolveInternalAgentId = jest.fn();
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => resolveInternalAgentId(...a),
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPoolForService: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'ten-1', agentId: 'runtime-agent-1',
  memoryScope: { readableLayers: [], writableLayers: [] },
  traceId: 'tr-1', invocationId: 'inv-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  resolveInternalAgentId.mockResolvedValue('cp-agent-1');
  openEscalationThread.mockResolvedValue('thread-abc');
});

const call = (input: Record<string, unknown>) => executeStandardTool('open_chat_thread', input, ctx);

it('delivers the message and returns the thread', async () => {
  const r = await call({ title: 'NDA review: Acme', body: 'Mutual, 3 years, no flags.' });
  expect(r?.success).toBe(true);
  expect(r?.result).toMatchObject({ threadId: 'thread-abc', delivered: true });
});

it("labels it a delivery, never an escalation", async () => {
  // Escalation counts are read as runs that got stuck. A delivered review is
  // not one, and sharing the label would quietly corrupt that number.
  await call({ body: 'done' });
  expect(openEscalationThread).toHaveBeenCalledWith(expect.objectContaining({ kind: 'delivery' }));
});

it('addresses the CONTROL-PLANE agent id, which is the only one PB can attach to', async () => {
  await call({ body: 'done' });
  expect(openEscalationThread).toHaveBeenCalledWith(
    expect.objectContaining({ internalAgentId: 'cp-agent-1' }),
  );
});

it('refuses when the team has no control-plane id rather than posting nowhere', async () => {
  resolveInternalAgentId.mockResolvedValue(null);
  const r = await call({ body: 'done' });
  expect(r?.success).toBe(false);
  expect(openEscalationThread).not.toHaveBeenCalled();
});

it('rejects an empty body, since a thread with no message is worse than none', async () => {
  const r = await call({ title: 'x' });
  expect(r?.success).toBe(false);
  expect(r?.error).toMatch(/requires "body"/);
});

it('is idempotent on content, so a retried step does not open a second thread', async () => {
  await call({ title: 't', body: 'same' });
  const first = openEscalationThread.mock.calls[0][0].escalationId;
  jest.clearAllMocks();
  openEscalationThread.mockResolvedValue('thread-abc');
  resolveInternalAgentId.mockResolvedValue('cp-agent-1');
  await call({ title: 't', body: 'same' });
  expect(openEscalationThread.mock.calls[0][0].escalationId).toBe(first);
});

it('gives different content its own thread', async () => {
  await call({ body: 'first' });
  const a = openEscalationThread.mock.calls[0][0].escalationId;
  await call({ body: 'second' });
  const b = openEscalationThread.mock.calls[1][0].escalationId;
  expect(a).not.toBe(b);
});

it('reports a callback failure rather than claiming delivery', async () => {
  openEscalationThread.mockRejectedValue(new Error('platform down'));
  const r = await call({ body: 'done' });
  expect(r?.success).toBe(false);
});

describe('the id this sends is one the control plane can accept', () => {
  // The whole tool failed on this and nothing caught it. The control plane
  // validates `escalationId` as a UUID and stores it as the message's turn_id,
  // a uuid column; this sent a 32-character hash. Every call it ever made
  // returned HTTP 400 -- the tool existed, distillation emitted it, workflows
  // dispatched it as a step, and it could not succeed.
  //
  // The old test asserted the id was STABLE and never that it was VALID,
  // because it mocks the callback: both sides were tested and the contract
  // between them was not.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('sends a well-formed UUID, version and variant included', async () => {
    await call({ title: 'Weekly digest', body: 'Here is this week.' });
    expect(openEscalationThread.mock.calls[0][0].escalationId).toMatch(UUID);
  });

  it('is still the same id for the same delivery', async () => {
    // The property the hash was chosen for: a retried step lands on the thread
    // it already opened rather than opening a second one saying the same thing.
    await call({ title: 'Weekly digest', body: 'Here is this week.' });
    await call({ title: 'Weekly digest', body: 'Here is this week.' });
    const [a, b] = openEscalationThread.mock.calls.map((c) => c[0].escalationId);
    expect(a).toBe(b);
  });

  it('is a different id for a different delivery', async () => {
    await call({ title: 'Weekly digest', body: 'Week one.' });
    await call({ title: 'Weekly digest', body: 'Week two.' });
    const [a, b] = openEscalationThread.mock.calls.map((c) => c[0].escalationId);
    expect(a).not.toBe(b);
  });
});
