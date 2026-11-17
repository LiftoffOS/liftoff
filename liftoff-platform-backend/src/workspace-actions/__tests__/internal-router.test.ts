// The internal workspace-actions router: the CAIO's door into the shared
// registry. Service auth is required on every route; the manifest carries
// the role rule already applied; a dispatch is made as the person named by
// x-account-id with the origin header parsed onto the actor.

import request from 'supertest';
import express from 'express';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockResolveActor = jest.fn();
jest.mock('../actor', () => {
  const actual = jest.requireActual('../actor');
  return { ...actual, resolveActor: (...a: unknown[]) => mockResolveActor(...a) };
});

const mockDispatch = jest.fn();
jest.mock('../tools', () => ({
  WORKSPACE_ACTION_TOOLS: [
    { definition: { name: 'thing_read', description: 'read', input_schema: { type: 'object', properties: {} } }, permission: null },
    { definition: { name: 'thing_change', description: 'change', input_schema: { type: 'object', properties: {} } }, permission: 'teams:update', mutating: true },
  ],
  isWorkspaceActionTool: (name: string) => name === 'thing_read' || name === 'thing_change',
  workspaceActionPermits: (name: string, role: string) => name === 'thing_read' || role !== 'viewer',
  dispatchWorkspaceAction: (...a: unknown[]) => mockDispatch(...a),
}));

const mockListAiWorkforce = jest.fn();
jest.mock('../teams', () => ({ listAiWorkforce: (...a: unknown[]) => mockListAiWorkforce(...a) }));

import { workspaceActionsInternalRouter } from '../internal-router';

const TOKEN = 'wf-service-token';
const TENANT = '22222222-2222-2222-2222-222222222222';

function app() {
  const a = express();
  a.use('/api/internal/workspace-actions', express.json(), workspaceActionsInternalRouter);
  return a;
}

beforeAll(() => { process.env.WORKFORCE_SERVICE_TOKEN = TOKEN; });

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveActor.mockResolvedValue({ tenantId: TENANT, accountId: 'acct-1', role: 'member', displayName: 'Ada', surface: 'caio' });
  mockDispatch.mockResolvedValue('{"ok":true}');
  mockListAiWorkforce.mockResolvedValue({
    teams: [{
      id: 'a1', role: 'Marketing', messagingNickname: 'Marketing Team', agentType: 'automated', status: 'active', summary: 's',
      responsibilities: 'r', integrations: [{ id: 'gm-1', type: 'google_mail' }], pendingIntegrations: [], workforcePlanId: null,
      systemPrompt: 'NEVER ON THE WIRE', userInstructions: 'NEVER ON THE WIRE',
    }],
    collaborators: [{ id: 'c1', name: 'Partner', description: null, status: 'active', collaborationMode: 'request_help', allowedInternalAgentIds: ['a1'], endpointUrl: 'https://x' }],
  });
});

describe('service auth', () => {
  it('refuses every route without the service token', async () => {
    expect((await request(app()).get('/api/internal/workspace-actions/tools')).status).toBe(401);
    expect((await request(app()).get(`/api/internal/workspace-actions/teams?tenantId=${TENANT}`)).status).toBe(401);
    expect((await request(app()).post('/api/internal/workspace-actions').send({ tenantId: TENANT, tool: 'thing_read' })).status).toBe(401);
    expect((await request(app()).get('/api/internal/workspace-actions/tools').set('X-Service-Auth', 'wrong')).status).toBe(401);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('GET /tools', () => {
  it('serves the manifest with the role rule applied', async () => {
    const res = await request(app()).get('/api/internal/workspace-actions/tools').set('X-Service-Auth', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual([
      { definition: expect.objectContaining({ name: 'thing_read' }), permission: null, mutating: false, roles: ['owner', 'admin', 'member', 'viewer'] },
      { definition: expect.objectContaining({ name: 'thing_change' }), permission: 'teams:update', mutating: true, roles: ['owner', 'admin', 'member'] },
    ]);
  });
});

describe('POST /', () => {
  it('dispatches as the person named by x-account-id, with the origin parsed', async () => {
    const res = await request(app())
      .post('/api/internal/workspace-actions')
      .set('X-Service-Auth', TOKEN)
      .set('x-account-id', 'acct-1')
      .set('x-tenant-role', 'member')
      .set('x-origin', JSON.stringify({ via: 'mcp', client: 'Claude Code', credentialId: 'anchor-1' }))
      .send({ tenantId: TENANT, tool: 'thing_change', input: { id: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: '{"ok":true}' });
    expect(mockResolveActor).toHaveBeenCalledWith({
      tenantId: TENANT, accountId: 'acct-1', surface: 'caio',
      via: 'mcp', client: 'Claude Code', credentialId: 'anchor-1',
    });
    expect(mockDispatch).toHaveBeenCalledWith('thing_change', { id: 'x' }, expect.objectContaining({ accountId: 'acct-1', surface: 'caio' }));
  });

  it('a malformed origin header reads as no origin', async () => {
    const res = await request(app())
      .post('/api/internal/workspace-actions')
      .set('X-Service-Auth', TOKEN)
      .set('x-account-id', 'acct-1')
      .set('x-origin', 'not json')
      .send({ tenantId: TENANT, tool: 'thing_read' });
    expect(res.status).toBe(200);
    expect(mockResolveActor).toHaveBeenCalledWith({ tenantId: TENANT, accountId: 'acct-1', surface: 'caio' });
  });

  it('refuses without x-account-id, an unknown tool, a bad body, and a non-member', async () => {
    const base = () => request(app()).post('/api/internal/workspace-actions').set('X-Service-Auth', TOKEN);
    expect((await base().send({ tenantId: TENANT, tool: 'thing_read' })).status).toBe(401);
    expect((await base().set('x-account-id', 'acct-1').send({ tenantId: TENANT, tool: 'nope' })).status).toBe(404);
    expect((await base().set('x-account-id', 'acct-1').send({ tenantId: 'not-a-uuid', tool: 'thing_read' })).status).toBe(400);
    mockResolveActor.mockResolvedValueOnce(null);
    expect((await base().set('x-account-id', 'acct-1').send({ tenantId: TENANT, tool: 'thing_read' })).status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('GET /teams', () => {
  it('reads the AI workforce for the CAIO, projected: names, status, text and bindings travel, prompts do not', async () => {
    const res = await request(app()).get(`/api/internal/workspace-actions/teams?tenantId=${TENANT}`).set('X-Service-Auth', TOKEN).set('x-account-id', 'acct-1');
    expect(res.status).toBe(200);
    expect(mockListAiWorkforce).toHaveBeenCalledWith(TENANT);
    expect(res.body).toEqual({
      aiWorkforce: {
        teams: [{
          id: 'a1', role: 'Marketing', messagingNickname: 'Marketing Team', agentType: 'automated', status: 'active', summary: 's',
          responsibilities: 'r', integrations: [{ id: 'gm-1', type: 'google_mail' }], pendingIntegrations: [], workforcePlanId: null,
        }],
        collaborators: [{ id: 'c1', name: 'Partner', description: null, status: 'active', collaborationMode: 'request_help', allowedInternalAgentIds: ['a1'] }],
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('NEVER ON THE WIRE');
    expect((await request(app()).get('/api/internal/workspace-actions/teams').set('X-Service-Auth', TOKEN)).status).toBe(400);
  });
});
