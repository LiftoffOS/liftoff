// runAdapterHitlGate — a repeat of a completed act is answered, not paused.
//
// The dispatch-time duplicate guard sits after the approval gate, so a repeated
// outbound call paused first and only an approval could carry it to the guard;
// each approval then repeated the act. The gate now asks the same question
// before it creates a pause: an act this run already completed is answered to
// the model, and no approval request is written.

const completedActHoldMock = jest.fn();
jest.mock('../completed-act-hold', () => ({
  completedActHold: (...a: unknown[]) => completedActHoldMock(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const checkHitlGateMock = jest.fn().mockResolvedValue({ shouldGate: false });
const checkMessageMock = jest.fn().mockResolvedValue({ kind: 'as_today' });
jest.mock('../../tool-gateway/message-check', () => ({ checkMessage: (...a: unknown[]) => checkMessageMock(...a) }));
jest.mock('../../hitl-enforcement', () => {
  const actualTypes = jest.requireActual('../../hitl-enforcement/types');
  return {
    hitlEnforcementService: {
      checkHitlGate: (...a: unknown[]) => checkHitlGateMock(...a),
      getOversightSettings: jest.fn(),
      createApprovalRequest: jest.fn(),
    },
    HitlGateError: actualTypes.HitlGateError,
    ModelTool: {},
  };
});

jest.mock('../adapter', () => ({
  createAdapter: jest.fn().mockReturnValue({
    invoke: jest.fn(), pause: jest.fn(), resume: jest.fn(),
    registerToolCatalog: jest.fn(), registerHitlGate: jest.fn(), registerAnomalyHandler: jest.fn(),
  }),
}));

const checkAdmissionMock = jest.fn().mockResolvedValue({ allowed: true });
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: checkAdmissionMock })),
}));

jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/dispatcher', () => ({ getCoordinatorDispatcher: jest.fn().mockReturnValue({}) }));
jest.mock('../../tool-gateway/dispatcher', () => ({
  // The gate asks the dispatcher to judge every vendor-hosted tool before the
  // SDK runs it. Null is "proceed", which is what these cases are about.
  getToolGatewayDispatcher: jest.fn().mockReturnValue({ guardExternal: async () => null }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
jest.mock('../../agent-lifecycle/service', () => ({ AgentLifecycleService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  getPool: jest.fn(),
  pool: { query: jest.fn() },
}));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getFeatureFlags: jest.fn().mockResolvedValue({}), getEntitlements: jest.fn().mockResolvedValue({}),
  }),
}));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: {} }));
jest.mock('../../streaming', () => ({ streamingService: { emitHitlRequired: jest.fn() } }));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(), getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({ agentRunStateService: {} }));
jest.mock('../untrusted-input', () => ({
  formatInputForPrompt: jest.fn(), formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue(''),
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]), buildSkillContextBlock: jest.fn().mockReturnValue(''),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../infrastructure/pubsub', () => ({ publisher: {} }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('') }));
jest.mock('../../connectors/connector-service-client', () => ({
  getPrefetchThreadClient: jest.fn().mockReturnValue({}),
  getConnectorServiceClient: jest.fn().mockReturnValue({
    listTenantConnectors: jest.fn().mockResolvedValue({ connectors: [] }),
    listManifests: jest.fn().mockResolvedValue({ manifests: [] }),
  }),
}));

import { AgentExecutionService } from '../service';
import type { ExecutionState, ExecutionContext } from '../types';
import type { McpToolCatalog } from '../adapter';

function makeState(overrides?: Partial<ExecutionContext>): ExecutionState {
  return {
    context: {
      tenantId: 't1', agentId: 'a1', workflowId: 'wf1', taskId: 'tk1',
      instructionVersion: 1,
      instruction: { systemPrompt: 's', allowedConnectors: [] } as ExecutionContext['instruction'],
      traceId: 'tr-1', agentType: 'agent',
      hitlLevel: 3,
      modelConfig: { provider: 'anthropic' } as ExecutionContext['modelConfig'],
      execConfig: {} as ExecutionContext['execConfig'],
      memoryScope: {} as ExecutionContext['memoryScope'],
      threadId: 'thread-1', invocationId: 'inv-1',
      oversight: {
        tenantId: 't1', autonomy: 'controlled', escalation: 'exceptions',
        sensitiveWork: {
          customerCommunication: false, financialActions: false, dataChanges: false,
          externalPublishing: false, hiringDecisions: false,
        },
        communication: 'draft',
      },
      ...overrides,
    } as ExecutionContext,
    reasoningSteps: 0, toolCallsExecuted: 0,
    startTime: new Date(), steps: [],
    conversationHistory: [], pendingToolCalls: [], completedToolCalls: [],
    toolFailureCounts: new Map(), injectedSkillIds: [],
  } as ExecutionState;
}


const gmailOutboundCatalog: McpToolCatalog = {
  servers: [],
  tools: [{
    name: 'google-mail-0105297e__send_email',
    description: 'Send a new email via Gmail',
    inputSchema: {},
    serverId: 'liftoff-tool-gateway',
    categories: ['write', 'outbound', 'customerCommunication'],
    effect: 'write',
  }],
} as unknown as McpToolCatalog;

const reviewOversight = {
  tenantId: 't1', autonomy: 'controlled', escalation: 'important',
  sensitiveWork: {
    customerCommunication: true, financialActions: false, dataChanges: false,
    externalPublishing: true, hiringDecisions: false,
  },
  communication: 'review',
} as ExecutionContext['oversight'];

const send = { to: 'person@example.com', subject: 'Lead enrichment result', body: 'hello' };

type Gate = {
  runAdapterHitlGate(
    _state: ExecutionState, _catalog: McpToolCatalog, _toolName: string, _args: unknown, _label: string, _callId?: string,
  ): Promise<{ allow: boolean; reason?: string; hitlPause?: { pendingToolCalls: Array<{ id: string; name: string }> } }>;
};

beforeEach(() => {
  jest.clearAllMocks();
  checkAdmissionMock.mockResolvedValue({ allowed: true });
  // Review + a sensitive outbound match: this call would pause.
  checkHitlGateMock.mockResolvedValue({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
  completedActHoldMock.mockResolvedValue(null);
});

describe('runAdapterHitlGate — an act this run already completed', () => {
  it('is answered to the model instead of paused, and the run is not marked gated', async () => {
    completedActHoldMock.mockResolvedValue(
      'Already done in this run: `send_email` on google-mail:to/person@example.com@abc123def456, at 02:37. '
      + 'This is the result that call returned; nothing was sent a second time.',
    );
    const svc = new AgentExecutionService();
    const state = makeState({ oversight: reviewOversight });

    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      state, gmailOutboundCatalog, 'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email', send, 'conv',
    );

    expect(result.allow).toBe(false);
    expect(result.hitlPause).toBeUndefined();
    expect(result.reason).toMatch(/Already done in this run/);
    expect((state as ExecutionState & { governanceStopped?: boolean }).governanceStopped).toBeUndefined();
    // Asked with the run's identity and the call as made.
    expect(completedActHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', agentId: 'a1', traceId: 'tr-1' }),
      'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email',
      send,
    );
  });

  it('a first-time send still pauses for approval', async () => {
    const svc = new AgentExecutionService();
    const state = makeState({ oversight: reviewOversight });

    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      state, gmailOutboundCatalog, 'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email', send, 'conv',
    );

    expect(result.allow).toBe(false);
    expect(result.hitlPause).toEqual(expect.objectContaining({ gateReason: 'sensitive_work' }));
    expect((state as ExecutionState & { governanceStopped?: boolean }).governanceStopped).toBe(true);
  });

  it('pre-empts the write-capability pause the same way', async () => {
    completedActHoldMock.mockResolvedValue('Already done in this run: `run_capability` on capability:to/person@example.com@abc123def456.');
    const svc = new AgentExecutionService();
    const state = makeState({ oversight: reviewOversight });

    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      state, gmailOutboundCatalog, 'mcp__liftoff-tool-gateway__run_capability',
      { capabilityId: 'cap_w.0123456789ab.aGVsbG8', args: send }, 'conv',
    );

    expect(result.allow).toBe(false);
    expect(result.hitlPause).toBeUndefined();
    expect(result.reason).toMatch(/Already done in this run/);
    expect(checkHitlGateMock).not.toHaveBeenCalled();
  });

  it('a first-time capability write still pauses for approval', async () => {
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      makeState({ oversight: reviewOversight }), gmailOutboundCatalog, 'mcp__liftoff-tool-gateway__run_capability',
      { capabilityId: 'cap_w.0123456789ab.aGVsbG8', args: send }, 'conv',
    );
    expect(result.hitlPause).toEqual(expect.objectContaining({ gateReason: 'capability_requires_approval' }));
  });

  // The third pause site. checkHitlGate clears the call (the escalation gate
  // matches declared categories only) and the Communication pre-check pauses
  // it — the branch a native send takes under Review. A repeat must be
  // answered here too, or it is answered at two gates and put to a person at
  // the third.
  it('pre-empts the draft pre-check pause the same way — a native send under Review', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    completedActHoldMock.mockResolvedValue('Already done in this run: `send_email` on google-mail:to/person@example.com@04289bf00477.');
    const nativeCatalog = {
      servers: [],
      tools: [{
        name: 'google-mail-0105297e__send_email',
        description: 'Send a new email via Gmail',
        inputSchema: {},
        serverId: 'liftoff-tool-gateway',
        // Exactly as the registry ships it: no finer class than `outbound`.
        categories: ['write', 'outbound'],
        draftVariant: 'google-mail__create_draft',
        effect: 'write',
      }],
    } as unknown as McpToolCatalog;
    const svc = new AgentExecutionService();
    const state = makeState({ oversight: reviewOversight });

    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      state, nativeCatalog, 'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email', send, 'conv',
    );

    expect(result.allow).toBe(false);
    expect(result.hitlPause).toBeUndefined();
    expect(result.reason).toMatch(/Already done in this run/);
    expect((state as ExecutionState & { governanceStopped?: boolean }).governanceStopped).toBeUndefined();
  });

  it('a first-time native send under Review pauses at the draft pre-check, naming the toggle', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    const nativeCatalog = {
      servers: [],
      tools: [{
        name: 'google-mail-0105297e__send_email', description: 'Send', inputSchema: {},
        serverId: 'liftoff-tool-gateway', categories: ['write', 'outbound'],
        draftVariant: 'google-mail__create_draft', effect: 'write',
      }],
    } as unknown as McpToolCatalog;
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      makeState({ oversight: reviewOversight }), nativeCatalog,
      'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email', send, 'conv',
    );
    expect(result.hitlPause).toEqual(expect.objectContaining({ gateReason: 'sensitive_work', matchedCategory: 'externalPublishing' }));
    expect(completedActHoldMock).toHaveBeenCalledTimes(1);
  });

  it('is not asked about a call that would not pause', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    const svc = new AgentExecutionService();

    await (svc as unknown as Gate).runAdapterHitlGate(
      makeState({ oversight: { ...reviewOversight, communication: 'auto' } as ExecutionContext['oversight'] }), gmailOutboundCatalog,
      'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email', send, 'conv',
    );

    // The dispatch-time guard owns that case.
    expect(completedActHoldMock).not.toHaveBeenCalled();
  });
});

// The id a pending call is stamped with. The engine's own, where the engine
// has one at the gate, so a resume finds the call in the checkpointed record
// by identity; minted here, and marked as such, where nothing has an id yet.
describe('runAdapterHitlGate — the pending call carries the engine\'s call id', () => {
  it('stamps the id the engine handed the gate', async () => {
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      makeState({ oversight: reviewOversight }), gmailOutboundCatalog,
      'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email', send, 'conv', 'toolu_01abc',
    );
    expect(result.hitlPause?.pendingToolCalls).toEqual([
      expect.objectContaining({ id: 'toolu_01abc', name: 'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email' }),
    ]);
  });

  it('mints its own, marked as such, when the engine has none', async () => {
    const svc = new AgentExecutionService();
    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      makeState({ oversight: reviewOversight }), gmailOutboundCatalog,
      'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email', send, 'conv',
    );
    expect(result.hitlPause?.pendingToolCalls[0].id).toMatch(/^pending-[0-9a-f-]{36}$/);
  });
});

// The Communication setting reads the message at the execute-time seam of
// every path. A vendor-hosted MCP tool never reaches the in-process gateway's
// handler (the bridge sends it to the vendor's own server), so this gate is
// where the check runs for it, with the wrapper's mapping; an in-process tool
// is checked in its handler and never here.
describe('runAdapterHitlGate — the message check on a vendor-hosted tool', () => {
  const githubVendorCatalog: McpToolCatalog = {
    servers: [],
    tools: [{
      name: 'github-dd4c4689__add_issue_comment',
      remoteToolName: 'add_issue_comment',
      description: 'Add a comment to an issue or pull request',
      inputSchema: {},
      serverId: 'vendor-github-dd4c4689',
      categories: ['dataChanges', 'externalPublishing'],
      effect: 'write',
    }],
  } as unknown as McpToolCatalog;
  const autoOversight = {
    tenantId: 't1', autonomy: 'autonomous', escalation: 'exceptions',
    sensitiveWork: { customerCommunication: true, financialActions: true, dataChanges: false, externalPublishing: false, hiringDecisions: false },
    communication: 'auto', communicationSemantics: 2,
  } as ExecutionContext['oversight'];
  const comment = { owner: 'acme', repo: 'backend', issue_number: 123, body: 'We will refund every affected customer in full by Friday.' };

  it('runs the check with the tool, its categories, the args, the oversight, this batch\'s decision and the contract', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    const svc = new AgentExecutionService();
    const state = makeState({ oversight: autoOversight });
    await (svc as unknown as Gate).runAdapterHitlGate(state, githubVendorCatalog, 'github-dd4c4689__add_issue_comment', comment, 'conv');
    expect(checkMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'github-dd4c4689__add_issue_comment', categories: ['dataChanges', 'externalPublishing'], args: comment,
      oversight: autoOversight, decision: { kind: 'allow' }, tenantId: 't1', agentId: 'a1', invocationId: 'inv-1',
    }));
  });

  it('Auto: an unsafe verdict pauses with sensitive_work, the category and the verdict on the pause', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    const context = { messageCheck: { setting: 'auto', asked: { financial_actions: 0.94 }, model: 'jev-1.13.0' } };
    checkMessageMock.mockResolvedValue({ kind: 'pause', reason: 'sensitive_work', matchedCategory: 'financialActions', context });
    const svc = new AgentExecutionService();
    const state = makeState({ oversight: autoOversight });
    const result = await (svc as unknown as Gate).runAdapterHitlGate(state, githubVendorCatalog, 'github-dd4c4689__add_issue_comment', comment, 'conv');
    expect(result.allow).toBe(false);
    expect(result.hitlPause).toEqual(expect.objectContaining({ gateReason: 'sensitive_work', matchedCategory: 'financialActions', context }));
  });

  it('Review: the check is asked under the CATALOG decision, not this batch\'s gate verdict', async () => {
    // A vendor tool under Review is paused by the draft pre-check, not by
    // checkHitlGate — so judging by the gate verdict said "nothing would pause
    // this" and the message was never read on the one setting whose whole
    // promise is that it is.
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    checkMessageMock.mockResolvedValue({ kind: 'send', context: { messageCheck: { setting: 'review', asked: { customer_communication: 0.02 } } } });
    const svc = new AgentExecutionService();
    const review = {
      ...autoOversight,
      communication: 'review',
      sensitiveWork: { ...autoOversight!.sensitiveWork, externalPublishing: true },
    } as ExecutionContext['oversight'];
    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      makeState({ oversight: review }), githubVendorCatalog, 'github-dd4c4689__add_issue_comment', comment, 'conv',
    );
    expect(checkMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      decision: { kind: 'require_approval', reason: 'sensitive_work' },
    }));
    // …and the cleared message skips the pre-check that would have paused it.
    expect(result.allow).toBe(true);
    expect(result.hitlPause).toBeUndefined();
  });

  it('Review: a message the check does not clear still pauses at the pre-check', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    checkMessageMock.mockResolvedValue({ kind: 'as_today', context: { messageCheck: { setting: 'review', asked: {}, incomplete: true } } });
    const svc = new AgentExecutionService();
    const review = {
      ...autoOversight,
      communication: 'review',
      sensitiveWork: { ...autoOversight!.sensitiveWork, externalPublishing: true },
    } as ExecutionContext['oversight'];
    const result = await (svc as unknown as Gate).runAdapterHitlGate(
      makeState({ oversight: review }), githubVendorCatalog, 'github-dd4c4689__add_issue_comment', comment, 'conv',
    );
    expect(result.allow).toBe(false);
    expect(result.hitlPause).toEqual(expect.objectContaining({ gateReason: 'sensitive_work' }));
  });

  it('Review: a cleared verdict sends the matched message; any other verdict pauses as today with the record', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: true, reason: 'sensitive_work', matchedCategory: 'customerCommunication' });
    checkMessageMock.mockResolvedValue({ kind: 'send', context: { messageCheck: { setting: 'review', asked: { customer_communication: 0.02 } } } });
    const svc = new AgentExecutionService();
    const review = { ...autoOversight, communication: 'review' } as ExecutionContext['oversight'];
    let result = await (svc as unknown as Gate).runAdapterHitlGate(makeState({ oversight: review }), githubVendorCatalog, 'github-dd4c4689__add_issue_comment', comment, 'conv');
    expect(checkMessageMock).toHaveBeenLastCalledWith(expect.objectContaining({ decision: { kind: 'require_approval', reason: 'sensitive_work' } }));
    expect(result.allow).toBe(true);

    const context = { messageCheck: { setting: 'review', asked: {}, incomplete: true } };
    checkMessageMock.mockResolvedValue({ kind: 'as_today', context });
    result = await (svc as unknown as Gate).runAdapterHitlGate(makeState({ oversight: review }), githubVendorCatalog, 'github-dd4c4689__add_issue_comment', comment, 'conv');
    expect(result.allow).toBe(false);
    expect(result.hitlPause).toEqual(expect.objectContaining({ gateReason: 'sensitive_work', context }));
  });

  it('a COLLAPSED vendor server: the deferred tool is checked with the categories it was classified with', async () => {
    // A realistic shape: GitHub is over the tool cap, so its tools leave
    // `catalog.tools` for the search pair and reach the gate only through
    // `deferredVendorTools`. Stripped of its categories there, the comment reads
    // as a tool that sends nothing to nobody and the check never runs.
    const collapsed = {
      servers: [],
      tools: [],
      deferredVendorTools: new Map([['github-dd4c4689', [{
        name: 'github-dd4c4689__add_issue_comment',
        remoteToolName: 'add_issue_comment',
        description: 'Add a comment to an issue or pull request',
        inputSchema: {},
        serverId: 'vendor-github-dd4c4689',
        categories: ['dataChanges', 'externalPublishing'],
        effect: 'write',
      }]]]),
    } as unknown as McpToolCatalog;
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    const svc = new AgentExecutionService();
    await (svc as unknown as Gate).runAdapterHitlGate(
      makeState({ oversight: autoOversight }), collapsed, 'github-dd4c4689__add_issue_comment', comment, 'conv',
    );
    expect(checkMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'github-dd4c4689__add_issue_comment', categories: ['dataChanges', 'externalPublishing'], args: comment,
    }));
  });

  it('an in-process gateway tool is checked in its own handler, never here', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    const svc = new AgentExecutionService();
    await (svc as unknown as Gate).runAdapterHitlGate(makeState({ oversight: autoOversight }), gmailOutboundCatalog, 'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email', send, 'conv');
    expect(checkMessageMock).not.toHaveBeenCalled();
  });
});
