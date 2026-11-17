// Regression: the three POST routes must accept the calls platform-backend makes.
//
// PB's `retrieveAgentMemories` posts `{query, topK}` and `saveAgentMemory`
// posts `{layer, content, tags}`. Neither sends `tenantId` in the body — the
// tenant rides on the `x-tenant-id` header that `buildRuntimeHeaders` sets on
// every runtime call. Routes that read the body alone answer
// `400 Missing tenantId or query` on every such call. The client's circuit
// breaker falls back to `[]`, so chat and distillation simply run with no
// memory context and log a WARN.
//
// These tests drive the routes exactly the way PB does: header only, no
// `tenantId` in the body.

import express from 'express';
import request from 'supertest';

const INTERNAL_ID = 'e8af341f-4d82-43c8-ba7b-6ca64bc8d983';
const RUNTIME_ID = '630aa7f5-4b06-4f03-860b-cbf165d6cc94';
const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

const retrieveMemories = jest.fn();
const saveMemory = jest.fn();
const resolveRuntimeAgentId = jest.fn();
// The feedback route uses the STRICT resolver (INV-TR-010) rather than the
// falling-back one, so the mock has to provide both or the handler 500s.
const resolveRuntimeAgentIdStrict = jest.fn();

jest.mock('../../memory/service', () => ({
  memoryService: {
    retrieveMemories: (...args: unknown[]) => retrieveMemories(...args),
    saveMemory: (...args: unknown[]) => saveMemory(...args),
  },
}));

jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: (...args: unknown[]) => resolveRuntimeAgentId(...args),
  resolveRuntimeAgentIdStrict: (...args: unknown[]) => resolveRuntimeAgentIdStrict(...args),
}));

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: jest.fn(async () => ({ rows: [] })) }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Imported after mocks are registered.
import { interactiveChatRouter } from '../tool-proxy-router';

/**
 * Mirrors the `req.ctx` middleware in src/index.ts, which is where the
 * `x-tenant-id` header becomes `req.ctx.tenantId`. The router is mounted
 * behind it in production, so a test that omits it would not be testing the
 * composition that actually runs.
 */
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const tenantId = req.headers['x-tenant-id'] as string | undefined;
    if (tenantId && tenantId !== 'unknown') {
      (req as express.Request).ctx = { ...(req as express.Request).ctx, tenantId };
    }
    next();
  });
  app.use(interactiveChatRouter);
  return app;
}

describe('tool-proxy-router POST routes — tenant arrives on the header, not the body', () => {
  const ORIG_TOKEN = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  beforeAll(() => { process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-service-token'; });
  afterAll(() => {
    if (ORIG_TOKEN) process.env.TENANT_RUNTIME_SERVICE_TOKEN = ORIG_TOKEN;
    else delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  });
  beforeEach(() => {
    retrieveMemories.mockReset();
    saveMemory.mockReset();
    resolveRuntimeAgentId.mockReset();
    resolveRuntimeAgentId.mockResolvedValue(RUNTIME_ID);
    resolveRuntimeAgentIdStrict.mockReset();
    resolveRuntimeAgentIdStrict.mockResolvedValue(RUNTIME_ID);
  });

  it('memory-retrieve succeeds with the exact body PB sends', async () => {
    retrieveMemories.mockResolvedValue([]);

    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/memory-retrieve`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', TENANT_ID)
      .send({ query: 'what did we decide about billing', topK: 10 });

    expect(res.status).toBe(200);
    expect(retrieveMemories).toHaveBeenCalledTimes(1);
    expect(retrieveMemories.mock.calls[0][0].tenantId).toBe(TENANT_ID);
    expect(retrieveMemories.mock.calls[0][0].agentId).toBe(RUNTIME_ID);
  });

  it('memory-save succeeds with the exact body PB sends', async () => {
    saveMemory.mockResolvedValue({ memoryId: 'm1', deduplicated: false });

    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/memory-save`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', TENANT_ID)
      .send({ layer: 'individual', content: 'prefers concise summaries', tags: ['pref'] });

    expect(res.status).toBe(200);
    expect(saveMemory).toHaveBeenCalledTimes(1);
    expect(saveMemory.mock.calls[0][0].tenantId).toBe(TENANT_ID);
  });

  it('feedback succeeds with the exact body PB sends', async () => {
    // The handler looks for a contradicting memory before saving, so this has
    // to resolve to a list even when there is nothing to supersede.
    retrieveMemories.mockResolvedValue([]);
    saveMemory.mockResolvedValue({ memoryId: 'm2', deduplicated: false });

    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/feedback`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', TENANT_ID)
      .send({
        threadId: 't1',
        messageId: 'msg1',
        feedbackType: 'correction',
        content: 'that repo name was wrong',
        userId: 'u1',
      });

    expect(res.status).toBeLessThan(400);
  });

  it('an explicit body tenantId still wins, so existing callers are unaffected', async () => {
    retrieveMemories.mockResolvedValue([]);

    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/memory-retrieve`)
      .set('x-service-auth', 'test-service-token')
      .set('x-tenant-id', 'header-tenant-should-lose')
      .send({ tenantId: TENANT_ID, query: 'q' });

    expect(res.status).toBe(200);
    expect(retrieveMemories.mock.calls[0][0].tenantId).toBe(TENANT_ID);
  });

  it('still rejects when the tenant is genuinely absent everywhere', async () => {
    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/memory-retrieve`)
      .set('x-service-auth', 'test-service-token')
      .send({ query: 'q' });

    expect(res.status).toBe(400);
    expect(retrieveMemories).not.toHaveBeenCalled();
  });
});
