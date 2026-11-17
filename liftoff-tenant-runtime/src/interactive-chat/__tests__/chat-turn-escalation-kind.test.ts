// The turn claims a hand-off only when a person actually receives one, and a
// turn whose graph could not continue still says what it found.
//
// `escalated` on a result says an escalation ROW was written. Only a row of
// kind 'escalation' opened a thread and sent a notification; a
// 'system_internal' row is operator-only, and the thread was still told
// "Passed to a person for review." — by this service's persisted row AND by
// the control plane, which reads the `escalated` flag on the `complete` frame
// and appends the same sentence. Nobody in the workspace received anything.
//
// Driven through the real route with a stubbed executeTask and a stubbed
// kind lookup, and read off the three consumers: the persisted assistant
// row, the `complete` frame, and the settle callback's replyText.

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
});

describe('the hand-off sentence follows the record', () => {
  it('a customer-facing escalation: the sentence in the row, the flag on the frame, the sentence settled', async () => {
    escalationKindMock.mockResolvedValue('escalation');
    engineScript = async (sink) => {
      speaks(sink, 'Starting now.');
      return { success: true, escalated: true, escalationId: 'esc-1', terminalState: 'escalated', output: 'Starting now.' };
    };
    const { status, frames } = await turn();
    await flush();
    expect(status).toBe(200);
    expect(escalationKindMock).toHaveBeenCalledWith(TENANT_ID, 'esc-1');
    expect(assistantRow()?.content).toBe('Starting now.\n\nPassed to a person for review.');
    const complete = frames.find((f) => f.event === 'complete');
    expect(complete?.data.escalated).toBe(true);
    expect(complete?.data.outputText).toBe('Starting now.\n\nPassed to a person for review.');
    expect(settled()[0]).toMatchObject({ replyText: 'Starting now.\n\nPassed to a person for review.', final: true });
  });

  it('a system_internal escalation: none of the three, and the run is said not to have finished', async () => {
    escalationKindMock.mockResolvedValue('system_internal');
    engineScript = async (sink) => {
      speaks(sink, 'Starting now.');
      return { success: true, escalated: true, escalationId: 'esc-2', terminalState: 'escalated', output: 'Starting now.' };
    };
    const { frames } = await turn();
    await flush();
    // This case's TITLE always said the run is said not to have finished, and
    // its body asserted the opposite: `said || RUN_DID_NOT_FINISH` made the
    // statement a substitute for silence, so a run that escalated AND spoke
    // published only its prose. A run that died early could tell someone
    // "This week's report already ran" with nothing anywhere saying it had
    // failed.
    const WITH_FACT = 'Starting now.\n\nThis run did not finish.';
    expect(assistantRow()?.content).toBe(WITH_FACT);
    const complete = frames.find((f) => f.event === 'complete');
    // Still NOT `escalated`: nobody in the workspace was handed anything, so
    // the control plane must not append its hand-off sentence.
    expect(complete?.data.escalated).toBeUndefined();
    // The other half of that fact, so the control plane can append its own
    // wording rather than rebuild the message from its accumulator and strip
    // the sentence off `outputText`.
    expect(complete?.data.didNotFinish).toBe(true);
    expect(complete?.data.outputText).toBe(WITH_FACT);
    expect(settled()[0].replyText).toBe(WITH_FACT);
    expect(JSON.stringify(frames)).not.toContain('Passed to a person');
  });

  it('a customer-facing escalation does NOT also claim the run did not finish', async () => {
    // One terminal fact per turn. A person who was handed the work does not
    // need to be told the run stopped as well, and the two sentences together
    // read as two different things having happened.
    escalationKindMock.mockResolvedValue('escalation');
    engineScript = async (sink) => {
      speaks(sink, 'Starting now.');
      return { success: true, escalated: true, escalationId: 'esc-4', terminalState: 'escalated', output: 'Starting now.' };
    };
    const { frames } = await turn();
    await flush();
    const complete = frames.find((f) => f.event === 'complete');
    expect(complete?.data.escalated).toBe(true);
    expect(complete?.data.didNotFinish).toBeUndefined();
    expect(assistantRow()?.content).not.toContain('did not finish');
  });

  it('a system_internal escalation with nothing said and nothing gathered persists RUN_DID_NOT_FINISH', async () => {
    escalationKindMock.mockResolvedValue('system_internal');
    engineScript = async () => ({ success: true, escalated: true, escalationId: 'esc-3', terminalState: 'escalated' });
    const { frames } = await turn();
    await flush();
    expect(assistantRow()?.content).toBe('This run did not finish.');
    expect(frames.find((f) => f.event === 'complete')?.data.outputText).toBe('This run did not finish.');
    expect(frames.find((f) => f.event === 'complete')?.data.escalated).toBeUndefined();
  });

  it('a lookup that throws is treated as system_internal: the claim is made only when the record proves it', async () => {
    escalationKindMock.mockRejectedValue(new Error('db down'));
    engineScript = async (sink) => {
      speaks(sink, 'Starting now.');
      return { success: true, escalated: true, escalationId: 'esc-4', terminalState: 'escalated', output: 'Starting now.' };
    };
    const { frames } = await turn();
    await flush();
    // Treated as operator-side, so the hand-off claim is withheld AND the
    // statement that the run did not finish is made. A lookup that could not
    // answer is the case where both halves matter: nobody has reliably been
    // handed anything, and the run definitely did not finish.
    expect(assistantRow()?.content).toBe('Starting now.\n\nThis run did not finish.');
    expect(frames.find((f) => f.event === 'complete')?.data.escalated).toBeUndefined();
    expect(frames.find((f) => f.event === 'complete')?.data.didNotFinish).toBe(true);
  });

  it('a missing escalation id never claims a hand-off', async () => {
    // The real lookup answers null for a missing id; the mock does the same.
    engineScript = async () => ({ success: true, escalated: true, terminalState: 'escalated', output: 'x' });
    const { frames } = await turn();
    await flush();
    expect(escalationKindMock).toHaveBeenCalledWith(TENANT_ID, undefined);
    expect(frames.find((f) => f.event === 'complete')?.data.escalated).toBeUndefined();
    // Nothing was streamed, so nothing was said; the flat statement stands.
    expect(assistantRow()?.content).toBe('This run did not finish.');
  });
});

describe('the last resort: a turn whose graph could not continue says what it found', () => {
  it('an escalated turn with prose and tool results gets the closing reply appended, from a digest of those results', async () => {
    escalationKindMock.mockResolvedValue('system_internal');
    closingReplyMock.mockResolvedValue('ACME sells widgets; two of the pages I tried were not there.');
    engineScript = async (sink) => {
      speaks(sink, 'Starting now.');
      calls(sink, 'web_fetch_advanced', 'item_0', { url: 'https://acme.example/' }, { content: 'ACME HOME' });
      calls(sink, 'web_fetch_advanced', 'item_1', { url: 'https://acme.example/about' }, { content: 'ACME ABOUT' });
      return { success: true, escalated: true, escalationId: 'esc-5', terminalState: 'escalated', output: 'Starting now.' };
    };
    const { frames } = await turn();
    await flush();
    // Asked even though the turn had prose; fed the turn's own tool results.
    expect(closingReplyMock).toHaveBeenCalledTimes(1);
    const ask = (closingReplyMock.mock.calls[0] as unknown[])[0] as { activityDigest: string; unfinished?: boolean };
    expect(ask.unfinished).toBe(true);
    expect(ask.activityDigest).toContain('Tool calls this step made: 2 (2 succeeded, 0 failed).');
    expect(ask.activityDigest).toContain('ACME HOME');
    expect(ask.activityDigest).toContain('ACME ABOUT');
    // The closing reply says what the run found; the statement says the run
    // stopped. Both, because a digest of partial work reads as a finished
    // answer without it — which is how "This week's report already ran"
    // can reach a person off a run that died early.
    const expected = 'Starting now.\n\nACME sells widgets; two of the pages I tried were not there.'
      + '\n\nThis run did not finish.';
    expect(assistantRow()?.content).toBe(expected);
    expect(frames.find((f) => f.event === 'complete')?.data.outputText).toBe(expected);
    expect(settled()[0].replyText).toBe(expected);
  });

  it('an escalated turn with NO successful tool result is not asked from a digest', async () => {
    escalationKindMock.mockResolvedValue('system_internal');
    engineScript = async (sink) => {
      speaks(sink, 'Starting now.');
      return { success: true, escalated: true, escalationId: 'esc-6', terminalState: 'escalated', output: 'Starting now.' };
    };
    await turn();
    await flush();
    expect(closingReplyMock).not.toHaveBeenCalled();
  });

  it('an engine_error turn with tool results streams the closing prose, persists and settles it, THEN sends the error frame', async () => {
    closingReplyMock.mockResolvedValue('I read the home page; the rest did not complete.');
    engineScript = async (sink) => {
      calls(sink, 'web_fetch_advanced', 'item_0', { url: 'https://acme.example/' }, { content: 'ACME HOME' });
      return { success: false, terminalState: 'engine_error', failureClass: 'unknown', error: 'provider 500' };
    };
    const { frames } = await turn();
    await flush();
    const types = frames.map((f) => f.event);
    const delta = frames.find((f) => f.event === 'text_delta' && f.data.text === 'I read the home page; the rest did not complete.');
    expect(delta).toBeDefined();
    const errorIdx = types.lastIndexOf('error');
    expect(errorIdx).toBeGreaterThan(frames.indexOf(delta!));
    expect(types[errorIdx - 1]).toBe('text_break');
    // The error frame exactly as today.
    expect(frames[errorIdx].data).toMatchObject({ code: 'EXEC_ERROR', failureClass: 'unknown' });
    expect(assistantRow()?.content).toBe('I read the home page; the rest did not complete.');
    expect(settled()[0]).toMatchObject({ replyText: 'I read the home page; the rest did not complete.', final: true });
  });

  it('a task_failed turn takes the same path, keeping what the turn said before it failed in front', async () => {
    closingReplyMock.mockResolvedValue('Here is what I found before stopping.');
    engineScript = async (sink) => {
      speaks(sink, 'Looking now.');
      calls(sink, 'web_fetch_advanced', 'item_0', { url: 'https://acme.example/' }, { content: 'ACME HOME' });
      return { success: false, terminalState: 'task_failed', failureClass: 'unknown', error: 'cannot be done' };
    };
    const { frames } = await turn();
    await flush();
    // Both writers agree: the control plane accumulated both deltas, and the
    // row and the settle carry the same two paragraphs.
    expect(assistantRow()?.content).toBe('Looking now.\n\nHere is what I found before stopping.');
    expect(settled()[0].replyText).toBe('Looking now.\n\nHere is what I found before stopping.');
    expect(frames.some((f) => f.event === 'error')).toBe(true);
  });

  it('a failed turn with no tool results persists nothing, as today', async () => {
    engineScript = async () => ({ success: false, terminalState: 'engine_error', failureClass: 'unknown', error: 'provider 500' });
    const { frames } = await turn();
    await flush();
    expect(closingReplyMock).not.toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(frames.some((f) => f.event === 'error')).toBe(true);
  });

  it('a context overflow is excluded: the session-clearing behaviour stands and no model call is spent', async () => {
    engineScript = async (sink) => {
      calls(sink, 'web_fetch_advanced', 'item_0', { url: 'https://acme.example/' }, { content: 'ACME HOME' });
      return { success: false, terminalState: 'engine_error', failureClass: 'context_overflow', error: 'prompt too long' };
    };
    await turn();
    await flush();
    expect(closingReplyMock).not.toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  it('a closing reply that produces nothing leaves the failed turn exactly as today', async () => {
    closingReplyMock.mockResolvedValue(null);
    engineScript = async (sink) => {
      calls(sink, 'web_fetch_advanced', 'item_0', { url: 'https://acme.example/' }, { content: 'ACME HOME' });
      return { success: false, terminalState: 'engine_error', failureClass: 'unknown', error: 'provider 500' };
    };
    const { frames } = await turn();
    await flush();
    expect(closingReplyMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(settleMock).not.toHaveBeenCalled();
    expect(frames.some((f) => f.event === 'error')).toBe(true);
  });
});

describe('the collector pairs a finish with its own start', () => {
  it('two calls both named item_0 across turns are recorded and remembered correctly', async () => {
    escalationKindMock.mockResolvedValue('system_internal');
    closingReplyMock.mockResolvedValue('Found it.');
    engineScript = async (sink) => {
      calls(sink, 'run_routine_now', 'item_0', { routine: 'audit' }, { started: true });
      calls(sink, 'web_fetch_advanced', 'item_0', { url: 'https://acme.example/' }, { content: 'ACME HOME' });
      return { success: true, escalated: true, escalationId: 'esc-7', terminalState: 'escalated', output: '' };
    };
    await turn();
    await flush();
    const remembered = (rememberMock.mock.calls as unknown as Array<[{ toolName: string; args: unknown; result: unknown }]>).map((c) => c[0]);
    expect(remembered).toEqual([
      expect.objectContaining({ toolName: 'run_routine_now', args: { routine: 'audit' }, result: { started: true } }),
      expect.objectContaining({ toolName: 'web_fetch_advanced', args: { url: 'https://acme.example/' }, result: { content: 'ACME HOME' } }),
    ]);
    const ask = (closingReplyMock.mock.calls[0] as unknown[])[0] as { activityDigest: string };
    expect(ask.activityDigest).toContain('run_routine_now({"routine":"audit"}): {"started":true}');
    expect(ask.activityDigest).toContain('web_fetch_advanced({"url":"https://acme.example/"}): {"content":"ACME HOME"}');
  });
});
