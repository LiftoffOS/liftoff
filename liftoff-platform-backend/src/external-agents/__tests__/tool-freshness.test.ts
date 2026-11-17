// External-agent tool freshness + credential resolution + event envelope.
//
// Three defects pinned here:
//   1. raw_mcp_tools was a discovery-time snapshot that nothing refreshed, so a
//      snapshot could list dozens of tools while the live server exposed two.
//   2. credential_secret_name held a BARE name while the tenant runtime
//      reconstructed the path against its own project. storeCredentials writes
//      to the CONTROL-PLANE project when tenants.gcp_project_id is NULL, so the
//      runtime looked in the wrong project and silently degraded to an
//      unauthenticated call.
//   3. external_agent.* events went out through the legacy raw publisher, whose
//      payload lacks the snake_case entity_type / entity_id / event_type the
//      runtime's validateEventSchema requires — so every one fails validation
//      and the runtime's cache-clearing handlers never run.

const publishOutboxEvent = jest.fn(async () => undefined);
const poolQuery = jest.fn();
const tenantScopeQuery = jest.fn();

jest.mock('../../events/publisher', () => ({
  publishEvent: (...args: unknown[]) => publishOutboxEvent(...args),
}));
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => poolQuery(...a), connect: jest.fn() },
  withTenantScope: (_t: string, fn: (c: unknown) => unknown) =>
    fn({ query: (...a: unknown[]) => tenantScopeQuery(...a) }),
  withAdminScope: (_o: unknown, fn: (c: unknown) => unknown) =>
    fn({ query: (...a: unknown[]) => poolQuery(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    createSecret = jest.fn();
    addSecretVersion = jest.fn();
    accessSecretVersion = jest.fn(async () => [{ payload: { data: Buffer.from('{}') } }]);
  },
}));

import { externalAgentService } from '../service';

type Svc = {
  resolveCredentialSecretResourceName: (t: string, s: string | null) => Promise<string | null>;
  publishEvent: (t: string, d: Record<string, unknown>) => Promise<void>;
};
const svc = externalAgentService as unknown as Svc;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GCP_PROJECT_ID;
});

describe('resolveCredentialSecretResourceName', () => {
  it('leaves an already-qualified path alone and does not hit the DB', async () => {
    const out = await svc.resolveCredentialSecretResourceName(
      't1', 'projects/example-project/secrets/external-agent-x-t1',
    );
    expect(out).toBe('projects/example-project/secrets/external-agent-x-t1');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('qualifies a legacy bare name against the TENANT project when it has one', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: 'tenant-acme-prod' }] });
    const out = await svc.resolveCredentialSecretResourceName('t1', 'external-agent-x-t1');
    expect(out).toBe('projects/tenant-acme-prod/secrets/external-agent-x-t1');
  });

  it('falls back to the CONTROL-PLANE project when the tenant has none', async () => {
    // The shared-runtime case. storeCredentials wrote here, so this is where the
    // secret actually is — the runtime could never have guessed it.
    process.env.GCP_PROJECT_ID = 'example-control-staging';
    poolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: null }] });
    const out = await svc.resolveCredentialSecretResourceName('t1', 'external-agent-x-t1');
    expect(out).toBe('projects/example-control-staging/secrets/external-agent-x-t1');
  });

  it('returns null when there is nothing stored', async () => {
    expect(await svc.resolveCredentialSecretResourceName('t1', null)).toBeNull();
  });

  it('returns the stored value unchanged when no project id can be determined', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: null }] });
    expect(await svc.resolveCredentialSecretResourceName('t1', 'bare-name')).toBe('bare-name');
  });
});

describe('getForInternalAgent — the runtime catalog payload', () => {
  // This endpoint feeds the runtime's per-run catalog build. It used to return
  // only descriptive fields, so the runtime had no endpoint or auth to reach the
  // server with: live enumeration would throw on every run and fall back to the
  // stale snapshot, leaving the phantom-tools bug in place while looking fixed.
  const ROW = {
    id: 'ext-1',
    name: 'CoinGecko',
    summary: null,
    collaboration_hints: null,
    raw_mcp_tools: JSON.stringify([{ name: 'execute' }]),
    tool_classifications: JSON.stringify({}),
    collaboration_mode: 'two_way',
    request_rules: JSON.stringify([]),
    status: 'connected',
    transport_type: 'streamable-http',
    endpoint_url: 'https://mcp.api.coingecko.com/mcp',
    auth_type: 'bearer_token',
    credential_secret_name: 'external-agent-ext-1-t1',
  };

  it('returns the connection details the runtime needs to enumerate live', async () => {
    tenantScopeQuery
      .mockResolvedValueOnce({ rows: [{ integrations: [{ id: '11111111-1111-4111-8111-111111111111' }] }] })
      .mockResolvedValueOnce({ rows: [ROW] });
    poolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: 'tenant-acme-prod' }] });

    const agents = await externalAgentService.getForInternalAgent('t1', 'ia-1');

    expect(agents).toHaveLength(1);
    expect(agents[0].endpointUrl).toBe('https://mcp.api.coingecko.com/mcp');
    expect(agents[0].authType).toBe('bearer_token');
  });

  it('qualifies the credential path here too, not only on the by-id route', async () => {
    tenantScopeQuery
      .mockResolvedValueOnce({ rows: [{ integrations: [{ id: '11111111-1111-4111-8111-111111111111' }] }] })
      .mockResolvedValueOnce({ rows: [ROW] });
    poolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: null }] });
    process.env.GCP_PROJECT_ID = 'example-control-staging';

    const agents = await externalAgentService.getForInternalAgent('t1', 'ia-1');

    expect(agents[0].credentialSecretName)
      .toBe('projects/example-control-staging/secrets/external-agent-ext-1-t1');
  });

  it('costs ONE tenant lookup regardless of how many agents come back', async () => {
    tenantScopeQuery
      .mockResolvedValueOnce({ rows: [{ integrations: [{ id: '11111111-1111-4111-8111-111111111111' }] }] })
      .mockResolvedValueOnce({ rows: [ROW, { ...ROW, id: 'ext-2' }, { ...ROW, id: 'ext-3' }] });
    poolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: 'tenant-acme-prod' }] });

    await externalAgentService.getForInternalAgent('t1', 'ia-1');

    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});

describe('external_agent.* event envelope', () => {
  it('publishes through the outbox with the envelope the runtime validates', async () => {
    await svc.publishEvent('external_agent.rediscovered', {
      externalAgentId: 'ext-1',
      tenantId: 't1',
      entityVersion: 7,
      requiresReview: true,
    });

    expect(publishOutboxEvent).toHaveBeenCalledTimes(1);
    const input = publishOutboxEvent.mock.calls[0][0] as Record<string, unknown>;
    // These four are exactly what validateEventSchema requires and what the
    // legacy `{ type, ... }` payload was missing.
    expect(input.entityType).toBe('external_agent');
    expect(input.entityId).toBe('ext-1');
    expect(input.eventType).toBe('external_agent.rediscovered');
    expect(input.tenantId).toBe('t1');
    expect(input.entityVersion).toBe(7);
    expect(input.eventVersion).toBe(1);
    expect(input.payload).toMatchObject({
      externalAgentId: 'ext-1', tenantId: 't1', requiresReview: true,
    });
  });

  it('defaults entityVersion when the caller has none (delete has no version)', async () => {
    await svc.publishEvent('external_agent.deleted', { externalAgentId: 'ext-1', tenantId: 't1' });
    const input = publishOutboxEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(input.entityVersion).toBe(1);
  });

  it('propagates a failed enqueue instead of swallowing it', async () => {
    // Only internal_agent.* swallows (EVENT_PUBLISHING_CHECKLIST). A lost
    // external_agent event means the runtime never learns about the change.
    publishOutboxEvent.mockRejectedValueOnce(new Error('outbox down'));
    await expect(
      svc.publishEvent('external_agent.updated', { externalAgentId: 'ext-1', tenantId: 't1' }),
    ).rejects.toThrow('outbox down');
  });
});
