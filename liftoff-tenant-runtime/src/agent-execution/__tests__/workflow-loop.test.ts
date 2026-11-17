/**
 * Phase 4 — runWorkflowLoop tests: comprehensive integration tests for the
 * rewritten workflow executor. Tests template substitution, output-field
 * extraction, retry, timeout, per-step HITL, loop iteration, condition
 * evaluation, graph validation, and ceiling enforcement.
 *
 * Strategy: we directly test the private runWorkflowLoop/executeSingleStep/
 * executeLoopStep methods via (service as any) after mocking out all
 * external dependencies (executeToolCalls, createEscalation, streamingService).
 */

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../streaming', () => ({
  streamingService: {
    emitAgentStatus: jest.fn(),
    emitStepResult: jest.fn(),
  },
}));

// We need HitlGateError to be a real class so instanceof checks work
class MockHitlGateError extends Error {
  reason: string;
  constructor(_toolCalls: unknown[], reason: string, _matchedCategory?: string) {
    super(reason);
    this.name = 'HitlGateError';
    this.reason = reason;
  }
}

jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkGate: jest.fn() },
  HitlGateError: MockHitlGateError,
  ModelTool: {},
}));

// Mock all the heavy service imports that AgentExecutionService constructor needs
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/service', () => ({
  CoordinatorService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({
    setCredentialService: jest.fn(),
    routeToolCall: jest.fn(),
  })),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    // Hybrid execution engine: createClarificationPause / createHitlPause
    // mark the agent WAITING_FOR_HUMAN. Provide a no-op so tests don't crash.
    updateRuntimeStatus: jest.fn().mockResolvedValue(undefined),
    getAgent: jest.fn(),
  })),
}));
jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({})),
}));
// Hybrid execution engine: the cursor walk calls checkUserInterruptSignal
// at every step boundary, which queries agent_invocation_signals via
// getPoolForService('scheduled-execution'). Provide a no-op pool so the
// signal query returns an empty result set (no interrupts pending).
jest.mock('../../infrastructure/database', () => {
  const pool = {
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: jest.fn(async () => ({
      query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
      release: jest.fn(),
    })),
  };
  return {
    getPoolForService: jest.fn(() => pool),
    getPool: jest.fn(() => pool),
  };
});
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}),
    getEntitlements: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock('../../memory', () => ({
  memoryService: { retrieve: jest.fn(), save: jest.fn() },
  RetrievedMemory: {},
}));
jest.mock('../../invocations', () => ({
  invocationsService: { getMessages: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../audit', () => ({
  // Hybrid execution engine writes audit rows on recovery + clarification;
  // resolve to a thenable so `.catch(...)` does not crash.
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../tool-interceptor', () => ({
  interceptToolCalls: jest.fn(calls => calls),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifests: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({
  executeStandardTool: jest.fn(),
}));

import { AgentExecutionService } from '../service';
import type { ExecutionState, WorkflowStep, TaskExecutionResult } from '../types';

// Helper to build a minimal ExecutionState
function makeState(overrides: {
  workflowSteps?: WorkflowStep[];
  hitlLevel?: number;
  execConfig?: { maxToolCalls?: number; timeoutMs?: number };
}): ExecutionState {
  return {
    context: {
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      workflowId: 'wf-1',
      taskId: 'task-1',
      instructionVersion: 1,
      instruction: { systemPrompt: 'test', tools: [], guardrails: [] } as any,
      traceId: 'trace-1',
      agentType: 'workflow',
      hitlLevel: overrides.hitlLevel ?? 0,
      modelConfig: {},
      execConfig: overrides.execConfig || {},
      memoryScope: {},
      workflowSteps: overrides.workflowSteps,
      threadId: 'thread-1',
      invocationId: 'inv-1',
    },
    reasoningSteps: 0,
    toolCallsExecuted: 0,
    startTime: new Date(),
    steps: [],
    conversationHistory: [],
    pendingToolCalls: [],
    completedToolCalls: [],
    toolFailureCounts: new Map(),
  };
}

describe('Phase 4 — runWorkflowLoop', () => {
  let service: AgentExecutionService;
  let mockExecuteToolCalls: jest.Mock;
  let mockCreateEscalation: jest.Mock;

  beforeEach(() => {
    service = new AgentExecutionService();
    mockExecuteToolCalls = jest.fn();
    mockCreateEscalation = jest.fn().mockResolvedValue('esc-1');
    (service as any).executeToolCalls = mockExecuteToolCalls;
    (service as any).createEscalation = mockCreateEscalation;
    // Mock buildToolsSchema to return an empty array (no manifests loaded).
    // The validator skips tool name resolution when the catalog is empty.
    (service as any).buildToolsSchema = jest.fn().mockResolvedValue([]);
    jest.useFakeTimers({ advanceTimers: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const stubAdapter = {
    kind: 'anthropic',
    invoke: jest.fn(),
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
  };

  // Helper to call the private method. runAgentHybridLoop now requires
  // an adapter; pass a stub since structured-workflow tests don't exercise
  // the conversational adapter branch (they're mocked via stepLLM /
  // executeToolCalls).
  function callRunWorkflowLoop(
    state: ExecutionState,
    objective: string,
    inputData?: Record<string, unknown>,
  ): Promise<TaskExecutionResult> {
    return (service as any).runAgentHybridLoop(state, objective, inputData, undefined, stubAdapter);
  }

  describe('happy paths', () => {
    it('executes a 3-step linear workflow successfully', async () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'Step 1', toolName: 'slack__send_message', toolInput: { msg: 'hello' }, onSuccess: 's2' },
        { stepId: 's2', description: 'Step 2', toolName: 'slack__send_message', toolInput: { msg: 'world' }, onSuccess: 's3' },
        { stepId: 's3', description: 'Step 3', toolName: 'slack__send_message', toolInput: { msg: 'done' } },
      ];

      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: true, result: { ok: 1 } }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { ok: 2 } }])
        .mockResolvedValueOnce([{ id: '3', success: true, result: { ok: 3 } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      expect(result.success).toBe(true);
      expect(result.toolCallsExecuted).toBe(3);
      expect(result.reasoningSteps).toBe(3);
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
    });

    it('routes empty workflowSteps to the adapter-driven conversational path', async () => {
      // Empty workflowSteps → runConversationalTurnsViaAdapter is called.
      const convoMock = jest.fn().mockResolvedValue({
        success: true, toolCallsExecuted: 0, reasoningSteps: 1,
      });
      (service as unknown as { runConversationalTurnsViaAdapter: jest.Mock }).runConversationalTurnsViaAdapter =
        convoMock;
      const state = makeState({ workflowSteps: [] });
      const result = await callRunWorkflowLoop(state, 'test');
      expect(convoMock).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it('routes undefined workflowSteps to the adapter-driven conversational path', async () => {
      const convoMock = jest.fn().mockResolvedValue({
        success: true, toolCallsExecuted: 0, reasoningSteps: 1,
      });
      (service as unknown as { runConversationalTurnsViaAdapter: jest.Mock }).runConversationalTurnsViaAdapter =
        convoMock;
      const state = makeState({});
      state.context.workflowSteps = undefined;
      const result = await callRunWorkflowLoop(state, 'test');
      expect(convoMock).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });
  });

  describe('template substitution', () => {
    it('resolves toolInputTemplate with {{output.X}} from previous step', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Fetch',
          toolName: 'crm__get_customer',
          toolInput: { id: '42' },
          outputField: 'customer',
          onSuccess: 's2',
        },
        {
          stepId: 's2',
          description: 'Notify',
          toolName: 'slack__send_message',
          toolInputTemplate: '{"channel": {{output.email}}}',
        },
      ];

      // Step 1 returns a result with a nested customer field
      mockExecuteToolCalls
        .mockResolvedValueOnce([{
          id: '1',
          success: true,
          result: { customer: { email: 'test@example.com' }, id: 'c1' },
        }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { ok: true } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      expect(result.success).toBe(true);
      // Second call should have template-resolved input
      const secondCall = mockExecuteToolCalls.mock.calls[1][1][0];
      expect(secondCall.payload).toEqual({ channel: 'test@example.com' });
    });
  });

  describe('outputField extraction', () => {
    it('extracts nested value via outputField', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Fetch',
          toolName: 'api__get_data',
          toolInput: {},
          outputField: 'data.records',
        },
      ];

      mockExecuteToolCalls.mockResolvedValueOnce([{
        id: '1',
        success: true,
        result: { data: { records: [1, 2, 3] }, meta: 'ignored' },
      }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      expect(result.success).toBe(true);
      expect(result.output).toEqual([1, 2, 3]);
    });

    it('does NOT pass the full result off as the extracted field', async () => {
      // This asserted the opposite, and named the behaviour plainly: "keeps
      // full result if outputField resolves to undefined". That is a step
      // reporting success with a value of a shape nobody declared. Everything
      // downstream then reads it silently — `stepOutputs[s1]` holds the
      // envelope, so `$.steps.s1.<field>` is undefined and the branch quietly
      // goes the wrong way, and `{{steps.s1.<field>}}` renders null.
      //
      // `outputField` is a contract. A miss fails the step, and the recovery
      // model is handed the envelope that actually arrived.
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Fetch',
          toolName: 'api__get_data',
          toolInput: {},
          outputField: 'nonexistent.path',
        },
      ];

      const fullResult = { data: 'hello' };
      mockExecuteToolCalls.mockResolvedValueOnce([{
        id: '1',
        success: true,
        result: fullResult,
      }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      // Routed to the recovery LLM, which with no llmClient mock synthesizes
      // an escalation — the same terminal shape every other recovery path in
      // this file asserts. The point is what did NOT happen: the raw envelope
      // never became this step's output.
      expect(result.escalated).toBe(true);
      expect(result.error).toContain('recovery_llm_unavailable');
      expect(result.output).not.toEqual(fullResult);
    });

    it('does not retry a shape mismatch, because the call already happened', async () => {
      // The tool SUCCEEDED; only the declared field was absent. Retrying
      // repeats whatever the call did in the world and returns the same shape.
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Post',
          toolName: 'api__post',
          toolInput: {},
          outputField: 'nope',
          retry: { maxAttempts: 3, backoffMs: 0 },
        },
      ];

      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: { a: 1 } }]);

      const state = makeState({ workflowSteps: steps });
      await callRunWorkflowLoop(state, 'test');

      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry logic', () => {
    it('retries on failure and succeeds on second attempt', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Flaky step',
          toolName: 'api__call',
          toolInput: {},
          retry: { maxAttempts: 3, backoffMs: 10 },
        },
      ];

      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'transient' }])
        .mockResolvedValueOnce([{ id: '1', success: true, result: { ok: true } }]);

      const state = makeState({ workflowSteps: steps });
      const resultPromise = callRunWorkflowLoop(state, 'test');

      // Advance timers past backoff
      await jest.advanceTimersByTimeAsync(50);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
    });

    it('fails after exhausting all retry attempts', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Always fails',
          toolName: 'api__call',
          toolInput: {},
          retry: { maxAttempts: 2, backoffMs: 10 },
        },
      ];

      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'permanent failure' }])
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'permanent failure' }]);

      const state = makeState({ workflowSteps: steps });
      const resultPromise = callRunWorkflowLoop(state, 'test');
      await jest.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      // Hybrid engine semantics: when executeToolStep's retries are exhausted,
      // the error propagates to the recovery LLM. With no llmClient.complete
      // mock wired up here, invokeRecoveryLLM throws, which D6 synthesizes as
      // decision='escalate' with reason='recovery_llm_unavailable: ...'.
      expect(result.success).toBe(true);
      expect(result.escalated).toBe(true);
      expect(result.error).toContain('recovery_llm_unavailable');
    });
  });

  describe('timeout', () => {
    it('fails when step exceeds timeoutMs', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Slow step',
          toolName: 'api__slow_call',
          toolInput: {},
          timeoutMs: 100,
        },
      ];

      // executeToolCalls never resolves within timeout
      mockExecuteToolCalls.mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 5000)),
      );

      const state = makeState({ workflowSteps: steps });
      const resultPromise = callRunWorkflowLoop(state, 'test');

      // Advance past the 100ms timeout
      await jest.advanceTimersByTimeAsync(200);
      const result = await resultPromise;

      // Hybrid engine: timeout maps to recovery LLM (D6 synth-escalate when
      // no LLM mock is wired, per the comment above).
      expect(result.success).toBe(true);
      expect(result.escalated).toBe(true);
      expect(result.error).toContain('recovery_llm_unavailable');
    });
  });

  describe('per-step HITL', () => {
    it('escalates when step.requiresApproval triggers HITL gate', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Approval required',
          toolName: 'finance__make_payment',
          toolInput: { amount: 10000 },
          requiresApproval: true,
        },
      ];

      mockExecuteToolCalls.mockRejectedValueOnce(
        new MockHitlGateError([], 'Payment requires approval'),
      );

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      // Hybrid engine: HitlGateError no longer terminates the workflow —
      // executeToolStep propagates it to the hybrid loop's outer catch, which
      // calls createHitlPause to persist a HybridResumeState. Resume re-enters
      // the gated step after approval, bringing workflow HITL into parity
      // with the agent loop. The test's old assertion (escalated:true) is
      // superseded by the new paused-and-resumable behavior.
      expect(result.paused).toBe(true);
      expect(result.pausedAtStepId).toBe('s1');
    });

    it('HITL gate error does NOT retry — escalates immediately', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Gated step',
          toolName: 'finance__make_payment',
          toolInput: {},
          requiresApproval: true,
          retry: { maxAttempts: 3 },
        },
      ];

      mockExecuteToolCalls.mockRejectedValueOnce(
        new MockHitlGateError([], 'Needs approval'),
      );

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      // Hybrid engine HITL parity: HitlGateError pauses (vs the old
      // escalate-immediately). executeToolCalls is still called only once
      // because HitlGateError short-circuits the executeToolStep retry loop.
      expect(result.paused).toBe(true);
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
    });
  });

  describe('loop iteration', () => {
    it('iterates over array and executes tool for each item', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Process items',
          toolName: 'api__process',
          toolInputTemplate: '{"item_id": {{item.id}}}',
          loop: { over: 'items', collect: false },
        },
      ];

      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: true, result: { processed: 'a' } }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { processed: 'b' } }]);

      const state = makeState({ workflowSteps: steps });
      const inputData = { items: [{ id: 'a' }, { id: 'b' }] };
      const result = await callRunWorkflowLoop(state, 'test', inputData);

      expect(result.success).toBe(true);
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
    });

    it('collects outputs when loop.collect is true', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Collect items',
          toolName: 'api__process',
          toolInput: {},
          loop: { over: 'items', collect: true },
        },
      ];

      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: true, result: { val: 1 } }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { val: 2 } }])
        .mockResolvedValueOnce([{ id: '3', success: true, result: { val: 3 } }]);

      const state = makeState({ workflowSteps: steps });
      const inputData = { items: ['x', 'y', 'z'] };
      const result = await callRunWorkflowLoop(state, 'test', inputData);

      expect(result.success).toBe(true);
      expect(result.output).toEqual([{ val: 1 }, { val: 2 }, { val: 3 }]);
    });

    it('loop cross-iteration isolation: iteration K output not visible to iteration K+1 template', async () => {
      // Each iteration gets the SAME stepOutput (inputData), not the previous iteration's result.
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Isolated loop',
          toolName: 'api__process',
          toolInputTemplate: '{"item_name": {{item.name}}}',
          loop: { over: 'items', collect: true },
        },
      ];

      const calls: Record<string, unknown>[] = [];
      mockExecuteToolCalls.mockImplementation((_state: any, toolCalls: any[]) => {
        calls.push(toolCalls[0].payload);
        return Promise.resolve([{ id: toolCalls[0].id, success: true, result: { changed: true } }]);
      });

      const state = makeState({ workflowSteps: steps });
      const inputData = { items: [{ name: 'Alice' }, { name: 'Bob' }] };
      const result = await callRunWorkflowLoop(state, 'test', inputData);

      expect(result.success).toBe(true);
      // Each call should have its own item, not the previous iteration's result
      expect(calls[0]).toEqual({ item_name: 'Alice' });
      expect(calls[1]).toEqual({ item_name: 'Bob' });
    });

    it('fails when loop.over does not resolve to an array', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Bad loop',
          toolName: 'api__process',
          toolInput: {},
          loop: { over: 'nonexistent' },
        },
      ];

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test', { data: 'not-array' });

      // Hybrid engine: executeLoopStep failure routes to the recovery LLM.
      // D6 synthesizes escalate when no LLM mock is wired.
      expect(result.success).toBe(true);
      expect(result.escalated).toBe(true);
      expect(result.error).toContain('recovery_llm_unavailable');
    });
  });

  describe('ceiling enforcement', () => {
    it('stops when maxToolCalls ceiling is hit', async () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'Step 1', toolName: 'api__call', toolInput: {}, onSuccess: 's2' },
        { stepId: 's2', description: 'Step 2', toolName: 'api__call', toolInput: {} },
      ];

      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: {} }]);

      const state = makeState({ workflowSteps: steps, execConfig: { maxToolCalls: 1 } });
      const result = await callRunWorkflowLoop(state, 'test');

      // First step succeeds (toolCallsExecuted=1), then ceiling check fires before step 2
      expect(result.success).toBe(false);
      expect(result.error).toContain('maximum tool calls');
    });

    it('stops when maxWallClockMs ceiling is exceeded', async () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'Step 1', toolName: 'api__call', toolInput: {}, onSuccess: 's2' },
        { stepId: 's2', description: 'Step 2', toolName: 'api__call', toolInput: {} },
      ];

      mockExecuteToolCalls.mockImplementation(() => {
        // Advance time past ceiling between steps
        jest.advanceTimersByTime(700_000);
        return Promise.resolve([{ id: '1', success: true, result: {} }]);
      });

      const state = makeState({ workflowSteps: steps, execConfig: { timeoutMs: 500 } });
      const result = await callRunWorkflowLoop(state, 'test');

      // First step takes too long, so step 2 wall-clock check fails
      expect(result.success).toBe(false);
      expect(result.error).toContain('wall-clock time');
    });

    it('stops when per-connector rate limit is exceeded', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Loop many',
          toolName: 'api__call',
          toolInput: {},
          loop: { over: 'items', maxIterations: 200 },
        },
      ];

      // Create 101 items but per-connector limit is 100
      const items = Array.from({ length: 101 }, (_, i) => ({ id: i }));
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: {} }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test', { items });

      // Hybrid engine: per-connector rate-limit failure inside the loop step
      // routes to the recovery LLM (D6 synth-escalate without LLM mock).
      expect(result.success).toBe(true);
      expect(result.escalated).toBe(true);
      expect(result.error).toContain('recovery_llm_unavailable');
    });
  });

  // Conditions address an explicit context — `$.input.<field>` for the workflow
  // input, `$.steps.<id>.<field>` for any completed step. Previously they
  // resolved against a bare `stepOutput`, which started as inputData, so
  // `$.status` happened to reach the input on the first step and meant
  // something different on every step after it. No stored condition relies on
  // that behaviour.
  describe('condition evaluation', () => {
    it('skips step when condition evaluates to false, routing to onFailure', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Conditional',
          toolName: 'api__call',
          toolInput: {},
          condition: "$.input.status == 'approved'",
          onSuccess: 's2',
          onFailure: 's3',
        },
        { stepId: 's2', description: 'Should skip', toolName: 'api__call', toolInput: {} },
        { stepId: 's3', description: 'Fallback', toolName: 'api__call', toolInput: {} },
      ];

      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: {} }]);

      const state = makeState({ workflowSteps: steps });
      // inputData has status=rejected, so condition $.input.status == 'approved' is false
      const result = await callRunWorkflowLoop(state, 'test', { status: 'rejected' });

      expect(result.success).toBe(true);
      // Should have executed only s3 (fallback), not s1's tool or s2
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
    });

    it('executes step when condition evaluates to true', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Conditional',
          toolName: 'api__call',
          toolInput: {},
          condition: "$.input.status == 'approved'",
        },
      ];

      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: {} }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test', { status: 'approved' });

      expect(result.success).toBe(true);
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
    });
  });

  describe('graph validation', () => {
    it('returns validation error before execution for invalid graph', async () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'Step 1', onSuccess: 'nonexistent' },
      ];

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Workflow graph validation failed');
      expect(result.error).toContain('DANGLING_REF');
      // No tool calls should have been made
      expect(mockExecuteToolCalls).not.toHaveBeenCalled();
    });
  });

  describe('step without tool', () => {
    it('proceeds to onSuccess without executing tool calls', async () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'No-op step', onSuccess: 's2' },
        { stepId: 's2', description: 'Real step', toolName: 'api__call', toolInput: {} },
      ];

      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: { done: true } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      expect(result.success).toBe(true);
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
    });
  });

  describe('tool name parsing via buildToolCallRequest', () => {
    it('correctly splits connector__action in tool call', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Test parsing',
          toolName: 'salesforce_prod__read_record',
          toolInput: { id: '123' },
        },
      ];

      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: {} }]);

      const state = makeState({ workflowSteps: steps });
      await callRunWorkflowLoop(state, 'test');

      const toolCall = mockExecuteToolCalls.mock.calls[0][1][0];
      expect(toolCall.connector).toBe('salesforce_prod');
      expect(toolCall.actionType).toBe('read_record');
      expect(toolCall.entityType).toBe('workflow');
    });
  });

  describe('failure routing', () => {
    it('routes to onFailure when step fails without retry', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Might fail',
          toolName: 'api__call',
          toolInput: {},
          onSuccess: 's2',
          onFailure: 's3',
        },
        { stepId: 's2', description: 'Success path', toolName: 'api__call', toolInput: {} },
        { stepId: 's3', description: 'Failure path', toolName: 'api__call', toolInput: {} },
      ];

      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'API error' }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { recovered: true } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'test');

      expect(result.success).toBe(true);
      // s1 failed -> s3 executed (2 total calls)
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
    });
  });

  // ── A resumed run still has to translate its steps ────────────────────
  //
  // The trigger-bound pass and the stale-alias remap REWRITE `step.toolName`
  // for the run and persist nothing, and every resume primitive reloads the
  // steps from `loadRuntimeConfig`. Both passes used to sit inside the
  // `if (!resumeState)` block labelled "structural graph validation, skipped on
  // resume" — so a resumed run got the AUTHORED names back with nothing left to
  // translate them, and `trigger__<op>` reached the gateway with `trigger` read
  // as a connector alias.
  //
  // Resuming after an operator approves a review, the approved call dispatches,
  // then the next step dies with `Connector 'trigger' is not in instruction's
  // allowed connectors`. `trigger` is the reserved pseudo-alias — no allowlist
  // could ever contain it.
  describe('step rewrites survive a resume', () => {
    const GITHUB_TOOL = 'github-dd4c4689__pull_request_read';

    /** The live catalog a GitHub-connected run holds. `method` is a closed set,
     *  and the resolver checks it against this schema rather than assuming. */
    const catalog = [
      {
        name: GITHUB_TOOL,
        input_schema: {
          properties: { method: { enum: ['get', 'get_diff', 'list_comments'] } },
        },
      },
    ];

    /** A run woken by a GitHub pull-request event, exactly as the dispatcher
     *  shapes it: normalized record under `inputData.eventData`. */
    function eventState(steps: WorkflowStep[]): ExecutionState {
      const state = makeState({ workflowSteps: steps });
      (state.context as any).trigger = { kind: 'connector_event', source: 'github' };
      (state.context as any).inputData = {
        eventData: { repository: 'acme/webapp', number: 42 },
      };
      return state;
    }

    function triggerBoundStep(): WorkflowStep {
      return { stepId: 's1', description: 'Read the PR that woke us', toolName: 'trigger__pr_get', toolInput: {} };
    }

    beforeEach(() => {
      (service as any).buildToolsSchema = jest.fn().mockResolvedValue(catalog);
    });

    it('resolves a trigger-bound step on a FRESH run (control)', async () => {
      const steps = [triggerBoundStep()];
      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = eventState(steps);
      const result = await callRunWorkflowLoop(state, 'test');

      expect(result.success).toBe(true);
      expect(steps[0].toolName).toBe(GITHUB_TOOL);
    });

    it('resolves a trigger-bound step on a RESUME too', async () => {
      // The regression. Same graph, same trigger — only the resume cursor
      // differs, and that alone used to leave the alias unresolved.
      const steps = [triggerBoundStep()];
      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = eventState(steps);
      const result = await (service as any).runAgentHybridLoop(
        state,
        'hitl-approved-resume',
        { eventData: { repository: 'acme/webapp', number: 42 } },
        {
          kind: 'hybrid-pause',
          pauseReason: 'delay',
          currentStepId: 's1',
          resumeAfterStepId: 's1',
          stepOutput: undefined,
          inputData: undefined,
          perStepRecoveries: {},
          totalRecoveries: 0,
          recoveryHistory: [],
        },
        stubAdapter,
      );

      expect(result.success).toBe(true);
      expect(steps[0].toolName).toBe(GITHUB_TOOL);
      // And the literal pseudo-alias never reached dispatch.
      const dispatched = mockExecuteToolCalls.mock.calls[0][1];
      expect(JSON.stringify(dispatched)).not.toContain('trigger__');
      expect(JSON.stringify(dispatched)).not.toContain('"connector":"trigger"');
    });

    it('addresses the resumed call at the entity that woke the run', async () => {
      // Identity arguments are built by the resolver, never authored — losing
      // the pass loses them too, so the call would have been half-addressed
      // even if the NAME had somehow survived.
      const steps = [triggerBoundStep()];
      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = eventState(steps);
      await (service as any).runAgentHybridLoop(
        state,
        'hitl-approved-resume',
        undefined,
        {
          kind: 'hybrid-pause', pauseReason: 'delay', currentStepId: 's1', resumeAfterStepId: 's1',
          stepOutput: undefined, inputData: undefined,
          perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [],
        },
        stubAdapter,
      );

      expect(steps[0].toolInput).toMatchObject({
        owner: 'acme', repo: 'webapp', pullNumber: 42, method: 'get',
      });
    });

    it('refuses a resumed trigger-bound step that cannot be resolved', async () => {
      // Fails CLOSED on resume, and NOT on a fresh run — see the sibling case
      // below, and the skip branch in service.ts for why the two differ.
      //
      // On a fresh run, no trigger is a fact about how the run started, and the
      // event-specific steps are skipped so the rest of the graph still runs. On
      // a resume the same emptiness more likely means the trigger was lost in
      // the pause, and skipping would silently not do the work. Dispatching
      // `trigger__…` as a connector name is what neither may do.
      const steps = [triggerBoundStep()];
      const state = makeState({ workflowSteps: steps });   // no trigger at all

      const result = await (service as any).runAgentHybridLoop(
        state,
        'hitl-approved-resume',
        undefined,
        {
          kind: 'hybrid-pause', pauseReason: 'delay', currentStepId: 's1', resumeAfterStepId: 's1',
          stepOutput: undefined, inputData: undefined,
          perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [],
        },
        stubAdapter,
      );

      expect(result.success).toBe(false);
      expect(result.failureClass).toBe('validation');
      expect(mockExecuteToolCalls).not.toHaveBeenCalled();
    });

    it('skips, rather than refuses, the same step on a FRESH run', async () => {
      // The counterpart. One trigger-bound step used to make the ENTIRE graph
      // event-only: a cron or manual fire of the same workflow stopped at step
      // zero instead of running the steps with nothing to do with the trigger.
      const steps = [triggerBoundStep()];
      const state = makeState({ workflowSteps: steps });   // no trigger at all

      const result = await (service as any).runAgentHybridLoop(
        state, 'manual run', undefined, undefined, stubAdapter,
      );

      expect(result.failureClass).not.toBe('validation');
      // Skipped, never dispatched — `trigger__…` must not reach the gateway as
      // a connector name on either path.
      expect(mockExecuteToolCalls).not.toHaveBeenCalled();
      expect((steps[0] as { __triggerBoundSkip?: string }).__triggerBoundSkip).toBeTruthy();
    });

    it('still skips the graph VALIDATION on resume', async () => {
      // The checks were correctly skipped and must stay skipped: only the
      // rewrites moved. A graph that fails a fresh run resumes without
      // complaint.
      //
      // The vehicle is a DANGLING REFERENCE rather than an unknown tool. An
      // unknown tool no longer fails a fresh run — it degrades that step and
      // escalates at the end of the graph — so it can no longer show the
      // fresh/resume difference this test exists for. A structural defect still
      // can. A DUPLICATE STEP ID is the one used here: it fails validation
      // outright, and it is harmless to a resume, which looks a step up by id
      // and finds the first. A dangling reference would fail the resume too,
      // for a different reason, and prove nothing about validation.
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'First', toolName: 'note_save', toolInput: {} },
        { stepId: 's1', description: 'Same id', toolName: 'note_save', toolInput: {} },
      ];
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: { ok: 1 } }]);

      const fresh = await callRunWorkflowLoop(makeState({ workflowSteps: [...steps] }), 'test');
      expect(fresh.success).toBe(false);
      expect(fresh.error).toContain('validation failed');

      const resumed = await (service as any).runAgentHybridLoop(
        makeState({ workflowSteps: [...steps] }),
        'hitl-approved-resume',
        undefined,
        {
          kind: 'hybrid-pause', pauseReason: 'delay', currentStepId: 's1', resumeAfterStepId: 's1',
          stepOutput: undefined, inputData: undefined,
          perStepRecoveries: {}, totalRecoveries: 0, recoveryHistory: [],
        },
        stubAdapter,
      );
      expect(resumed.success).toBe(true);
    });
  });

  // One step's tool going missing costs that step, not the run.
  describe('a step whose tool cannot be resolved', () => {
    it('degrades one unresolvable step instead of failing the whole run', async () => {
      // A connector reconnected overnight mints a new alias, and every step
      // naming the old one stops resolving. Failing the graph means a workflow
      // that worked yesterday does nothing today through no change of its own.
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'read the inbox', toolName: 'google-mail-deadbeef__get_thread', onSuccess: 's2' },
        { stepId: 's2', description: 'note it', toolName: 'note_save', toolInput: { content: 'x' } },
      ];
      // A non-empty catalog, because the membership check is skipped against an
      // empty one — an empty catalog means it could not be loaded, not that the
      // agent holds nothing.
      // Only note_save: with a surviving google-mail alias in the catalog the
      // step would be REMAPPED, not degraded — that is the reconnect path
      // resolveStepToolName already handles, and a different case entirely.
      (service as any).buildToolsSchema = jest.fn().mockResolvedValue([{ name: 'note_save' }]);
      mockExecuteToolCalls.mockResolvedValue([{ id: 't', success: true, data: { ok: true } }]);

      const result = await callRunWorkflowLoop(makeState({ workflowSteps: steps }), 'go');

      // The run did not die at validation...
      expect(result.failureClass).not.toBe('validation');
      // ...s2 still ran...
      expect(mockExecuteToolCalls).toHaveBeenCalled();
      // ...and the run does NOT report clean success for work it did not do.
      expect(result.escalated).toBe(true);
      expect(result.terminalState).toBe('escalated');
      // And the step itself carries WHY, so the escalation can name it. (The
      // escalation is written by a module-level createEscalation, not a method,
      // so it is not observable through the service stub.)
      expect((steps[0] as { __unresolvableTool?: string }).__unresolvableTool)
        .toContain('UNRESOLVABLE_TOOL');
    });

    it('still fails the run on a structural defect, which has no coherent subset', async () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'a', toolName: 'note_save', toolInput: {}, onSuccess: 'nope' },
      ];
      (service as any).buildToolsSchema = jest.fn().mockResolvedValue([{ name: 'note_save' }]);

      const result = await callRunWorkflowLoop(makeState({ workflowSteps: steps }), 'go');

      expect(result.success).toBe(false);
      expect(result.failureClass).toBe('validation');
    });

  });


  // ── A stale draft review must not wedge the run ───────────────────────
  //
  // GitHub allows one pending review per PR per user. A run that died between
  // `pr_review_begin` and `pr_review_publish` left one open, and the next run's
  // create fails permanently — so it takes onFailure, completes "successfully",
  // and posts nothing. Forever, because no path in the graph can discard it.
  describe('a stale pending review is discarded and the create re-attempted', () => {
    const REVIEW_TOOL = 'github-dd4c4689__pull_request_review_write';
    const WEDGE = 'User can only have one pending review per pull request';

    function reviewStep(): WorkflowStep {
      return {
        stepId: 's7',
        description: 'Open the review',
        toolName: REVIEW_TOOL,
        toolInput: { owner: 'acme', repo: 'webapp', pullNumber: 42, method: 'create' },
      };
    }

    it('discards the stale draft, retries, and the step succeeds', async () => {
      mockExecuteToolCalls
        // The wedge. `retryable: false` — a permanent error, so the retry
        // counter rightly refuses to re-issue it; the repair is what unblocks.
        .mockResolvedValueOnce([{ id: '1', success: false, error: WEDGE, retryable: false }])
        .mockResolvedValueOnce([{ id: '1-discard', success: true, result: {} }])
        .mockResolvedValueOnce([{ id: '1', success: true, result: { id: 5045891406 } }]);

      const state = makeState({ workflowSteps: [reviewStep()] });
      const result = await callRunWorkflowLoop(state, 'review the PR');

      expect(result.success).toBe(true);
      // Three dispatches: blocked create, discard, successful create. With the
      // default maxAttempts of 1, a bare `continue` would have fallen out of the
      // loop after the discard and made exactly two.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);

      const discarded = mockExecuteToolCalls.mock.calls[1][1][0];
      expect(discarded.payload).toMatchObject({
        method: 'delete_pending', owner: 'acme', repo: 'webapp', pullNumber: 42,
      });
      const retried = mockExecuteToolCalls.mock.calls[2][1][0];
      expect(retried.payload).toMatchObject({ method: 'create' });
    });

    it('does not loop when the create keeps failing the same way', async () => {
      // At most one discard per step, or a persistently-failing create becomes a
      // discard/create loop against the vendor.
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: WEDGE, retryable: false }])
        .mockResolvedValueOnce([{ id: '1-discard', success: true, result: {} }])
        .mockResolvedValueOnce([{ id: '1', success: false, error: WEDGE, retryable: false }])
        .mockResolvedValue([{ id: '1', success: false, error: WEDGE, retryable: false }]);

      const state = makeState({ workflowSteps: [reviewStep()] });
      const result = await callRunWorkflowLoop(state, 'review the PR');

      // Escalates via the recovery LLM, per this suite's established semantics.
      expect(result.escalated).toBe(true);
      // THE claim: three dispatches, not an unbounded discard/create loop.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
    });

    it('reports the discard failure, not the create failure, when the discard fails', async () => {
      // "cannot open a review" sends the reader looking at permissions when the
      // real state is a draft that would not go away.
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: WEDGE, retryable: false }])
        .mockResolvedValueOnce([{ id: '1-discard', success: false, error: 'Resource not accessible by integration' }]);

      const { logger } = require('../../infrastructure/logging');
      const state = makeState({ workflowSteps: [reviewStep()] });
      await callRunWorkflowLoop(state, 'review the PR');

      // The step's own error is swallowed by the recovery escalation, so the
      // operator-facing record of WHY is the log line. It must name the discard.
      const errs = (logger.error as jest.Mock).mock.calls
        .map((c: unknown[]) => JSON.stringify(c)).join('\n');
      expect(errs).toContain('could not discard the stale pending review');
      expect(errs).toContain('Resource not accessible by integration');
      // Two dispatches: the blocked create and the failed discard. No third,
      // because a create against a slot that is still occupied would just fail.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
    });

    it('leaves an unrelated permanent failure alone', async () => {
      mockExecuteToolCalls
        .mockResolvedValue([{ id: '1', success: false, error: 'Bad credentials', retryable: false }]);

      const state = makeState({ workflowSteps: [reviewStep()] });
      await callRunWorkflowLoop(state, 'review the PR');

      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);   // no discard attempted
    });
  });


  // ── loop.over uses the same addressing as every other field ───────────
  //
  // Loops authored against the documented stepId-keyed model could not resolve
  // when this one field went straight to getByPath against the previous step's
  // output.
  describe('loop.over addressing', () => {
    it('iterates a collection addressed by stepId', async () => {
      const steps: WorkflowStep[] = [
        // Narrows to `review`, as a review step typically does, so
        // `stepOutputs.s5` is the CONTENTS of review and `steps.s5.findings`
        // has to reach inside it.
        {
          stepId: 's5', description: 'Analyse', toolName: 'api__analyse',
          toolInput: {}, outputField: 'review', onSuccess: 's8',
        },
        {
          stepId: 's8', description: 'Attach each finding', toolName: 'github__add_comment',
          toolInput: {}, loop: { over: '{{steps.s5.findings}}', itemVar: 'finding' },
        },
      ];
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: 's5', success: true, result: {
          review: { findings: [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }] },
        } }])
        .mockResolvedValue([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'review');

      expect(result.success).toBe(true);
      // s5, then three findings → three comment calls. Before the fix the loop
      // resolved to nothing, ran zero iterations, and failed into onFailure.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(4);
    });

    it('iterates a rooted path', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's3', description: 'Post to each channel', toolName: 'slack__send_message',
          toolInput: {}, loop: { over: 'output.plan.channels', itemVar: 'channel' },
        },
      ];
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'report', { plan: { channels: ['#eng', '#ops'] } });

      expect(result.success).toBe(true);
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
    });

    it('runs a REASONING step once per item, with the item in its prose', async () => {
      // The branch that did not exist. `executeLoopStep`'s per-item body was
      // `if (step.toolName)` with no else, so this graph used to walk three
      // items, execute nothing, and report success — the fabricated success
      // INV-TR-004 forbids.
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'List them', toolName: 'api__list', toolInput: {}, onSuccess: 's2' },
        {
          stepId: 's2', type: 'llm_reason', description: 'Research {{item.name}} thoroughly',
          loop: { over: '{{steps.s1.names}}', itemVar: 'competitor', collect: true },
        },
      ];
      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: {
        names: [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }],
      } }]);
      const invokeSpy = jest
        .spyOn(service as unknown as { invokeStepLLM: (...a: unknown[]) => Promise<{ output: unknown }> }, 'invokeStepLLM')
        .mockImplementation(async (..._a: unknown[]) => ({ output: { done: true } }));

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'sweep');

      expect(result.success).toBe(true);
      // Once per item, not once for the list.
      expect(invokeSpy).toHaveBeenCalledTimes(3);
      // And each call was handed ITS item — the last positional argument.
      const itemsSeen = invokeSpy.mock.calls.map((c) => c[c.length - 1]);
      expect(itemsSeen).toEqual([{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }]);
      invokeSpy.mockRestore();
    });

    it('a reasoning loop collects each item\'s output', async () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'List', toolName: 'api__list', toolInput: {}, onSuccess: 's2' },
        {
          stepId: 's2', type: 'llm_reason', description: 'Judge {{item}}', outputField: 'verdict',
          loop: { over: '{{steps.s1.names}}', collect: true },
        },
      ];
      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: { names: ['a', 'b'] } }]);
      let n = 0;
      const invokeSpy = jest
        .spyOn(service as unknown as { invokeStepLLM: (...a: unknown[]) => Promise<{ output: unknown }> }, 'invokeStepLLM')
        .mockImplementation(async () => ({ output: { verdict: `v${++n}` } }));

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'judge');

      expect(result.success).toBe(true);
      expect(invokeSpy).toHaveBeenCalledTimes(2);
      invokeSpy.mockRestore();
    });

    it('a reasoning loop finishes past a failed item when told the items are independent', async () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'List', toolName: 'api__list', toolInput: {}, onSuccess: 's2' },
        {
          stepId: 's2', type: 'llm_reason', description: 'Research {{item}}',
          loop: { over: '{{steps.s1.names}}', continueOnItemFailure: true },
        },
      ];
      mockExecuteToolCalls.mockResolvedValueOnce([{ id: '1', success: true, result: { names: ['a', 'b', 'c'] } }]);
      let n = 0;
      const invokeSpy = jest
        .spyOn(service as unknown as { invokeStepLLM: (...a: unknown[]) => Promise<{ output: unknown }> }, 'invokeStepLLM')
        .mockImplementation(async () => {
          n++;
          if (n === 2) throw new Error('that site would not load');
          return { output: { ok: true } };
        });

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'sweep');

      // All three attempted; the failure is recorded, not swallowed.
      expect(invokeSpy).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(true);
      invokeSpy.mockRestore();
    });

    it('an unresolvable collection does NOT take the author onFailure branch', async () => {
      // THE behaviour change. A loop whose collection never resolved ran its
      // body zero times — the step did not fail, it never happened. Routing
      // that down the author's failure branch is what published a code review
      // announcing findings it had not attached.
      //
      // s5 exists and runs; what it produces has no `findings`. That is the
      // RUN-TIME failure this pins, and it is the only shape left: a collection
      // naming a step the graph does not contain is now refused before step 1
      // by `UNRESOLVABLE_LOOP_COLLECTION`.
      const steps: WorkflowStep[] = [
        {
          stepId: 's5', description: 'Analyse', toolName: 'api__analyse',
          toolInput: {}, onSuccess: 's8',
        },
        {
          stepId: 's8', description: 'Attach findings', toolName: 'github__add_comment',
          toolInput: {}, loop: { over: '{{steps.s5.findings}}' }, onFailure: 's11',
        },
        { stepId: 's11', description: 'Publish the review', toolName: 'github__submit_review', toolInput: {} },
      ];
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'review');

      // Recovery, not onFailure — so s11 never publishes an empty review.
      expect(result.escalated).toBe(true);
      // s5 ran; s8's body and s11 did not.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
    });

    // A collection that RESOLVED and is the wrong shape runs the body zero times
    // exactly as an unresolvable one does, so it gets the same route. The two
    // used to part company here: an absent key threw TemplateResolutionError and
    // reached recovery, while a null or an object returned and took `onFailure`.
    //
    // Null is not a corner. The contract the producing step is handed ends "a
    // key you cannot determine must still be present, set to null", so a model
    // with nothing to iterate was INSTRUCTED into the one value that breaks the
    // loop — and the step that writes a battle card per competitor wrote none,
    // down its own failure branch, with the run reporting a digest.
    for (const [shape, produced] of [
      ['null', { findings: null }],
      ['an object', { findings: { a: 1 } }],
      ['a string', { findings: 'two findings' }],
      ['a number', { findings: 2 }],
    ] as Array<[string, Record<string, unknown>]>) {
      it(`a collection that resolved to ${shape} does NOT take the author onFailure branch`, async () => {
        const steps: WorkflowStep[] = [
          {
            stepId: 's5', description: 'Analyse', toolName: 'api__analyse',
            toolInput: {}, onSuccess: 's8',
          },
          {
            stepId: 's8', description: 'Attach findings', toolName: 'github__add_comment',
            toolInput: {}, loop: { over: '{{steps.s5.findings}}' }, onFailure: 's11',
          },
          { stepId: 's11', description: 'Publish the review', toolName: 'github__submit_review', toolInput: {} },
        ];
        mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: produced }]);

        const state = makeState({ workflowSteps: steps });
        const result = await callRunWorkflowLoop(state, 'review');

        expect(result.escalated).toBe(true);
        // The LOOP's own error, not a template resolution failure: the path
        // resolved, so this is the branch that used to return and take
        // `onFailure`. Without this the four cases could pass on the older
        // route and prove nothing about the change.
        expect(result.error).toContain('loops over');
        // s5 ran; s8's body and s11 did not.
        expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
      });
    }

    // ── a tool_call step's own toolInputTemplate ────────────────────────
    //
    // The contract-defect rule's own worked example is a TOOL_CALL step:
    // a support agent's s1 reads the thread via
    // `{{input.message.threadId}}`, and on a companion-cron run there is no
    // `input.message`. The rule says that step was never attempted and must not
    // take the author's business-failure branch.
    //
    // It did anyway. `applyTemplate` throws TemplateResolutionError, and the
    // catch around the tool_call site logged it and returned a plain
    // `{success:false, error: string}` — so the caller threw an untyped Error
    // and `isContractDefect` could never see what it was. The classifier was
    // intact and the type was destroyed one frame below it.
    it('a tool_call template that cannot resolve does NOT take the author onFailure branch', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's4', description: 'Resolve the docs', toolName: 'api__resolve',
          toolInput: {}, onSuccess: 's8',
        },
        {
          stepId: 's8', description: 'Overwrite the snapshot', toolName: 'google-docs__update',
          toolInputTemplate: '{"document_id":"{{steps.s4.snapshot_doc_id}}"}', onFailure: 's9',
        },
        { stepId: 's9', description: 'Write the cards', toolName: 'google-docs__create', toolInput: {} },
      ];
      // s4 ran and recorded a value with no `snapshot_doc_id` in it.
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'sweep');

      // Recovery, not onFailure: s9 does not run on a snapshot that was never
      // written. The call count is the discriminator — `escalated` is true
      // either way, because a step routed to onFailure joins the unsatisfied
      // set and the graph end escalates on that too.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
      expect(result.escalated).toBe(true);
    });

    it('a tool_call template that resolved to NULL is still the author\'s branch', async () => {
      // The deliberate exception, preserved: a null is the producing step having
      // RUN and reported nothing, which is exactly what an author's
      // "update it, or create it if missing" branch answers.
      const steps: WorkflowStep[] = [
        {
          stepId: 's4', description: 'Resolve the docs', toolName: 'api__resolve',
          toolInput: {}, onSuccess: 's8',
        },
        {
          stepId: 's8', description: 'Overwrite the snapshot', toolName: 'google-docs__update',
          toolInputTemplate: '{"document_id":"id-{{steps.s4.snapshot_doc_id}}"}', onFailure: 's9',
        },
        { stepId: 's9', description: 'Create the snapshot', toolName: 'google-docs__create', toolInput: {} },
      ];
      mockExecuteToolCalls.mockResolvedValue([
        { id: '1', success: true, result: { snapshot_doc_id: null } },
      ]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'sweep');

      // s4, then the author's branch s9 — which is the step that creates it.
      // This is the case the carve-out exists for, and it is the control that
      // shows the fix above narrows to resolution failures rather than sending
      // every template error to recovery.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
    });

    it('an EMPTY array is a legitimate answer and is not a defect', async () => {
      // The other half of the same property, and the reason the prompt tells an
      // iterated key to use `[]`: a producing step with nothing to iterate has
      // reported a real result. The loop runs no body, the step succeeds, and
      // the graph goes on through onSuccess.
      const steps: WorkflowStep[] = [
        {
          stepId: 's5', description: 'Analyse', toolName: 'api__analyse',
          toolInput: {}, onSuccess: 's8',
        },
        {
          stepId: 's8', description: 'Attach findings', toolName: 'github__add_comment',
          toolInput: {}, loop: { over: '{{steps.s5.findings}}' }, onSuccess: 's11', onFailure: 's11',
        },
        { stepId: 's11', description: 'Publish the review', toolName: 'github__submit_review', toolInput: {} },
      ];
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: { findings: [] } }]);

      const state = makeState({ workflowSteps: steps });
      const result = await callRunWorkflowLoop(state, 'review');

      expect(result.escalated).toBeFalsy();
      // s5 and s11. s8's body ran zero times because there was nothing in it.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
    });
  });


  // ── the identity arguments survive into every loop iteration ─────────
  //
  // Declared scope clears a step only when the call names the entity that woke
  // the run, and for a trigger-bound step those arguments are built by
  // `resolveTriggerBoundTool` onto `step.toolInput` — never authored, because
  // the distiller does not know which host will fire. If the loop dropped them
  // per iteration, `targetsTriggerEntity` would answer false and the Code
  // Reviewer's findings would gate one card at a time, which is the exact
  // outcome the declared-scope work exists to remove.
  describe('loop iterations carry the trigger identity', () => {
    it('merges step.toolInput into every iteration', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's8',
          description: 'Attach each finding',
          toolName: 'github-dd4c4689__add_comment_to_pending_review',
          // What resolveTriggerBoundTool leaves on the step: identity, not semantics.
          toolInput: { owner: 'acme', repo: 'webapp', pullNumber: 42 },
          toolInputTemplate: '{"body": {{item.file}}}',
          loop: { over: 'findings', itemVar: 'item' },
        },
      ];
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: steps });
      await callRunWorkflowLoop(state, 'review', { findings: [{ file: 'a.ts' }, { file: 'b.ts' }] });

      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
      for (const c of mockExecuteToolCalls.mock.calls) {
        expect(c[1][0].payload).toMatchObject({
          owner: 'acme', repo: 'webapp', pullNumber: 42,
        });
      }
    });

    it('hands the gate the step on every iteration, not just the first', async () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's8', description: 'Attach each finding',
          toolName: 'github-dd4c4689__add_comment_to_pending_review',
          toolInput: { owner: 'acme', repo: 'webapp', pullNumber: 42 },
          loop: { over: 'findings' },
        },
      ];
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: steps });
      await callRunWorkflowLoop(state, 'review', { findings: [1, 2, 3] });

      // Third argument is the declared step. Present on each dispatch, or the
      // second finding onward would gate while the first did not.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
      for (const c of mockExecuteToolCalls.mock.calls) {
        expect(c[2]).toMatchObject({ stepId: 's8' });
      }
    });
  });


  // ── independent items: one failure must not discard the rest ──────────
  //
  // A loop over independent items — attach each finding, post to each channel —
  // lost EVERY item when one failed, because the first failure returned from
  // the whole step. A review is the worked example: three findings, one line
  // anchor GitHub would not accept, and a review published
  // "Blocking issues: 1, Suggestions: 2" with nothing attached to the diff.
  describe('continueOnItemFailure', () => {
    function attachStep(over = 'findings'): WorkflowStep {
      return {
        stepId: 's8',
        description: 'Attach each finding',
        toolName: 'github__add_comment',
        toolInput: {},
        loop: { over, continueOnItemFailure: true },
      };
    }

    it('finishes the independent items when one fails', async () => {
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'line not in diff' }])
        .mockResolvedValueOnce([{ id: '2', success: true, result: { ok: 1 } }])
        .mockResolvedValueOnce([{ id: '3', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: [attachStep()] });
      const result = await callRunWorkflowLoop(state, 'review', { findings: [1, 2, 3] });

      // All three attempted. Under the old rule the second and third were never
      // tried, so two good findings were lost to one bad one.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(true);
    });

    it('does NOT report plain success when an item was lost', async () => {
      // Partial completion is not completion. The step joins the unsatisfied
      // set, which the graph-end check turns into an escalation, so the
      // operator learns which finding is missing.
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'line not in diff' }])
        .mockResolvedValue([{ id: '2', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: [attachStep()] });
      const result = await callRunWorkflowLoop(state, 'review', { findings: [1, 2] });

      expect(result.escalated).toBe(true);
    });

    it('fails the step when EVERY item fails', async () => {
      // Running to the end of a list without a single success is not partial
      // completion, it is failure that happened to be iterated.
      mockExecuteToolCalls.mockResolvedValue([{ id: '1', success: false, error: 'line not in diff' }]);

      const state = makeState({ workflowSteps: [attachStep()] });
      const result = await callRunWorkflowLoop(state, 'review', { findings: [1, 2, 3] });

      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
      expect(result.escalated).toBe(true);
    });

    it('with collect, a failed item is in the list as its own result and nothing is escalated', async () => {
      // A check of each site that records the ones that fail: every item was
      // attempted, and the failure is the item's finding, sitting at its place
      // in the collected list as `{ item, error }`.
      const check: WorkflowStep = {
        stepId: 's10', description: 'Check each site', toolName: 'api__fetch_site',
        toolInput: {}, loop: { over: 'sites', collect: true, continueOnItemFailure: true },
      };
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: true, result: { title: 'A' } }])
        .mockResolvedValueOnce([{ id: '2', success: false, error: 'Failed to fetch URL.' }])
        .mockResolvedValueOnce([{ id: '3', success: true, result: { title: 'C' } }]);

      const state = makeState({ workflowSteps: [check] });
      const result = await callRunWorkflowLoop(state, 'check', { sites: ['a', 'b', 'c'] });

      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(true);
      expect(result.escalated).toBeFalsy();
      expect(result.output).toEqual([{ title: 'A' }, { item: 'b', error: 'Failed to fetch URL.' }, { title: 'C' }]);
    });

    it('still aborts on the first failure by DEFAULT', async () => {
      // Unset means today's behaviour, so nothing changes for a sequence whose
      // steps depend on each other. The flag is opt-in per loop.
      const seq: WorkflowStep[] = [{
        stepId: 's8', description: 'Dependent sequence', toolName: 'api__call',
        toolInput: {}, loop: { over: 'findings' },
      }];
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: 'boom' }])
        .mockResolvedValue([{ id: '2', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: seq });
      await callRunWorkflowLoop(state, 'review', { findings: [1, 2, 3] });

      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(1);
    });
  });


  // ── a refused line anchor keeps the finding ───────────────────────────
  describe('review comment anchor fallback', () => {
    const REFUSAL = "Failed to add comment to pending review. Possible reasons:\n"
      + "- The line number doesn't exist in the pull request diff";

    function attach(): WorkflowStep {
      return {
        stepId: 's8', description: 'Attach each finding',
        toolName: 'github-dd4c4689__add_comment_to_pending_review',
        toolInput: { subjectType: 'line' },
        toolInputTemplate: '{"path": {{item.path}}, "line": {{item.line}}, "body": {{item.body}}}',
        loop: { over: 'findings', continueOnItemFailure: true },
      };
    }

    it('re-attaches the finding to its file when the line is refused', async () => {
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: REFUSAL }])
        .mockResolvedValueOnce([{ id: '1-file', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: [attach()] });
      const result = await callRunWorkflowLoop(state, 'review', {
        findings: [{ path: 'src/a.ts', line: 42, body: 'nit' }],
      });

      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(2);
      const retry = mockExecuteToolCalls.mock.calls[1][1][0];
      expect(retry.payload).toMatchObject({ path: 'src/a.ts', subjectType: 'file', body: 'nit' });
      expect(retry.payload).not.toHaveProperty('line');
      // The finding landed, so the step is NOT partially complete.
      expect(result.success).toBe(true);
      expect(result.escalated).toBeFalsy();
    });

    it('records the item as failed when the file-level retry is refused too', async () => {
      // A wrong guess can only cost what was already lost.
      mockExecuteToolCalls
        .mockResolvedValueOnce([{ id: '1', success: false, error: REFUSAL }])
        .mockResolvedValueOnce([{ id: '1-file', success: false, error: 'still no' }])
        .mockResolvedValue([{ id: '2', success: true, result: { ok: 1 } }]);

      const state = makeState({ workflowSteps: [attach()] });
      const result = await callRunWorkflowLoop(state, 'review', {
        findings: [{ path: 'src/a.ts', line: 42, body: 'a' }, { path: 'src/b.ts', line: 9, body: 'b' }],
      });

      // finding 1: attempt + downgrade. finding 2: attempt. The second finding
      // is still attempted — one bad anchor does not discard it.
      expect(mockExecuteToolCalls).toHaveBeenCalledTimes(3);
      expect(result.escalated).toBe(true);
    });
  });
});
