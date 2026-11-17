// A bound closed the chat turn: the person gets the closing reply, and the
// work goes on as a run when it says so.
//
// A chat turn that reaches its turn budget ends `limit_reached`, which is
// `success: false` with the last narration as its output. It landed on the
// failure branch: an error frame, nothing persisted, everything the turn had
// gathered reaching nobody. Now it gets the closing reply the platform loops
// give theirs — what was done, what was found, what is still to do — appended
// to whatever it had said, persisted and settled like any finished turn; and
// the reply's verdict decides whether a continuation run is scheduled on the
// thread. Driven through the real route with a stubbed engine.

import express from 'express';
import request from 'supertest';

const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const AGENT_ID = '5e4acb47-c63b-4f3f-a90d-aedcedbda8eb';
const RUNTIME_ID = 'abbb7a1c-f66f-46d8-b65a-e2e52ea77568';
const THREAD_ID = '7b9d446d-2f0e-4a44-9c1e-2b7a5f0c1d33';
const INVOCATION_ID = '627da69d-5f8a-4a2b-9f31-0c7d4e2a1b55';
const TURN_ID = '9f1c2b3a-4d5e-4f60-8a71-2b3c4d5e6f70';

const fakePool = {
  query: jest.fn(async (sql: string) => {
    if (/FROM system_config/i.test(sql)) return { rows: [{ chat_turn_globally_disabled: false }] };
    if (/FROM compiled_instructions/i.test(sql)) {
      return { rows: [{
        id: 'ins-1', version: 3, status: 'active', instruction: { allowedActionTypes: ['*'] },
        system_prompt: 'sp', user_instructions: '', integrations: [], instructions_md: null,
        learned_instructions_md: null, capability_tier: 'connector_only', result_rules: [],
        tool_description_overrides: {}, grounds_on: [], raw_input: {},
      }] };
    }
    if (/FROM agents WHERE id/i.test(sql)) {
      return { rows: [{ name: 'Monitor', role: 'analyst', messaging_nickname: null, memory_scope: {}, model_config: { provider: 'anthropic' }, workflow_steps: [] }] };
    }
    return { rows: [] };
  }),
  connect: jest.fn(),
};
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => fakePool, getPool: () => fakePool, pool: fakePool,
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../startup/schema-check', () => ({ isSchemaReady: () => true }));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: jest.fn(async () => RUNTIME_ID),
  resolveRuntimeAgentIdStrict: jest.fn(async () => RUNTIME_ID),
  resolveInternalAgentId: jest.fn(async () => AGENT_ID),
}));
jest.mock('../locks', () => ({
  tryAcquireLock: jest.fn(async () => ({
    tenantId: TENANT_ID, threadId: THREAD_ID, invocationId: INVOCATION_ID,
    abortController: new AbortController(), heartbeatTask: null, consecutiveFailures: 0, released: false,
  })),
  releaseLock: jest.fn(async () => undefined),
  LockServiceUnavailableError: class LockServiceUnavailableError extends Error {},
}));
jest.mock('../sigterm-handler', () => ({ drainController: { register: jest.fn(), unregister: jest.fn() } }));
jest.mock('../../memory/service', () => ({
  memoryService: { retrieveMemories: jest.fn(async () => []) },
  buildMemoryContextBlock: jest.fn(() => ''),
}));
jest.mock('../../connectors/manifest-repository', () => ({
  connectorManifestRepository: { getManifestsForAgent: jest.fn(async () => []) },
}));
jest.mock('../../skills/retrieval', () => ({
  retrieveContextSkills: jest.fn(async () => []),
  buildSkillContextBlock: jest.fn(() => ''),
  skillDisclosureMode: jest.fn(() => 'inline'),
}));
jest.mock('../system-prompt', () => ({
  buildAgentChatSystemPrompt: jest.fn(() => 'SYSTEM'),
  getHitlDescription: jest.fn(() => ''),
}));
jest.mock('../../hitl-enforcement/service', () => ({
  hitlEnforcementService: { getOversightSettings: jest.fn(async () => undefined) },
}));
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: jest.fn(async () => null) }),
}));
jest.mock('../../llm/tiers', () => ({ resolveModelForTier: jest.fn(() => 'model-x') }));
jest.mock('../../browser-sessions/session-vendor-connectors', () => ({
  hasSessionBrowserConnector: jest.fn(() => false),
  platformPaneBrowserOn: jest.fn(async () => false),
}));
jest.mock('../../agent-execution/prior-work', () => ({
  priorWork: jest.fn(async () => []),
  renderPriorWorkBlock: jest.fn(() => ''),
}));
jest.mock('../../agent-execution/autonomous-session', () => ({
  rebuildFromCanonical: jest.fn(async () => null),
}));
jest.mock('../../trajectories/canonical-artifact', () => ({ appendCanonicalArtifact: jest.fn(async () => undefined) }));
jest.mock('../../clients/generated-files-client', () => ({ fetchMediaBytes: jest.fn() }));
jest.mock('../../infrastructure/oidc-fetch', () => ({ fetchWithOidc: jest.fn() }));
jest.mock('../../infrastructure/runtime-env', () => ({ getPlatformBackendUrl: jest.fn(() => '') }));
jest.mock('../../infrastructure/secret-store', () => ({ getManagedSecret: jest.fn(() => '') }));
jest.mock('../delivery-rule-check', () => ({ recordDeliveryRuleViolations: jest.fn() }));
jest.mock('../../tool-gateway/host-delivered', () => ({ drainHostDelivered: jest.fn(() => []) }));
jest.mock('../../agent-execution/delegated-agents', () => ({ listDelegatedAgentIds: jest.fn(async () => []) }));
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ warm: jest.fn(async () => undefined) }),
}));
jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: { onChatTurnCompleted: jest.fn(async () => undefined) },
}));
const rememberMock = jest.fn(async () => undefined);
jest.mock('../../agent-execution/remember-external-tool-call', () => ({
  rememberExternalToolCall: (...a: unknown[]) => rememberMock(...a),
}));
const addMessageMock = jest.fn(async () => undefined);
jest.mock('../../invocations', () => ({
  invocationsService: { addMessage: (...a: unknown[]) => addMessageMock(...a) },
}));
const settleMock = jest.fn(async () => undefined);
jest.mock('../../platform-callback/client', () => ({
  settleChatTurnViaCallback: (...a: unknown[]) => settleMock(...a),
  getPlatformCallbackClient: jest.fn(() => null),
}));
const escalationKindMock = jest.fn();
jest.mock('../../agent-execution/engine/escalation-helper', () => ({
  escalationKindById: (...a: unknown[]) => escalationKindMock(...a),
}));
const closingReplyMock = jest.fn();
const closingVerdictMock = jest.fn();
jest.mock('../closing-reply', () => ({
  requestClosingReply: (...a: unknown[]) => closingReplyMock(...a),
  requestClosingReplyWithVerdict: (...a: unknown[]) => closingVerdictMock(...a),
  trimActivityDigest: (t: string | null) => t ?? '(no transcript for this turn)',
}));
const scheduleContinuationMock = jest.fn(async () => 'row-1');
const cancelContinuationsMock = jest.fn(async () => 0);
jest.mock('../chat-continuation', () => ({
  scheduleChatContinuation: (...a: unknown[]) => scheduleContinuationMock(...(a as [])),
  cancelChatContinuations: (...a: unknown[]) => cancelContinuationsMock(...(a as [])),
  MAX_CHAT_CONTINUATIONS_PER_MESSAGE: 5,
}));

// The engine, scripted per test: what it streams and how it ends.
type Sink = (event: Record<string, unknown>) => void;
let engineScript: (sink: Sink) => Promise<Record<string, unknown>> = async () => ({ success: true, output: '' });
const executeTaskMock = jest.fn(async (input: { streamSink: Sink }) => engineScript(input.streamSink));
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: {
    executeTask: (...a: unknown[]) => executeTaskMock(...(a as [{ streamSink: Sink }])),
    buildChatToolCatalog: jest.fn(async () => ({
      catalog: { tools: [], servers: [] }, toolNames: [], vendorMcpServers: {}, activeBrowserSession: null, delegateIdByLabel: new Map(),
    })),
  },
  chatSandboxCapabilities: jest.fn(() => ({})),
  workflowStepsEnabled: jest.fn(() => false),
  completeResultToolNames: jest.fn(() => []),
  chatConversationalDefaultEnabled: jest.fn(() => false),
}));

import { chatTurnRouter } from '../chat-turn-handler';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(chatTurnRouter);
  return app;
}

interface Frame { event: string; data: Record<string, unknown> }
function parseSse(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (ev && data) frames.push({ event: ev, data: JSON.parse(data) });
  }
  return frames;
}

async function turn(): Promise<{ status: number; frames: Frame[] }> {
  const res = await request(makeApp())
    .post(`/${AGENT_ID}/chat-turn`)
    .send({
      tenantId: TENANT_ID, agentId: AGENT_ID, threadId: THREAD_ID, invocationId: INVOCATION_ID, turnId: TURN_ID,
      channelHint: 'web', userId: 'u1', userDisplayName: 'Tester', userRole: 'member',
      userMessage: 'Run the audit now.',
    });
  return { status: res.status, frames: parseSse(res.text) };
}

const assistantRow = () => (addMessageMock.mock.calls as unknown as Array<[{ role: string; content: string }]>)
  .map((c) => c[0]).find((m) => m.role === 'assistant');
const settled = () => (settleMock.mock.calls as unknown as Array<[{ replyText: string; final?: boolean }]>).map((c) => c[0]);
const flush = () => new Promise((r) => setTimeout(r, 20));

const speaks = (sink: Sink, text: string) => {
  sink({ type: 'assistant_delta', text });
  sink({ type: 'assistant_message', content: [{ type: 'text', text }] });
};
const calls = (sink: Sink, name: string, callId: string, args: Record<string, unknown>, result: unknown) => {
  sink({ type: 'tool_call_started', toolName: name, callId, args });
  sink({ type: 'tool_call_finished', callId, result });
};


beforeEach(() => {
  jest.clearAllMocks();
  escalationKindMock.mockResolvedValue(null);
  closingReplyMock.mockResolvedValue(null);
  closingVerdictMock.mockResolvedValue(null);
  scheduleContinuationMock.mockResolvedValue('row-1');
});

describe('a chat turn a bound closed', () => {
  it('limit_reached WITH text: the closing reply is asked for and appended, persisted, settled, completed, and no error frame goes out', async () => {
    closingVerdictMock.mockResolvedValue({ text: 'I read twelve of the twenty threads; eight are still to do.', unfinished: true });
    engineScript = async (sink) => {
      speaks(sink, 'Reading the threads now.');
      calls(sink, 'dataset_extract', 'item_0', { datasetId: 'd1', instruction: 'summarise' }, { digest: 'twelve summaries' });
      return { success: false, terminalState: 'limit_reached', failureClass: 'limit_reached', output: 'Reading the threads now.', error: 'max turns' };
    };
    const { status, frames } = await turn();
    await flush();
    expect(status).toBe(200);
    // Asked WITH text, from the turn's own tool results, with the verdict.
    expect(closingVerdictMock).toHaveBeenCalledTimes(1);
    const ask = (closingVerdictMock.mock.calls[0] as unknown[])[0] as { activityDigest: string; userMessage: string };
    expect(ask.activityDigest).toContain('twelve summaries');
    expect(ask.userMessage).toBe('Run the audit now.');
    const expected = 'Reading the threads now.\n\nI read twelve of the twenty threads; eight are still to do.';
    expect(assistantRow()?.content).toBe(expected);
    expect(frames.find((f) => f.event === 'complete')?.data.outputText).toBe(expected);
    expect(settled()[0]).toMatchObject({ replyText: expected, final: true });
    expect(frames.find((f) => f.event === 'error')).toBeUndefined();
    // Unfinished: a continuation run is scheduled on the thread, for the
    // person who asked, as the first of at most five.
    expect(scheduleContinuationMock).toHaveBeenCalledTimes(1);
    expect((scheduleContinuationMock.mock.calls[0] as unknown[])[0]).toMatchObject({
      tenantId: TENANT_ID, runtimeAgentId: RUNTIME_ID, internalAgentId: AGENT_ID, threadId: THREAD_ID,
      originTurnId: TURN_ID, originMessage: 'Run the audit now.', senderUserId: 'u1', ordinal: 1,
      scheduledByInvocationId: INVOCATION_ID, reason: 'limit_reached',
    });
    // Queued after the reply is persisted.
    const assistantPersisted = addMessageMock.mock.invocationCallOrder[
      (addMessageMock.mock.calls as unknown as Array<[{ role: string }]>).findIndex((c) => c[0].role === 'assistant')
    ];
    expect(scheduleContinuationMock.mock.invocationCallOrder[0]).toBeGreaterThan(assistantPersisted);
  });

  it('limit_reached whose closing reply says [done] schedules nothing', async () => {
    closingVerdictMock.mockResolvedValue({ text: 'All twenty are summarised.', unfinished: false });
    engineScript = async (sink) => {
      speaks(sink, 'Nearly there.');
      return { success: false, terminalState: 'limit_reached', failureClass: 'limit_reached', output: 'Nearly there.' };
    };
    await turn();
    await flush();
    expect(assistantRow()?.content).toBe('Nearly there.\n\nAll twenty are summarised.');
    expect(scheduleContinuationMock).not.toHaveBeenCalled();
  });

  it('a closing call that produced nothing is unfinished: the narration stands and the continuation is scheduled', async () => {
    closingVerdictMock.mockResolvedValue(null);
    engineScript = async (sink) => {
      speaks(sink, 'Partial.');
      return { success: false, terminalState: 'limit_reached', failureClass: 'limit_reached', output: 'Partial.' };
    };
    await turn();
    await flush();
    expect(assistantRow()?.content).toBe('Partial.');
    expect(scheduleContinuationMock).toHaveBeenCalledTimes(1);
  });

  it('a turn that finished on its own is never asked for a verdict and schedules nothing', async () => {
    engineScript = async (sink) => {
      speaks(sink, 'Done.');
      return { success: true, terminalState: 'success', output: 'Done.' };
    };
    await turn();
    await flush();
    expect(closingVerdictMock).not.toHaveBeenCalled();
    expect(scheduleContinuationMock).not.toHaveBeenCalled();
  });

  it('a new person message on the thread cancels the queued continuations before its turn runs', async () => {
    engineScript = async (sink) => {
      speaks(sink, 'Done.');
      return { success: true, terminalState: 'success', output: 'Done.' };
    };
    await turn();
    await flush();
    expect(cancelContinuationsMock).toHaveBeenCalledWith(TENANT_ID, THREAD_ID);
  });
});
