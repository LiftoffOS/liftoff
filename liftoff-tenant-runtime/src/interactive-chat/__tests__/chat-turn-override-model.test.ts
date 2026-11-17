// The chat turn's catalog runs on the agent's vendor, not the workspace's.
//
// The catalog's `resolvedModelId` is what code_session reads as `outerModelId`
// and picks its coding model from. The turn resolved it by hand as
// `modelId ?? workspaceRouting.model ?? tier table`, with no check that the
// workspace's model belonged to the agent's provider, so a team moved to Qwen
// by the per-agent AI Provider Override on a GLM workspace coded on GLM's model
// while the session was billed as Qwen. executeTask never had the bug; it now
// shares one resolver with this path (resolveAgentModelId).
//
// Driven through the real route; read off the arguments the catalog is built
// with. The tier tables are real, so the ids are the ones production resolves.

import express from 'express';
import request from 'supertest';

const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const AGENT_ID = '5e4acb47-c63b-4f3f-a90d-aedcedbda8eb';
const RUNTIME_ID = 'abbb7a1c-f66f-46d8-b65a-e2e52ea77568';
const THREAD_ID = '7b9d446d-2f0e-4a44-9c1e-2b7a5f0c1d33';
const INVOCATION_ID = '627da69d-5f8a-4a2b-9f31-0c7d4e2a1b55';
const TURN_ID = '9f1c2b3a-4d5e-4f60-8a71-2b3c4d5e6f70';

let agentModelConfig: Record<string, unknown> = {};
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
      return { rows: [{ name: 'Monitor', role: 'analyst', messaging_nickname: null, memory_scope: {}, model_config: agentModelConfig, workflow_steps: [] }] };
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
const getModelForTaskMock = jest.fn();
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: (...a: unknown[]) => getModelForTaskMock(...a) }),
}));
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

const buildCatalogMock = jest.fn(async (_p: unknown) => ({
  catalog: { tools: [], servers: [] }, toolNames: [], vendorMcpServers: {}, activeBrowserSession: null, delegateIdByLabel: new Map(),
}));

// The engine, scripted per test: what it streams and how it ends.
type Sink = (_event: Record<string, unknown>) => void;
let engineScript: (_sink: Sink) => Promise<Record<string, unknown>> = async () => ({ success: true, output: '' });
const executeTaskMock = jest.fn(async (input: { streamSink: Sink }) => engineScript(input.streamSink));
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: {
    executeTask: (...a: unknown[]) => executeTaskMock(...(a as [{ streamSink: Sink }])),
    buildChatToolCatalog: (...a: unknown[]) => buildCatalogMock(...a),
  },
  chatSandboxCapabilities: jest.fn(() => ({})),
  workflowStepsEnabled: jest.fn(() => false),
  completeResultToolNames: jest.fn(() => []),
  chatConversationalDefaultEnabled: jest.fn(() => false),
}));

import { chatTurnRouter } from '../chat-turn-handler';
import { resolveModelForTier } from '../../llm/tiers';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(chatTurnRouter);
  return app;
}

async function turn(): Promise<void> {
  await request(makeApp())
    .post(`/${AGENT_ID}/chat-turn`)
    .send({
      tenantId: TENANT_ID, agentId: AGENT_ID, threadId: THREAD_ID, invocationId: INVOCATION_ID, turnId: TURN_ID,
      channelHint: 'web', userId: 'u1', userDisplayName: 'Tester', userRole: 'member',
      userMessage: 'Fix the failing test.',
    });
  await new Promise((r) => setTimeout(r, 20));
}

const catalogArgs = () => (buildCatalogMock.mock.calls[0] as unknown as [{
  resolvedProvider: string; resolvedModelId: string; explicitModelId?: string;
}])[0];

const GLM_WORKSPACE = { model: 'z-ai/glm-5.2', provider: 'glm' };

beforeEach(() => {
  jest.clearAllMocks();
  escalationKindMock.mockResolvedValue(null);
  closingReplyMock.mockResolvedValue(null);
  engineScript = async () => ({ success: true, output: 'done' });
  getModelForTaskMock.mockResolvedValue(GLM_WORKSPACE);
});

describe('the chat turn resolves its model for the agent\'s own vendor', () => {
  it('a Qwen-overridden team on a GLM workspace gets Qwen\'s model, not the workspace\'s', async () => {
    agentModelConfig = { provider: 'qwen' };
    await turn();
    expect(catalogArgs().resolvedProvider).toBe('qwen');
    expect(catalogArgs().resolvedModelId).toBe(resolveModelForTier('qwen', 'medium'));
    expect(catalogArgs().resolvedModelId).toBe('qwen/qwen3.7-plus');
    expect(catalogArgs().explicitModelId).toBeUndefined();
  });

  it('the override honours the agent\'s tier', async () => {
    agentModelConfig = { provider: 'qwen', tier: 'large' };
    await turn();
    expect(getModelForTaskMock).toHaveBeenCalledWith(TENANT_ID, 'agent_execution', 'large');
    expect(catalogArgs().resolvedModelId).toBe('qwen/qwen3.8-max-0902');
  });

  it('a pinned modelId still wins, and is passed on as the pin', async () => {
    agentModelConfig = { provider: 'qwen', modelId: 'qwen/qwen3.7-flash' };
    await turn();
    expect(catalogArgs().resolvedModelId).toBe('qwen/qwen3.7-flash');
    expect(catalogArgs().explicitModelId).toBe('qwen/qwen3.7-flash');
  });

  it('an agent on the workspace\'s vendor keeps the workspace\'s model', async () => {
    agentModelConfig = { provider: 'glm' };
    await turn();
    expect(catalogArgs().resolvedProvider).toBe('glm');
    expect(catalogArgs().resolvedModelId).toBe('z-ai/glm-5.2');
  });

  it('an agent naming no provider follows the workspace entirely', async () => {
    agentModelConfig = {};
    await turn();
    expect(catalogArgs().resolvedProvider).toBe('glm');
    expect(catalogArgs().resolvedModelId).toBe('z-ai/glm-5.2');
  });
});
