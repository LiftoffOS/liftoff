// An escalated run has to land somewhere a person can find it.
//
// It is deliberately not in the /review queue: that queue holds work which
// resumes when someone answers it, and an escalated run has already ended.
// Before this, the Slack DM was the only delivery in existence — miss it and
// there was no screen anywhere to go and look, and the DM itself carried no
// link because there was nothing honest to point at.
//
// These pin the two halves that fix it: the chat thread is opened, and its id
// reaches the notification so the DM can link to it.

jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn() },
}));
jest.mock('../../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../evidence-totals', () => ({
  recordEscalationRaised: jest.fn(),
}));

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

const openEscalationThread = jest.fn();
const enqueueEscalationNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null),
  openEscalationThread: (...a: unknown[]) => openEscalationThread(...a),
  enqueueEscalationNotification: (...a: unknown[]) => enqueueEscalationNotification(...a),
}));

const resolveInternalAgentId = jest.fn();
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => resolveInternalAgentId(...a),
}));

import { createEscalation, escalationThreadTitle } from '../engine/escalation-helper';

const INTERNAL_AGENT = '11111111-1111-1111-1111-111111111111';
const CHAT_THREAD = '22222222-2222-2222-2222-222222222222';

const baseCtx = {
  tenantId: '33333333-3333-3333-3333-333333333333',
  agentId: '44444444-4444-4444-4444-444444444444',
  workflowId: 'w',
  taskId: 'k',
  instructionVersion: 0,
  instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' },
  traceId: 'tr',
  agentType: 'agent' as const,
  hitlLevel: 3,
  modelConfig: {},
  execConfig: {},
  memoryScope: {},
  threadId: '55555555-5555-5555-5555-555555555555',
  invocationId: '66666666-6666-6666-6666-666666666666',
} as never;

beforeEach(() => {
  mockQuery.mockClear();
  openEscalationThread.mockReset().mockResolvedValue(CHAT_THREAD);
  enqueueEscalationNotification.mockClear();
  resolveInternalAgentId.mockReset().mockResolvedValue(INTERNAL_AGENT);
});

describe('an escalation opens a chat thread', () => {
  it('writes the blocker into chat, addressed by the control-plane agent id', async () => {
    await createEscalation(baseCtx, 'Grant the service account access to the sheet.');

    expect(openEscalationThread).toHaveBeenCalledTimes(1);
    const arg = openEscalationThread.mock.calls[0][0];
    // A runtime agents.id addresses nothing in the control plane, so sending
    // one would attach the message to no team at all (INV-TR-010).
    expect(arg.internalAgentId).toBe(INTERNAL_AGENT);
    expect(arg.reason).toBe('Grant the service account access to the sheet.');
  });

  it('hands the thread id to the notification, so the DM has somewhere to point', async () => {
    await createEscalation(baseCtx, 'Reconnect the GitHub account.');

    expect(enqueueEscalationNotification).toHaveBeenCalledTimes(1);
    expect(enqueueEscalationNotification.mock.calls[0][0].chatThreadId).toBe(CHAT_THREAD);
  });

  it('opens the thread before announcing it, or the link would always be missing', async () => {
    const order: string[] = [];
    openEscalationThread.mockImplementation(async () => { order.push('thread'); return CHAT_THREAD; });
    enqueueEscalationNotification.mockImplementation(async () => { order.push('notify'); });

    await createEscalation(baseCtx, 'Unpause the team.');

    expect(order).toEqual(['thread', 'notify']);
  });

  // The chat thread is the second delivery, not the only one. A failure here
  // must cost the link and nothing else.
  it('still notifies when the chat thread cannot be opened', async () => {
    openEscalationThread.mockRejectedValue(new Error('platform unreachable'));

    await createEscalation(baseCtx, 'Fix the connector.');

    expect(enqueueEscalationNotification).toHaveBeenCalledTimes(1);
    expect(enqueueEscalationNotification.mock.calls[0][0].chatThreadId).toBeNull();
  });

  // Operator-only records are not a person's to-do list; they get no SSE and no
  // notification, so they must get no chat thread either.
  it('opens nothing for a system_internal record', async () => {
    await createEscalation(baseCtx, 'Provider unreachable.', { kind: 'system_internal' });

    expect(openEscalationThread).not.toHaveBeenCalled();
    expect(enqueueEscalationNotification).not.toHaveBeenCalled();
  });

  // Without the control-plane id PB has no team to attach the message to.
  it('skips the thread when the agent id cannot be translated', async () => {
    resolveInternalAgentId.mockResolvedValue(null);

    await createEscalation(baseCtx, 'Something broke.');

    expect(openEscalationThread).not.toHaveBeenCalled();
    expect(enqueueEscalationNotification).toHaveBeenCalledTimes(1);
  });
});

describe('escalationThreadTitle', () => {
  it('takes the first line, so a list of escalations is readable without opening each', () => {
    expect(escalationThreadTitle('Grant access to the sheet.\n\nThe run failed at step 3.'))
      .toBe('Grant access to the sheet.');
  });

  it('strips markdown, because a title is plain text', () => {
    expect(escalationThreadTitle('**Reconnect** the `github` account'))
      .toBe('Reconnect the github account');
  });

  it('renders a link as its text rather than its target', () => {
    expect(escalationThreadTitle('Delete rows in [the sheet](https://example.com/x)'))
      .toBe('Delete rows in the sheet');
  });

  it('truncates rather than letting one blocker fill the list', () => {
    const title = escalationThreadTitle('x'.repeat(200));
    expect(title).toHaveLength(80);
    expect(title?.endsWith('...')).toBe(true);
  });

  it('returns null for blank text rather than an empty title', () => {
    expect(escalationThreadTitle('   \n  ')).toBeNull();
  });
});
