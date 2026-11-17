// Internal Agent Instruction Service Unit Tests (TE-001)
// Tests instruction creation for internal agents

import { InternalAgentInstructionService } from '../internal-agent-instruction-service';

// Mock dependencies
const mockQueryFn = jest.fn().mockResolvedValue({ rows: [] });
const mockPoolInstance = { query: mockQueryFn };

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPoolInstance),
  pool: new Proxy({} as any, {
    get(_, prop) {
      return (mockPoolInstance as any)[prop];
    },
  }),
}));
jest.mock('../../infrastructure/logging');

describe('InternalAgentInstructionService', () => {
  let service: InternalAgentInstructionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InternalAgentInstructionService();
    // Default: each call returns empty rows (overridden per-test with mockResolvedValueOnce)
    mockQueryFn.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('createAndActivateForInternalAgent', () => {
    it('should create instruction with all fields populated', async () => {
      const input = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        systemPrompt: 'You are a helpful assistant',
        userInstructions: 'Process daily reports',
        hitlLevel: 2,
        integrations: [{ id: 'slack', selectedObjects: ['#general'] }],
        triggerConfig: { type: 'cron' as const, cronExpr: '0 9 * * *' },
      };

      // Mock sequence: (1) deactivate UPDATE, (2) version SELECT, (3) INSERT RETURNING id
      mockQueryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // deactivate existing
        .mockResolvedValueOnce({ rows: [{ next_version: 1 }], rowCount: 1 })  // version select
        .mockResolvedValueOnce({ rows: [{ id: 'test-instruction-id' }], rowCount: 1 });  // insert RETURNING id

      const instructionId = await service.createAndActivateForInternalAgent(input);

      expect(instructionId).toBeDefined();
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO compiled_instructions'),
        expect.arrayContaining([
          expect.any(String), // id
          input.agentId,
          input.tenantId,
          1, // version
          input.systemPrompt,
          input.userInstructions,
          input.hitlLevel,
          JSON.stringify(input.integrations),
          JSON.stringify(input.triggerConfig),
          'active',
          'internal_agent',
          expect.any(String), // createdAt
          expect.any(String), // activatedAt
        ])
      );
    });

    it('should throw error if tenantId is missing', async () => {
      await expect(
        service.createAndActivateForInternalAgent({
          tenantId: '',
          agentId: 'agent-456',
        })
      ).rejects.toThrow('tenantId and agentId are required');
    });

    it('should throw error if agentId is missing', async () => {
      await expect(
        service.createAndActivateForInternalAgent({
          tenantId: 'tenant-123',
          agentId: '',
        })
      ).rejects.toThrow('tenantId and agentId are required');
    });

    it('should use default hitlLevel of 3 when not provided', async () => {
      const input = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
      };

      // Mock sequence: (1) deactivate UPDATE, (2) version SELECT, (3) INSERT RETURNING id
      mockQueryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ next_version: 1 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'test-instruction-id' }], rowCount: 1 });

      await service.createAndActivateForInternalAgent(input);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          expect.any(String), // id
          input.agentId,
          input.tenantId,
          1, // version
          '', // systemPrompt default
          '', // userInstructions default
          3, // default hitlLevel
          '[]', // empty integrations
          null, // no triggerConfig
          'active',
          'internal_agent',
          expect.any(String),
          expect.any(String),
        ])
      );
    });

    it('should handle null triggerConfig', async () => {
      const input = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        triggerConfig: undefined,
      };

      // Mock sequence: (1) deactivate UPDATE, (2) version SELECT, (3) INSERT RETURNING id
      mockQueryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ next_version: 1 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'test-instruction-id' }], rowCount: 1 });

      await service.createAndActivateForInternalAgent(input);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          null, // triggerConfig should be null
        ])
      );
    });

    it('should set source to internal_agent', async () => {
      const input = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
      };

      // Mock sequence: (1) deactivate UPDATE, (2) version SELECT, (3) INSERT RETURNING id
      mockQueryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ next_version: 1 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'test-instruction-id' }], rowCount: 1 });

      await service.createAndActivateForInternalAgent(input);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['internal_agent'])
      );
    });

    // Per-binding integration config (gmailQuery, outlookFilter, sendAs) is the
    // payload the platform-backend distillation merges onto each integration
    // before publishing tenant.internal_agent.created/updated. The runtime must
    // preserve that .config field on the compiled_instructions.integrations
    // JSONB so the binding-resolver and tool-gateway can apply it at execute
    // time. This test fixes the contract: integrations are forwarded JSON-
    // verbatim, never type-narrowed away.
    it('preserves per-binding integration config (gmailQuery + sendAs) on the compiled_instructions INSERT', async () => {
      const input = {
        tenantId: 'tenant-123',
        agentId: 'agent-456',
        integrations: [
          {
            id: 'gmail-binding-1',
            type: 'google_mail',
            selectedObjects: [],
            config: { gmailQuery: 'label:support-agent', sendAs: 'help@x.com' },
          },
          {
            id: 'outlook-binding-1',
            type: 'microsoft_outlook_mail',
            selectedObjects: [],
            config: { outlookFilter: "categories/any(c:c eq 'Support')" },
          },
        ],
      };

      mockQueryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ next_version: 1 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'test-instruction-id' }], rowCount: 1 });

      await service.createAndActivateForInternalAgent(input);

      // The INSERT call's integrations bind (positional 9) is
      // JSON.stringify(integrations). Round-trip and assert config fields are
      // present on both bindings.
      const insertCall = mockQueryFn.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO compiled_instructions'),
      );
      expect(insertCall).toBeDefined();
      const params = insertCall![1] as unknown[];
      const integrationsJson = params[8] as string; // positional bind for `integrations`
      const persistedIntegrations = JSON.parse(integrationsJson) as Array<{
        id: string;
        type?: string;
        config?: Record<string, unknown>;
      }>;
      expect(persistedIntegrations).toHaveLength(2);
      const gmailPersisted = persistedIntegrations.find((i) => i.type === 'google_mail');
      const outlookPersisted = persistedIntegrations.find((i) => i.type === 'microsoft_outlook_mail');
      expect(gmailPersisted?.config).toEqual({ gmailQuery: 'label:support-agent', sendAs: 'help@x.com' });
      expect(outlookPersisted?.config).toEqual({ outlookFilter: "categories/any(c:c eq 'Support')" });
    });
  });

  describe('updateAgentSkillsOnly — event_processing_ledger INSERT shape', () => {
    // Regression for "inconsistent types deduced for parameter $1" — the
    // recordEventLedger INSERT reused `$1` for both tenant_id (UUID column)
    // and entity_id (VARCHAR column), so PostgreSQL's prepared-statement
    // parser failed every skills_updated handler invocation and Pub/Sub
    // redelivered indefinitely. The repair: explicit ::uuid
    // cast on the tenant_id position, distinct $3 for entity_id, and
    // entity_id set to the agent_id (not duplicated tenant_id).

    it('records ledger with explicit ::uuid cast + distinct entity_id = agent_id', async () => {
      const input = {
        tenantId: '00000000-0000-0000-0000-00000000000a',
        agentId:  '00000000-0000-0000-0000-00000000000b',
        idempotencyKey: 'evt-xyz',
        skills: [],
      };

      // Query sequence for updateAgentSkillsOnly with idempotency:
      //   1. checkEventLedger SELECT → not found
      //   2. compiled_instructions SELECT → return active row
      //   3. UPDATE agent_skills SET status='superseded'
      //   4. recordEventLedger INSERT (the one we're pinning)
      mockQueryFn
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                  // checkEventLedger
        .mockResolvedValueOnce({ rows: [{ id: 'ci-1' }], rowCount: 1 })                    // compiled_instructions SELECT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                  // UPDATE agent_skills
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });                                 // recordEventLedger INSERT

      await service.updateAgentSkillsOnly(input);

      const ledgerCall = mockQueryFn.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO event_processing_ledger'),
      );
      expect(ledgerCall).toBeDefined();
      const sql = ledgerCall![0] as string;
      const params = ledgerCall![1] as unknown[];

      // Pin the cast — without ::uuid PG falls back to type deduction and
      // re-fails the moment a future edit reintroduces parameter aliasing.
      expect(sql).toMatch(/\$1::uuid/);

      // tenant_id, event_id, entity_id are three distinct placeholders (not
      // the original `$1, $2, ..., $1` aliasing that triggered the
      // "inconsistent types deduced for parameter $1" production error).
      expect(sql).toMatch(/VALUES\s*\(\s*\$1::uuid\s*,\s*\$2\s*,\s*'skills_updated'\s*,\s*'agent'\s*,\s*\$3\s*,\s*0\s*,\s*'completed'\s*\)/);

      // entity_id is the agent_id, not a duplicate of tenant_id.
      expect(params).toEqual([input.tenantId, input.idempotencyKey, input.agentId]);
    });
  });
});
