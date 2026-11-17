// The turn claims a hand-over to the Chief AI Officer only when a request
// was actually registered.
//
// A team can reply "I will have the Chief AI Officer draft the automation"
// and make no tool call; then nothing is registered and no preview comes.
// Driven through the real route with a stubbed engine: a
// reply that claims the hand-over without the call gets the request
// registered on the team's behalf with the person's own message; a turn
// that made the call is left alone; a refusal or a failure puts the
// correcting sentence into the persisted row, the complete frame and the
// settle callback alike. The detector's own edges are pinned on their own.

import { claimsChiefAiOfficerHandover, calledBringInColleague } from '../colleague-handover-claim';
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
const registerMock = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  settleChatTurnViaCallback: (...a: unknown[]) => settleMock(...a),
  registerColleagueRequest: (...a: unknown[]) => registerMock(...a),
  getPlatformCallbackClient: jest.fn(() => null),
}));
const escalationKindMock = jest.fn();
jest.mock('../../agent-execution/engine/escalation-helper', () => ({
  escalationKindById: (...a: unknown[]) => escalationKindMock(...a),
}));
const closingReplyMock = jest.fn();
jest.mock('../closing-reply', () => ({
  requestClosingReply: (...a: unknown[]) => closingReplyMock(...a),
  trimActivityDigest: (t: string | null) => t ?? '(no transcript for this turn)',
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

const PERSON_MESSAGE = 'Automate everything we both just did';

async function turn(): Promise<{ status: number; frames: Frame[] }> {
  const res = await request(makeApp())
    .post(`/${AGENT_ID}/chat-turn`)
    .send({
      tenantId: TENANT_ID, agentId: AGENT_ID, threadId: THREAD_ID, invocationId: INVOCATION_ID, turnId: TURN_ID,
      channelHint: 'web', userId: 'u1', userDisplayName: 'Tester', userRole: 'member',
      userMessage: PERSON_MESSAGE,
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
  registerMock.mockResolvedValue({ registered: true });
});


const CLAIM = 'I will have the Chief AI Officer draft the automation for opening Fratello Watches and reporting the homepage highlights.';

describe('claimsChiefAiOfficerHandover', () => {
  it.each([
    CLAIM,
    'Understood. The Chief AI Officer will post here shortly what would change, and it happens only when you agree.',
    "I'm bringing in the Chief AI Officer to change how I am built.",
    'Let me pass this to the Chief AI Officer.',
  ])('reads a claim: %s', (text) => {
    expect(claimsChiefAiOfficerHandover(text)).toBe(true);
  });

  it.each([
    'The Chief AI Officer designs new agents in its own chat and through Liftoff, so a new team is asked for there; I will not bring it in for that.',
    'The Chief AI Officer changed my workflow last week.',
    'I opened the page and summarised it. Nothing else to do.',
    '',
  ])('reads no claim: %s', (text) => {
    expect(claimsChiefAiOfficerHandover(text)).toBe(false);
  });

  it('recognises the call by its catalog name or its namespaced spelling', () => {
    expect(calledBringInColleague(['web_fetch_advanced', 'bring_in_colleague'])).toBe(true);
    expect(calledBringInColleague(['mcp__liftoff-tool-gateway__bring_in_colleague'])).toBe(true);
    expect(calledBringInColleague(['web_fetch_advanced'])).toBe(false);
  });
});

describe('a claimed hand-over follows the record', () => {
  it('a reply that promises the Chief AI Officer without the call: the request is registered on the team\'s behalf, in the person\'s words, and the reply stands', async () => {
    engineScript = async (sink) => {
      speaks(sink, CLAIM);
      return { success: true, output: CLAIM };
    };
    const { status, frames } = await turn();
    await flush();
    expect(status).toBe(200);
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID, agentId: RUNTIME_ID, internalAgentId: AGENT_ID, threadId: THREAD_ID,
      colleague: 'caio', request: PERSON_MESSAGE,
    });
    expect(assistantRow()?.content).toBe(CLAIM);
    expect(frames.find((f) => f.event === 'complete')?.data.outputText).toBe(CLAIM);
    expect(settled()[0]).toMatchObject({ replyText: CLAIM, final: true });
  });

  it('a turn that made the call itself is left alone', async () => {
    engineScript = async (sink) => {
      calls(sink, 'bring_in_colleague', 'c1', { colleague: 'caio', request: 'automate the check' }, { registered: true, colleague: 'caio' });
      speaks(sink, 'The Chief AI Officer will post here shortly what would change, and it happens only when you agree.');
      return { success: true, output: 'ok' };
    };
    await turn();
    await flush();
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('a reply with no claim registers nothing', async () => {
    engineScript = async (sink) => {
      speaks(sink, 'The homepage lists three videos and a newsletter box.');
      return { success: true, output: 'ok' };
    };
    await turn();
    await flush();
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('a refused registration puts the refusal into every copy of the reply', async () => {
    registerMock.mockResolvedValue({ registered: false, reason: 'open_proposal_exists' });
    engineScript = async (sink) => {
      speaks(sink, CLAIM);
      return { success: true, output: CLAIM };
    };
    const { frames } = await turn();
    await flush();
    const expected = `${CLAIM}\n\nCorrection: An earlier proposal of mine is still waiting for your answer, so I cannot open another until it is settled.`;
    expect(assistantRow()?.content).toBe(expected);
    expect(frames.find((f) => f.event === 'complete')?.data.outputText).toBe(expected);
    expect(settled()[0]).toMatchObject({ replyText: expected });
  });

  it('a registration that fails says the Chief AI Officer has not been brought in', async () => {
    registerMock.mockRejectedValue(new Error('platform down'));
    engineScript = async (sink) => {
      speaks(sink, CLAIM);
      return { success: true, output: CLAIM };
    };
    await turn();
    await flush();
    expect(assistantRow()?.content).toContain('Correction: the Chief AI Officer has not been brought in');
    expect(assistantRow()?.content).not.toMatch(/\u2014|n't\b/);
  });
});
