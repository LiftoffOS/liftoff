// Tests for the pure assembleWorkforce function.
// No jest.mock() needed — assembly.ts only imports types, no service implementations.
import { assembleWorkforce } from '../assembly';
import type { McpTokenRow } from '../assembly';
import type { PersonWithAssignments } from '../../person-assignments/types';
import type { OauthConnectedTool } from '../../oauth/connected-tools';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_ID_1 = '00000000-0000-0000-0000-000000000100';
const AGENT_ID_2 = '00000000-0000-0000-0000-000000000200';
const MCP_ID = '00000000-0000-0000-0000-000000000400';

// Minimal stubs — only fields the assembly function reads
const makeInternalAgent = (id: string) => ({
  id,
  tenantId: TENANT_ID,
  role: 'Support Agent',
  responsibilities: null,
  integrations: [],
  pendingIntegrations: [],
  additionalContext: null,
  summary: null,
  systemPrompt: null,
  userInstructions: null,
  instructionsMd: null,
  temperature: 0.3,
  status: 'active' as const,
  currentVersion: 1,
  tasksCompleted: 0,
  tasks30d: 0,
  monthlyCost: 0,
  lastActive: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  agentType: 'agent' as const,
  modelConfig: {},
  memoryScope: { readableLayers: ['global' as const, 'individual' as const], writableLayers: ['individual' as const] },
  execConfig: {},
  workflowSteps: null,
  triggerConfig: null,
  delegates: [],
  workforcePlanId: null,
  reviewedAt: null,
  reviewedBy: null,
  workflowStepsHash: null,
  messagingNickname: null,
  lastActivity: null,
  lastActivityAction: null,
});

const makeExternalAgent = (id: string) => ({
  id,
  tenantId: TENANT_ID,
  name: 'CoinGecko',
  endpointUrl: 'https://mcp.coingecko.com',
  transportType: 'streamable-http' as const,
  description: null,
  connectionType: 'automatic' as const,
  authType: 'none' as const,
  credentialSecretName: null,
  apiKeyHint: null,
  bearerTokenHint: null,
  customHeaderKeys: null,
  collaborationMode: 'allow-all' as const,
  summary: null,
  collaborationHints: null,
  detectedCapabilities: [],
  detectedResources: [],
  toolClassifications: {},
  rawMcpTools: [],
  rawMcpResources: [],
  allowedInternalAgentIds: [],
  requestRules: [],
  status: 'connected' as const,
  capabilityChanges: null,
  capabilitySource: 'mcp_discovery' as const,
  lastCheckedAt: null,
  lastError: null,
  costAmount: null,
  costType: null,
  monthlyCost: null,
  tasks30d: 0,
  currentVersion: 1,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  lastActivity: null,
  lastActivityAction: null,
});

const MCP_TOKEN: McpTokenRow = {
  id: MCP_ID,
  tenantId: TENANT_ID,
  accountId: '00000000-0000-0000-0000-000000000011',
  name: 'Collab Token',
  status: 'active',
  tokenPrefix: 'liftoff_mcp_',
  lastUsedAt: null,
  expiresAt: '2025-01-01T00:00:00Z',
  createdAt: '2024-01-01T00:00:00Z',
};

describe('assembleWorkforce', () => {
  it('happy path: returns correct WorkforceResponse shape', () => {
    const result = assembleWorkforce(
      [makeInternalAgent(AGENT_ID_1)],
      [makeExternalAgent(AGENT_ID_2)],
      [MCP_TOKEN],
      [],
      {},
    );

    expect(result.internalAgents).toHaveLength(1);
    expect(result.externalAgents).toHaveLength(1);
    expect(result.claudeCodeKeys).toHaveLength(1); // 1 mcp (developer proxy keys fetched by frontend directly)
    expect(result.personnel).toHaveLength(0);
  });

  it('claudeCodeKeys maps MCP tokens with keyType mcp', () => {
    const result = assembleWorkforce(
      [], [], [MCP_TOKEN], [], {},
    );

    const mcpKey = result.claudeCodeKeys.find(k => k.keyType === 'mcp');

    expect(mcpKey?.id).toBe(MCP_ID);
    expect(mcpKey?.keyPrefix).toBe('liftoff_mcp_'); // mapped from tokenPrefix
    expect(mcpKey?.keyHint).toBe('');
  });

  it('hides revoked (archived) proxy credentials and MCP tokens from claudeCodeKeys', () => {
    const makeCred = (id: string, status: 'active' | 'revoked') => ({
      id,
      tenantId: TENANT_ID,
      userId: '00000000-0000-0000-0000-000000000011',
      vendor: 'openai',
      keyPrefix: 'liftoff_sk_abcd',
      keyHint: 'wxyz',
      label: `key-${status}`,
      status,
      lastUsedAt: null,
      revokedAt: status === 'revoked' ? '2024-02-01T00:00:00Z' : null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const revokedMcp: McpTokenRow = { ...MCP_TOKEN, id: '00000000-0000-0000-0000-000000000401', status: 'revoked' };

    const result = assembleWorkforce(
      [], [],
      [MCP_TOKEN, revokedMcp],
      [], {},
      [makeCred('00000000-0000-0000-0000-000000000500', 'active'), makeCred('00000000-0000-0000-0000-000000000501', 'revoked')],
    );

    const ids = result.claudeCodeKeys.map(k => k.id);
    expect(ids).toContain('00000000-0000-0000-0000-000000000500'); // active proxy cred
    expect(ids).toContain(MCP_ID);                                 // active mcp token
    expect(ids).not.toContain('00000000-0000-0000-0000-000000000501'); // revoked proxy cred hidden
    expect(ids).not.toContain('00000000-0000-0000-0000-000000000401'); // revoked mcp token hidden
    expect(result.claudeCodeKeys.every(k => k.status === 'active')).toBe(true);
  });

  it('carries the credential vendor through so the frontend can brand the row', () => {
    const makeCred = (id: string, vendor: string) => ({
      id,
      tenantId: TENANT_ID,
      userId: '00000000-0000-0000-0000-000000000011',
      vendor,
      keyPrefix: 'liftoff_sk_abcd',
      keyHint: 'wxyz',
      label: `key-${vendor}`,
      status: 'active' as const,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });

    const result = assembleWorkforce(
      [], [], [MCP_TOKEN], [], {},
      [
        makeCred('00000000-0000-0000-0000-000000000600', 'openai'),
        makeCred('00000000-0000-0000-0000-000000000601', 'anthropic'),
      ],
    );

    const byId = new Map(result.claudeCodeKeys.map(k => [k.id, k]));
    expect(byId.get('00000000-0000-0000-0000-000000000600')?.vendor).toBe('openai');
    expect(byId.get('00000000-0000-0000-0000-000000000601')?.vendor).toBe('anthropic');
    // MCP collab tokens are not vendor credentials
    expect(byId.get(MCP_ID)?.vendor).toBe('claude_code_mcp');
  });

  it('defaults vendor to anthropic for credentials predating the vendor column', () => {
    const legacyCred = {
      id: '00000000-0000-0000-0000-000000000700',
      tenantId: TENANT_ID,
      userId: '00000000-0000-0000-0000-000000000011',
      vendor: undefined as unknown as string,
      keyPrefix: 'liftoff_sk_abcd',
      keyHint: 'wxyz',
      label: 'legacy key',
      status: 'active' as const,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const result = assembleWorkforce([], [], [], [], {}, [legacyCred]);

    expect(result.claudeCodeKeys[0]?.vendor).toBe('anthropic');
  });

  describe('coding-tool description', () => {
    // These rows have no description column of their own, so the field says
    // whose tool it is. The owner is named the way the dashboard's Workspace
    // Members tooltips name people: first name, else email.
    const OWNER_ID = '00000000-0000-0000-0000-000000000011';

    const makePerson = (over: Partial<PersonWithAssignments> = {}): PersonWithAssignments => ({
      accountId: OWNER_ID,
      personId: '00000000-0000-0000-0000-000000000012',
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'person@example.com',
      onboardStatus: null,
      joinedAt: '2024-01-01T00:00:00Z',
      costPerMonth: null,
      tasks30d: 0,
      isAssignable: true,
      assignments: [],
      ...over,
    });

    const makeCred = () => ({
      id: '00000000-0000-0000-0000-000000000800',
      tenantId: TENANT_ID,
      userId: OWNER_ID,
      vendor: 'openai',
      keyPrefix: 'liftoff_sk_abcd',
      keyHint: 'wxyz',
      label: 'codex key',
      status: 'active' as const,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });

    it('names the owner by first name, on both proxy credentials and MCP tokens', () => {
      const result = assembleWorkforce(
        [], [], [MCP_TOKEN], [makePerson()], {}, [makeCred()],
      );

      expect(result.claudeCodeKeys.map(k => k.description)).toEqual([
        'AI Coding Tool for Alex',
        'AI Coding Tool for Alex',
      ]);
    });

    it('falls back to the email when the owner has no first name', () => {
      // Same heuristic as the Workspace Members tooltip: a blank first name is
      // no name at all, so the person is identified by the address instead.
      const result = assembleWorkforce(
        [], [], [], [makePerson({ firstName: '   ' })], {}, [makeCred()],
      );

      expect(result.claudeCodeKeys[0]?.description).toBe(
        'AI Coding Tool for person@example.com',
      );
    });

    it('drops the attribution when the owner is not in the workspace list', () => {
      // A key whose owner has since left. Naming nobody would read worse than
      // saying only what the row is.
      const result = assembleWorkforce([], [], [], [], {}, [makeCred()]);

      expect(result.claudeCodeKeys[0]?.description).toBe('AI Coding Tool');
    });

    describe('OAuth-connected tools', () => {
      const STATS = { hoursSavedLast30Days: 0 };
      const makeTool = (over: Partial<OauthConnectedTool> = {}): OauthConnectedTool => ({
        id: '00000000-0000-0000-0000-000000000900',
        tenantId: TENANT_ID,
        accountId: OWNER_ID,
        clientName: 'Gemini CLI MCP Client',
        clientSlug: 'gemini-cli',
        clientLabel: 'Gemini CLI',
        lastUsedAt: '2026-09-17T10:00:00Z',
        createdAt: '2026-09-10T00:00:00Z',
        ...over,
      });

      it('names the row "Person (Tool)" the way the Switch connectors do, keyed on the client slug', () => {
        const result = assembleWorkforce([], [], [], [makePerson()], {}, [], STATS, [makeTool()]);

        expect(result.claudeCodeKeys).toHaveLength(1);
        expect(result.claudeCodeKeys[0]).toMatchObject({
          id: '00000000-0000-0000-0000-000000000900',
          name: 'Alex Rivera (Gemini CLI)',
          description: 'AI Coding Tool for Alex',
          keyType: 'mcp',
          vendor: 'gemini-cli',
          clientName: 'Gemini CLI MCP Client',
          clientLabel: 'Gemini CLI',
          status: 'active',
          lastUsedAt: '2026-09-17T10:00:00Z',
        });
      });

      it('names an unknown client by its registered name under the generic key', () => {
        const result = assembleWorkforce(
          [], [], [], [makePerson()], {}, [], STATS,
          [makeTool({ clientName: 'Muse personal agent', clientSlug: null, clientLabel: 'Muse personal agent' })],
        );

        expect(result.claudeCodeKeys[0]).toMatchObject({
          name: 'Alex Rivera (Muse personal agent)',
          vendor: 'mcp',
          clientName: 'Muse personal agent',
        });
      });

      it('falls back to the email, then to the tool alone, when the person has no name', () => {
        const byEmail = assembleWorkforce([], [], [], [makePerson({ firstName: '', lastName: '' })], {}, [], STATS, [makeTool()]);
        expect(byEmail.claudeCodeKeys[0]?.name).toBe('person@example.com (Gemini CLI)');

        const gone = assembleWorkforce([], [], [], [], {}, [], STATS, [makeTool()]);
        expect(gone.claudeCodeKeys[0]?.name).toBe('Gemini CLI');
      });
    });

    describe('connection profiles', () => {
      // What the person wrote on the update page wins over the derived name
      // and description, field by field, on every connection family.
      const STATS = { hoursSavedLast30Days: 0 };
      const tool: OauthConnectedTool = {
        id: '00000000-0000-0000-0000-000000000900',
        tenantId: TENANT_ID,
        accountId: OWNER_ID,
        clientName: 'Codex',
        clientSlug: 'codex',
        clientLabel: 'Codex',
        lastUsedAt: null,
        createdAt: '2026-09-10T00:00:00Z',
      };

      it('applies a written name and description over the derived ones', () => {
        const profiles = new Map([
          [tool.id, { name: 'Release reviewer', description: 'Reviews every release branch' }],
          [MCP_ID, { name: null, description: 'Pairs on migrations' }],
          ['00000000-0000-0000-0000-000000000800', { name: 'Codex on the laptop', description: null }],
        ]);
        const result = assembleWorkforce([], [], [MCP_TOKEN], [makePerson()], {}, [makeCred()], STATS, [tool], profiles);
        const byId = new Map(result.claudeCodeKeys.map(k => [k.id, k]));

        expect(byId.get(tool.id)).toMatchObject({ name: 'Release reviewer', description: 'Reviews every release branch' });
        expect(byId.get(MCP_ID)).toMatchObject({ name: 'Collab Token', description: 'Pairs on migrations' });
        expect(byId.get('00000000-0000-0000-0000-000000000800')).toMatchObject({ name: 'Codex on the laptop', description: 'AI Coding Tool for Alex' });
      });

      it('leaves a row untouched when it has no profile', () => {
        const result = assembleWorkforce([], [], [], [makePerson()], {}, [], STATS, [tool], new Map());
        expect(result.claudeCodeKeys[0]).toMatchObject({ name: 'Alex Rivera (Codex)', description: 'AI Coding Tool for Alex' });
      });
    });
  });

  it('embeds lastActivity and lastActivityAction from activityMap when present', () => {
    const lastActivityTs = '2024-06-15T12:00:00.000Z';
    const activityMap = {
      [AGENT_ID_1]: { timestamp: lastActivityTs, action: 'gmail_send_email' },
      [AGENT_ID_2]: { timestamp: lastActivityTs, action: 'slack_post_message' },
    };

    const result = assembleWorkforce(
      [makeInternalAgent(AGENT_ID_1)],
      [makeExternalAgent(AGENT_ID_2)],
      [], [], activityMap,
    );

    expect(result.internalAgents[0].lastActivity).toBe(lastActivityTs);
    expect(result.internalAgents[0].lastActivityAction).toBe('gmail_send_email');
    expect(result.externalAgents[0].lastActivity).toBe(lastActivityTs);
    expect(result.externalAgents[0].lastActivityAction).toBe('slack_post_message');
  });

  it('sets lastActivity and lastActivityAction to null when agent not in activityMap', () => {
    const result = assembleWorkforce(
      [makeInternalAgent(AGENT_ID_1)],
      [makeExternalAgent(AGENT_ID_2)],
      [], [], {},
    );

    expect(result.internalAgents[0].lastActivity).toBeNull();
    expect(result.internalAgents[0].lastActivityAction).toBeNull();
    expect(result.externalAgents[0].lastActivity).toBeNull();
    expect(result.externalAgents[0].lastActivityAction).toBeNull();
  });

  it('empty inputs: all arrays empty, no crash', () => {
    const result = assembleWorkforce([], [], [], [], {});

    expect(result.internalAgents).toHaveLength(0);
    expect(result.externalAgents).toHaveLength(0);
    expect(result.claudeCodeKeys).toHaveLength(0);
    expect(result.personnel).toHaveLength(0);
  });

  it('passes stats through and defaults hoursSavedLast30Days to 0', () => {
    const withStats = assembleWorkforce([], [], [], [], {}, [], { hoursSavedLast30Days: 42 });
    expect(withStats.stats).toEqual({ hoursSavedLast30Days: 42 });

    const withoutStats = assembleWorkforce([], [], [], [], {});
    expect(withoutStats.stats).toEqual({ hoursSavedLast30Days: 0 });
  });
});
