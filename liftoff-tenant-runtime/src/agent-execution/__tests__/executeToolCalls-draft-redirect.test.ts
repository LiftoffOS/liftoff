/**
 * Tests for the draft-mode redirect block at the top of executeToolCalls.
 *
 * Coverage:
 *   - draft mode + outbound slack tool call → postDraftDm is called and the call
 *     is removed from the remaining set (no HITL gate, no tool gateway)
 *   - draft mode + non-slack tool → the call falls through to the normal path
 *   - draft mode + slack tool with no assignees → returns failure result
 *   - draft mode + slack tool with missing channel/text → falls through
 *   - non-draft mode → redirect block is skipped entirely
 *   - an approved dispatch (bypassHitlCheck) → neither the redirect nor the
 *     interceptor touches the call; it runs exactly as approved
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

const interceptToolCallsMock = jest.fn((calls) => calls);
jest.mock('../tool-interceptor', () => ({
  interceptToolCalls: (...a: unknown[]) => interceptToolCallsMock(...a),
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

// Stub all the heavy deps the AgentExecutionService constructor needs.
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
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../infrastructure/database', () => ({ getPoolForService: jest.fn() }));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({}),
}));
jest.mock('../../memory', () => ({ memoryService: {}, RetrievedMemory: {} }));
jest.mock('../../invocations', () => ({ invocationsService: {} }));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(),
  getToolSchemas: jest.fn().mockReturnValue([]),
}));
const executeStandardToolMock = jest.fn();
jest.mock('../../tools/standard-tool-handler', () => ({
  executeStandardTool: (...a: unknown[]) => executeStandardToolMock(...a),
}));
jest.mock('../../agent-lifecycle/types', () => ({
  trustLevelFor: jest.fn().mockReturnValue('trusted'),
}));
jest.mock('../run-state/service', () => ({
  agentRunStateService: {},
}));
jest.mock('../untrusted-input', () => ({
  formatInputForPrompt: jest.fn(),
  formatUntrustedSystemPromptDirective: jest.fn().mockReturnValue(''),
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn().mockResolvedValue([]),
  buildSkillContextBlock: jest.fn().mockReturnValue(''),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: {},
}));
jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null),
  postSkillFeedback: jest.fn(),
}));
jest.mock('../../infrastructure/pubsub', () => ({ publisher: {} }));
jest.mock('../../interactive-chat/system-prompt', () => ({
  getHitlDescription: jest.fn().mockReturnValue(''),
}));
jest.mock('../../audit/citation-warning', () => ({
  deriveInternalDomains: jest.fn().mockReturnValue([]),
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getPrefetchThreadClient: jest.fn().mockReturnValue({}),
}));

import { AgentExecutionService } from '../service';
import type { ExecutionState, ToolCallRequest } from '../types';

function makeState(
  communication: 'draft' | 'auto' | 'review' = 'draft',
  extra: Record<string, unknown> = {},
): ExecutionState {
  return {
    context: {
      ...extra,
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

function call(svc: AgentExecutionService, state: ExecutionState, tcs: ToolCallRequest[]) {
   
  return (svc as any).executeToolCalls(state, tcs);
}

function tc(actionType: string, payload: Record<string, unknown>, connector = ''): ToolCallRequest {
   
  return { id: `tc_${Math.random().toString(36).slice(2, 8)}`, connector, actionType, entityType: '', payload } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  checkHitlGateMock.mockResolvedValue({ shouldGate: false });
});

describe('executeToolCalls draft-mode redirect', () => {
  it('redirects outbound slack_send_message to postDraftDm and removes from remaining', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);
    listAgentAssigneesMock.mockResolvedValue(['acct_a', 'acct_b']);
    postDraftDmMock.mockResolvedValue({ totalAssignees: 2, delivered: 2, unreachable: [] });

    const state = makeState('draft');
    const calls = [tc('slack_send_message', { channel: 'C1', text: 'hi' })];

    const results = await call(svc, state, calls);

    expect(postDraftDmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'ten_1',
        agentId: 'ag_1',
        channelId: 'C1',
        draftText: 'hi',
        assigneeAccountIds: ['acct_a', 'acct_b'],
      }),
    );
    expect(checkHitlGateMock).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({ id: calls[0].id, success: true }),
    ]);
  });

  it('returns failure result when no assignees are configured', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);
    listAgentAssigneesMock.mockResolvedValue([]);

    const state = makeState('draft');
    const calls = [tc('slack_send_message', { channel: 'C1', text: 'hi' })];
    const results = await call(svc, state, calls);

    expect(results).toEqual([
      expect.objectContaining({
        id: calls[0].id,
        success: false,
        error: 'no_assignees_to_deliver_draft_to',
      }),
    ]);
    expect(postDraftDmMock).not.toHaveBeenCalled();
  });

  it('lets non-slack tool calls flow to the normal path under draft mode', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);

    const state = makeState('draft');
    const calls = [tc('read', { foo: 'bar' }, 'gmail')]; // batchable connector tool

    toolGatewayExecuteBatchMock.mockResolvedValue([{ success: true, data: { ok: true } }]);
    toolGatewayExecuteMock.mockResolvedValue({ success: true, data: { ok: true } });

    const results = await call(svc, state, calls);

    expect(postDraftDmMock).not.toHaveBeenCalled();
    expect(results.length).toBe(1);
  });

  it('does not engage redirect when communication is not "draft"', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);

    const state = makeState('auto');
    const calls = [tc('slack_send_message', { channel: 'C1', text: 'hi' })];
    toolGatewayExecuteMock.mockResolvedValue({ success: true });

    await call(svc, state, calls);

    expect(postDraftDmMock).not.toHaveBeenCalled();
  });

  // Once a person has approved a call, that call is what runs. The redirect
  // and the interceptor both exist to decide what happens BEFORE approval;
  // applying either afterwards would swap in a draft or ask again. The grant
  // names the call: the same id, the same arguments.
  it('sends an approved dispatch as approved — no draft redirect, no interceptor', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);
    listAgentAssigneesMock.mockResolvedValue(['acct_a']);
    executeStandardToolMock.mockResolvedValue({ success: true, result: 'sent' });

    const calls = [tc('slack_send_message', { channel: 'C1', text: 'hi' })];
    const state = makeState('draft', {
      approvedGrant: {
        approvalId: 'appr_1',
        finalCalls: [{ id: calls[0].id, name: 'slack_send_message', input: { channel: 'C1', text: 'hi' } }],
        fingerprint: 'fp',
        routes: [],
      },
    });

    const results = await call(svc, state, calls);

    expect(postDraftDmMock).not.toHaveBeenCalled();
    expect(interceptToolCallsMock).not.toHaveBeenCalled();
    expect(checkHitlGateMock).not.toHaveBeenCalled();
    // Dispatched once, with the approved name and arguments intact.
    expect(executeStandardToolMock).toHaveBeenCalledTimes(1);
    expect(executeStandardToolMock.mock.calls[0][0]).toBe('slack_send_message');
    expect(executeStandardToolMock.mock.calls[0][1]).toEqual({ channel: 'C1', text: 'hi' });
    expect(results).toEqual([expect.objectContaining({ id: calls[0].id, success: true })]);
  });

  // A grant covers exactly its calls. A batch with a different argument is not
  // the approved batch, and the bypass must not reach it.
  it('a grant that does not cover the batch does not bypass the redirect', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);
    listAgentAssigneesMock.mockResolvedValue(['acct_a']);

    const calls = [tc('slack_send_message', { channel: 'C1', text: 'hi' })];
    const state = makeState('draft', {
      approvedGrant: {
        approvalId: 'appr_1',
        finalCalls: [{ id: calls[0].id, name: 'slack_send_message', input: { channel: 'C1', text: 'something else' } }],
        fingerprint: 'fp',
        routes: [],
      },
    });

    await call(svc, state, calls);

    expect(postDraftDmMock).toHaveBeenCalledTimes(1);
  });

  it('runs the interceptor on an ordinary (unapproved) dispatch', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);
    executeStandardToolMock.mockResolvedValue({ success: true, result: 'sent' });

    const state = makeState('review');
    await call(svc, state, [tc('slack_send_message', { channel: 'C1', text: 'hi' })]);

    expect(interceptToolCallsMock).toHaveBeenCalledTimes(1);
  });

  it('falls through to normal path when slack call has no channel or text', async () => {
    const svc = new AgentExecutionService();
     
    (svc as any).buildToolsSchema = jest.fn().mockResolvedValue([]);

    const state = makeState('draft');
    const calls = [tc('slack_send_message', { channel: '' })]; // no text
    toolGatewayExecuteMock.mockResolvedValue({ success: false, error: 'no_text' });

    await call(svc, state, calls);

    expect(postDraftDmMock).not.toHaveBeenCalled();
  });
});
