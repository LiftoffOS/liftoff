// A synthesized escalate reason does not reach the customer's review queue.
//
// An `escalate` decision usually carries a reason the model wrote for a person,
// and that belongs in the queue. Two of them are assembled by this code when the
// recovery advisor itself fails — it was unreachable, or it answered with
// nothing parseable — and those read like
// `recovery_llm_unavailable: Provider 'openrouter' is not available. Available:
// anthropic-vertex, anthropic, google, openai`. That sat in a customer's review
// queue for days beside approvals they actually had to answer, and there is
// nothing for them to accept or deny in it.
//
// escalationKind carries that distinction from where the reason is built to
// where the escalation row is written.

// The behavioural block at the bottom drives the workflow-path `escalate`
// branch through the real service; these are the seams it crosses.
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const createEscalationMock = jest.fn().mockResolvedValue('esc-1');
jest.mock('../engine/escalation-helper', () => ({
  createEscalation: (...a: unknown[]) => createEscalationMock(...a),
  escalationKindById: jest.fn().mockResolvedValue(null),
  escalationThreadTitle: jest.fn(),
}));
jest.mock('../../streaming', () => ({
  streamingService: { emitAgentStatus: jest.fn(), emitStepResult: jest.fn(), emitHitlRequired: jest.fn(), emitHitlRejected: jest.fn() },
}));
jest.mock('../../agent-chat/agent-slack-client', () => ({ postReviewDm: jest.fn(), listAgentAssignees: jest.fn().mockResolvedValue([]) }));
jest.mock('../../tool-gateway/agent-slack-tool-catalog', () => ({ SLACK_OUTBOUND_TOOL_NAMES: new Set() }));
jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn(), emitAgentStatus: jest.fn(), emitStepResult: jest.fn() },
}));
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: { checkGate: jest.fn(), createApprovalRequest: jest.fn() },
  HitlGateError: class HitlGateError extends Error {},
  ModelTool: {},
}));
jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: () => ({}), complete: jest.fn(), chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/service', () => ({ CoordinatorService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: () => ({}) }));
jest.mock('../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({ setCredentialService: jest.fn(), routeToolCall: jest.fn() })),
}));
jest.mock('../../tool-gateway/dispatcher', () => ({ getToolGatewayDispatcher: () => ({}) }));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({ updateRuntimeStatus: jest.fn(), getAgent: jest.fn() })),
}));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../memory', () => ({ memoryService: { retrieve: jest.fn(), save: jest.fn() }, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: { getMessages: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/service', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../tool-interceptor', () => ({ interceptToolCalls: jest.fn((calls) => calls) }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifests: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: jest.fn().mockResolvedValue({ taskName: 'mock-task' }) }));
const mockPool = {
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() })),
};
jest.mock('../../infrastructure/database', () => ({ getPoolForService: jest.fn(() => mockPool), getPool: jest.fn(() => mockPool), pool: mockPool }));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: { updateCloudTaskName: jest.fn(), markFiredByInvocationId: jest.fn().mockResolvedValue(1), markErrored: jest.fn() },
  mapRow: (row: Record<string, unknown>) => ({ id: row.id }),
}));

import type { ReasoningResult, ExecutionState, WorkflowStep, AnomalyContext } from '../types';
import { AgentExecutionService } from '../service';

describe('escalationKind', () => {
  // The expression both escalate branches use to pick a surface.
  const surfaceFor = (decision: Pick<ReasoningResult, 'whoCanUnblock' | 'escalationKind'>) =>
    decision.escalationKind ?? (decision.whoCanUnblock === 'customer' ? 'escalation' : 'system_internal');

  it('keeps a model-authored blocker the customer can clear customer-facing', () => {
    const decision: ReasoningResult = {
      thinking: '',
      decision: 'escalate',
      toolCalls: [],
      escalationReason: 'The spreadsheet needs an owner before I can write to it.',
      whoCanUnblock: 'customer',
    };

    expect(surfaceFor(decision)).toBe('escalation');
  });

  it('keeps an unreachable recovery provider off the queue', () => {
    const decision: ReasoningResult = {
      thinking: '',
      decision: 'escalate',
      toolCalls: [],
      escalationReason: "recovery_llm_unavailable: Provider 'openrouter' is not available",
      escalationKind: 'system_internal',
    };

    expect(surfaceFor(decision)).toBe('system_internal');
  });

  it('keeps an unparseable advisor answer off the queue', () => {
    const decision: ReasoningResult = {
      thinking: '',
      decision: 'escalate',
      toolCalls: [],
      escalationReason: 'recovery advisor returned no structured decision',
      escalationKind: 'system_internal',
    };

    expect(surfaceFor(decision)).toBe('system_internal');
  });
});

// Who can clear the blocker decides where it goes, and whether the run waits
// at all.
//
// "escalate = a human must act" was one audience covering two. A customer
// cannot fix a connector-id mismatch or an unreachable provider, and the
// recovery prompt actively told the model to escalate environmental faults —
// so their queue filled with things only we could act on. Silence routes to us:
// a model that cannot name who unblocks it has not established that anyone in
// the workspace can.
describe('whoCanUnblock decides the audience', () => {
  // The expressions the escalate branches use.
  const parks = (d: Pick<ReasoningResult, 'whoCanUnblock' | 'escalationKind'>) =>
    d.escalationKind === 'system_internal' ? false : d.whoCanUnblock === 'customer';
  const surfaceFor = (d: Pick<ReasoningResult, 'whoCanUnblock' | 'escalationKind'>) =>
    d.escalationKind ?? (d.whoCanUnblock === 'customer' ? 'escalation' : 'system_internal');

  it('parks the run when someone in the workspace can clear it', () => {
    expect(parks({ whoCanUnblock: 'customer' })).toBe(true);
  });

  it('does not park, and records operator-side, when only we can clear it', () => {
    expect(parks({ whoCanUnblock: 'platform' })).toBe(false);
    expect(surfaceFor({ whoCanUnblock: 'platform' })).toBe('system_internal');
  });

  it('treats an unattributed blocker as ours, not the customer\'s', () => {
    expect(parks({})).toBe(false);
    expect(surfaceFor({})).toBe('system_internal');
  });

  it('keeps a code-synthesized reason operator-side even if it claims otherwise', () => {
    // escalationKind is set at the synthesis site, not by the model, so it wins.
    const synthesized = { whoCanUnblock: 'customer' as const, escalationKind: 'system_internal' as const };
    expect(parks(synthesized)).toBe(false);
    expect(surfaceFor(synthesized)).toBe('system_internal');
  });
});

// The two synthesis sites have to actually set it, or the routing above is
// dead code. Read from source rather than executed, because reaching them
// through the engine needs a live provider, a workflow and a database.
describe('the synthesis sites set escalationKind', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'),
    'utf8',
  ) as string;

  it('marks recovery_llm_unavailable as internal', () => {
    const site = source.slice(source.indexOf('recovery_llm_unavailable: ${'));
    expect(site.slice(0, 400)).toContain("escalationKind: 'system_internal'");
  });

  it('marks the missing recovery decision as internal', () => {
    const site = source.slice(source.indexOf("escalationReason: 'recovery advisor returned no structured decision'"));
    expect(site.slice(0, 400)).toContain("escalationKind: 'system_internal'");
  });

  it('routes both escalate branches through the decision rather than a literal', () => {
    const branches = source.split("case 'escalate': {").slice(1);
    expect(branches.length).toBeGreaterThanOrEqual(2);
    for (const branch of branches) {
      const head = branch.slice(0, 2000);
      if (!head.includes('createEscalation')) continue;
      expect(head).toContain('kind: escalationKindFor(decision)');
    }
  });

  it('parks the run in both escalate branches before it can escalate', () => {
    const branches = source.split("case 'escalate': {").slice(1);
    for (const branch of branches) {
      const head = branch.slice(0, 2000);
      if (!head.includes('createEscalation')) continue;
      // The park check has to come FIRST: reaching createEscalation for a
      // blocker the customer could clear is the bug this prevents.
      expect(head.indexOf('customerCanUnblock(decision)')).toBeGreaterThan(-1);
      expect(head.indexOf('customerCanUnblock(decision)'))
        .toBeLessThan(head.indexOf('createEscalation'));
      expect(head).toContain('createClarificationPause');
    }
  });

  it('routes report_task_outcome escalations by audience too', () => {
    const site = source.slice(source.indexOf("reportedOutcome?.status === 'escalate'"));
    expect(site.slice(0, 900)).toContain('escalationKindFor({ whoCanUnblock: reportedOutcome.whoCanUnblock })');
  });

  it('records the action the model was asked for, on the terminal path as well', () => {
    // The model is asked for requestedAction on every escalate. Discarding it
    // here would make the request pointless on this path.
    const site = source.slice(source.indexOf("reportedOutcome?.status === 'escalate'"));
    expect(site.slice(0, 900)).toContain('requestedAction: reportedOutcome.requestedAction');
  });

  it('routes the [ESCALATE] marker by its audience, defaulting to us', () => {
    // A bare marker cannot name who unblocks it, and escalationKindFor treats
    // that silence as ours. [ESCALATE:customer] routes like any other
    // attributed blocker.
    const site = source.slice(source.indexOf("marker?.state === 'escalated'"));
    expect(site.slice(0, 900)).toContain('escalationKindFor({ whoCanUnblock: marker.whoCanUnblock })');
  });
});

// An operator record states the facts, deduplicates on them, and labels the
// opinion. A record whose reason is the advisor's sentence alone can read "the
// web fetching service could not retrieve any of the target URLs …
// connectivity" beside thirty successful fetches in the same step. Driven
// through the real dispatch so the record is what production
// writes: the fact line first, the advisor beneath it, the fingerprint and
// graph version on the row.
describe('a system_internal escalate records the facts first', () => {
  function makeState(steps: WorkflowStep[]): ExecutionState {
    return {
      context: {
        tenantId: 'tenant-1', agentId: 'agent-1', workflowId: 'wf-1', taskId: 'task-1',
        instructionVersion: 7,
        instruction: { systemPrompt: 'test', tools: [], guardrails: [] } as unknown as ExecutionState['context']['instruction'],
        traceId: 'trace-1', agentType: 'agent', hitlLevel: 0,
        modelConfig: {} as ExecutionState['context']['modelConfig'],
        execConfig: {}, memoryScope: {},
        workflowSteps: steps, threadId: 'thread-1', invocationId: 'inv-1',
      },
      reasoningSteps: 0, toolCallsExecuted: 3, startTime: new Date(), steps: [], conversationHistory: [],
      pendingToolCalls: [], completedToolCalls: [], toolFailureCounts: new Map(), injectedSkillIds: [],
    };
  }
  const step: WorkflowStep = { stepId: 's2', type: 'llm_reason', description: 'research', onSuccess: 's3' } as WorkflowStep;
  const loop = () => ({
    stepOutputs: {}, enteredSteps: new Set<string>(), unsatisfiedSteps: new Set<string>(),
    salvagedSteps: new Set<string>(), salvageNotes: {},
    perStepRecoveries: { s2: 2 }, totalRecoveries: 2, recoveryHistory: [],
  });
  type Dispatch = (
    state: ExecutionState, steps: WorkflowStep[], decision: ReasoningResult, currentStepId: string,
    stepOutput: unknown, inputData: unknown, counters: ReturnType<typeof loop>, proposal?: unknown,
    facts?: { stepId: string; anomalyKind: AnomalyContext['kind']; detail: string; recoveriesBefore: number; totalBefore: number },
  ) => Promise<{ terminal: boolean; result?: { error?: string; escalationId?: string } }>;
  const dispatch = (svc: AgentExecutionService) =>
    (svc as unknown as { dispatchRecoveryDecision: Dispatch }).dispatchRecoveryDecision.bind(svc);

  beforeEach(() => { createEscalationMock.mockClear(); });

  it('writes the fact line, then the advisor sentence labelled as such, with fingerprint and version', async () => {
    const svc = new AgentExecutionService();
    const decision: ReasoningResult = {
      thinking: '', decision: 'escalate', toolCalls: [],
      escalationReason: 'The web fetching service could not retrieve any of the target URLs.',
      whoCanUnblock: 'platform',
    };
    const out = await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, undefined, loop(), undefined, {
      stepId: 's2', anomalyKind: 'tool_error',
      detail: 'codex invoke failed: The operation was aborted', recoveriesBefore: 2, totalBefore: 2,
    });
    expect(createEscalationMock).toHaveBeenCalledTimes(1);
    const [, reason, opts] = createEscalationMock.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(reason.startsWith('codex invoke failed: The operation was aborted (step s2; 2 earlier recoveries on this step, 2 in the run)')).toBe(true);
    expect(reason).toContain('\n\nAdvisor: The web fetching service could not retrieve any of the target URLs.');
    expect(opts).toMatchObject({
      kind: 'system_internal',
      fingerprint: 'recovery_decision:s2:tool_error',
      instructionVersion: 7,
    });
    expect(out.terminal).toBe(true);
    expect(out.result?.error).toBe(reason);
    expect(out.result?.escalationId).toBe('esc-1');
  });

  it('still yields a fact line when the anomaly carried no detail, and never reads "undefined"', async () => {
    const svc = new AgentExecutionService();
    const decision: ReasoningResult = { thinking: '', decision: 'escalate', toolCalls: [], escalationReason: undefined, whoCanUnblock: 'platform' };
    // What runRecoveryCycle passes when anomalyDetailText returned undefined.
    await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, undefined, loop(), undefined, {
      stepId: 's2', anomalyKind: 'timeout', detail: 'timeout on step s2', recoveriesBefore: 0, totalBefore: 0,
    });
    const reason = createEscalationMock.mock.calls[0][1] as string;
    expect(reason.startsWith('timeout on step s2 (step s2; 0 earlier recoveries on this step, 0 in the run)')).toBe(true);
    expect(reason).toContain('Advisor: no reason given');
    expect(reason).not.toContain('undefined');
  });

  it('leaves the customer-facing branch as it was: the advisor\'s reason, no fact line', async () => {
    const svc = new AgentExecutionService();
    const paused = { success: true, paused: true };
    (svc as unknown as { createClarificationPause: jest.Mock }).createClarificationPause = jest.fn().mockResolvedValue(paused);
    const decision: ReasoningResult = {
      thinking: '', decision: 'escalate', toolCalls: [],
      escalationReason: 'The sheet needs an owner before it can be written to.',
      requestedAction: 'Share the sheet with the service account.',
      whoCanUnblock: 'customer',
    };
    const out = await dispatch(svc)(makeState([step]), [step], decision, 's2', undefined, undefined, loop(), undefined, {
      stepId: 's2', anomalyKind: 'tool_error', detail: 'permission denied', recoveriesBefore: 1, totalBefore: 1,
    });
    expect(createEscalationMock).not.toHaveBeenCalled();
    expect(out.result).toBe(paused);
  });
});
