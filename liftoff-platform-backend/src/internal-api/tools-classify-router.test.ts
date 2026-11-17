// POST /api/internal/tools/classify: the token, the bounds, the per-tool
// result, and the null-tenant attribution of the global inventory.

import express from 'express';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockClassifyTool = jest.fn();
jest.mock('../mcp/tool-classifier', () => ({
  toolClassifier: { classifyTool: (...a: unknown[]) => mockClassifyTool(...a) },
}));

import { toolsClassifyRouter } from './tools-classify-router';

const TOKEN = 'connector-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';

function buildApp() {
  const app = express();
  app.use('/api/internal/tools/classify', express.json({ limit: '4mb' }), toolsClassifyRouter);
  return app;
}

function post(app: express.Express, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/tools/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-service-auth': token } : {}) },
        body: JSON.stringify(body),
      })
        .then(async (res) => { const b = await res.json().catch(() => ({})); server.close(); resolve({ status: res.status, body: b as Record<string, unknown> }); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const TOOLS = [{ name: 'delete_record', description: 'Deletes a record' }, { name: 'get_record', description: 'Reads a record' }];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CONNECTOR_SERVICE_TOKEN = TOKEN;
  mockClassifyTool.mockImplementation(async (tool: { name: string }) =>
    tool.name === 'delete_record'
      ? { categories: ['dataChanges'], effectClass: 'destructive', by: 'jev' }
      : { categories: [], effectClass: 'read', by: 'jev' });
});

describe('POST /api/internal/tools/classify', () => {
  it('rejects a missing token and a wrong token', async () => {
    const app = buildApp();
    expect((await post(app, { tools: TOOLS, attribution: { kind: 'global_inventory' } })).status).toBe(401);
    expect((await post(app, { tools: TOOLS, attribution: { kind: 'global_inventory' } }, 'wrong')).status).toBe(401);
    expect(mockClassifyTool).not.toHaveBeenCalled();
  });

  it('accepts CONNECTOR_SERVICE_TOKEN and returns per-tool categories and effect class', async () => {
    const r = await post(buildApp(), { tools: TOOLS, attribution: { kind: 'tenant', tenantId: TENANT_ID } }, TOKEN);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ results: [
      { name: 'delete_record', categories: ['dataChanges'], effectClass: 'destructive' },
      { name: 'get_record', categories: [], effectClass: 'read' },
    ] });
    expect(mockClassifyTool).toHaveBeenCalledWith(TOOLS[0], { purpose: 'tool_classification', tenantId: TENANT_ID });
  });

  it('the global inventory classifies with no tenant (a null-tenant usage row)', async () => {
    const r = await post(buildApp(), { tools: TOOLS, attribution: { kind: 'global_inventory' } }, TOKEN);
    expect(r.status).toBe(200);
    expect(mockClassifyTool).toHaveBeenCalledWith(TOOLS[0], { purpose: 'tool_classification' });
  });

  it('rejects an oversized or malformed body', async () => {
    const app = buildApp();
    expect((await post(app, { tools: [], attribution: { kind: 'global_inventory' } }, TOKEN)).status).toBe(400);
    expect((await post(app, { tools: Array.from({ length: 501 }, (_, i) => ({ name: `t${i}`, description: '' })), attribution: { kind: 'global_inventory' } }, TOKEN)).status).toBe(400);
    expect((await post(app, { tools: [{ name: '', description: '' }], attribution: { kind: 'global_inventory' } }, TOKEN)).status).toBe(400);
    expect((await post(app, { tools: [{ name: 'x', description: 'y'.repeat(4001) }], attribution: { kind: 'global_inventory' } }, TOKEN)).status).toBe(400);
    expect((await post(app, { tools: TOOLS, attribution: { kind: 'tenant' } }, TOKEN)).status).toBe(400);
    expect((await post(app, { tools: TOOLS }, TOKEN)).status).toBe(400);
    expect(mockClassifyTool).not.toHaveBeenCalled();
  });
});
