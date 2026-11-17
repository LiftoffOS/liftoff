// Team-provisioning service — run/role state machine + idempotency + compensation.

const mockRepo = {
  findRun: jest.fn(),
  createRun: jest.fn(),
  reclaimStaleLease: jest.fn(),
  reclaimForRetry: jest.fn(),
  setRunStatus: jest.fn(),
  listRunRoles: jest.fn(),
  upsertRunRole: jest.fn(),
  findProvenanceInTx: jest.fn(),
  listProvenanceAgents: jest.fn(),
  findStrandedRuns: jest.fn(),
};
jest.mock('../repository', () => ({ teamProvisioningRepository: mockRepo }));

const mockValidate = jest.fn();
jest.mock('../validation', () => ({ validateProvisionRequest: (...a: unknown[]) => mockValidate(...a) }));

const mockCreate = jest.fn();
const mockDelete = jest.fn();
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: { create: (...a: unknown[]) => mockCreate(...a), delete: (...a: unknown[]) => mockDelete(...a) },
}));
jest.mock('../../internal-agents/distill-service', () => ({
  distillInternalAgent: jest.fn().mockResolvedValue({
    summary: 's', systemPrompt: 'sp', userInstructions: 'ui', instructionsMd: null,
    // The distilled triggerConfig carries reactiveSubscriptions at runtime (a
    // connector_event on github with an existing filter + a system_event that must NOT
    // get the self-event exclusion).
    triggerConfig: {
      type: 'event', eventTopic: 'pr.opened', reasoning: 'r',
      reactiveSubscriptions: [
        { label: 'pr', source: { kind: 'connector_event', connectorRef: 'github' }, filter: { op: 'eq', path: 'action', value: 'opened' }, objective: 'review' },
        { label: 'sys', source: { kind: 'system_event', topic: 'x' }, objective: 'y' },
      ],
    },
    skills: [],
  }),
}));
jest.mock('../../agent-templates/loader', () => ({
  getTemplate: () => ({ role: 'R', additionalContext: '', defaultMemoryScope: { readableLayers: ['individual'], writableLayers: ['individual'] } }),
}));
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: unknown) => unknown) => fn({ query: jest.fn() }),
}));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { teamProvisioningService } from '../service';

const req = {
  idempotencyKey: 'idem-1',
  bindings: [{ roleKey: 'engineer', connectorId: '11111111-1111-1111-1111-111111111111' }],
};
const validated = {
  ok: true,
  plan: { preset: {}, roles: [{ roleKey: 'engineer', templateId: 'software-engineer', roleProse: 'p', connectorId: 'c', connectorType: 'github', repoScope: null, botLogin: 'bot', escalationRecipient: null }] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockValidate.mockResolvedValue(validated);
  mockRepo.listRunRoles.mockResolvedValue([]);
  mockRepo.findProvenanceInTx.mockResolvedValue(null);
  mockRepo.listProvenanceAgents.mockResolvedValue([]);
  mockRepo.upsertRunRole.mockResolvedValue(undefined);
  mockRepo.setRunStatus.mockResolvedValue(undefined);
  mockCreate.mockResolvedValue({ id: 'agent-eng' });
});

describe('provision — happy path', () => {
  it('a fresh run creates one agent per role and completes', async () => {
    mockRepo.findRun.mockResolvedValue(null);
    mockRepo.createRun.mockResolvedValue({ run: { id: 'run-1', createdAgentIds: [], status: 'pending', lockedAt: new Date() }, created: true });
    const { result, conflict } = await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    expect(conflict).toBeUndefined();
    expect(result!.status).toBe('completed');
    expect(result!.createdAgentIds).toEqual(['agent-eng']);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRepo.setRunStatus).toHaveBeenCalledWith('t1', 'run-1', 'completed', expect.anything());

    // The created agent carries the distilled reactiveSubscriptions (not a reconstructed
    // subset), with the sender.login != bot_login self-event exclusion AND-combined into
    // the connector_event subscription — and NOT into the system_event one.
    const createInput = mockCreate.mock.calls[0][1] as { triggerConfig: { reactiveSubscriptions: Array<{ filter?: unknown; source: { kind: string } }> } };
    const subs = createInput.triggerConfig.reactiveSubscriptions;
    expect(subs).toHaveLength(2);
    const connectorSub = subs.find((s) => s.source.kind === 'connector_event')!;
    expect(connectorSub.filter).toEqual({
      op: 'and',
      operands: [
        { op: 'eq', path: 'action', value: 'opened' },
        { op: 'ne', path: 'sender.login', value: 'bot' },
      ],
    });
    const systemSub = subs.find((s) => s.source.kind === 'system_event')!;
    expect(systemSub.filter).toBeUndefined(); // exclusion only for connector events

    // The bound connector is persisted as an integration so the role has github tools at
    // runtime (TR resolves tools from integrations[]; [] → no tools). repoScope is null
    // here → no repo filter config.
    const bind = mockCreate.mock.calls[0][1] as { integrations: unknown };
    expect(bind.integrations).toEqual([{ id: 'c', type: 'github', selectedObjects: [] }]);
  });
});

describe('provision — connector binding + repoScope', () => {
  it('persists the bound connector with repoScope as githubFilter.repos (github)', async () => {
    mockValidate.mockResolvedValue({
      ok: true,
      plan: { preset: {}, roles: [{ roleKey: 'engineer', templateId: 'software-engineer', roleProse: 'p', connectorId: 'gh-c', connectorType: 'github', repoScope: ['acme/api', 'acme/web'], botLogin: 'bot', escalationRecipient: null }] },
    });
    mockRepo.findRun.mockResolvedValue(null);
    mockRepo.createRun.mockResolvedValue({ run: { id: 'run-1', createdAgentIds: [], status: 'pending', lockedAt: new Date() }, created: true });
    await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    const input = mockCreate.mock.calls[0][1] as { integrations: unknown };
    expect(input.integrations).toEqual([
      { id: 'gh-c', type: 'github', selectedObjects: [], config: { githubFilter: { repos: ['acme/api', 'acme/web'] } } },
    ]);
  });

  it('maps repoScope to gitlabFilter.projects for gitlab', async () => {
    mockValidate.mockResolvedValue({
      ok: true,
      plan: { preset: {}, roles: [{ roleKey: 'engineer', templateId: 'software-engineer', roleProse: 'p', connectorId: 'gl-c', connectorType: 'gitlab', repoScope: ['grp/proj'], botLogin: 'bot', escalationRecipient: null }] },
    });
    mockRepo.findRun.mockResolvedValue(null);
    mockRepo.createRun.mockResolvedValue({ run: { id: 'run-1', createdAgentIds: [], status: 'pending', lockedAt: new Date() }, created: true });
    await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    const input = mockCreate.mock.calls[0][1] as { integrations: unknown };
    expect(input.integrations).toEqual([
      { id: 'gl-c', type: 'gitlab', selectedObjects: [], config: { gitlabFilter: { projects: ['grp/proj'] } } },
    ]);
  });
});

describe('provision — idempotency', () => {
  it('a retry with a TERMINAL run returns the recorded run without re-creating', async () => {
    mockRepo.findRun.mockResolvedValue({ id: 'run-1', status: 'completed', createdAgentIds: ['agent-eng'], requestHash: HASH(), lockedAt: null, error: null });
    const { result } = await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    expect(result!.status).toBe('completed');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRepo.createRun).not.toHaveBeenCalled();
  });

  it('a retry of a FAILED run (same request) re-validates + provisions instead of replaying the error', async () => {
    // The first attempt failed (e.g. a connector scope not yet recorded). A later pass must
    // NOT replay that stale error — it must reset the run and re-validate against live data.
    mockRepo.findRun.mockResolvedValue({ id: 'run-1', status: 'failed', createdAgentIds: [], requestHash: HASH(), lockedAt: null, error: 'missing required scope "repo"' });
    mockRepo.reclaimForRetry.mockResolvedValue({ id: 'run-1', status: 'pending', createdAgentIds: [], requestHash: HASH(), lockedAt: new Date(), error: null });
    const { result, conflict } = await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    expect(conflict).toBeUndefined();
    expect(mockRepo.reclaimForRetry).toHaveBeenCalledWith('t1', 'run-1');
    expect(mockCreate).toHaveBeenCalledTimes(1); // re-validated + provisioned
    expect(result!.status).toBe('completed');
    expect(result!.error).toBeUndefined(); // the stale error is gone
  });

  it('a retry lost to a concurrent reclaim (reclaimForRetry -> null) is a 409 in-progress', async () => {
    mockRepo.findRun.mockResolvedValue({ id: 'run-1', status: 'failed', createdAgentIds: [], requestHash: HASH(), lockedAt: null, error: 'boom' });
    mockRepo.reclaimForRetry.mockResolvedValue(null);
    const { conflict } = await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    expect(conflict!.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a retry with a DIFFERENT request body is a 409', async () => {
    mockRepo.findRun.mockResolvedValue({ id: 'run-1', status: 'completed', createdAgentIds: [], requestHash: 'DIFFERENT', lockedAt: null, error: null });
    const { conflict } = await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    expect(conflict!.status).toBe(409);
    expect(conflict!.error).toMatch(/different request/);
  });

  it('a pending run with a LIVE lease is a 409 in-progress', async () => {
    mockRepo.findRun.mockResolvedValue({ id: 'run-1', status: 'pending', createdAgentIds: [], requestHash: HASH(), lockedAt: new Date(), error: null });
    const { conflict } = await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    expect(conflict!.status).toBe(409);
    expect(conflict!.error).toMatch(/in progress/);
  });
});

describe('provision — failure compensates', () => {
  it('a role create failure compensates (soft-deletes) created agents', async () => {
    mockRepo.findRun.mockResolvedValue(null);
    mockRepo.createRun.mockResolvedValue({ run: { id: 'run-1', createdAgentIds: [], status: 'pending', lockedAt: new Date() }, created: true });
    mockCreate.mockRejectedValueOnce(new Error('create blew up'));
    // After failure the service reads the run status back:
    mockRepo.findRun.mockResolvedValueOnce(null).mockResolvedValue({ id: 'run-1', status: 'compensated', createdAgentIds: [], requestHash: HASH(), lockedAt: null, error: 'create blew up' });
    // compensate() lists the roles it recorded — the engineer role crashed at 'creating' with a
    // ZERO agent_id, but provenance holds its REAL agent (the crash-between-insert-and-mark case):
    mockRepo.listRunRoles.mockResolvedValueOnce([]).mockResolvedValue([{ runId: 'run-1', roleKey: 'engineer', agentId: '00000000-0000-0000-0000-000000000000', status: 'failed', error: 'create blew up' }]);
    mockRepo.listProvenanceAgents.mockResolvedValue([{ agentId: 'agent-eng-orphan', roleKey: 'engineer' }]);
    const { result } = await teamProvisioningService.provision('t1', 'software-delivery-team', req, 'wf-1');
    expect(result!.error).toMatch(/create blew up/);
    expect(mockRepo.setRunStatus).toHaveBeenCalledWith('t1', 'run-1', 'failed', expect.anything());
    // Finding #5: compensation resolves the ZERO-agent role's real agent from provenance and
    // soft-deletes it — no orphan.
    expect(mockDelete).toHaveBeenCalledWith('agent-eng-orphan', 't1', 'system:provisioning-compensation');
  });
});

// The service hashes the canonical body; mirror it so the "same body" retries match.
function HASH(): string {
  const crypto = require('crypto');
  const canonical = {
    bindings: [{ roleKey: 'engineer', connectorId: '11111111-1111-1111-1111-111111111111', repoScope: [] }],
    escalationRecipientOverrides: {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
