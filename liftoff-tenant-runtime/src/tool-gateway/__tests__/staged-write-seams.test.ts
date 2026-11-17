// The stage/apply protocol at its seams: the guardrail that records a stage,
// the gate that holds an apply to its one ask, and the dispatcher's claim,
// dispatch and settle of an apply (ADR-052 rule 5).
//
// The protocol's own clauses are held in staged-batches.test.ts; these hold
// the places the protocol is WIRED, because a protocol wired at one end is the
// defect class this codebase keeps finding.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
  getPoolForService: jest.fn(),
  pool: { query: jest.fn() },
}));

const STAGE_SCHEMA = { name: 'create_campaign', categories: ['write'], writeRole: 'stage', paired_apply: 'send_campaign', inputSchema: {} };
const APPLY_SCHEMA = { name: 'send_campaign', categories: ['write', 'outbound'], writeRole: 'apply', inputSchema: {} };
jest.mock('../../connectors/tool-schema-cache', () => ({
  getToolSchemas: jest.fn().mockReturnValue([STAGE_SCHEMA, APPLY_SCHEMA]),
  getToolSchema: (type: string, name: string) =>
    type === 'mailchimp' ? (name === 'create_campaign' ? STAGE_SCHEMA : name === 'send_campaign' ? APPLY_SCHEMA : null) : null,
  getCustomMcpToolSchema: () => null,
  catalogTypeFor: (connector: string) => connector.replace(/-[0-9a-f]{8}$/, ''),
  capabilityForToolName: () => undefined,
}));

import { runOutputGuardrails } from '../output-guardrails';
import { StagedBatchRepository, _setStagedBatchRepository, type StagedBatch } from '../staged-batches';
import { evaluateApprovalObligations } from '../../hitl-enforcement/approval-obligations';
import type { ModelTool } from '../../hitl-enforcement/types';

function fakeRepo() {
  const mint = jest.fn(async (args: Record<string, unknown>): Promise<StagedBatch> => ({
    id: 'batch-1', tenantId: args.tenantId as string, agentId: args.agentId as string, invocationId: (args.invocationId as string) ?? null,
    connector: args.connector as string, stageTool: args.stageTool as string, applyTool: args.applyTool as string,
    vendorIds: ['cmp_881'], itemCount: 1, digest: 'd1', status: 'staged', approvalId: null, approvedDigest: null,
    appliedAt: null, applyResult: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 1000),
  }));
  const repo = Object.assign(Object.create(StagedBatchRepository.prototype), { mint }) as StagedBatchRepository & { mint: typeof mint };
  return repo;
}

afterEach(() => _setStagedBatchRepository(null));

describe('the staged-write guardrail records what a stage prepared', () => {
  it('mints a batch from the dispatched call and the vendor answer, and hands the model only the opaque id', async () => {
    const repo = fakeRepo();
    _setStagedBatchRepository(repo);
    const guarded = await runOutputGuardrails(
      { actionType: 'create_campaign', payload: { type: 'regular', settings: { subject_line: 'September' } }, tenantId: 't1', invocationId: 'inv-1', connector: 'mailchimp-1a2b3c4d', agentId: 'a1' },
      { id: 'cmp_881', status: 'save' },
    );
    expect(repo.mint).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv-1', connector: 'mailchimp-1a2b3c4d',
      stageTool: 'create_campaign', applyTool: 'send_campaign',
      input: { type: 'regular', settings: { subject_line: 'September' } },
      output: { id: 'cmp_881', status: 'save' },
    }));
    expect(guarded).toEqual({ outcome: 'ok', data: { id: 'cmp_881', status: 'save', stagedBatchId: 'batch-1' } });
  });

  it('a stage the host cannot bind is blocked rather than let through as a draft nothing can commit', async () => {
    const repo = fakeRepo();
    _setStagedBatchRepository(repo);
    const guarded = await runOutputGuardrails(
      { actionType: 'create_campaign', payload: {}, tenantId: 't1', invocationId: 'inv-1', connector: 'mailchimp-1a2b3c4d' },
      { id: 'cmp_881' },
    );
    expect(guarded.outcome).toBe('blocked');
    expect(repo.mint).not.toHaveBeenCalled();
  });

  it('leaves every other tool\'s result alone', async () => {
    const repo = fakeRepo();
    _setStagedBatchRepository(repo);
    const guarded = await runOutputGuardrails(
      { actionType: 'list_campaigns', payload: {}, tenantId: 't1', connector: 'mailchimp-1a2b3c4d', agentId: 'a1' },
      { campaigns: [] },
    );
    expect(guarded).toEqual({ outcome: 'ok', data: { campaigns: [] } });
    expect(repo.mint).not.toHaveBeenCalled();
  });
});

describe('the gate holds an apply to its one ask', () => {
  const TOOLS: ModelTool[] = [
    { name: 'mailchimp-1a2b3c4d__send_campaign', description: 'Send a campaign', inputSchema: {}, effect: 'write', categories: ['write', 'outbound'], writeRole: 'apply' } as ModelTool,
    { name: 'mailchimp-1a2b3c4d__create_campaign', description: 'Create a campaign', inputSchema: {}, effect: 'write', categories: ['write'], writeRole: 'stage' } as ModelTool,
  ];

  it('an apply-role tool is a size ask whatever the thresholds say, and the grant records it', () => {
    const out = evaluateApprovalObligations(
      [{ id: 'pc1', name: 'mailchimp-1a2b3c4d__send_campaign', input: { campaign_id: 'cmp_881' } }],
      // Level 3 with nothing sensitive on: nothing else would ask.
      { hitlLevel: 3, oversight: { tenantId: 't1', autonomy: 'balanced', escalation: 'critical', communication: 'auto', sensitiveWork: {} } as never, tools: TOOLS },
    );
    expect(out.reasons).toEqual(['blast_radius']);
    expect(out.measuredReasons).toEqual(['mailchimp-1a2b3c4d__send_campaign commits a staged batch (cmp_881)']);
  });

  it('the stage itself does not ask on that account', () => {
    const out = evaluateApprovalObligations(
      [{ id: 'pc1', name: 'mailchimp-1a2b3c4d__create_campaign', input: { type: 'regular' } }],
      { hitlLevel: 3, oversight: { tenantId: 't1', autonomy: 'balanced', escalation: 'critical', communication: 'auto', sensitiveWork: {} } as never, tools: TOOLS },
    );
    expect(out.reasons).not.toContain('blast_radius');
  });
});
