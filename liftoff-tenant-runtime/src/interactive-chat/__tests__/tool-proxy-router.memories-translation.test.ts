// Regression: the user-facing "Learned Context" memory list came back empty
// for every agent ("No learned context yet") because the memory CRUD routes
// filtered memories.agent_id by the Platform Backend's internal_agent_id,
// while memories are keyed by the runtime agent_id. These tests assert the
// routes translate internal_agent_id → runtime agent_id before touching
// memory storage.

import express from 'express';
import request from 'supertest';

const INTERNAL_ID = 'e8af341f-4d82-43c8-ba7b-6ca64bc8d983';
const RUNTIME_ID = '630aa7f5-4b06-4f03-860b-cbf165d6cc94';
const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

const listMemories = jest.fn();
const retrieveMemories = jest.fn();
const resolveRuntimeAgentId = jest.fn();

jest.mock('../../memory/service', () => ({
  memoryService: {
    listMemories: (...args: unknown[]) => listMemories(...args),
    retrieveMemories: (...args: unknown[]) => retrieveMemories(...args),
  },
}));

jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: (...args: unknown[]) => resolveRuntimeAgentId(...args),
}));

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: jest.fn(async () => ({ rows: [] })) }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Imported after mocks are registered.
import { interactiveChatRouter } from '../tool-proxy-router';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(interactiveChatRouter);
  return app;
}

describe('tool-proxy-router memory routes — internal→runtime agent id translation', () => {
  const ORIG_TOKEN = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  beforeAll(() => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-service-token';
  });
  afterAll(() => {
    if (ORIG_TOKEN) process.env.TENANT_RUNTIME_SERVICE_TOKEN = ORIG_TOKEN;
    else delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  });
  beforeEach(() => {
    listMemories.mockReset();
    retrieveMemories.mockReset();
    resolveRuntimeAgentId.mockReset();
    resolveRuntimeAgentId.mockResolvedValue(RUNTIME_ID);
  });

  it('GET /:agentId/memories queries listMemories with the RUNTIME id, not the internal id', async () => {
    listMemories.mockResolvedValue({ memories: [], nextCursor: null, total: 0 });

    const res = await request(makeApp())
      .get(`/${INTERNAL_ID}/memories?tenantId=${TENANT_ID}&limit=100`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(200);
    expect(resolveRuntimeAgentId).toHaveBeenCalledWith(TENANT_ID, INTERNAL_ID, 'tool-proxy-router:memories-list');
    expect(listMemories).toHaveBeenCalledTimes(1);
    const [, opts] = listMemories.mock.calls[0];
    expect(opts.agentId).toBe(RUNTIME_ID);
    expect(opts.agentId).not.toBe(INTERNAL_ID);
  });

  it('GET /:agentId/memories?search=… retrieves with the RUNTIME id', async () => {
    retrieveMemories.mockResolvedValue([]);

    const res = await request(makeApp())
      .get(`/${INTERNAL_ID}/memories?tenantId=${TENANT_ID}&search=onboarding`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', TENANT_ID);

    expect(res.status).toBe(200);
    expect(resolveRuntimeAgentId).toHaveBeenCalledWith(TENANT_ID, INTERNAL_ID, 'tool-proxy-router:memories-list');
    expect(retrieveMemories).toHaveBeenCalledTimes(1);
    expect(retrieveMemories.mock.calls[0][0].agentId).toBe(RUNTIME_ID);
  });
});
