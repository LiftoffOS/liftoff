// C6 verification: HITL admission is source-agnostic. A Composio-sourced
// tool whose ModelTool carries categories and (when applicable) the
// "⚠️ DESTRUCTIVE" description marker MUST trip the same gates that a
// native tool would. Locks the contract that the cutover (composio
// dispatch in-process via tool-gateway/composio-dispatcher.ts) did NOT
// route around HITL.

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

function oversight(overrides: Partial<OversightSettings> = {}): OversightSettings {
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
    ...overrides,
  };
}

function call(name: string): ToolCallRequest {
  return { id: 'tc-1', name, input: {} };
}

describe('HitlEnforcementService.checkHitlGate — Composio-sourced tools (C6)', () => {
  let service: HitlEnforcementService;

  beforeEach(() => {
    service = new HitlEnforcementService();
    jest.clearAllMocks();
  });

  it('Level 1 gates a Composio Gmail outbound tool same as a native one', async () => {
    const tools: ModelTool[] = [{
      name: 'gmail-acct-aaa__send_email',
      description: 'Send an email via Gmail',
      categories: ['write', 'outbound'],
    } as ModelTool];
    const result = await service.checkHitlGate(
      [call('gmail-acct-aaa__send_email')],
      oversight(),
      1, // HITL Level 1
      tools,
      TENANT_ID,
      AGENT_ID,
    );
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('level_1_gate');
  });

  it('Level 2 gates a destructive Composio tool (description marker drives the gate)', async () => {
    const tools: ModelTool[] = [{
      name: 'gmail-acct-aaa__delete_thread',
      description: '⚠️ DESTRUCTIVE: Permanently delete a Gmail thread',
      categories: ['write', 'destructive'],
    } as ModelTool];
    const result = await service.checkHitlGate(
      [call('gmail-acct-aaa__delete_thread')],
      oversight(),
      2,
      tools,
      TENANT_ID,
      AGENT_ID,
    );
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('destructive_gate');
  });

  // Regression: the case above passes the catalog's OWN name form on both sides,
  // which is not what the LLM path produces. The Agent SDK prefixes every
  // MCP-served tool, so the gate receives `mcp__liftoff-tool-gateway__<alias>__<fn>`
  // while the catalog holds `<alias>__<fn>`. The raw `Set.has` this replaced
  // matched neither, so level 2 was inert for every connector and vendor-MCP
  // tool while both destructive tests stayed green.
  it('Level 2 gates a destructive Composio tool called by its SDK-prefixed name', async () => {
    const tools: ModelTool[] = [{
      name: 'gmail-acct-aaa__delete_thread',
      description: '⚠️ DESTRUCTIVE: Permanently delete a Gmail thread',
      categories: ['write', 'destructive'],
    } as ModelTool];
    for (const prefixed of [
      'mcp__liftoff-tool-gateway__gmail-acct-aaa__delete_thread',
      'mcp__liftoff-tools-t1__gmail-acct-aaa__delete_thread',
    ]) {
      const result = await service.checkHitlGate(
        [call(prefixed)],
        oversight(),
        2,
        tools,
        TENANT_ID,
        AGENT_ID,
      );
      expect(result.shouldGate).toBe(true);
      expect(result.reason).toBe('destructive_gate');
    }
  });

  it('Level 2 still allows a non-destructive tool called by its SDK-prefixed name', async () => {
    const tools: ModelTool[] = [{
      name: 'gmail-acct-aaa__list_messages',
      description: 'List Gmail messages',
      categories: ['read'],
    } as ModelTool];
    const result = await service.checkHitlGate(
      [call('mcp__liftoff-tool-gateway__gmail-acct-aaa__list_messages')],
      oversight(),
      2,
      tools,
      TENANT_ID,
      AGENT_ID,
    );
    expect(result.shouldGate).toBe(false);
  });

  it('Level 3 gates a Composio outbound tool via the sensitive-work category match (customerCommunication)', async () => {
    const tools: ModelTool[] = [{
      name: 'slack-acct-bbb__send_message',
      description: 'Send a Slack message',
      categories: ['outbound', 'customerCommunication'],
    } as ModelTool];
    const result = await service.checkHitlGate(
      [call('slack-acct-bbb__send_message')],
      oversight({ escalation: 'sensitive' }),
      3,
      tools,
      TENANT_ID,
      AGENT_ID,
    );
    expect(result.shouldGate).toBe(true);
    expect(result.reason).toBe('sensitive_work');
    expect(result.matchedCategory).toBe('customerCommunication');
  });

  it('Level 3 allows a Composio read-only tool through (no sensitive category match)', async () => {
    const tools: ModelTool[] = [{
      name: 'gmail-acct-aaa__list_messages',
      description: 'List Gmail messages',
      categories: ['read'],
    } as ModelTool];
    const result = await service.checkHitlGate(
      [call('gmail-acct-aaa__list_messages')],
      oversight({ escalation: 'sensitive' }),
      3,
      tools,
      TENANT_ID,
      AGENT_ID,
    );
    expect(result.shouldGate).toBe(false);
  });

  it('Level 4 (smart autonomous) treats Composio read-only as low-risk and bypasses the gate', async () => {
    const tools: ModelTool[] = [{
      name: 'gmail-acct-aaa__list_messages',
      description: 'List Gmail messages',
      categories: [],
    } as ModelTool];
    const result = await service.checkHitlGate(
      [call('gmail-acct-aaa__list_messages')],
      oversight(),
      4,
      tools,
      TENANT_ID,
      AGENT_ID,
    );
    expect(result.shouldGate).toBe(false);
  });
});
