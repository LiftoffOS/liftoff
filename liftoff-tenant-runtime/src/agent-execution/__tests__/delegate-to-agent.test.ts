// delegateToAgent() unit tests
//
// delegateToAgent no longer assembles anything. It gates the delegation at the
// boundary (tenant scope, lifecycle, admission, canonical pause), then runs the
// child through executeTask — the same entry point a run started by a person, a
// schedule or a trigger uses. That is what makes the receiving team behave as
// itself: its own distilled system prompt, user instructions, memories, skills,
// connectors, model routing, oversight settings and HITL level all come from
// executeTask, none of them from the caller.
//
// So this suite spies on executeTask and asserts the CONTRACT delegateToAgent
// has with it: which values a parent is allowed to contribute, which it must not
// (an autonomy level, above all), and how the child's result is mapped back.
//
// It used to mock the adapter and assert the shape of a hand-rolled
// ExecutionContext — including `hitlLevel: 5`, with a comment calling that
// intended design. It was not intended: it meant a team the operator had set to
// approve every write performed unapproved writes the moment another team
// delegated to it.

const mockPoolQuery = jest.fn();
const mockGetAgent = jest.fn();
const mockCreateAdapter = jest.fn();

// --- Infrastructure mocks ---
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: mockPoolQuery })),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/pubsub', () => ({
  publisher: { publish: jest.fn().mockResolvedValue('msg-id') },
}));

// --- Agent lifecycle & service mocks ---
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({ getAgent: mockGetAgent })),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));

// --- Dispatcher mocks ---
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({ dispatch: jest.fn() }) }));
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: jest.fn().mockReturnValue({ execute: jest.fn() }) }));

// --- Adapter mock (replaces removed engine/factory + engine/hooks-builder) ---
jest.mock('../adapter', () => ({
  createAdapter: (...args: unknown[]) => mockCreateAdapter(...args),
}));

// --- Other service mocks ---
// Load-graph only. service.ts imports this module at top level, so SOMETHING
// must exist for the file to load — but no test here can reach the gate,
// because every test spies on executeTask, which is where the gate now lives.
// The stub used to matter (and to mislead): when delegateToAgent drove the
// adapter itself, this hardwired shouldGate:false silently swallowed any gate a
// fix added. Gate behaviour on the delegated path is asserted against the REAL
// hitl-enforcement module in delegation-child-identity.test.ts, which does not
// mock it.
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkHitlGate: jest.fn().mockResolvedValue({ shouldGate: false }) },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
jest.mock('../../memory', () => ({ memoryService: { retrieve: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../memory/embedding', () => ({ generateEmbedding: jest.fn().mockResolvedValue([]) }));
jest.mock('../../invocations', () => ({
  invocationsService: {
    createInvocation: jest.fn().mockResolvedValue({ id: 'child-inv-1', startedAt: new Date('2026-01-01T00:00:00Z') }),
    completeInvocation: jest.fn().mockResolvedValue(undefined),
    failInvocation: jest.fn().mockResolvedValue(undefined),
    markBillingQueued: jest.fn().mockResolvedValue(undefined),
    getMessages: jest.fn().mockResolvedValue([]),
    getInvocation: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('../../streaming', () => ({ streamingService: { sendEvent: jest.fn(), close: jest.fn() } }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../connectors/manifest-repository', () => ({ connectorManifestRepository: { findByConnectorId: jest.fn().mockResolvedValue(null) } }));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn().mockReturnValue(undefined), getToolSchemas: jest.fn().mockResolvedValue([]) }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../run-state/service', () => ({
  agentRunStateService: {
    create: jest.fn().mockResolvedValue({}), load: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined), appendItem: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]),
  buildSkillContextBlock: jest.fn().mockReturnValue(''), buildSkillTextBlock: jest.fn().mockReturnValue(''),
}));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: { maybeTrigger: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({
  calculateCost: jest.fn().mockReturnValue({ costUsd: 0, inputPricePerMillion: 3, outputPricePerMillion: 15 }),
  getModelPricing: jest.fn().mockReturnValue({ inputPricePerMillion: 3, outputPricePerMillion: 15 }),
}));
jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn().mockReturnValue([]) }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('') }));

import { BLOCKING_CHILD_WALL_CLOCK_MS } from '../constants';
import { AgentExecutionService } from '../service';
import { invocationsService } from '../../invocations';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeInstructionRow() {
  return {
    id: 'inst-1', tenant_id: 'tenant-1', agent_id: 'agent-1', version: 1, status: 'active',
    instruction: JSON.stringify({ allowedConnectors: [], allowedActionTypes: ['*'] }),
    validation_result: null, preview: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', instructions_md: null,
  };
}

function makeAgentRow() {
  return {
    agent_type: 'agent', hitl_level: 3,
    model_config: JSON.stringify({ provider: 'anthropic' }),
    exec_config: JSON.stringify({}), memory_scope: JSON.stringify({}),
    workflow_steps: null, engine_config: JSON.stringify({ type: 'claude-agent-sdk' }), workflow_steps_hash: null,
  };
}

type AdapterEvent = Record<string, unknown>;

/** Mock adapter whose invoke() yields the given event sequence. */
function makeAdapter(events: AdapterEvent[]) {
  return {
    registerToolCatalog: jest.fn(),
    registerHitlGate: jest.fn(),
    registerAnomalyHandler: jest.fn(),
    registerTrajectoryRecorder: jest.fn(),
    invoke: jest.fn().mockImplementation(() => (async function* () { for (const e of events) yield e; })()),
  };
}

const SUCCESS_EVENTS: AdapterEvent[] = [
  { type: 'assistant_message', content: [{ type: 'text', text: 'Delegate result' }] },
  { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
  { type: 'completion', outcome: 'success' },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentExecutionService.delegateToAgent()', () => {
  let service: AgentExecutionService;
  let execSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockReset();
    service = new AgentExecutionService();

    // executeTask is the seam. Everything the child IS gets built in there, so
    // the unit under test is what delegateToAgent hands it and what it does with
    // what comes back.
    execSpy = jest.spyOn(service as any, 'executeTask').mockResolvedValue({
      success: true,
      output: 'Delegate result',
      usage: { inputTokens: 100, outputTokens: 50 },
      toolCallsExecuted: 1,
      reasoningSteps: 1,
    });

    // Default: agent exists, is ACTIVE, belongs to the calling tenant, is
    // admissible, and is not paused canonically — i.e. every delegation-boundary
    // gate passes, so each test below exercises what it is actually about.
    // Tests that care about a gate override the relevant one locally.
    //
    // tenantId is load-bearing: getAgent is keyed by id alone and is not
    // tenant-scoped, so delegateToAgent scopes it itself. A fixture without a
    // tenantId is a cross-tenant agent as far as that check is concerned.
    mockGetAgent.mockResolvedValue({ id: 'agent-1', tenantId: 'tenant-1', lifecycle: 'ACTIVE' });
    (service as any).admissionService = {
      checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    jest.spyOn(service as any, 'verifyCanonicalAgentStatus').mockResolvedValue('active');
    // Routed on SQL text, not positional once-queues. The governed gate added
    // pool queries between the two loads (tenant config, spawn pause, capacity,
    // the delegation_active registry), and getTenantRuntimeConfig carries a
    // module-level 60s cache — so WHICH call reaches the pool depends on cache
    // state from earlier tests, and a positional queue hands the agent row to
    // whatever query happens to run second. Routing makes each query get its
    // own answer regardless of order or count.
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (/FROM compiled_instructions/i.test(sql)) return { rows: [makeInstructionRow()] };
      if (/FROM agents\b/i.test(sql)) return { rows: [makeAgentRow()] };
      // spawn pause: no rows = not paused. capacity: count 0 = room.
      if (/FROM delegation_active/i.test(sql)) return { rows: [{ n: '0' }] };
      // depth: the parent exists at depth 0, so the child resolves to 1. A
      // missing row is now an ERROR (parent_not_found), so the tests that pass
      // parentInvocationId need the row to exist.
      if (/FROM invocations/i.test(sql)) return { rows: [{ delegation_depth: 0 }] };
      return { rows: [] };
    });

  });

  it('returns output and usage from a successful run', async () => {
    const result = await service.delegateToAgent({
      collect: true,
      agentId: 'agent-1', tenantId: 'tenant-1', objective: 'Summarize this document',
    });
    expect(result.output).toBe('Delegate result');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });

  // --- Delegation boundary gates ------------------------------------------
  // A delegated child is a full run of that agent, so it faces the gates a run
  // started by a person faces. Before these existed, the only check was that the
  // agent row existed: a suspended tenant, a frozen tenant and a team the
  // customer had explicitly paused all still executed paid LLM work as long as
  // some other agent asked them to.

  it('refuses a delegation target belonging to another tenant', async () => {
    mockGetAgent.mockResolvedValue({ id: 'agent-1', tenantId: 'other-tenant', lifecycle: 'ACTIVE' });
    await expect(
      service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'x',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('refuses a delegation target that is not ACTIVE', async () => {
    mockGetAgent.mockResolvedValue({ id: 'agent-1', tenantId: 'tenant-1', lifecycle: 'PAUSED' });
    await expect(
      service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'x',
      }),
    ).rejects.toThrow(/not in ACTIVE state/);
  });

  it('refuses delegation when admission denies the tenant', async () => {
    // The case that matters: a billing-suspended tenant should not get paid LLM
    // work through the side door of one agent delegating to another.
    (service as any).admissionService = {
      checkAdmission: jest.fn().mockResolvedValue({
        allowed: false,
        reason: 'billing_suspended',
      }),
    };
    await expect(
      service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'x',
      }),
    ).rejects.toThrow(/admission denied: billing_suspended/);
  });

  it('refuses a target the customer paused, even when the local mirror says ACTIVE', async () => {
    // Local agents.lifecycle drifts from the customer's intent (stale events,
    // out-of-order delivery). The canonical check is the definitive one, and it
    // heals the local mirror so the scheduler stops too.
    const pauseSpy = jest.fn().mockResolvedValue(undefined);
    (service as any).agentLifecycle.pause = pauseSpy;
    jest.spyOn(service as any, 'verifyCanonicalAgentStatus').mockResolvedValue('paused');
    await expect(
      service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'x',
      }),
    ).rejects.toThrow(/paused by user/);
    expect(pauseSpy).toHaveBeenCalledWith('agent-1');
  });

  it('throws when the agent is not found', async () => {
    mockGetAgent.mockResolvedValue(null);
    await expect(
      service.delegateToAgent({ collect: true, agentId: 'missing', tenantId: 'tenant-1', objective: 'test' }),
    ).rejects.toThrow('agent missing not found');
  });

  it('throws when no active instruction exists', async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // getActiveInstruction → empty
    await expect(
      service.delegateToAgent({ collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test' }),
    ).rejects.toThrow('no active instruction for agent agent-1');
  });

  it('throws when the child run fails', async () => {
    execSpy.mockResolvedValue({
      success: false, error: 'Tool execution failed',
      toolCallsExecuted: 0, reasoningSteps: 0,
    });
    await expect(
      service.delegateToAgent({ collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test' }),
    ).rejects.toThrow('Tool execution failed');
  });

  // The truncation guard. A child that ran out of room did not answer the
  // question it was given, and handing its partial text back as the answer lets
  // the parent report unfinished work as a conclusion.
  it('refuses to return a partial answer from a child that hit its ceiling', async () => {
    execSpy.mockResolvedValue({
      success: true,
      terminalState: 'limit_reached',
      output: 'I checked the first two of the eight repositories and',
      error: 'child reached its limit',
      toolCallsExecuted: 5, reasoningSteps: 5,
    });
    await expect(
      service.delegateToAgent({ collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test' }),
    ).rejects.toThrow(/limit/);
  });

  // --- What the child actually runs as -------------------------------------
  //
  // This block replaces an assertion that pinned `hitlLevel: 5` on a hand-rolled
  // ExecutionContext and documented it as intended design. It was not: it meant
  // a delegated child ran fully autonomous regardless of what the workspace or
  // the team's own Autonomy Override said, so a workspace set to approve every
  // write performed unapproved writes the moment another team delegated to it.
  //
  // The child now runs through executeTask, which resolves the child's OWN
  // level, oversight settings, persona, memories and skills. So the thing to
  // assert is no longer the shape of a context built here — it is that this
  // function delegates the assembly and inherits exactly what it should.

  it('runs the child through executeTask rather than assembling its own context', async () => {
    await service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
    });
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('does not force an autonomy level on the child', async () => {
    // The child's level is resolved inside executeTask from its own
    // autonomy_override falling back to the workspace default. Delegation must
    // not send one at all — sending any value here would be the same bug with a
    // different number.
    await service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
    });
    expect(execSpy.mock.calls[0][0].hitlLevel).toBeUndefined();
  });

  it('inherits exactly the seven values a parent is allowed to contribute', async () => {
    await service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
      parentInvocationId: 'parent-inv-1',
      delegationDepth: 1,
      parentTrustLevel: 'untrusted_inbound',
      purpose: 'reflection',
      triggeredByUserId: 'account-88',
    });
    const passed = execSpy.mock.calls[0][0];
    expect(passed).toMatchObject({
      parentInvocationId: 'parent-inv-1',
      delegationDepth: 1,
      trustLevel: 'untrusted_inbound',
      purpose: 'reflection',
      triggeredByUserId: 'account-88',
      triggeredBy: 'agent',
    });
  });

  it('passes the caller budget as an override, not as the configured budget', async () => {
    await service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test', maxTurns: 2,
    });
    expect(execSpy.mock.calls[0][0].maxTurnsOverride).toBe(2);
  });

  it('leaves the budget to the child\u2019s own configuration by default', async () => {
    // The old default was `?? 5`: every delegated child got five turns
    // regardless of how the receiving team was configured, while the detached
    // tool description promised "their own budget". No override means
    // executeTask uses the child's execConfig, clamped by role.
    await service.delegateToAgent({ collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test' });
    expect(execSpy.mock.calls[0][0].maxTurnsOverride).toBeUndefined();
  });

  it('bounds a blocking call with a budget a child can actually finish in', async () => {
    // 30s was the old bound and it was unachievable: a child pays for catalog
    // assembly, memory retrieval and a first model turn before doing any work,
    // so every blocking delegation timed out and the parent read the timeout as
    // the answer. The bound now matches the detached child path, which already
    // finalizes inside the 270s Cloud Task delivery deadline.
    await service.delegateToAgent({ collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test' });
    expect(execSpy.mock.calls[0][0].execTimeoutMsOverride).toBe(BLOCKING_CHILD_WALL_CLOCK_MS);
    expect(BLOCKING_CHILD_WALL_CLOCK_MS).toBeGreaterThan(30_000);
  });

  it('bypasses the per-agent lock so a fan-out does not serialise behind itself', async () => {
    // Concurrency is bounded by the delegation gate. Taking the lock would queue
    // eight tasks sent to one specialist one behind another, and would deadlock
    // outright when an agent delegates to itself.
    await service.delegateToAgent({ collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test' });
    expect(execSpy.mock.calls[0][0].bypassAgentLock).toBe(true);
  });

  it('threads the caller cancellation down to the child', async () => {
    // Not the caller's signal by identity: the child gets a COMPOSED signal
    // (caller abort OR the operator's delegation_active interrupt flag,
    // whichever fires first). Asserted MID-FLIGHT — the link is torn down when
    // the child finishes, because a caller abort after completion means
    // nothing — so the fake child stays running until it observes the abort.
    const controller = new AbortController();
    execSpy.mockImplementation(async (task: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        if (task.signal?.aborted) return resolve();
        task.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        success: false, error: 'aborted',
        toolCallsExecuted: 0, reasoningSteps: 0,
      };
    });
    const pending = service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
      signal: controller.signal,
    }).catch((err: Error) => err);

    // Let the boundary gates run and the child start.
    await new Promise((r) => setTimeout(r, 0));
    const childSignal = execSpy.mock.calls[0][0].signal as AbortSignal;
    expect(childSignal.aborted).toBe(false);

    controller.abort();
    expect(childSignal.aborted).toBe(true);
    await pending;
  });

  it('starts the child already aborted when the caller cancelled first', async () => {
    // addEventListener on a settled signal never fires, so pre-aborted callers
    // are the case a naive listener-only chain silently ignores.
    const controller = new AbortController();
    controller.abort();
    await service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
      signal: controller.signal,
    }).catch(() => undefined);
    const childSignal = execSpy.mock.calls[0][0].signal as AbortSignal;
    expect(childSignal.aborted).toBe(true);
  });

  it('gives the child UUID workflow and task identity, not a readable string', async () => {
    // These reach uuid columns downstream — the action ledger writes
    // actions.workflow_id / actions.task_id (both uuid) for every tool call, so
    // a readable string kills the child on its FIRST tool call with
    // `invalid input syntax for type uuid`: the child runs, reaches for a
    // connector, and errors with failure_class 'validation' after exactly one
    // tool call.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    await service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
    });
    const passed = execSpy.mock.calls[0][0] as { workflowId: string; taskId: string };
    expect(passed.workflowId).toMatch(UUID);
    expect(passed.taskId).toMatch(UUID);
    // And they are distinct: one id used for both would collapse two different
    // things in every downstream join.
    expect(passed.workflowId).not.toBe(passed.taskId);
  });

  it('links the child run to its parent for the trajectory too', async () => {
    // The invocation row and the trajectory row must agree about lineage. When
    // the delegated path's own trajectory write was deleted in favour of
    // executeTask, nothing carried the parent into executeTask's write, so
    // agent_trajectories.parent_invocation_id went NULL for every delegated
    // child while invocations.parent_invocation_id was set — the two records of
    // the same fact disagreeing. Asserted at the seam, since the write itself
    // is inside executeTask.
    await service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
      parentInvocationId: 'parent-inv-1',
    });
    expect(execSpy.mock.calls[0][0].parentInvocationId).toBe('parent-inv-1');
  });

  it('passes the objective through to the child run', async () => {
    await service.delegateToAgent({
      collect: true,
      agentId: 'agent-1', tenantId: 'tenant-1', objective: 'Classify this support ticket',
    });
    expect(execSpy.mock.calls[0][0].objective).toBe('Classify this support ticket');
  });

  it('bubbles child anomalies back to the caller', async () => {
    execSpy.mockResolvedValue({
      success: true, output: 'done', toolCallsExecuted: 1, reasoningSteps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      anomalies: [{ kind: 'tool_error', context: { toolName: 'gmail__send' } }],
    });
    const result = await service.delegateToAgent({
      collect: true, agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
    });
    expect(result.anomalies).toHaveLength(1);
  });

  // A delegation does not change who asked for the work.
  describe('human attribution inheritance', () => {
    const getInvocation = invocationsService.getInvocation as jest.Mock;

    it('inherits the parent run\u2019s human, resolved here rather than at the call site', async () => {
      getInvocation.mockResolvedValue({ id: 'parent-inv-1', triggeredByUserId: 'account-77' });

      // Note what this call does NOT pass: the two singular delegate_to_agent
      // tool call sites hand over parentInvocationId and nothing about the human.
      await service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
        parentInvocationId: 'parent-inv-1',
      });

      expect(getInvocation).toHaveBeenCalledWith('parent-inv-1', 'tenant-1');
      expect(execSpy.mock.calls[0][0].triggeredByUserId).toBe('account-77');
    });

    it('leaves the child unattributed when the parent had no human', async () => {
      getInvocation.mockResolvedValue({ id: 'parent-inv-1', triggeredByUserId: null });

      await service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
        parentInvocationId: 'parent-inv-1',
      });

      expect(execSpy.mock.calls[0][0].triggeredByUserId).toBeUndefined();
    });

    it('takes a pre-resolved value without a second read (the fan-out path)', async () => {
      await service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
        parentInvocationId: 'parent-inv-1',
        triggeredByUserId: 'account-88',
      });

      expect(getInvocation).not.toHaveBeenCalled();
      expect(execSpy.mock.calls[0][0].triggeredByUserId).toBe('account-88');
    });

    it('inherits the operator too, so the audit trail survives a delegation hop', async () => {
      // A child dispatched by a support-driven parent is support-driven. If the
      // marker stopped at the first hop, "what did support do here" would
      // silently under-report every fan-out.
      getInvocation.mockResolvedValue({
        id: 'parent-inv-1',
        triggeredByUserId: 'account-77',
        impersonatedBy: 'operator-1',
      });

      await service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
        parentInvocationId: 'parent-inv-1',
      });

      expect(execSpy.mock.calls[0][0].impersonatedBy).toBe('operator-1');
    });

    it('leaves the child unmarked when the parent was not a support run', async () => {
      getInvocation.mockResolvedValue({
        id: 'parent-inv-1',
        triggeredByUserId: 'account-77',
        impersonatedBy: null,
      });

      await service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
        parentInvocationId: 'parent-inv-1',
      });

      expect(execSpy.mock.calls[0][0].impersonatedBy).toBeUndefined();
    });

    it('takes a pre-resolved operator without a second read, like the human', async () => {
      // The fan-out resolves both from one parent read and passes both. `null`
      // has to mean "resolved, and there was none" here, or N children would
      // cost N reads of the same row.
      await service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
        parentInvocationId: 'parent-inv-1',
        triggeredByUserId: 'account-88',
        impersonatedBy: 'operator-1',
      });

      expect(getInvocation).not.toHaveBeenCalled();
      expect(execSpy.mock.calls[0][0].impersonatedBy).toBe('operator-1');
    });

    it('still runs the child when the parent lookup fails', async () => {
      getInvocation.mockRejectedValue(new Error('pool exhausted'));

      const result = await service.delegateToAgent({
        collect: true,
        agentId: 'agent-1', tenantId: 'tenant-1', objective: 'test',
        parentInvocationId: 'parent-inv-1',
      });

      expect(result.output).toBe('Delegate result');
      expect(execSpy.mock.calls[0][0].triggeredByUserId).toBeUndefined();
    });
  });
});
