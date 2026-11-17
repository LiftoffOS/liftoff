// The harness builds its catalog on the same model the chat turn does.
//
// It had its own copy of the chat turn's `modelId ?? workspaceRouting.model`
// line, so it carried the same bug: a team on the per-agent AI Provider
// Override got the workspace vendor's model as code_session's `outerModelId`.
// It now resolves through the shared resolver, with the agent's tier and the
// tuning gate's override merged the way executeTask merges it.
//
// Driven through the real route up to the catalog build, which records its
// arguments and then stops the run.

import express from 'express';
import request from 'supertest';

const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const AGENT_ID = '5e4acb47-c63b-4f3f-a90d-aedcedbda8eb';

let agentModelConfig: unknown = {};
const fakePool = {
  query: jest.fn(async (sql: string) => {
    if (/FROM compiled_instructions/i.test(sql)) {
      return { rows: [{ id: 'ins-1', version: 3, system_prompt: 'sp', user_instructions: '', integrations: [], instructions_md: null, capability_tier: null, raw_input: {} }] };
    }
    if (/SELECT model_config FROM agents/i.test(sql)) return { rows: [{ model_config: agentModelConfig }] };
    return { rows: [] };
  }),
};
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => fakePool, getPool: () => fakePool,
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../interactive-chat/chat-turn-handler', () => ({ warmGovernancePreflightFireAndForget: jest.fn() }));
jest.mock('../../diagnostics/driver/passive', () => ({
  harvestTarget: jest.fn(), harvestOne: jest.fn(), harvestAllActiveAgents: jest.fn(),
}));
jest.mock('../../browser-sessions/session-vendor-connectors', () => ({
  hasSessionBrowserConnector: jest.fn(() => false), platformPaneBrowserOn: jest.fn(async () => false),
}));
const getModelForTaskMock = jest.fn();
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: (...a: unknown[]) => getModelForTaskMock(...a) }),
}));
const buildCatalogMock = jest.fn(async (_p: unknown) => { throw new Error('stop after catalog'); });
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: { buildChatToolCatalog: (...a: unknown[]) => buildCatalogMock(...(a as [unknown])) },
}));

import { testHarnessRouter } from '../run-agent-router';

async function run(extra: Record<string, unknown> = {}): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(testHarnessRouter);
  await request(app).post('/run-agent').send({ tenantId: TENANT_ID, agentId: AGENT_ID, prompt: 'Fix the failing test.', ...extra });
}

const catalogArgs = () => (buildCatalogMock.mock.calls[0] as unknown as [{
  resolvedProvider: string; resolvedModelId: string; explicitModelId?: string;
}])[0];

beforeEach(() => {
  jest.clearAllMocks();
  getModelForTaskMock.mockResolvedValue({ model: 'z-ai/glm-5.2', provider: 'glm' });
});

describe('the harness resolves the model exactly as the chat turn does', () => {
  it('a Qwen-overridden team on a GLM workspace gets Qwen\'s model', async () => {
    agentModelConfig = { provider: 'qwen' };
    await run();
    expect(catalogArgs()).toMatchObject({ resolvedProvider: 'qwen', resolvedModelId: 'qwen/qwen3.7-plus' });
    expect(catalogArgs().explicitModelId).toBeUndefined();
  });

  it('passes the agent\'s tier to routing and resolves the override at it', async () => {
    agentModelConfig = JSON.stringify({ provider: 'qwen', tier: 'large' });
    await run();
    expect(getModelForTaskMock).toHaveBeenCalledWith(TENANT_ID, 'agent_execution', 'large');
    expect(catalogArgs().resolvedModelId).toBe('qwen/qwen3.8-max-0902');
  });

  it('a pinned modelId wins and is forwarded as the pin', async () => {
    agentModelConfig = { provider: 'qwen', modelId: 'qwen/qwen3.7-flash' };
    await run();
    expect(catalogArgs()).toMatchObject({ resolvedModelId: 'qwen/qwen3.7-flash', explicitModelId: 'qwen/qwen3.7-flash' });
  });

  it('same-vendor routing keeps the workspace model', async () => {
    agentModelConfig = { provider: 'glm' };
    await run();
    expect(catalogArgs()).toMatchObject({ resolvedProvider: 'glm', resolvedModelId: 'z-ai/glm-5.2' });
  });

  it('the tuning gate\'s override is merged over the agent config, as executeTask merges it', async () => {
    agentModelConfig = { provider: 'glm', tier: 'large' };
    await run({ modelConfigOverride: { provider: 'qwen' } });
    expect(catalogArgs()).toMatchObject({ resolvedProvider: 'qwen', resolvedModelId: 'qwen/qwen3.8-max-0902' });
  });
});
