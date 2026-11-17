// A meta-tool server (omnisend) exposes one tool — `execute` — whose ARGUMENT
// names the operation. The tool's own name says nothing about what a call
// does, so the gate resolves the call to its operation's seeded classification
// (McpToolDefinition.operationClassifications, folded on by the enumerator):
// a destructive operation gates at level 2, a read operation passes, and an
// operation with no seed falls to the write class.

import { ModelTool, OversightSettings, ToolCallRequest } from '../types';
import { HitlEnforcementService } from '../service';

jest.mock('../../infrastructure/database', () => {
  const sharedQuery = jest.fn().mockResolvedValue({ rows: [{ count: '0' }] });
  return {
    pool: { query: sharedQuery },
    withTenantScope: jest.fn(async (
      _tenantId: string,
      fn: (_client: { query: typeof sharedQuery }) => Promise<unknown>,
    ) => fn({ query: sharedQuery })),
  };
});

jest.mock('../../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../governance/governance-service-client', () => ({
  getGovernanceApprovalPolicy: jest.fn().mockResolvedValue(null),
}));

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

function oversight(): OversightSettings {
  return {
    tenantId: TENANT_ID,
    autonomy: 'balanced',
    escalation: 'important',
    sensitiveWork: {
      customerCommunication: true,
      financialActions: true,
      dataChanges: false,
      externalPublishing: true,
      hiringDecisions: false,
      mergeToMain: false,
    },
    communication: 'auto',
    currentVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const EXECUTE: ModelTool = {
  name: 'omnisend-abc12345__execute',
  description: 'Run an Omnisend operation',
  categories: [],
  effect: 'write',
  operationClassifications: {
    arg: 'tool_name',
    byOperation: {
      get_automations: [],
      delete_campaigns_id: ['write', 'destructive'],
    },
  },
} as ModelTool;

function executeCall(operation: string): ToolCallRequest {
  return { id: 'tc-1', name: 'mcp__omnisend-abc12345__execute', input: { tool_name: operation, payload: {} } };
}

describe('HitlEnforcementService.checkHitlGate — meta-tool operation resolution', () => {
  let service: HitlEnforcementService;

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('gates execute with a destructive operation at level 2', async () => {
    const result = await service.checkHitlGate(
      [executeCall('delete_campaigns_id')],
      oversight(),
      2,
      [EXECUTE],
      TENANT_ID,
      AGENT_ID,
    );
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('destructive_gate');
  });

  it('passes execute with a read operation at level 2', async () => {
    const result = await service.checkHitlGate(
      [executeCall('get_automations')],
      oversight(),
      2,
      [EXECUTE],
      TENANT_ID,
      AGENT_ID,
    );
    expect(result.shouldGate).toBe(false);
  });

  it('an operation with no seed falls to the write class (gates on untrusted inbound)', async () => {
    const result = await service.checkHitlGate(
      [executeCall('post_something_new')],
      oversight(),
      2,
      [EXECUTE],
      TENANT_ID,
      AGENT_ID,
      { trustLevel: 'untrusted_inbound' },
    );
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('external_content_write');
  });

  it('a seeded read operation passes the untrusted-inbound gate', async () => {
    const result = await service.checkHitlGate(
      [executeCall('get_automations')],
      oversight(),
      2,
      [EXECUTE],
      TENANT_ID,
      AGENT_ID,
      { trustLevel: 'untrusted_inbound' },
    );
    expect(result.shouldGate).toBe(false);
  });
});
