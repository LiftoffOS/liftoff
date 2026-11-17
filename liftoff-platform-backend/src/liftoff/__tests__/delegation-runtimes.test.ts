// The four runtimes behind one interface.
//
// One relay drives every colleague, so what these tests are really checking
// is that each adapter presents the same shape over very different
// mechanisms: an HTTP stream in another service, two in-process generators
// with their own locks, and an in-process generator that itself fronts
// another service.
//
// Everything below the adapter is mocked at its module boundary, including the
// workforce wire, so nothing here touches the network.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreatePairedTeamPlanThread = jest.fn();
const mockStreamCAIOTurn = jest.fn();
const mockRequestCAIOTurnStop = jest.fn();
jest.mock('../caio-delegation', () => ({
  createPairedTeamPlanThread: (...a: unknown[]) => mockCreatePairedTeamPlanThread(...a),
  streamCAIOTurn: (...a: unknown[]) => mockStreamCAIOTurn(...a),
  requestCAIOTurnStop: (...a: unknown[]) => mockRequestCAIOTurnStop(...a),
}));

const mockCreateInsightsThread = jest.fn();
jest.mock('../../insights/chat-repository', () => ({
  createThread: (...a: unknown[]) => mockCreateInsightsThread(...a),
}));

const mockRunInsightsChatTurn = jest.fn();
jest.mock('../../insights/chat-service', () => ({
  runInsightsChatTurn: (...a: unknown[]) => mockRunInsightsChatTurn(...a),
}));

const mockAcquireInsightsLock = jest.fn();
const mockReleaseInsightsLock = jest.fn();
const mockInsertInsightsSignal = jest.fn();
jest.mock('../../insights/turn-control', () => ({
  newTurnId: () => 'insights-turn-1',
  tryAcquireTurnLock: (...a: unknown[]) => mockAcquireInsightsLock(...a),
  releaseTurnLock: (...a: unknown[]) => mockReleaseInsightsLock(...a),
  insertTurnSignal: (...a: unknown[]) => mockInsertInsightsSignal(...a),
}));

const mockCreateLiftoffThread = jest.fn();
jest.mock('../chat-repository', () => ({
  createThread: (...a: unknown[]) => mockCreateLiftoffThread(...a),
}));

const mockRunLiftoffChatTurn = jest.fn();
jest.mock('../chat-service', () => ({
  runLiftoffChatTurn: (...a: unknown[]) => mockRunLiftoffChatTurn(...a),
}));

const mockAcquireLiftoffLock = jest.fn();
const mockReleaseLiftoffLock = jest.fn();
const mockInsertLiftoffSignal = jest.fn();
jest.mock('../turn-control', () => ({
  newTurnId: () => 'turn-1',
  tryAcquireTurnLock: (...a: unknown[]) => mockAcquireLiftoffLock(...a),
  releaseTurnLock: (...a: unknown[]) => mockReleaseLiftoffLock(...a),
  insertTurnSignal: (...a: unknown[]) => mockInsertLiftoffSignal(...a),
}));

const mockCheckChatAdmission = jest.fn();
jest.mock('../../agent-chat/admission', () => ({
  checkChatAdmission: (...a: unknown[]) => mockCheckChatAdmission(...a),
}));

const mockRunAgentChatTurn = jest.fn();
jest.mock('../../agent-chat/chat-service', () => ({
  runAgentChatTurn: (...a: unknown[]) => mockRunAgentChatTurn(...a),
}));

const mockCreateAgentChatThread = jest.fn();
const mockAddParticipant = jest.fn();
jest.mock('../../agent-chat/chat-repository', () => ({
  createThread: (...a: unknown[]) => mockCreateAgentChatThread(...a),
  addParticipant: (...a: unknown[]) => mockAddParticipant(...a),
}));

const mockSignalStopChatTurn = jest.fn();
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    signalStopChatTurn: (...a: unknown[]) => mockSignalStopChatTurn(...a),
  },
}));

import {
  createDelegateRuntime,
  type DelegatedEvent,
  type DelegationCaller,
} from '../delegation-runtimes';
import type { DelegationTarget } from '../delegation-targets';

const CALLER: DelegationCaller = {
  tenantId: 'tenant-1',
  accountId: 'account-1',
  // Deliberately not an owner: a role that was widened anywhere shows up here.
  role: 'viewer',
  displayName: 'Dana Reyes',
};

const CAIO: DelegationTarget = {
  kind: 'caio',
  id: 'caio',
  label: 'Chief AI Officer',
  description: '',
};
const INSIGHTS: DelegationTarget = {
  kind: 'insights',
  id: 'insights',
  label: 'Insights Manager',
  description: '',
};
const LIFTOFF: DelegationTarget = {
  kind: 'liftoff',
  id: 'liftoff',
  label: 'Liftoff',
  description: '',
};
const TEAM: DelegationTarget = {
  kind: 'team',
  id: 'team-uuid',
  label: 'Payroll Operations',
  description: '',
};

function iterableOf<T>(events: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

async function collect(iter: AsyncIterable<DelegatedEvent>): Promise<DelegatedEvent[]> {
  const out: DelegatedEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAcquireInsightsLock.mockResolvedValue({
    tenantId: 'tenant-1',
    threadId: 'insights-thread',
    turnId: 'insights-turn-1',
    abortController: new AbortController(),
    heartbeatTask: null,
    consecutiveFailures: 0,
    released: false,
  });
  mockReleaseInsightsLock.mockResolvedValue(undefined);
  mockInsertInsightsSignal.mockResolvedValue('delivered');
  mockCheckChatAdmission.mockResolvedValue({ allowed: true });
  mockSignalStopChatTurn.mockResolvedValue({ acknowledged: true, deliveredAs: 'abort' });
});

describe('the Chief AI Officer runtime', () => {
  it('creates the paired thread with the caller\'s real role', async () => {
    mockCreatePairedTeamPlanThread.mockResolvedValue('team-plan-thread');

    const runtime = createDelegateRuntime(CAIO, CALLER);
    await expect(runtime.createThread()).resolves.toBe('team-plan-thread');

    expect(mockCreatePairedTeamPlanThread).toHaveBeenCalledWith({
      caller: { tenantId: 'tenant-1', accountId: 'account-1', role: 'viewer', displayName: 'Dana Reyes' },
    });
  });

  it('normalises its stream, carrying the persisted reply and its blocks', async () => {
    mockStreamCAIOTurn.mockReturnValue(
      iterableOf([
        { type: 'thinking' },
        { type: 'text_delta', text: 'Drafting.' },
        { type: 'content_block', block: { type: 'org_chart' } },
        {
          type: 'complete',
          message: {
            content: 'Drafting.',
            visualizationBlocks: [{ type: 'org_chart' }],
            inputTokens: 11,
            outputTokens: 22,
          },
        },
      ]),
    );

    const runtime = createDelegateRuntime(CAIO, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'team-plan-thread', content: 'hello' }),
    );

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text_delta', text: 'Drafting.' },
      { type: 'content_block', block: { type: 'org_chart' } },
      {
        type: 'complete',
        text: 'Drafting.',
        blocks: [{ type: 'org_chart' }],
        inputTokens: 11,
        outputTokens: 22,
        answeredBy: null,
      },
    ]);
  });

  it('hands the person\'s name to workforce with the caller', async () => {
    mockStreamCAIOTurn.mockReturnValue(iterableOf([{ type: 'complete', message: null }]));
    await collect(createDelegateRuntime(CAIO, CALLER).runTurn({
      delegateThreadId: 'team-plan-thread', content: 'hello', forwardedContext: null,
    }));
    expect(mockStreamCAIOTurn).toHaveBeenCalledWith(expect.objectContaining({
      caller: { tenantId: 'tenant-1', accountId: 'account-1', role: 'viewer', displayName: 'Dana Reyes' },
    }));
  });

  it('tells workforce this is a hand-over, and who forwarded the note', async () => {
    mockStreamCAIOTurn.mockReturnValue(iterableOf([{ type: 'complete', message: null }]));

    const runtime = createDelegateRuntime(CAIO, { ...CALLER, asColleague: true });
    await collect(runtime.runTurn({
      delegateThreadId: 'team-plan-thread',
      content: 'pause it',
      forwardedContext: 'note',
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
    }));

    expect(mockStreamCAIOTurn).toHaveBeenCalledWith(expect.objectContaining({
      forwardedContext: 'note',
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
      handover: true,
    }));

    // Not a hand-over: the flag is off, so the Chief AI Officer keeps its own
    // colleagues on its own surface.
    mockStreamCAIOTurn.mockClear();
    mockStreamCAIOTurn.mockReturnValue(iterableOf([{ type: 'complete', message: null }]));
    await collect(createDelegateRuntime(CAIO, CALLER).runTurn({
      delegateThreadId: 'team-plan-thread',
      content: 'hello',
      forwardedContext: null,
    }));
    expect(mockStreamCAIOTurn).toHaveBeenCalledWith(expect.objectContaining({
      forwardedBy: null,
      handover: false,
    }));
  });

  it('names who answered when the Chief AI Officer handed its own turn on', async () => {
    mockStreamCAIOTurn.mockReturnValue(
      iterableOf([
        { type: 'delegation_started', author: 'insights', authorLabel: 'Insights Manager' },
        { type: 'text_delta', text: 'Twelve.' },
        {
          type: 'complete',
          message: {
            content: 'Twelve.',
            visualizationBlocks: null,
            inputTokens: 1,
            outputTokens: 2,
            messageType: 'colleague',
            contributors: [{ id: 'insights', label: 'Insights Manager' }],
          },
        },
      ]),
    );

    const events = await collect(
      createDelegateRuntime(CAIO, CALLER).runTurn({ delegateThreadId: 'tp', content: 'how many' }),
    );
    // The live frame has no counterpart here; the answer is read off the row.
    expect(events).toEqual([
      { type: 'text_delta', text: 'Twelve.' },
      {
        type: 'complete', text: 'Twelve.', blocks: null, inputTokens: 1, outputTokens: 2,
        answeredBy: 'Insights Manager',
      },
    ]);
  });

  it('turns a pause of the colleague it brought in into a pause', async () => {
    mockStreamCAIOTurn.mockReturnValue(
      iterableOf([
        { type: 'delegation_paused', author: 'liftoff', authorLabel: 'Liftoff', reason: 'Liftoff is waiting.' },
      ]),
    );
    const events = await collect(
      createDelegateRuntime(CAIO, CALLER).runTurn({ delegateThreadId: 'tp', content: 'go' }),
    );
    expect(events).toEqual([{ type: 'paused', reason: 'Liftoff is waiting.' }]);
  });

  it('reports a turn already running as busy rather than as a failure', async () => {
    mockStreamCAIOTurn.mockReturnValue(iterableOf([{ type: 'busy' }]));

    const runtime = createDelegateRuntime(CAIO, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'team-plan-thread', content: 'hello' }),
    );

    expect(events).toEqual([{ type: 'busy' }]);
  });

  it('stops the turn through workforce, not by dropping the stream', async () => {
    mockRequestCAIOTurnStop.mockResolvedValue(undefined);

    const runtime = createDelegateRuntime(CAIO, CALLER);
    await runtime.requestStop({ delegateThreadId: 'team-plan-thread' });

    expect(mockRequestCAIOTurnStop).toHaveBeenCalledWith({
      caller: { tenantId: 'tenant-1', accountId: 'account-1', role: 'viewer', displayName: 'Dana Reyes' },
      workforceThreadId: 'team-plan-thread',
    });
  });
});

describe('the Insights Manager runtime', () => {
  it('hands the caller\'s origin to the insights turn, so its actions say where they came from', async () => {
    mockRunInsightsChatTurn.mockReturnValue(
      iterableOf([{ type: 'complete', message: { content: 'ok', visualizationBlocks: null, inputTokens: 1, outputTokens: 1 } }]),
    );
    const origin = { via: 'slack' as const, client: 'T1', credentialId: '' };
    const runtime = createDelegateRuntime(INSIGHTS, { ...CALLER, origin });
    await collect(runtime.runTurn({ delegateThreadId: 'insights-thread', content: 'how much did we spend' }));
    expect(mockRunInsightsChatTurn).toHaveBeenCalledWith(expect.objectContaining({ origin }));
  });

  it('takes the insights thread\'s own lock and hands its turn id to the runner', async () => {
    mockRunInsightsChatTurn.mockReturnValue(
      iterableOf([
        { type: 'text_delta', text: 'Spend is down.' },
        {
          type: 'complete',
          message: {
            content: 'Spend is down.',
            visualizationBlocks: [{ type: 'bar_chart' }],
            inputTokens: 5,
            outputTokens: 6,
          },
        },
      ]),
    );

    const runtime = createDelegateRuntime(INSIGHTS, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'insights-thread', content: 'how much did we spend' }),
    );

    expect(mockAcquireInsightsLock).toHaveBeenCalledWith(
      'tenant-1',
      'insights-thread',
      'insights-turn-1',
    );
    expect(mockRunInsightsChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'insights-thread',
        tenantId: 'tenant-1',
        accountId: 'account-1',
        role: 'viewer',
        callerName: 'Dana Reyes',
        turnId: 'insights-turn-1',
      }),
    );
    expect(events.at(-1)).toEqual({
      type: 'complete',
      text: 'Spend is down.',
      blocks: [{ type: 'bar_chart' }],
      inputTokens: 5,
      outputTokens: 6,
      answeredBy: null,
    });
    // The lock is always given back, or that thread looks busy for 20 minutes.
    expect(mockReleaseInsightsLock).toHaveBeenCalledTimes(1);
  });

  it('hands the colleague flag and the forwarder to the insights turn', async () => {
    mockAcquireInsightsLock.mockResolvedValue({ turnId: 'insights-turn-1', abortController: new AbortController() });
    mockRunInsightsChatTurn.mockReturnValue(iterableOf([{ type: 'complete', message: null }]));

    await collect(createDelegateRuntime(INSIGHTS, { ...CALLER, asColleague: true }).runTurn({
      delegateThreadId: 'insights-thread',
      content: 'how many runs',
      forwardedContext: 'note',
      forwardedBy: { id: 'caio', label: 'Chief AI Officer' },
    }));
    expect(mockRunInsightsChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      forwardedContext: 'note',
      forwardedBy: { id: 'caio', label: 'Chief AI Officer' },
      asColleague: true,
    }));

    // Not a hand-over: the key is absent rather than false, exactly like
    // toolMode, so the turn is offered everything.
    mockRunInsightsChatTurn.mockClear();
    mockRunInsightsChatTurn.mockReturnValue(iterableOf([{ type: 'complete', message: null }]));
    await collect(createDelegateRuntime(INSIGHTS, CALLER).runTurn({
      delegateThreadId: 'insights-thread',
      content: 'hi',
      forwardedContext: null,
    }));
    expect(mockRunInsightsChatTurn.mock.calls[0][0]).not.toHaveProperty('asColleague');
    expect(mockRunInsightsChatTurn.mock.calls[0][0]).toHaveProperty('forwardedBy', null);
  });

  it('names who answered when the Insights Manager handed its own turn on', async () => {
    mockAcquireInsightsLock.mockResolvedValue({ turnId: 'insights-turn-1', abortController: new AbortController() });
    mockRunInsightsChatTurn.mockReturnValue(
      iterableOf([
        { type: 'delegation_started', author: 'caio', authorLabel: 'Chief AI Officer' },
        {
          type: 'complete',
          message: {
            content: 'Paused.',
            visualizationBlocks: null,
            inputTokens: 1,
            outputTokens: 2,
            messageType: 'colleague',
            contributors: [{ id: 'caio', label: 'Chief AI Officer' }],
          },
        },
      ]),
    );
    const events = await collect(
      createDelegateRuntime(INSIGHTS, CALLER).runTurn({ delegateThreadId: 'insights-thread', content: 'pause it' }),
    );
    expect(events).toEqual([
      { type: 'complete', text: 'Paused.', blocks: null, inputTokens: 1, outputTokens: 2, answeredBy: 'Chief AI Officer' },
    ]);
  });

  it('reports busy when somebody else already holds that thread', async () => {
    mockAcquireInsightsLock.mockResolvedValue(null);

    const runtime = createDelegateRuntime(INSIGHTS, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'insights-thread', content: 'hi' }),
    );

    expect(events).toEqual([{ type: 'busy' }]);
    expect(mockRunInsightsChatTurn).not.toHaveBeenCalled();
  });

  it('stops it with a signal row, never by aborting the handle', async () => {
    // The runner tells the two apart: a claimed signal is a clean stop that
    // keeps what it had written, an unclaimed abort is a lost lock and reports
    // itself as an interruption the person did not cause.
    mockRunInsightsChatTurn.mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', text: 'Working' };
        await new Promise((resolve) => setImmediate(resolve));
        yield { type: 'complete', message: null };
      })(),
    );

    const runtime = createDelegateRuntime(INSIGHTS, CALLER);
    const running = collect(
      runtime.runTurn({ delegateThreadId: 'insights-thread', content: 'hi' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await runtime.requestStop({ delegateThreadId: 'insights-thread' });
    await running;

    expect(mockInsertInsightsSignal).toHaveBeenCalledWith(
      'tenant-1',
      'insights-turn-1',
      'abort',
      expect.objectContaining({ senderAccountId: 'account-1' }),
    );
  });

  it('has nothing to stop before a turn has started', async () => {
    const runtime = createDelegateRuntime(INSIGHTS, CALLER);
    await runtime.requestStop({ delegateThreadId: 'insights-thread' });

    expect(mockInsertInsightsSignal).not.toHaveBeenCalled();
  });
});

describe('the Liftoff runtime', () => {
  it('creates the paired thread on Liftoff\'s own table', async () => {
    mockCreateLiftoffThread.mockResolvedValue({ id: 'thread' });

    const runtime = createDelegateRuntime(LIFTOFF, CALLER);
    await expect(runtime.createThread()).resolves.toBe('thread');

    expect(mockCreateLiftoffThread).toHaveBeenCalledWith({ tenantId: 'tenant-1', accountId: 'account-1' });
  });

  it('takes Liftoff\'s own lock, runs the turn as a colleague and gives the lock back', async () => {
    const abortController = new AbortController();
    mockAcquireLiftoffLock.mockResolvedValue({ turnId: 'turn-1', abortController });
    mockRunLiftoffChatTurn.mockReturnValue(
      iterableOf([
        { type: 'thinking' },
        { type: 'text_delta', text: 'Here you go.' },
        {
          type: 'complete',
          message: {
            content: 'Here you go.',
            visualizationBlocks: [],
            inputTokens: 3,
            outputTokens: 4,
            author: null,
            authorLabel: null,
          },
        },
      ]),
    );

    const runtime = createDelegateRuntime(LIFTOFF, { ...CALLER, asColleague: true, origin: { via: 'claude_code' } as never });
    const events = await collect(runtime.runTurn({
      delegateThreadId: 'thread',
      content: 'what is a webhook',
      forwardedContext: 'Insights Manager shared background from the conversation so far\n\nThey asked about webhooks.',
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
    }));

    expect(mockAcquireLiftoffLock).toHaveBeenCalledWith('tenant-1', 'thread', 'turn-1');
    expect(mockRunLiftoffChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'viewer',
      userMessage: 'what is a webhook',
      forwardedContext: 'Insights Manager shared background from the conversation so far\n\nThey asked about webhooks.',
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
      callerName: 'Dana Reyes',
      turnId: 'turn-1',
      abortController,
      origin: { via: 'claude_code' },
      asColleague: true,
    }));
    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text_delta', text: 'Here you go.' },
      { type: 'complete', text: 'Here you go.', blocks: [], inputTokens: 3, outputTokens: 4, answeredBy: null },
    ]);
    expect(mockReleaseLiftoffLock).toHaveBeenCalledTimes(1);
  });

  it('reports busy when somebody is already talking to Liftoff on that thread', async () => {
    mockAcquireLiftoffLock.mockResolvedValue(null);

    const events = await collect(
      createDelegateRuntime(LIFTOFF, CALLER).runTurn({ delegateThreadId: 'thread', content: 'hi' }),
    );

    expect(events).toEqual([{ type: 'busy' }]);
    expect(mockRunLiftoffChatTurn).not.toHaveBeenCalled();
  });

  it('turns a lock it could not take into an error the person can read', async () => {
    mockAcquireLiftoffLock.mockRejectedValue(new Error('db down'));

    const events = await collect(
      createDelegateRuntime(LIFTOFF, CALLER).runTurn({ delegateThreadId: 'thread', content: 'hi' }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'That colleague could not be reached just now. Please try again in a moment.' },
    ]);
  });

  it('relays a pause of a colleague Liftoff brought in on its own surface', async () => {
    mockAcquireLiftoffLock.mockResolvedValue({ turnId: 'turn-1', abortController: new AbortController() });
    mockRunLiftoffChatTurn.mockReturnValue(
      iterableOf([
        { type: 'delegation_started', author: 'team-1', authorLabel: 'Payroll Operations' },
        {
          type: 'delegation_paused', author: 'team-1', authorLabel: 'Payroll Operations',
          delegateThreadId: 'ac-1', reason: 'Payroll Operations is waiting on an approval.', message: null,
        },
      ]),
    );

    const events = await collect(
      createDelegateRuntime(LIFTOFF, CALLER).runTurn({ delegateThreadId: 'thread', content: 'run payroll' }),
    );
    expect(events).toEqual([{ type: 'paused', reason: 'Payroll Operations is waiting on an approval.' }]);
    expect(mockReleaseLiftoffLock).toHaveBeenCalledTimes(1);
  });

  it('stops it with a signal row on Liftoff\'s own table', async () => {
    mockAcquireLiftoffLock.mockResolvedValue({ turnId: 'turn-1', abortController: new AbortController() });
    mockRunLiftoffChatTurn.mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', text: 'Working' };
        await new Promise((resolve) => setImmediate(resolve));
        yield { type: 'complete', message: null };
      })(),
    );

    const runtime = createDelegateRuntime(LIFTOFF, CALLER);
    const running = collect(runtime.runTurn({ delegateThreadId: 'thread', content: 'hi' }));
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.requestStop({ delegateThreadId: 'thread' });
    await running;

    expect(mockInsertLiftoffSignal).toHaveBeenCalledWith(
      'tenant-1',
      'turn-1',
      'abort',
      expect.objectContaining({ senderAccountId: 'account-1' }),
    );
  });

  it('has nothing to stop before a turn has started', async () => {
    await createDelegateRuntime(LIFTOFF, CALLER).requestStop({ delegateThreadId: 'thread' });
    expect(mockInsertLiftoffSignal).not.toHaveBeenCalled();
  });
});

describe('the agent runtime', () => {
  it('creates the thread and puts the team in it', async () => {
    // A thread has participants rather than an agent_id column, and the turn
    // runner does not add one.
    mockCreateAgentChatThread.mockResolvedValue({ id: 'agent-chat-thread' });

    const runtime = createDelegateRuntime(TEAM, CALLER);
    await expect(runtime.createThread()).resolves.toBe('agent-chat-thread');

    expect(mockCreateAgentChatThread).toHaveBeenCalledWith(
      'tenant-1',
      'account-1',
      'web',
      undefined,
      // Titled at creation. The title generator only runs on a turn that
      // COMPLETES, so a handover that paused for an approval left the team's
      // history showing "Untitled chat" for the one thread people are now sent
      // to. Says where it came from and names nobody: a title is listed to the
      // whole workspace.
      'Brought in by Liftoff',
    );
    expect(mockAddParticipant).toHaveBeenCalledWith(
      'agent-chat-thread',
      'team-uuid',
      'account-1',
      'lead',
    );
  });

  it('pays the admission checks the HTTP router would have run', async () => {
    // Those live in agent-chat's router, not its turn runner, so calling the
    // runner directly would skip the chat rate limit and the billing guard.
    mockRunAgentChatTurn.mockReturnValue(
      iterableOf([{ type: 'complete', message: { content: 'Done.', inputTokens: 1, outputTokens: 2 } }]),
    );

    const runtime = createDelegateRuntime(TEAM, CALLER);
    await collect(runtime.runTurn({ delegateThreadId: 'agent-chat-thread', content: 'go' }));

    expect(mockCheckChatAdmission).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      agentId: 'team-uuid',
    });
    expect(mockRunAgentChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        agentId: 'team-uuid',
        threadId: 'agent-chat-thread',
        senderAccountId: 'account-1',
        userDisplayName: 'Dana Reyes',
        userRole: 'viewer',
        content: 'go',
      }),
    );
  });

  it.each([
    [402, 'billing'],
    [429, 'too many messages'],
  ])('says what a %s admission refusal means, without starting a turn', async (status, phrase) => {
    mockCheckChatAdmission.mockResolvedValue({ allowed: false, httpStatus: status, error: 'no' });

    const runtime = createDelegateRuntime(TEAM, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'agent-chat-thread', content: 'go' }),
    );

    expect(mockRunAgentChatTurn).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message.toLowerCase()).toContain(phrase);
  });

  it('writes a paragraph break where the team started a new message', async () => {
    mockRunAgentChatTurn.mockReturnValue(
      iterableOf([
        { type: 'text_delta', text: 'First.' },
        { type: 'text_break' },
        { type: 'text_delta', text: 'Second.' },
        { type: 'complete', message: { content: 'First.\n\nSecond.', inputTokens: 0, outputTokens: 0 } },
      ]),
    );

    const runtime = createDelegateRuntime(TEAM, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'agent-chat-thread', content: 'go' }),
    );

    expect(events[1]).toEqual({ type: 'text_delta', text: '\n\n' });
  });

  it.each([
    [
      'an approval gate',
      { type: 'hitl_required', approvalId: 'a1', reason: 'r' },
      'approval',
    ],
    [
      'a question it asked',
      { type: 'awaiting_input', question: 'Which quarter?', sessionId: 's1' },
      'Which quarter?',
    ],
  ])('ends the segment on %s, before the spurious error behind it', async (_name, pause, phrase) => {
    // The agent-chat runner emits a PROVIDER_ERROR after a pause, because from
    // below a pause looks like a stream that ended without completing. Relaying
    // that would report a failure on top of a legitimate wait.
    mockRunAgentChatTurn.mockReturnValue(
      iterableOf([
        { type: 'text_delta', text: 'Started.' },
        pause,
        { type: 'error', code: 'PROVIDER_ERROR', message: 'The agent stopped before sending a response.' },
      ]),
    );

    const runtime = createDelegateRuntime(TEAM, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'agent-chat-thread', content: 'go' }),
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'paused' });
    expect((events[1] as { reason: string }).reason).toContain(phrase);
    // The sentence is persisted into the Liftoff transcript and read by
    // everyone on the thread, so it names the team in the third person rather
    // than addressing the one person whose turn tripped the gate.
    expect((events[1] as { reason: string }).reason).toContain(TEAM.label);
  });

  // The old copy told the person to "review it in that team's chat" and gave
  // them no way to get there. The way there is an affordance beside the row now,
  // so the prose must not carry a second, unclickable copy of it.
  it('does not send the person looking for the team chat in prose', async () => {
    mockRunAgentChatTurn.mockReturnValue(
      iterableOf([{ type: 'hitl_required', approvalId: 'a1', reason: 'r' }]),
    );

    const runtime = createDelegateRuntime(TEAM, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'agent-chat-thread', content: 'go' }),
    );

    expect((events[0] as { reason: string }).reason).not.toContain('chat');
  });

  it('turns a runtime that is busy into a sentence about waiting', async () => {
    mockRunAgentChatTurn.mockReturnValue(
      iterableOf([{ type: 'error', code: 'AGENT_BUSY', message: 'agent_already_running' }]),
    );

    const runtime = createDelegateRuntime(TEAM, CALLER);
    const events = await collect(
      runtime.runTurn({ delegateThreadId: 'agent-chat-thread', content: 'go' }),
    );

    expect((events[0] as { message: string }).message).toContain('busy with another conversation');
  });

  it('stops the turn through the runtime, which is the only thing that ends it', async () => {
    const runtime = createDelegateRuntime(TEAM, CALLER);
    await runtime.requestStop({ delegateThreadId: 'agent-chat-thread' });

    expect(mockSignalStopChatTurn).toHaveBeenCalledWith('tenant-1', {
      agentId: 'team-uuid',
      threadId: 'agent-chat-thread',
      senderAccountId: 'account-1',
      userDisplayName: 'Dana Reyes',
    });
  });

  it('swallows a stop that could not be delivered, because the turn is ending anyway', async () => {
    mockSignalStopChatTurn.mockRejectedValue(new Error('runtime unreachable'));

    const runtime = createDelegateRuntime(TEAM, CALLER);
    await expect(runtime.requestStop({ delegateThreadId: 'agent-chat-thread' })).resolves
      .toBeUndefined();
  });
});
