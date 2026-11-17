// The provenance hold comes before the HITL pause.
//
// A hold is an answer for the model — read first, then act — and a pause is
// a question for a person. Judged after the pauses, the hold never sees a
// gated write: the first pass pauses before reaching it, and on resume an
// operator-approved call is allowed without re-gating. So a person would be
// asked to approve writes whose target the run could not account for, and
// once they had, nothing would judge the write at all.
//
// And on resume the judgement is on what WILL be dispatched: a reviewer may
// rewrite an approved call to a target the run never read, and an approval is
// a decision about the draft, not provenance for a new target.
//
// Drives the REAL gate with a guard that holds and a HITL check that would
// pause, and asserts which one answers.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const checkHitlGateMock = jest.fn().mockResolvedValue({ shouldGate: false });
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
const guardExternalMock = jest.fn<Promise<string | null>, [unknown]>().mockResolvedValue(null);
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: jest.fn().mockReturnValue({ guardExternal: (a: unknown) => guardExternalMock(a) }),
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
      modelConfig: { provider: 'openrouter' } as ExecutionContext['modelConfig'],
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

/** A vendor-hosted GitHub server, the way the catalog carries one. */
const githubCatalog: McpToolCatalog = {
  servers: [{ id: 'github-dd4c4689', name: 'github', kind: 'vendor' } as unknown as McpToolCatalog['servers'][number]],
  tools: [{
    name: 'github-dd4c4689__add_issue_comment',
    description: 'Add a comment to an issue or pull request',
    inputSchema: {},
    serverId: 'github-dd4c4689',
    categories: ['outbound', 'externalPublishing'],
  }],
} as unknown as McpToolCatalog;

const COMMENT = { owner: 'acme', repo: 'api', issue_number: 122, body: 'x' };
const HOLD = 'Held: github.add_issue_comment names github:acme/api#122, which nothing in this run has read.';

type Gate = {
  runAdapterHitlGate(
    state: ExecutionState, catalog: McpToolCatalog, toolName: string, args: unknown, label: string,
  ): Promise<{ allow: boolean; reason?: string; hitlPause?: unknown }>;
};
const gate = () => new AgentExecutionService() as unknown as Gate;

beforeEach(() => {
  jest.clearAllMocks();
  checkAdmissionMock.mockResolvedValue({ allowed: true });
  checkHitlGateMock.mockResolvedValue({ shouldGate: true, reason: 'external_content_write' });
  guardExternalMock.mockResolvedValue(null);
});

describe('runAdapterHitlGate — the hold comes before the pause', () => {
  it('HOLDS an ungrounded write that HITL would otherwise pause, and asks nobody', async () => {
    guardExternalMock.mockResolvedValue(HOLD);
    const result = await gate().runAdapterHitlGate(
      makeState(), githubCatalog, 'github-dd4c4689__add_issue_comment', COMMENT, 'conv',
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe(HOLD);
    expect(result.hitlPause).toBeUndefined();
    // The guard was consulted with the SDK-form name, and the HITL check was
    // never reached: nothing to approve until the model has read the target.
    expect(guardExternalMock).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'mcp__github-dd4c4689__add_issue_comment', input: COMMENT, invocationId: 'inv-1',
    }));
    expect(checkHitlGateMock).not.toHaveBeenCalled();
  });

  it('PAUSES the same write once it is grounded — the person is asked about a write the run can account for', async () => {
    guardExternalMock.mockResolvedValue(null);
    const result = await gate().runAdapterHitlGate(
      makeState(), githubCatalog, 'github-dd4c4689__add_issue_comment', COMMENT, 'conv',
    );
    expect(result.allow).toBe(false);
    expect(result.hitlPause).toEqual(expect.objectContaining({ gateReason: 'external_content_write' }));
    expect(guardExternalMock).toHaveBeenCalledTimes(1);
    expect(checkHitlGateMock).toHaveBeenCalledTimes(1);
  });

  it('judges an operator-approved call on resume by what WILL be dispatched', async () => {
    // A reviewer may rewrite the draft before approving it. The original was
    // judged when it first arrived; the approval is a decision about the
    // draft, not a source of provenance for a target the run never read — so
    // a call approved for #123 and edited to #124 is held, on #124.
    const EDITED = { ...COMMENT, issue_number: 124 };
    guardExternalMock.mockImplementation(async (a) =>
      ((a as { input: { issue_number: number } }).input.issue_number === 124 ? HOLD : null));
    const state = makeState({
      hitlResumeDecision: {
        decision: 'approved',
        pending: [{ name: 'github-dd4c4689__add_issue_comment', input: COMMENT, editedInput: EDITED }],
        resolved: [],
      },
    } as unknown as Partial<ExecutionContext>);
    const result = await gate().runAdapterHitlGate(
      state, githubCatalog, 'github-dd4c4689__add_issue_comment', COMMENT, 'conv',
    );
    expect(result).toEqual({ allow: false, reason: HOLD });
    expect(guardExternalMock).toHaveBeenCalledTimes(1);
    expect(guardExternalMock).toHaveBeenCalledWith(expect.objectContaining({ input: EDITED }));
    expect(checkHitlGateMock).not.toHaveBeenCalled();
  });

  it('lets an approved, unedited call through once judged, without asking again', async () => {
    guardExternalMock.mockResolvedValue(null);
    const state = makeState({
      hitlResumeDecision: {
        decision: 'approved',
        pending: [{ name: 'github-dd4c4689__add_issue_comment', input: COMMENT }],
        resolved: [],
      },
    } as unknown as Partial<ExecutionContext>);
    const result = await gate().runAdapterHitlGate(
      state, githubCatalog, 'github-dd4c4689__add_issue_comment', COMMENT, 'conv',
    );
    expect(result).toEqual({ allow: true });
    expect(guardExternalMock).toHaveBeenCalledWith(expect.objectContaining({ input: COMMENT }));
    expect(checkHitlGateMock).not.toHaveBeenCalled();
  });
});
