// The CAIO's two _svc endpoints: read the config, update the team.
//
// The write goes through the same function the dashboard's Save calls, with
// the distil run server-side over the merged inputs BEFORE anything is
// written: a successful update lands as one 'distill' version, a failed
// distil writes nothing (502). The distillation-output fields are still
// rejected BY NAME (a caller that thinks it can hand-author config must hear
// no, not have the field silently dropped); the rest of the assistant patch
// shape — bindings, skill verbs, attachments — is accepted.

import express from 'express';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockGetById = jest.fn();
const mockUpdate = jest.fn();
jest.mock('../service', () => ({
  internalAgentService: {
    getById: (...a: unknown[]) => mockGetById(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
  InternalAgentService: class {},
}));

// The workspace action behind the write, mocked at its seam: the route's job
// is to build the actor from the caller headers, gate the body, and map the
// result. applyTeamUpdate's own behaviour is covered in workspace-actions.
const mockApplyTeamUpdate = jest.fn();
jest.mock('../../workspace-actions/team-update', () => ({
  applyTeamUpdate: (...a: unknown[]) => mockApplyTeamUpdate(...a),
  isTeamUpdateRefusal: (r: { refused?: string }) => 'refused' in r,
}));
const mockResolveActor = jest.fn();
jest.mock('../../workspace-actions/actor', () => ({
  resolveActor: (...a: unknown[]) => mockResolveActor(...a),
  PermissionDenied: class PermissionDenied extends Error { status = 403; },
}));
jest.mock('../row-mapper', () => ({
  mapInternalAgentRow: (r: unknown) => r,
  toClientAgent: (a: unknown) => a,
  toClientAgents: (a: unknown) => a,
  toClientVersion: (v: unknown) => v,
}));

import { internalAgentsServiceRouter } from '../router';

const TOKEN = 'workforce-token-under-test';
const TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = '55555555-5555-5555-5555-555555555555';
const ACCOUNT = '77777777-7777-7777-7777-777777777777';
const COLLABORATOR = '88888888-8888-8888-8888-888888888888';
const ACTOR = { tenantId: TENANT, accountId: ACCOUNT, role: 'admin', displayName: 'Alice', surface: 'caio' };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal-agents', internalAgentsServiceRouter);
  return app;
}

function call(
  app: express.Express,
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
  headers: Record<string, string> = { 'x-account-id': ACCOUNT, 'x-tenant-role': 'admin' },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-service-auth': TOKEN,
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WORKFORCE_SERVICE_TOKEN = TOKEN;
  mockGetById.mockResolvedValue({
    id: AGENT,
    role: 'Weekly Vendor Chase',
    status: 'draft',
    responsibilities: 'Chase overdue invoices every Monday at 9am.',
    additionalContext: 'Never send the chase emails.',
    triggerConfig: {
      type: 'cron',
      cronExpr: '0 9 * * 1',
      companionCrons: [{ label: 'friday-check', cronExpr: '0 16 * * 5' }],
    },
  });
  mockUpdate.mockResolvedValue({});
  mockResolveActor.mockResolvedValue(ACTOR);
  mockApplyTeamUpdate.mockResolvedValue({ agent: { id: AGENT, role: 'Weekly Vendor Chase' } });
});

afterAll(() => {
  delete process.env.WORKFORCE_SERVICE_TOKEN;
});

describe('GET /_svc/:id/config', () => {
  it('returns the prose and a trigger summary', async () => {
    const res = await call(buildApp(), 'GET', `/api/internal-agents/_svc/${AGENT}/config?tenantId=${TENANT}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      role: 'Weekly Vendor Chase',
      responsibilities: 'Chase overdue invoices every Monday at 9am.',
      additionalContext: 'Never send the chase emails.',
      trigger: {
        type: 'cron',
        cronExpr: '0 9 * * 1',
        companions: [{ label: 'friday-check', cronExpr: '0 16 * * 5' }],
      },
    });
  });

  it('404s an unknown id', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await call(buildApp(), 'GET', `/api/internal-agents/_svc/${AGENT}/config?tenantId=${TENANT}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /_svc/:id', () => {
  it('distils then writes with source distill, as the person the CAIO speaks for', async () => {
    const res = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { additionalContext: 'Never send the chase emails. Run on Tuesdays at 9am instead of Mondays.' },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ distilled: true, agent: { id: AGENT } });

    // The actor is resolved from the caller header (membership re-read), on
    // the CAIO surface.
    expect(mockResolveActor).toHaveBeenCalledWith({ tenantId: TENANT, accountId: ACCOUNT, surface: 'caio' });
    // The write is the shared function, in server-distil mode: distil first,
    // over the merged inputs, then one version with source 'distill'.
    expect(mockApplyTeamUpdate).toHaveBeenCalledWith(
      ACTOR,
      AGENT,
      expect.objectContaining({ additionalContext: 'Never send the chase emails. Run on Tuesdays at 9am instead of Mondays.' }),
      { distill: 'server' },
    );
    // Nothing writes around the shared function.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('carries the coding-tool origin through to the actor', async () => {
    await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { additionalContext: 'x' },
      {
        'x-account-id': ACCOUNT,
        'x-tenant-role': 'admin',
        'x-origin': JSON.stringify({ via: 'mcp', client: 'Claude Code', credentialId: '33333333-3333-3333-3333-333333333333' }),
      },
    );
    expect(mockResolveActor).toHaveBeenCalledWith({
      tenantId: TENANT, accountId: ACCOUNT, surface: 'caio',
      via: 'mcp', client: 'Claude Code', credentialId: '33333333-3333-3333-3333-333333333333',
    });
  });

  it('rejects non-prose keys by name', async () => {
    const res = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { systemPrompt: 'You are...', additionalContext: 'x' },
    );
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('systemPrompt');
    expect(mockApplyTeamUpdate).not.toHaveBeenCalled();
  });

  it('bindings accepted, trigger rejected by name', async () => {
    const accepted = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { bindings: [{ kind: 'connector', type: 'google_mail' }, { kind: 'collaborator', id: COLLABORATOR }] },
    );
    expect(accepted.status).toBe(200);
    expect(mockApplyTeamUpdate).toHaveBeenCalledWith(
      ACTOR,
      AGENT,
      expect.objectContaining({ bindings: [{ kind: 'connector', type: 'google_mail' }, { kind: 'collaborator', id: COLLABORATOR }] }),
      { distill: 'server' },
    );

    mockApplyTeamUpdate.mockClear();
    const rejected = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { triggerConfig: { type: 'cron', cronExpr: '0 9 * * 1' }, additionalContext: 'x' },
    );
    expect(rejected.status).toBe(400);
    expect(String(rejected.body.error)).toContain('triggerConfig');
    expect(mockApplyTeamUpdate).not.toHaveBeenCalled();
  });

  it('distill failure → nothing written, 502', async () => {
    mockApplyTeamUpdate.mockResolvedValue({ refused: 'distill_failed', message: 'graph did not converge' });
    const res = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { additionalContext: 'x' },
    );
    expect(res.status).toBe(502);
    expect(res.body.distilled).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('404s an unknown team', async () => {
    mockApplyTeamUpdate.mockResolvedValue({ refused: 'not_found', message: 'agent not found' });
    const res = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { additionalContext: 'x' },
    );
    expect(res.status).toBe(404);
  });

  it('refuses without a person to act as (no x-account-id) and for a non-member', async () => {
    const noPerson = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { additionalContext: 'x' },
      {},
    );
    expect(noPerson.status).toBe(401);
    expect(mockApplyTeamUpdate).not.toHaveBeenCalled();

    mockResolveActor.mockResolvedValue(null);
    const nonMember = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      { additionalContext: 'x' },
    );
    expect(nonMember.status).toBe(403);
    expect(mockApplyTeamUpdate).not.toHaveBeenCalled();
  });

  it('requires something to change', async () => {
    const res = await call(
      buildApp(),
      'PATCH',
      `/api/internal-agents/_svc/${AGENT}?tenantId=${TENANT}`,
      {},
    );
    expect(res.status).toBe(400);
    expect(mockApplyTeamUpdate).not.toHaveBeenCalled();
  });
});
