/**
 * Tests for the review-mode Slack DM fan-out triggered immediately after
 * createApprovalRequest succeeds and before HitlGateError is thrown.
 *
 * Coverage:
 *   - review mode + outbound slack tool call → createApprovalRequest AND
 *     postReviewDm both fire
 *   - review mode + non-slack tool call → createApprovalRequest fires, no
 *     postReviewDm
 *   - HitlGateError is thrown regardless (execution pauses)
 */

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../streaming', () => ({
  streamingService: {
    emitToolStart: jest.fn(),
    emitToolComplete: jest.fn(),
    emitHitlRequired: jest.fn(),
  },
}));

class MockHitlGateError extends Error {
  constructor(_tcs: unknown[], reason: string, _cat?: string) {
    super(reason);
    this.name = 'HitlGateError';
  }
}

const checkHitlGateMock = jest.fn();
const createApprovalRequestMock = jest.fn();
jest.mock('../../hitl-enforcement', () => ({
  hitlEnforcementService: {
    checkHitlGate: (...a: unknown[]) => checkHitlGateMock(...a),
    createApprovalRequest: (...a: unknown[]) => createApprovalRequestMock(...a),
  },
  HitlGateError: MockHitlGateError,
  ModelTool: {},
}));

jest.mock('../tool-interceptor', () => ({
  interceptToolCalls: jest.fn((calls) => calls),
}));

jest.mock('../../audit', () => ({
  insertAuditLog: jest.fn(),
}));

const postDraftDmMock = jest.fn();
const listAgentAssigneesMock = jest.fn();
const postReviewDmMock = jest.fn();
jest.mock('../../agent-chat/agent-slack-client', () => ({
  postDraftDm: (...a: unknown[]) => postDraftDmMock(...a),
  postReviewDm: (...a: unknown[]) => postReviewDmMock(...a),
  listAgentAssignees: (...a: unknown[]) => listAgentAssigneesMock(...a),
  listAgentSlackInstalls: jest.fn().mockResolvedValue([]),
}));

const toolGatewayExecuteMock = jest.fn();
const toolGatewayExecuteBatchMock = jest.fn();

// Constructor deps
jest.mock('../../llm/client', () => ({ llmClient: { chat: jest.fn() } }));
jest.mock('../../llm/pricing', () => ({ calculateCost: jest.fn().mockReturnValue(0) }));
jest.mock('../../coordinator/dispatcher', () => ({
  getCoordinatorDispatcher: jest.fn().mockReturnValue({}),
}));
jest.mock('../../tool-gateway/dispatcher', () => ({
  getToolGatewayDispatcher: jest.fn().mockReturnValue({
    execute: (...a: unknown[]) => toolGatewayExecuteMock(...a),
    executeBatch: (...a: unknown[]) => toolGatewayExecuteBatchMock(...a),
  }),
}));
jest.mock('../../infrastructure/runtime-env', () => ({
  getPlatformBackendUrl: jest.fn().mockReturnValue(''),
  getTenantRuntimeUrl: jest.fn().mockReturnValue(''),
  tenantRuntimeUrlState: jest.fn().mockReturnValue({}),
}));
jest.mock('../../admission/service', () => ({ AdmissionService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../agent-lifecycle/service', () => ({ AgentLifecycleService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../action-ledger/service', () => ({ ActionLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../usage-ledger/service', () => ({ UsageLedgerService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../infrastructure/database', () => ({ getPoolForService: jest.fn() }));
jest.mock('../../entitlements-client/service', () => ({ getEntitlementsClient: jest.fn().mockReturnValue({}) }));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: {} }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
}));
jest.mock('../../tools/standard-tool-handler', () => ({ executeStandardTool: jest.fn() }));
jest.mock('../../agent-lifecycle/types', () => ({ trustLevelFor: jest.fn().mockReturnValue('trusted') }));
jest.mock('../run-state/service', () => ({ agentRunStateService: {} }));
jest.mock('../untrusted-input', () => ({
  formatInputForPrompt: jest.fn(),
  formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue(''),
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]),
  buildSkillContextBlock: jest.fn().mockReturnValue(''),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null), postSkillFeedback: jest.fn() }));
jest.mock('../../infrastructure/pubsub', () => ({ publisher: {} }));
jest.mock('../../interactive-chat/system-prompt', () => ({ getHitlDescription: jest.fn().mockReturnValue('') }));
jest.mock('../../audit/citation-warning', () => ({ deriveInternalDomains: jest.fn().mockReturnValue([]) }));
jest.mock('../../connectors/connector-service-client', () => ({ getPrefetchThreadClient: jest.fn().mockReturnValue({}) }));

import { AgentExecutionService } from '../service';
import type { ExecutionState, ToolCallRequest } from '../types';

function makeState(communication: 'draft' | 'auto' | 'review' = 'review'): ExecutionState {
  return {
    context: {
      tenantId: 'ten_1',
      agentId: 'ag_1',
      workflowId: 'wf_1',
      taskId: 'tk_1',
      instructionVersion: 1,
       
      instruction: { systemPrompt: 's', tools: [], guardrails: [] } as any,
      traceId: 'tr_1',
      agentType: 'workflow',
      hitlLevel: 2,
      modelConfig: {},
      execConfig: {},
      memoryScope: {},
      threadId: 't',
      invocationId: 'inv',
       
      oversight: { communication } as any,
     
    } as any,
    reasoningSteps: 0,
    toolCallsExecuted: 0,
    startTime: new Date(),
    steps: [],
    conversationHistory: [],
    pendingToolCalls: [],
    completedToolCalls: [],
    toolFailureCounts: new Map(),
    injectedSkillIds: [],
   
  } as any;
}

function tc(actionType: string, payload: Record<string, unknown>, connector = ''): ToolCallRequest {
   
  return { id: `tc_${Math.random().toString(36).slice(2, 8)}`, connector, actionType, entityType: '', payload } as any;
}

function call(svc: AgentExecutionService, state: ExecutionState, tcs: ToolCallRequest[]) {
   
  return (svc as any).executeToolCalls(state, tcs);
}

async function flushSetImmediate() {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  jest.clearAllMocks();
  checkHitlGateMock.mockResolvedValue({ shouldGate: true, reason: 'communication_review', matchedCategory: 'externalPublishing' });
  createApprovalRequestMock.mockResolvedValue({
    id: 'approval_1',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
});

describe('executeToolCalls review-mode fan-out', () => {
  it('on gated outbound slack call, creates approval AND fires postReviewDm', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);
    listAgentAssigneesMock.mockResolvedValue(['acct_a']);
    postReviewDmMock.mockResolvedValue({ totalAssignees: 1, delivered: 1, unreachable: [] });

    const state = makeState('review');
    const calls = [tc('slack_send_message', { channel: 'C1', text: 'hi' })];

    await expect(call(svc, state, calls)).rejects.toBeInstanceOf(MockHitlGateError);

    expect(createApprovalRequestMock).toHaveBeenCalled();
    await flushSetImmediate();
    expect(postReviewDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: 'approval_1',
        channelId: 'C1',
        draftText: 'hi',
        assigneeAccountIds: ['acct_a'],
      }),
    );
  });

  it('on gated non-slack call, creates approval but does NOT fire postReviewDm', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);

    const state = makeState('review');
    const calls = [tc('send_email', { to: 'x@y.com' }, 'gmail')];

    await expect(call(svc, state, calls)).rejects.toBeInstanceOf(MockHitlGateError);

    expect(createApprovalRequestMock).toHaveBeenCalled();
    await flushSetImmediate();
    expect(postReviewDmMock).not.toHaveBeenCalled();
  });

  it('skips fan-out when assignees are empty (no DM to send)', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);
    listAgentAssigneesMock.mockResolvedValue([]);

    const state = makeState('review');
    const calls = [tc('slack_send_message', { channel: 'C1', text: 'hi' })];

    await expect(call(svc, state, calls)).rejects.toBeInstanceOf(MockHitlGateError);
    await flushSetImmediate();
    expect(postReviewDmMock).not.toHaveBeenCalled();
  });
});
