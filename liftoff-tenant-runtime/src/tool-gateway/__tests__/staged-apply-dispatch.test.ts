// The dispatcher's half of the stage/apply protocol: an apply is claimed in
// the guard chain before the vendor is called, dispatched with the model's
// arguments minus the protocol's, and settled with what the vendor answered —
// on the native route, and stateless enough that the claim and the settle
// need not share an instance (ADR-052 rule 5, clauses 3, 4, 5, 8 and 9).

jest.mock('../../connectors/connector-service-client', () => ({ getConnectorServiceClient: () => ({}) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  withTenantScope: jest.fn(),
}));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../state-fetcher', () => ({ stateFetcherRegistry: { fetchState: jest.fn() } }));
jest.mock('../permission-validator', () => ({ permissionValidator: { validate: jest.fn() } }));
jest.mock('../conflict-policy-registry', () => ({
  ConflictPolicyRegistry: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

const APPLY_SCHEMA = { name: 'send_campaign', categories: ['write', 'outbound'], writeRole: 'apply', inputSchema: {} };
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([APPLY_SCHEMA]),
  getToolSchema: (type: string, name: string) => (type === 'mailchimp' && name === 'send_campaign' ? APPLY_SCHEMA : null),
  getCustomMcpToolSchema: () => null,
  catalogTypeFor: (connector: string) => connector.replace(/-[0-9a-f]{8}$/, ''),
  capabilityForToolName: () => undefined,
}));

import { ToolGatewayService } from '../service';
import { StagedBatchRepository, _setStagedBatchRepository, type StagedBatch } from '../staged-batches';
import { logger } from '../../infrastructure/logging';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const CONNECTOR = 'mailchimp-1a2b3c4d';

function batch(over: Partial<StagedBatch> = {}): StagedBatch {
  return {
    id: 'batch-1', tenantId: TENANT, agentId: AGENT, invocationId: 'inv-1', connector: CONNECTOR,
    stageTool: 'create_campaign', applyTool: 'send_campaign', vendorIds: ['cmp_881'], itemCount: 1, digest: 'd1',
    status: 'approved', approvalId: 'appr-1', approvedDigest: 'd1', appliedAt: null, applyResult: null,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

/** A repository whose rows the test controls. */
function fakeRepo(initial: StagedBatch | null) {
  let row = initial;
  const repo = Object.assign(Object.create(StagedBatchRepository.prototype), {
    findForApply: jest.fn(async () => row),
    findClaimedForSettle: jest.fn(async () => (row && row.status === 'applied' && row.applyResult === null ? row : null)),
    get: jest.fn(async () => row),
    claimApply: jest.fn(async (_t: string, id: string, digest: string) => {
      if (!row || row.id !== id || row.digest !== digest || row.approvedDigest !== digest || row.status !== 'approved') return false;
      row = { ...row, status: 'applied', appliedAt: new Date() };
      return true;
    }),
    recordApplyResult: jest.fn(async (_t: string, _id: string, result: unknown) => { if (row) row = { ...row, applyResult: result }; }),
    releaseApply: jest.fn(async (_t: string, _id: string, error: string) => { if (row) row = { ...row, status: 'approved', appliedAt: null, applyResult: { error } }; }),
  }) as StagedBatchRepository & Record<string, jest.Mock>;
  return { repo, current: () => row };
}

function input(payload: Record<string, unknown>) {
  return {
    tenantId: TENANT, agentId: AGENT, instructionVersion: 1, traceId: 'tr-1', idempotencyKey: 'ik-1',
    connector: CONNECTOR, entityType: 'campaign', actionType: 'send_campaign', payload,
  };
}

afterEach(() => _setStagedBatchRepository(null));

describe('the guard chain claims an approved apply and refuses everything else', () => {
  it('claims the approved batch the arguments name and lets the call through', async () => {
    const { repo, current } = fakeRepo(batch());
    _setStagedBatchRepository(repo);
    const svc = new ToolGatewayService();
    const refusal = await svc.preDispatchGuards(input({ campaign_id: 'cmp_881' }));
    expect(refusal).toBeNull();
    expect(repo.findForApply).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, agentId: AGENT, connector: CONNECTOR, applyTool: 'send_campaign', applyArgs: { campaign_id: 'cmp_881' },
    }));
    expect(current()?.status).toBe('applied');
  });

  it('refuses an apply that names nothing this run staged', async () => {
    const { repo } = fakeRepo(null);
    _setStagedBatchRepository(repo);
    const svc = new ToolGatewayService();
    const refusal = await svc.preDispatchGuards(input({ campaign_id: 'cmp_000' }));
    expect(refusal).toMatchObject({ success: false, error: expect.stringMatching(/nothing this run staged matches/) });
    expect(repo.claimApply).not.toHaveBeenCalled();
  });

  it.each([
    ['not approved', batch({ status: 'staged', approvalId: null, approvedDigest: null }), /has not been approved/],
    ['cancelled', batch({ status: 'cancelled' }), /was cancelled/],
    ['expired', batch({ expiresAt: new Date(Date.now() - 1) }), /expired with its ask/],
    ['a digest no person approved', batch({ approvedDigest: 'd0' }), /not the batch that was approved/],
    ['claimed and unsettled', batch({ status: 'applied', applyResult: null }), /being applied/],
  ])('refuses a batch that is %s, and writes nothing', async (_label, row, message) => {
    const { repo } = fakeRepo(row);
    _setStagedBatchRepository(repo);
    const svc = new ToolGatewayService();
    const refusal = await svc.preDispatchGuards(input({ campaign_id: 'cmp_881' }));
    expect(refusal).toMatchObject({ success: false, error: expect.stringMatching(message) });
    expect(repo.claimApply).not.toHaveBeenCalled();
  });

  it('answers an applied batch with the recorded result and no second vendor call', async () => {
    const { repo } = fakeRepo(batch({ status: 'applied', applyResult: { sent: true } }));
    _setStagedBatchRepository(repo);
    const svc = new ToolGatewayService();
    const refusal = await svc.preDispatchGuards(input({ campaign_id: 'cmp_881' }));
    expect(refusal).toEqual({ success: true, data: { sent: true }, traceId: 'tr-1' });
    expect(repo.claimApply).not.toHaveBeenCalled();
  });

  it('strips and logs the protocol arguments the model supplied; the batch is resolved host-side', async () => {
    const { repo } = fakeRepo(batch());
    _setStagedBatchRepository(repo);
    const svc = new ToolGatewayService();
    const call = input({ campaign_id: 'cmp_881', stagedBatchId: 'batch-9', digest: 'ffff' });
    await svc.preDispatchGuards(call);
    expect(repo.findForApply).toHaveBeenCalledWith(expect.objectContaining({ applyArgs: { campaign_id: 'cmp_881' } }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'staged_apply_model_supplied_args_ignored', stripped: ['stagedBatchId', 'digest'] }),
      expect.any(String),
    );
    expect(svc.stagedApplyPayload(call)).toEqual({ campaign_id: 'cmp_881' });
    // Not an apply: nothing to strip, nothing to substitute.
    expect(svc.stagedApplyPayload({ ...call, actionType: 'list_campaigns' })).toBeUndefined();
  });
});

describe('the settle records the vendor\'s answer or hands the claim back', () => {
  it('a success records the result on the claimed batch, found by the call rather than by memory', async () => {
    const { repo, current } = fakeRepo(batch({ status: 'applied', applyResult: null }));
    _setStagedBatchRepository(repo);
    // A different instance from the one that claimed.
    const other = new ToolGatewayService();
    await other.settleStagedApply(input({ campaign_id: 'cmp_881' }), { success: true, data: { sent: true } });
    expect(repo.findClaimedForSettle).toHaveBeenCalledWith(expect.objectContaining({ applyArgs: { campaign_id: 'cmp_881' } }));
    expect(current()?.applyResult).toEqual({ sent: true });
  });

  it('a failure releases the claim with the error, so the approval is not spent on a write that did not happen', async () => {
    const { repo, current } = fakeRepo(batch({ status: 'applied', applyResult: null }));
    _setStagedBatchRepository(repo);
    const svc = new ToolGatewayService();
    await svc.settleStagedApply(input({ campaign_id: 'cmp_881' }), { success: false, error: 'vendor 502' });
    expect(current()).toMatchObject({ status: 'approved', applyResult: { error: 'vendor 502' } });
  });

  it('settles nothing for a call that claimed nothing', async () => {
    const { repo } = fakeRepo(batch({ status: 'approved' }));
    _setStagedBatchRepository(repo);
    const svc = new ToolGatewayService();
    await svc.settleStagedApply(input({ campaign_id: 'cmp_881' }), { success: true, data: {} });
    expect(repo.recordApplyResult).not.toHaveBeenCalled();
    await svc.settleStagedApply({ ...input({}), actionType: 'list_campaigns' }, { success: true, data: {} });
    expect(repo.findClaimedForSettle).toHaveBeenCalledTimes(1);
  });
});
