// HRBP per-tool contract tests (PR 0.2):
//
// Each tool is exercised against mocked fetch / pool to confirm:
//   - the right HTTP endpoint or SQL statement is invoked
//   - context fields (tenantId, planId, specId, runId, createdInternalAgentId)
//     are wired correctly
//   - response shape matches { ok, data }
//   - failure modes return { ok: false, data: { error } } rather than throw

import { handleTeambuilderDistill } from '../platform-agent/hrbp/tools/teambuilder-distill.js';
import { handleTeambuilderCreate } from '../platform-agent/hrbp/tools/teambuilder-create.js';
import { handleProvisioningCompensate } from '../platform-agent/hrbp/tools/provisioning-compensate.js';
import { handleProvisioningUpdateSpecStatus } from '../platform-agent/hrbp/tools/provisioning-update-spec-status.js';
import { handleProvisioningTransitionToBlocker } from '../platform-agent/hrbp/tools/provisioning-transition-to-blocker.js';
import { HrbpBlockerException } from '../platform-agent/types.js';
import type { HrbpToolContext } from '../platform-agent/hrbp/types.js';
import { resetConfigForTests } from '../infrastructure/config.js';

jest.mock('../infrastructure/database.js', () => {
  const query = jest.fn().mockResolvedValue({ rows: [{ id: 'compensation-row-1' }] });
  const connect = jest.fn();
  return {
    getPool: () => ({ query, connect }),
    __getQueryMock: () => query,
    __getConnectMock: () => connect,
  };
});

jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: jest.fn().mockResolvedValue({ Authorization: 'Bearer test', 'X-Service-Auth': 'shh' }),
}));

jest.mock('../platform-agent/audit-log-writer.js', () => ({
  writeAgentAuditLog: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const dbMock = require('../infrastructure/database.js');
const query: jest.Mock = dbMock.__getQueryMock();
const connect: jest.Mock = dbMock.__getConnectMock();

function ctx(overrides: Partial<HrbpToolContext> = {}): HrbpToolContext {
  return {
    tenantId: 'tenant-1',
    planId: 'plan-1',
    runId: 'run-1',
    specId: 'spec-1',
    approverAccountId: 'acct-1',
    spec: { specId: 'spec-1', name: 'Test', agentType: 'agent', roleSummary: 'Test' },
    ...overrides,
  };
}

const okJsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const failResponse = (status: number, body: string): Response =>
  ({
    ok: false,
    status,
    json: async () => ({ error: body }),
    text: async () => body,
  }) as unknown as Response;

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'http://pb.local';
  process.env['WORKFORCE_SERVICE_TOKEN'] = 'shh';
  process.env['GCP_PROJECT_ID'] = 'test-project';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:region:instance';
  query.mockClear();
  connect.mockReset();
  fetchSpy = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('teambuilder__distill', () => {
  it('POSTs to /api/internal-agents/_svc/distill with tenantId injected', async () => {
    fetchSpy.mockResolvedValueOnce(okJsonResponse({
      summary: 's', systemPrompt: 'sp', userInstructions: 'ui',
    }));
    const result = await handleTeambuilderDistill(
      { role: 'Sales', responsibilities: 'Sell' },
      ctx(),
    );
    expect(result).toEqual({
      ok: true,
      data: { summary: 's', systemPrompt: 'sp', userInstructions: 'ui' },
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://pb.local/api/internal-agents/_svc/distill?tenantId=tenant-1');
    expect(init.method).toBe('POST');
    // `integrations` is always present now, resolved from the spec's connectors
    // rather than taken from the model's arguments. This spec declares none, so
    // it is empty — and empty is the honest answer, not a cue for
    // platform-backend to fall back to every manifest in the workspace.
    // role and responsibilities now come from the approved spec, not from the
    // model's arguments — the model summarises, and a stored paraphrase is what
    // a later redistill would rebuild the agent from.
    expect(JSON.parse(init.body as string)).toEqual({
      role: 'Test',
      responsibilities: 'Test',
      tenantId: 'tenant-1',
      integrations: [],
    });
  });

  it('ignores an `integrations` argument the model supplies', async () => {
    fetchSpy.mockResolvedValueOnce(okJsonResponse({ summary: 's', systemPrompt: 'sp' }));

    await handleTeambuilderDistill(
      {
        role: 'Sales',
        responsibilities: 'Sell',
        // The model cannot know connection ids. What it invented here is what
        // reached distill with no usable `type`.
        integrations: [{ name: 'Google Sheets' }],
      },
      ctx(),
    );

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body as string).integrations).toEqual([]);
  });

  it('returns ok=false on non-2xx without throwing', async () => {
    fetchSpy.mockResolvedValueOnce(failResponse(503, 'upstream down'));
    const result = await handleTeambuilderDistill({ role: 'r', responsibilities: 'r' }, ctx());
    expect(result.ok).toBe(false);
    expect((result.data as { error: string }).error).toMatch(/distill failed: HTTP 503/);
  });
});

describe('teambuilder__create', () => {
  it('POSTs to /api/internal-agents/_svc with status=draft, idempotency key, and never sends modelConfig', async () => {
    fetchSpy.mockResolvedValueOnce(okJsonResponse({ agent: { id: 'agent-7' } }));
    const c = ctx();
    const result = await handleTeambuilderCreate(
      { role: 'Sales SDR', systemPrompt: 'Be nice', modelConfig: { tier: 'flagship' } },
      c,
    );
    expect(result.ok).toBe(true);
    expect(c.createdInternalAgentId).toBe('agent-7');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://pb.local/api/internal-agents/_svc?tenantId=tenant-1');
    // Keyed to the RUN. platform-backend replays the cached body for a repeated
    // key, and provisioning__compensate deletes the agent that body names, so a
    // plan-scoped key leaves a compensated spec unrebuildable.
    expect(init.headers['Idempotency-Key']).toBe('hrbp-run-1-spec-1');
    const body = JSON.parse(init.body as string);
    expect(body.status).toBe('draft');
    expect(body.tenantId).toBe('tenant-1');
    expect(body.modelConfig).toBeUndefined();
  });
});

describe('provisioning__compensate', () => {
  it('logs intent, DELETEs the agent, then marks the compensation completed', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' } as Response);
    const result = await handleProvisioningCompensate(
      { internalAgentId: 'agent-7', reason: 'rollback' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO hrbp_compensation_log/);
    expect(query.mock.calls[1][0]).toMatch(/UPDATE hrbp_compensation_log SET status='completed'/);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/internal-agents\/_svc\/agent-7\?tenantId=tenant-1/);
    expect(init.method).toBe('DELETE');
  });

  it('marks compensation failed when the DELETE returns 5xx', async () => {
    fetchSpy.mockResolvedValueOnce(failResponse(500, 'boom'));
    const result = await handleProvisioningCompensate(
      { internalAgentId: 'agent-7', reason: 'rollback' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(query.mock.calls[1][0]).toMatch(/UPDATE hrbp_compensation_log SET status='failed'/);
  });

  it('treats 404 as success — agent already deleted', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' } as Response);
    const result = await handleProvisioningCompensate(
      { internalAgentId: 'agent-7', reason: 'rollback' },
      ctx(),
    );
    expect(result.ok).toBe(true);
  });
});

describe('provisioning__update_spec_status', () => {
  it('opens a transaction under withTenantContext, reads agents JSONB, updates the matching spec, and commits', async () => {
    // withTenantContext issues BEGIN + set_config before the tool's own queries.
    const fakeClient = {
      query: jest.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // set_config('app.current_tenant_id', ...)
        .mockResolvedValueOnce({
          rows: [{ agents: [{ specId: 'spec-1', provisioningStatus: 'pending' }] }],
        }) // SELECT agents
        .mockResolvedValueOnce(undefined) // UPDATE
        .mockResolvedValueOnce(undefined), // COMMIT
      release: jest.fn(),
    };
    connect.mockResolvedValueOnce(fakeClient);
    const result = await handleProvisioningUpdateSpecStatus(
      { status: 'completed', internalAgentId: 'agent-7' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(fakeClient.query.mock.calls[0][0]).toBe('BEGIN');
    expect(fakeClient.query.mock.calls[1][0]).toMatch(/set_config\('app\.current_tenant_id'/);
    expect(fakeClient.query.mock.calls[4][0]).toBe('COMMIT');
    expect(fakeClient.release).toHaveBeenCalled();
  });
});

describe('provisioning__transition_to_blocker', () => {
  it('throws HrbpBlockerException carrying reason + detail after writing audit + spec status', async () => {
    // withTenantContext adds BEGIN + set_config before the tool's queries.
    const fakeClient = {
      query: jest.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // set_config
        .mockResolvedValueOnce({
          rows: [{ agents: [{ specId: 'spec-1', provisioningStatus: 'pending' }] }],
        }) // SELECT agents
        .mockResolvedValueOnce(undefined) // UPDATE
        .mockResolvedValueOnce(undefined), // COMMIT
      release: jest.fn(),
    };
    connect.mockResolvedValueOnce(fakeClient);
    await expect(
      handleProvisioningTransitionToBlocker(
        { reason: 'name_collision', detail: 'agent already exists' },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(HrbpBlockerException);
  });
});
