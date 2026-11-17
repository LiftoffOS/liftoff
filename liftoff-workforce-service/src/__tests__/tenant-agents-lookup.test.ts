// "No agents exist" and "I could not read the roster" must never be the same
// answer.
//
// Collapsing both into an empty array lets a failed lookup reach the user as a
// confident statement that their workspace is empty. Two things have to hold:
// the call must reach a route a service token can actually use, and a response
// that is not shaped as expected must be treated as a broken contract rather
// than as a tenant with no agents.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: jest.fn().mockResolvedValue({
    Authorization: 'Bearer oidc-token',
    'X-Service-Auth': 'workforce-token',
  }),
}));

import { resetConfigForTests } from '../infrastructure/config.js';
import { listTenantAgents } from '../workforce-plans/tenant-agents.js';
import { orgGetExistingStructureTool } from '../workforce-plans/tools/org-get-existing.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

const CTX: WorkforcePlanToolContext = {
  tenantId: TENANT,
  accountId: 'acct-1',
  role: 'owner',
};

interface OrgResult {
  lookupSucceeded: boolean;
  totalAgents: number;
  activeCount: number;
  pausedCount: number;
  agents: Array<{ name: string; status: string }>;
  collaborators: Array<Record<string, unknown>>;
  message: string;
}

const runTool = (input: Record<string, unknown> = {}) =>
  orgGetExistingStructureTool.execute(input, CTX) as Promise<OrgResult>;

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'https://pb.example.com';
  process.env['GCP_PROJECT_ID'] = 'test';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:test-db';
  process.env['WORKFORCE_SERVICE_TOKEN'] = 'workforce-token';
  fetchSpy = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  resetConfigForTests();
});

describe('listTenantAgents', () => {
  it('calls the service-auth route, not one behind authMiddleware', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ aiWorkforce: { teams: [], collaborators: [], connections: [] }, humanWorkforce: [] }),
    } as unknown as Response);

    await listTenantAgents(TENANT);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/internal/workspace-actions/teams');
    // The route that never existed. A bearer token against it can only 401.
    expect(String(url)).not.toContain('/api/agents');
    expect((init as RequestInit).headers).toMatchObject({
      'X-Service-Auth': 'workforce-token',
    });
  });

  it('reports a failed lookup as a failure, not as an empty workforce', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 } as unknown as Response);

    const result = await listTenantAgents(TENANT);

    expect(result.ok).toBe(false);
    // `agents` must not be readable as an empty list on the failure branch.
    expect((result as { agents?: unknown }).agents).toBeUndefined();
    if (!result.ok) expect(result.reason).toContain('401');
  });

  it('treats a body with the wrong list key as a failure, not as an empty org', async () => {
    // A body shaped like a different endpoint's response. Reading
    // `.agents ?? []` off it yields [] and reads as an empty tenant.
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ internalAgents: [{ id: 'a1', role: 'Claude Coder' }], total: 1 }),
    } as unknown as Response);

    const result = await listTenantAgents(TENANT);

    expect(result.ok).toBe(false);
  });

  it('reports a network failure the same way', async () => {
    fetchSpy.mockRejectedValue(new Error('socket hang up'));
    expect((await listTenantAgents(TENANT)).ok).toBe(false);
  });

  it('distinguishes a genuinely empty workforce from a failure', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ aiWorkforce: { teams: [], collaborators: [], connections: [] }, humanWorkforce: [] }),
    } as unknown as Response);

    const result = await listTenantAgents(TENANT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.agents).toEqual([]);
  });
});

describe('org__get_existing_structure', () => {
  it('never calls a failed lookup a blank slate', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 } as unknown as Response);

    const result = await runTool();

    expect(result.lookupSucceeded).toBe(false);
    // The copy names "blank-slate" and "starting from scratch" on purpose, to
    // forbid them — so assert on the affirmative claim, not the substring.
    expect(result.message).not.toMatch(/This is a blank-slate tenant/i);
    expect(result.message).not.toMatch(/the user is starting from scratch/i);
    // The model reads this string as fact, so it has to say the opposite
    // explicitly rather than merely omitting the claim.
    expect(result.message).toMatch(/NOT a statement/);
    expect(result.message).toMatch(/could not be read/i);
  });

  it('says blank slate only when the roster really is empty', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ aiWorkforce: { teams: [], collaborators: [], connections: [] }, humanWorkforce: [] }),
    } as unknown as Response);

    const result = await runTool();

    expect(result.lookupSucceeded).toBe(true);
    expect(result.message).toMatch(/blank-slate/i);
  });

  it('summarises a live workforce', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        aiWorkforce: {
          teams: [
            { id: 'a1', role: 'Claude Coder', status: 'active', responsibilities: 'writes code' },
            { id: 'a2', role: 'Release Coordinator', status: 'active' },
            { id: 'a3', role: 'Draft Rep', status: 'draft' },
          ],
          collaborators: [
            { id: 'c1', name: 'Partner Bot', status: 'connected', collaborationMode: 'request_help', allowedInternalAgentIds: ['a1'] },
          ],
          connections: [],
        },
        humanWorkforce: [],
      }),
    } as unknown as Response);

    const result = await runTool();

    expect(result.lookupSucceeded).toBe(true);
    expect(result.totalAgents).toBe(3);
    expect(result.activeCount).toBe(2);
    expect(result.agents.map(a => a.name)).toContain('Claude Coder');
    expect(result.message).not.toMatch(/blank-slate/i);
    // The collaborators ride the same read, with what a plan needs to bind
    // a team to one.
    expect(result.collaborators).toEqual([
      { id: 'c1', name: 'Partner Bot', status: 'connected', collaborationMode: 'request_help', allowedInternalAgentIds: ['a1'] },
    ]);
  });

  it('reports paused agents even when it does not list them', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        aiWorkforce: { teams: [{ id: 'a1', role: 'Daily Metrics Reporter', status: 'paused' }], collaborators: [], connections: [] },
        humanWorkforce: [],
      }),
    } as unknown as Response);

    const result = await runTool();

    // A paused agent is still provisioned. Hiding it entirely is how the model
    // ends up proposing a duplicate of something that already exists.
    expect(result.agents).toHaveLength(0);
    expect(result.pausedCount).toBe(1);
    expect(result.message).toMatch(/paused/i);
    expect(result.message).not.toMatch(/blank-slate/i);
  });
});
