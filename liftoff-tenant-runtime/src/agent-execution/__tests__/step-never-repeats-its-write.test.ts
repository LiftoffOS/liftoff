// A step that ran twice must not write twice.
//
// A step that creates a document and then fails its declared output can end up
// with `create_document_markdown:ok` three times and three distinct documents.
//
// The first is the step's own. The other two are the advisor's: a `continue`
// proposal's calls are dispatched, the value they produce still does not satisfy
// the step's `outputField`, and the cycle re-asks — so the same create is
// proposed and sent again.
//
// FOUR THINGS DISPATCH A STEP'S WORK, and a replay wired to one of them holds on
// some runs and not others. This file drives the three that hold a request:
//
//   * `executeRecoveryCalls` — the advisor's corrective calls, the seam the
//     repeated create above runs through;
//   * `executeToolStep` — an AUTHORED `tool_call` step, re-dispatched whole when
//     a pause resumes (`resumeAfterStepId: currentStepId`);
//   * `executeLoopStep` — the same, per item, and the largest multiple: a loop
//     restarts from item 0, so a pause on item seven repeats items one to six.
//
// The fourth is the model's own call inside a step turn, which goes through the
// gateway's tool list; its wrapper is asserted in
// `tool-gateway/__tests__/replay-step-calls.test.ts` and its wiring in
// `workflow-step-salvage.test.ts`.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const poolMock = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), connect: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => poolMock), getPool: jest.fn(() => poolMock), pool: poolMock,
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: jest.fn().mockReturnValue({ guardExternal: async () => null }),
}));
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn(), complete: jest.fn(), modelSelectionFor: () => ({}) } }));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));

import { AgentExecutionService } from '../service';
import { StepReplayLedger } from '../step-replay-ledger';
import type { ExecutionContext, ExecutionState, ToolCallRequest, ToolCallResult } from '../types';

const CREATE = 'google-docs-8fd9fc68__create_document_markdown';
const CARD_PAYLOAD = { title: 'Acme: Battle Card: AllAgents', body: '# Card' };

/** The call the advisor proposes, as `mapLlmToolCallsToRequests` builds it. */
const proposal = (id: string, payload: Record<string, unknown> = CARD_PAYLOAD): ToolCallRequest => ({
  id,
  connector: 'google-docs-8fd9fc68',
  entityType: 'workflow',
  actionType: 'create_document_markdown',
  payload,
} as ToolCallRequest);

function makeState(): ExecutionState {
  return {
    context: {
      tenantId: 't1', agentId: 'a1', traceId: 'tr-1', invocationId: 'inv-1', instructionVersion: 1,
    } as ExecutionContext,
    reasoningSteps: 0, toolCallsExecuted: 0, startTime: new Date(), steps: [], conversationHistory: [],
    pendingToolCalls: [], completedToolCalls: [], toolFailureCounts: new Map(), injectedSkillIds: [],
    // The catalog the step registered. `create_document_markdown` is a stated
    // write, which is what makes it replayable.
    stepCatalog: {
      tools: [
        { name: CREATE, description: 'create', inputSchema: {}, categories: ['write'] },
        { name: 'google-docs-8fd9fc68__search_documents', description: 'search', inputSchema: {}, categories: ['read'] },
      ],
      servers: [],
    },
  } as unknown as ExecutionState;
}

type StepResult = { success: boolean; output?: unknown; error?: string };
type Svc = AgentExecutionService & {
  executeRecoveryCalls(s: ExecutionState, stepId: string, calls: ToolCallRequest[]): Promise<ToolCallResult[]>;
  executeToolStep(
    s: ExecutionState, step: unknown, stepOutput: unknown, inputData: unknown,
    counts: Map<string, number>, perConnectorLimit: number, stepOutputs?: Record<string, unknown>,
  ): Promise<StepResult>;
  executeLoopStep(
    s: ExecutionState, step: unknown, stepOutput: unknown, inputData: unknown,
    maxToolCalls: number, maxWallClockMs: number, wallClockStart: number,
    counts: Map<string, number>, perConnectorLimit: number, stepOutputs?: Record<string, unknown>,
  ): Promise<StepResult & { output?: unknown }>;
  executeToolCalls: jest.Mock;
  stepReplayLedgerFor(s: ExecutionState, stepId: string): StepReplayLedger;
  stepCallIsMutating(s: ExecutionState, name: string): boolean;
};

/** The service with the dispatch funnel stubbed, so what reached the vendor is
 *  exactly what this test measures. */
function service(dispatch?: jest.Mock): Svc {
  const svc = new AgentExecutionService() as Svc;
  svc.executeToolCalls = dispatch ?? jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
    calls.map((c, i) => ({ id: c.id, success: true, result: { documentId: `fresh-${i}` } })));
  return svc;
}

/** What the loop's catch does: the failed attempt's own calls into the ledger. */
function seedFromFailedAttempt(svc: Svc, state: ExecutionState, stepId: string, calls: Array<Record<string, unknown>>): void {
  state.completedToolCalls.push(...(calls as unknown as ToolCallResult[]));
  svc.stepReplayLedgerFor(state, stepId).record(
    calls as Array<{ success?: boolean; name?: string; input?: unknown; result?: unknown }>,
    (name) => svc.stepCallIsMutating(state, name),
  );
}

describe('a corrective call the step has already made is answered, not sent again', () => {
  it('does not dispatch the create the step itself performed, and hands back its document', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: 'SHOULD_NOT_HAPPEN' } })));
    const svc = service(dispatch);
    seedFromFailedAttempt(svc, state, 's13', [
      { id: 'c1', success: true, name: CREATE, input: CARD_PAYLOAD, result: { documentId: '1Gb-N8u6' } },
    ]);

    const results = await svc.executeRecoveryCalls(state, 's13', [proposal('recovery-0')]);

    expect(dispatch).not.toHaveBeenCalled();
    expect(results).toEqual([{ id: 'recovery-0', success: true, result: { documentId: '1Gb-N8u6' } }]);
  });

  it('does not repeat itself across a re-ask: one dispatch for two identical proposals', async () => {
    // The second and third documents. The advisor proposes, the value still fails
    // the step's output, the cycle re-asks, and it proposes the same call again.
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: '1EJDvekw' } })));
    const svc = service(dispatch);

    const first = await svc.executeRecoveryCalls(state, 's13', [proposal('recovery-0')]);
    const second = await svc.executeRecoveryCalls(state, 's13', [proposal('recovery-0')]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(first[0]!.result).toEqual({ documentId: '1EJDvekw' });
    // The re-ask reads the SAME document, so a step that links its deliverable
    // links the one that exists rather than one it just made.
    expect(second[0]!.result).toEqual({ documentId: '1EJDvekw' });
  });

  it('a DIFFERENT document is new work and dispatches', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: 'second-doc' } })));
    const svc = service(dispatch);
    seedFromFailedAttempt(svc, state, 's13', [
      { id: 'c1', success: true, name: CREATE, input: CARD_PAYLOAD, result: { documentId: '1Gb-N8u6' } },
    ]);

    const results = await svc.executeRecoveryCalls(state, 's13', [
      proposal('recovery-0', { title: 'Acme: Battle Card: Corvid', body: '# Card' }),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(results[0]!.result).toEqual({ documentId: 'second-doc' });
  });

  it('a READ the step already made is dispatched again, not replayed', async () => {
    // Fresh data is the most likely thing to make the retry work, so a read is
    // never answered from the record.
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: ['fresh'] })));
    const svc = service(dispatch);
    seedFromFailedAttempt(svc, state, 's13', [
      { id: 'c1', success: true, name: 'google-docs-8fd9fc68__search_documents', input: { q: 'Card' }, result: ['stale'] },
    ]);

    const results = await svc.executeRecoveryCalls(state, 's13', [{
      id: 'recovery-0', connector: 'google-docs-8fd9fc68', entityType: 'workflow',
      actionType: 'search_documents', payload: { q: 'Card' },
    } as ToolCallRequest]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(results[0]!.result).toEqual(['fresh']);
  });

  it('a create that FAILED is dispatched again: nothing was performed', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: 'now-it-worked' } })));
    const svc = service(dispatch);
    seedFromFailedAttempt(svc, state, 's13', [
      { id: 'c1', success: false, name: CREATE, input: CARD_PAYLOAD, error: 'rate limited' },
    ]);

    const results = await svc.executeRecoveryCalls(state, 's13', [proposal('recovery-0')]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(results[0]!.result).toEqual({ documentId: 'now-it-worked' });
  });

  it('a failed dispatch is not remembered, so the next proposal tries again', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: false, error: 'vendor 500' })));
    const svc = service(dispatch);

    await svc.executeRecoveryCalls(state, 's13', [proposal('recovery-0')]);
    await svc.executeRecoveryCalls(state, 's13', [proposal('recovery-0')]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('keeps the advisor\'s order, mixing a replay and a fresh call', async () => {
    // The caller reads `results[0]`, so an order derived from what happened to be
    // dispatched would hand it the wrong call's result.
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: 'fresh' } })));
    const svc = service(dispatch);
    seedFromFailedAttempt(svc, state, 's13', [
      { id: 'c1', success: true, name: CREATE, input: CARD_PAYLOAD, result: { documentId: 'recorded' } },
    ]);

    const results = await svc.executeRecoveryCalls(state, 's13', [
      proposal('recovery-0'),
      proposal('recovery-1', { title: 'Another card', body: '# B' }),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.id)).toEqual(['recovery-0', 'recovery-1']);
    expect(results[0]!.result).toEqual({ documentId: 'recorded' });
    expect(results[1]!.result).toEqual({ documentId: 'fresh' });
  });

  it('pairs results by POSITION, as the dispatcher has always been read', async () => {
    // `executeToolCalls` returns one result per call in the order it was given
    // them, and the code this replaces read `results[0]`. Pairing by id instead
    // would make a corrective action depend on the dispatcher echoing an id back,
    // and a mismatch would read as a call that failed rather than one that ran.
    const state = makeState();
    const dispatch = jest.fn(async () => [{ id: 'some-other-id', success: true, result: { ok: 1 } }]);
    const svc = service(dispatch as unknown as jest.Mock);
    const results = await svc.executeRecoveryCalls(state, 's13', [proposal('recovery-0')]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ success: true, result: { ok: 1 } });
  });

  it('reports a call the dispatcher answered nothing for, rather than shifting the array', async () => {
    // The caller reads `results[0]` and `results.find(r => !r.success)`. Dropping a
    // missing entry would shift the array and hand it the NEXT call's result under
    // the first call's name, which reads as the step having been corrected by
    // something that never ran.
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      // One result for two calls: the second call is answered by nothing.
      calls.slice(0, 1).map((c) => ({ id: c.id, success: true, result: 'first' })));
    const svc = service(dispatch);

    const results = await svc.executeRecoveryCalls(state, 's13', [
      proposal('recovery-0'),
      proposal('recovery-1', { title: 'Another card' }),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ success: true, result: 'first' });
    expect(results[1]).toMatchObject({ id: 'recovery-1', success: false });
    expect(results[1]!.error).toContain('create_document_markdown');
  });

  it('is scoped to the step: another step\'s write is not replayed here', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: 'fresh' } })));
    const svc = service(dispatch);
    seedFromFailedAttempt(svc, state, 's9', [
      { id: 'c1', success: true, name: CREATE, input: CARD_PAYLOAD, result: { documentId: 'from-s9' } },
    ]);

    const results = await svc.executeRecoveryCalls(state, 's13', [proposal('recovery-0')]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(results[0]!.result).toEqual({ documentId: 'fresh' });
  });

  it('dispatches nothing at all when every proposed call is a repeat', async () => {
    const state = makeState();
    const dispatch = jest.fn();
    const svc = service(dispatch as unknown as jest.Mock);
    seedFromFailedAttempt(svc, state, 's13', [
      { id: 'c1', success: true, name: CREATE, input: CARD_PAYLOAD, result: 'one' },
      { id: 'c2', success: true, name: CREATE, input: { title: 'B' }, result: 'two' },
    ]);

    const results = await svc.executeRecoveryCalls(state, 's13', [
      proposal('recovery-0'),
      proposal('recovery-1', { title: 'B' }),
    ]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(results.map((r) => r.result)).toEqual(['one', 'two']);
  });
});

// The wiring joint. The replay is worthless if the recovery dispatcher still
// calls the raw funnel, and a test of `executeRecoveryCalls` alone cannot see
// that: it was `this.executeToolCalls(state, decision.toolCalls)` for as long as
// this defect existed.
describe('the recovery dispatcher sends a `continue` proposal through the replay', () => {
  /** The one-step graph the dispatcher walks. */
  const GRAPH = [{ stepId: 's13', type: 'llm_reason', description: 'Write the card.', onSuccess: '' }];

  const counters = () => ({
    stepOutputs: {}, enteredSteps: new Set<string>(), unsatisfiedSteps: new Set<string>(),
    salvagedSteps: new Set<string>(), salvageNotes: {}, perStepRecoveries: {}, totalRecoveries: 0,
    recoveryHistory: [] as unknown[],
  });

  it('dispatches the proposal through executeRecoveryCalls, for the step being recovered', async () => {
    const state = makeState();
    const svc = service();
    const spy = jest.spyOn(
      svc as unknown as { executeRecoveryCalls: (...a: unknown[]) => Promise<ToolCallResult[]> },
      'executeRecoveryCalls',
    );

    await (svc as unknown as {
      dispatchRecoveryDecision: (...a: unknown[]) => Promise<unknown>;
    }).dispatchRecoveryDecision(
      state,
      GRAPH,
      { thinking: '', decision: 'continue', toolCalls: [proposal('recovery-0')] },
      's13',
      undefined,
      undefined,
      counters(),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe('s13');
    expect(spy.mock.calls[0]![2]).toEqual([proposal('recovery-0')]);
  });

  it('answers the proposal from the record, so nothing reaches the vendor twice', async () => {
    // End to end through the dispatcher: the step's own create is in the record,
    // the advisor proposes it again, and the funnel is never called.
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: 'SHOULD_NOT_HAPPEN' } })));
    const svc = service(dispatch);
    seedFromFailedAttempt(svc, state, 's13', [
      { id: 'c1', success: true, name: CREATE, input: CARD_PAYLOAD, result: { documentId: '1Gb-N8u6' } },
    ]);

    const out = await (svc as unknown as {
      dispatchRecoveryDecision: (...a: unknown[]) => Promise<{ stepOutputAfter?: unknown }>;
    }).dispatchRecoveryDecision(
      state,
      GRAPH,
      { thinking: '', decision: 'continue', toolCalls: [proposal('recovery-0')] },
      's13',
      undefined,
      undefined,
      counters(),
    );

    expect(dispatch).not.toHaveBeenCalled();
    // The value the dispatcher carries forward is the document that EXISTS.
    expect(out.stepOutputAfter).toEqual({ documentId: '1Gb-N8u6' });
  });
});

describe('what counts as a write', () => {
  it('believes the catalog when it answers', () => {
    const svc = service();
    const state = makeState();
    expect(svc.stepCallIsMutating(state, CREATE)).toBe(true);
    expect(svc.stepCallIsMutating(state, 'google-docs-8fd9fc68__search_documents')).toBe(false);
  });

  it('reads the NAME when the catalog does not answer', () => {
    // A `tool_call` step registers no catalog, so `state.stepCatalog` is absent
    // and the name is the only signal there is.
    const svc = service();
    const bare = { ...makeState(), stepCatalog: undefined } as unknown as ExecutionState;
    expect(svc.stepCallIsMutating(bare, 'notion-1__create_page')).toBe(true);
    expect(svc.stepCallIsMutating(bare, 'notion-1__get_page')).toBe(false);
    // An unrecognised verb fails toward write, which is the safe direction: it is
    // remembered rather than sent twice.
    expect(svc.stepCallIsMutating(bare, 'notion-1__reconcile_ledger')).toBe(true);
  });

  it('never replays the agent writing in its own notebook', () => {
    // record_step_output / report_task_outcome / audit_log leave the process
    // nowhere, so there is nothing to protect, and replaying one would hide the
    // retry's own report of what it did.
    const svc = service();
    const state = makeState();
    for (const name of ['record_step_output', 'report_task_outcome', 'audit_log']) {
      expect(svc.stepCallIsMutating(state, name)).toBe(false);
      expect(svc.stepCallIsMutating(state, `mcp__liftoff-tool-gateway__${name}`)).toBe(false);
    }
  });
});

// AN AUTHORED `tool_call` STEP, re-dispatched whole when a pause resumes.
//
// Every HITL pause site in the workflow loop writes
// `resumeAfterStepId: currentStepId` — "re-dispatch the gated step on approve" —
// and the resumed loop enters from it. An authored step's arguments cannot differ
// between attempts, so without a replay the second dispatch is the same write.
//
// The evidence this path depends on is NOT the run's record: the `ToolCallResult`
// `executeToolCalls` pushes carries `{id, success, result}` and no tool name, so
// the catch's name-based recorder skips it. The dispatch site records from the
// REQUEST instead, which is the only thing that holds the name.
describe('an authored tool_call step', () => {
  const STEP = {
    stepId: 's13',
    type: 'tool_call',
    description: 'Write the battle card.',
    toolName: CREATE,
    toolInput: CARD_PAYLOAD,
    onSuccess: '',
  };

  it('records what it dispatched, from the request, because the record has no name', async () => {
    const state = makeState();
    const svc = service();
    const out = await svc.executeToolStep(state, STEP, undefined, undefined, new Map(), 50);
    expect(out.success).toBe(true);
    // The run's record cannot carry this: executeToolCalls pushes no name.
    expect(state.completedToolCalls.some((c) => c.name)).toBe(false);
    // The ledger can, and did.
    expect(state.stepReplay?.get('s13')?.size).toBe(1);
  });

  it('answers the re-dispatch with that call\'s own result, and sends nothing', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: 'first' } })));
    const svc = service(dispatch);

    const first = await svc.executeToolStep(state, STEP, undefined, undefined, new Map(), 50);
    const second = await svc.executeToolStep(state, STEP, undefined, undefined, new Map(), 50);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(first.output).toEqual({ documentId: 'first' });
    expect(second.output).toEqual({ documentId: 'first' });
  });

  it('records BEFORE the outputField extraction that can throw', async () => {
    // The step a pause re-dispatches is precisely the one whose write landed and
    // whose declared output then failed its shape. Recording after the throw
    // would leave the ledger empty for it.
    const state = makeState();
    // The write lands and returns a shape the declared output is not in.
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { url: 'https://docs/…' } })));
    const svc = service(dispatch);
    const withField = { ...STEP, outputField: 'documentId' };
    await expect(svc.executeToolStep(state, withField, undefined, undefined, new Map(), 50))
      .rejects.toThrow(/documentId/);
    expect(state.stepReplay?.get('s13')?.size).toBe(1);
    // And the re-dispatch fails the same way rather than writing a second time.
    await expect(svc.executeToolStep(state, withField, undefined, undefined, new Map(), 50))
      .rejects.toThrow(/documentId/);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a replay applies the same outputField extraction a dispatch would', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: '10OzC7pB' } })));
    const svc = service(dispatch);
    const withField = { ...STEP, outputField: 'documentId' };

    const first = await svc.executeToolStep(state, withField, undefined, undefined, new Map(), 50);
    const second = await svc.executeToolStep(state, withField, undefined, undefined, new Map(), 50);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(first.output).toBe('10OzC7pB');
    expect(second.output).toBe('10OzC7pB');
  });

  it('does not record a READ, so a re-dispatched read still reads', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: ['fresh'] })));
    const svc = service(dispatch);
    const readStep = {
      stepId: 's13', type: 'tool_call', description: 'Find it.',
      toolName: 'google-docs-8fd9fc68__search_documents', toolInput: { q: 'Card' }, onSuccess: '',
    };
    await svc.executeToolStep(state, readStep, undefined, undefined, new Map(), 50);
    await svc.executeToolStep(state, readStep, undefined, undefined, new Map(), 50);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(state.stepReplay?.get('s13')?.size ?? 0).toBe(0);
  });
});

// A LOOP STEP, which restarts from item 0.
//
// The largest multiple of the four seams: a pause on item seven re-dispatches the
// step on approve and items one to six write again. Each iteration's arguments
// carry its own item, so the exact-call key separates them and only the items
// already done are answered.
describe('a loop step re-dispatched from the top', () => {
  const LOOP_STEP = {
    stepId: 's13',
    type: 'tool_call',
    description: 'Write the battle card for each competitor.',
    toolName: CREATE,
    toolInputTemplate: '{"title":"Card: {{item.name}}"}',
    loop: { over: '{{input.competitors}}' },
    onSuccess: '',
  };
  const ITEMS = { competitors: [{ name: 'Corvid' }, { name: 'Meridian' }, { name: 'AllAgents' }] };

  const runLoopStep = (svc: Svc, state: ExecutionState) => svc.executeLoopStep(
    state, LOOP_STEP, undefined, ITEMS, 100, 600_000, Date.now(), new Map(), 50,
  );

  it('writes once per item on the first pass, and nothing on the second', async () => {
    const state = makeState();
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: `doc-${c.id}` } })));
    const svc = service(dispatch);

    const first = await runLoopStep(svc, state);
    expect(first.success).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(state.stepReplay?.get('s13')?.size).toBe(3);

    // The resume: same step, same items, from the top.
    const second = await runLoopStep(svc, state);
    expect(second.success).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('writes only the items the first pass did NOT reach', async () => {
    // The shape this covers: a pause part way through.
    const state = makeState();
    let dispatched = 0;
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) => {
      dispatched++;
      // The third item fails, as a gate or a vendor rejection would.
      if (dispatched === 3) return calls.map((c) => ({ id: c.id, success: false, error: 'gated' }));
      return calls.map((c) => ({ id: c.id, success: true, result: { documentId: `doc-${dispatched}` } }));
    });
    const svc = service(dispatch);

    const first = await runLoopStep(svc, state);
    expect(first.success).toBe(false);
    expect(state.stepReplay?.get('s13')?.size).toBe(2);

    // The resume dispatches ONLY the item that never landed.
    dispatch.mockClear();
    const second = await runLoopStep(svc, state);
    expect(second.success).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const sent = (dispatch.mock.calls[0]![1] as ToolCallRequest[])[0]!;
    expect(sent.payload).toEqual({ title: 'Card: AllAgents' });
  });

  it('does NOT collapse two iterations that make the same call', async () => {
    // A loop body whose arguments carry no item dispatches identical arguments
    // every pass and differs only in what comes back — "call list_next until it
    // returns nothing", a static call whose answer moves. Keyed on the call alone,
    // pass two would be answered with pass one's result and a collecting loop
    // would collect the first answer three times. `workflow-loop.test.ts` has
    // exactly that shape, which is how this was found.
    const state = makeState();
    let n = 0;
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) => {
      n++;
      return calls.map((c) => ({ id: c.id, success: true, result: { val: n } }));
    });
    const svc = service(dispatch);
    const staticBody = {
      stepId: 's13', type: 'tool_call', description: 'Read the next page.',
      toolName: CREATE, toolInput: { fixed: true },
      loop: { over: '{{input.competitors}}', collect: true }, onSuccess: '',
    };

    const first = await svc.executeLoopStep(state, staticBody, undefined, ITEMS, 100, 600_000, Date.now(), new Map(), 50);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(first.output).toEqual([{ val: 1 }, { val: 2 }, { val: 3 }]);

    // And each pass is answered by its OWN record on a re-dispatch, not by the
    // first one's.
    const second = await svc.executeLoopStep(state, staticBody, undefined, ITEMS, 100, 600_000, Date.now(), new Map(), 50);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(second.output).toEqual([{ val: 1 }, { val: 2 }, { val: 3 }]);
  });

  it('keeps `collect` whole: a replayed iteration contributes its recorded output', async () => {
    // A collected list that lost its replayed items would be a shorter list than
    // the same run produced the first time.
    const state = makeState();
    const collecting = { ...LOOP_STEP, loop: { over: '{{input.competitors}}', collect: true }, outputField: 'documentId' };
    const dispatch = jest.fn(async (_s: ExecutionState, calls: ToolCallRequest[]) =>
      calls.map((c) => ({ id: c.id, success: true, result: { documentId: `doc-${c.id.slice(-1)}` } })));
    const svc = service(dispatch);

    const first = await svc.executeLoopStep(state, collecting, undefined, ITEMS, 100, 600_000, Date.now(), new Map(), 50);
    const second = await svc.executeLoopStep(state, collecting, undefined, ITEMS, 100, 600_000, Date.now(), new Map(), 50);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(second.output).toEqual(first.output);
    expect(second.output).toHaveLength(3);
  });
});
