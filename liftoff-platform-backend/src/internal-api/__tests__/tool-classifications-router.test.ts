/**
 * Tool-classifications internal router — the seed lookup tenant-runtime makes
 * before its name heuristics when it enumerates a vendor-hosted MCP.
 *
 * Three properties: only GLOBAL rows leave (the query pins tenant_id IS NULL and
 * the connector type); an unknown type is an empty list, never a 404 (a seed
 * lookup must not stop enumeration); and the meta-tool operation key rides
 * with the rows for the one server that needs it.
 */

const queryMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { toolClassificationsRouter } from '../tool-classifications-router';

const RUNTIME_TOKEN = 'tenant-runtime-service-secret';

let app: express.Express;
beforeAll(() => {
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = RUNTIME_TOKEN;
  app = express();
  app.use(express.json());
  app.use('/api/internal/tool-classifications', toolClassificationsRouter);
});

beforeEach(() => {
  queryMock.mockReset();
});

describe('GET /:integrationType', () => {
  it('401s without the service token', async () => {
    const res = await request(app).get('/api/internal/tool-classifications/typefully');
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns the global rows for the type, pinned to tenant_id IS NULL', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { tool_name: 'list_drafts', categories: [], is_manual_override: false, reviewed_by: 'vendor-mcp-seed' },
        { tool_name: 'delete_draft', categories: ['write', 'destructive'], is_manual_override: null, reviewed_by: 'vendor-mcp-seed' },
      ],
    });
    const res = await request(app)
      .get('/api/internal/tool-classifications/typefully')
      .set('x-service-auth', RUNTIME_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      integrationType: 'typefully',
      operationKey: null,
      tools: [
        { name: 'list_drafts', categories: [], manual: false, reviewedBy: 'vendor-mcp-seed' },
        { name: 'delete_draft', categories: ['write', 'destructive'], manual: false, reviewedBy: 'vendor-mcp-seed' },
      ],
    });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/tenant_id IS NULL/);
    expect(sql).toMatch(/integration_type = \$1/);
    expect(params).toEqual(['typefully']);
  });

  it('answers an unknown type with an empty list, not a 404', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/api/internal/tool-classifications/nobody')
      .set('x-service-auth', RUNTIME_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ integrationType: 'nobody', operationKey: null, tools: [] });
  });

  it('carries the operation key for a meta-tool server', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { tool_name: 'execute:delete_campaigns_id', categories: ['write', 'destructive'], is_manual_override: false, reviewed_by: 'vendor-mcp-seed' },
      ],
    });
    const res = await request(app)
      .get('/api/internal/tool-classifications/omnisend')
      .set('x-service-auth', RUNTIME_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.operationKey).toEqual({ tool: 'execute', arg: 'tool_name' });
    expect(res.body.tools[0].name).toBe('execute:delete_campaigns_id');
  });

  it('500s with a stable error when the lookup fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .get('/api/internal/tool-classifications/typefully')
      .set('x-service-auth', RUNTIME_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'tool_classifications_lookup_failed' });
  });
});
