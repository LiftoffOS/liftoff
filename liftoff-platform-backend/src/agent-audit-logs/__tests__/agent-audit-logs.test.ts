// Agent Audit Logs Unit Tests
// TE-002, TE-003, TE-005, TE-006, TE-008, TE-011

import { AgentAuditLogsRepository } from '../repository';
import { AgentAuditLogsService } from '../service';
import { InsertAgentAuditLogInput, AuditOutcome } from '../types';

// Mock query function - stable reference
const mockQuery = jest.fn();

// Mock external dependencies - use object with stable mockQuery reference.
// withTenantScope / withAdminScope route their client.query to the same
// mockQuery so ordered mockResolvedValueOnce sequences (items then count)
// still line up after the RLS-force wrapping.
jest.mock('../../infrastructure/database', () => {
  const runWith = (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => (global as any).__mockQuery(...args) });
  return {
    pool: {
      query: (...args: unknown[]) => (global as any).__mockQuery(...args),
    },
    withTenantScope: (_tenantId: string, cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) => runWith(cb),
    withAdminScope: (_opts: unknown, cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) => runWith(cb),
  };
});

// Store mock on global to avoid hoisting issues
beforeAll(() => {
  (global as any).__mockQuery = mockQuery;
});

jest.mock('../../infrastructure/logging');

// Helper to create mock audit log input
function createMockInput(overrides: Partial<InsertAgentAuditLogInput> = {}): InsertAgentAuditLogInput {
  return {
    tenantId: '123e4567-e89b-12d3-a456-426614174000',
    action: 'gmail_send_email',
    inputArgs: { to: 'user@example.com', subject: 'Hello' },
    outcome: 'success' as AuditOutcome,
    triggeredBy: 'agent',
    ...overrides,
  };
}

// Helper to create mock DB row
function createMockRow(overrides: any = {}) {
  return {
    id: '123e4567-e89b-12d3-a456-426614174001',
    tenant_id: '123e4567-e89b-12d3-a456-426614174000',
    internal_agent_id: null,
    user_id: null,
    thread_id: null,
    invocation_id: null,
    action: 'gmail_send_email',
    input_args: { to: 'user@example.com', subject: 'Hello' },
    output_summary: null,
    outcome: 'success',
    error_code: null,
    triggered_by: 'agent',
    duration_ms: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe('AgentAuditLogsRepository', () => {
  let repository: AgentAuditLogsRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new AgentAuditLogsRepository();
  });

  // TE-002: Sanitization tests for nested objects
  describe('sanitizeArgs', () => {
    it('redacts top-level sensitive fields', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({ input_args: { password: '[REDACTED]' } })],
      });

      const input = createMockInput({
        inputArgs: { password: 'secret123', username: 'john' },
      });

      await repository.insert(input);

      const insertCall = mockQuery.mock.calls[0];
      const argsJson = JSON.parse(insertCall[1][9]);
      expect(argsJson.password).toBe('[REDACTED]');
      expect(argsJson.username).toBe('john');
    });

    it('redacts nested object sensitive fields', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow()],
      });

      const input = createMockInput({
        inputArgs: {
          config: {
            apiKey: 'sk-12345',
            endpoint: 'https://api.example.com',
          },
        },
      });

      await repository.insert(input);

      const insertCall = mockQuery.mock.calls[0];
      const argsJson = JSON.parse(insertCall[1][9]);
      expect(argsJson.config.apiKey).toBe('[REDACTED]');
      expect(argsJson.config.endpoint).toBe('https://api.example.com');
    });

    it('redacts array element sensitive fields', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow()],
      });

      const input = createMockInput({
        inputArgs: {
          users: [
            { name: 'John', token: 'abc123' },
            { name: 'Jane', token: 'def456' },
          ],
        },
      });

      await repository.insert(input);

      const insertCall = mockQuery.mock.calls[0];
      const argsJson = JSON.parse(insertCall[1][9]);
      expect(argsJson.users[0].name).toBe('John');
      expect(argsJson.users[0].token).toBe('[REDACTED]');
      expect(argsJson.users[1].token).toBe('[REDACTED]');
    });

    it('recurses through deeply nested objects (no depth cap)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow()],
      });

      const input = createMockInput({
        inputArgs: {
          l1: { l2: { l3: { l4: { l5: { l6: 'deep' } } } } },
        },
      });

      await repository.insert(input);

      const insertCall = mockQuery.mock.calls[0];
      const argsJson = JSON.parse(insertCall[1][9]);
      expect(argsJson.l1.l2.l3.l4.l5.l6).toBe('deep');
    });

    // Layer 2 — value-level PII scan (the gap this change closes).
    it('redacts SSN/email in non-sensitive free-text fields', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [createMockRow()] });

      const input = createMockInput({
        inputArgs: {
          notes: 'Employee SSN: 123-45-6789',
          profile: { contact: 'reach alice@example.com' },
        },
      });

      await repository.insert(input);

      const argsJson = JSON.parse(mockQuery.mock.calls[0][1][9]);
      expect(argsJson.notes).toBe('Employee SSN: [REDACTED_SSN]');
      expect(argsJson.profile.contact).toBe('reach [REDACTED_EMAIL]');
    });

    it('handles mixed nesting with arrays and objects', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow()],
      });

      // Use non-sensitive key names for the container fields
      // The sensitive 'password' field inside should still be redacted
      const input = createMockInput({
        inputArgs: {
          items: [
            { config: { password: 'secret', username: 'john' } },
          ],
        },
      });

      await repository.insert(input);

      const insertCall = mockQuery.mock.calls[0];
      const argsJson = JSON.parse(insertCall[1][9]);
      // password should be redacted, username should not
      expect(argsJson.items[0].config.password).toBe('[REDACTED]');
      expect(argsJson.items[0].config.username).toBe('john');
    });

    it('is case-insensitive for sensitive patterns', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow()],
      });

      const input = createMockInput({
        inputArgs: {
          PASSWORD: 'secret1',
          ApiKey: 'secret2',
          ACCESS_TOKEN: 'secret3',
        },
      });

      await repository.insert(input);

      const insertCall = mockQuery.mock.calls[0];
      const argsJson = JSON.parse(insertCall[1][9]);
      expect(argsJson.PASSWORD).toBe('[REDACTED]');
      expect(argsJson.ApiKey).toBe('[REDACTED]');
      expect(argsJson.ACCESS_TOKEN).toBe('[REDACTED]');
    });

    it('redacts common patterns: auth, bearer, jwt, access_token', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow()],
      });

      const input = createMockInput({
        inputArgs: {
          authHeader: 'Bearer xyz',
          jwtToken: 'eyJ...',
          bearerToken: 'abc',
          myauth: 'secret',
        },
      });

      await repository.insert(input);

      const insertCall = mockQuery.mock.calls[0];
      const argsJson = JSON.parse(insertCall[1][9]);
      expect(argsJson.authHeader).toBe('[REDACTED]');
      expect(argsJson.jwtToken).toBe('[REDACTED]');
      expect(argsJson.bearerToken).toBe('[REDACTED]');
      expect(argsJson.myauth).toBe('[REDACTED]');
    });
  });

  // TE-003: Pagination boundary tests
  describe('pagination', () => {
    // list() now issues two queries in parallel via Promise.all:
    // (1) the items SELECT, (2) a COUNT(*) for the total. Each test below
    // mocks both — items first, then count.
    it('caps limit at 1000', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

      await repository.list('tenant-123', {}, 5000);

      const queryCall = mockQuery.mock.calls[0];
      // Should request 1001 rows (1000 + 1 for hasMore check)
      expect(queryCall[1][queryCall[1].length - 1]).toBe(1001);
    });

    it('passes a limit under the cap straight through', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

      await repository.list('tenant-123', {}, 500);

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1][queryCall[1].length - 1]).toBe(501);
    });

    it('handles cursor pointing to non-existent id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

      const result = await repository.list(
        'tenant-123',
        {},
        50,
        '00000000-0000-0000-0000-000000000000'
      );

      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
    });

    it('returns hasMore=false on last page', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow(), createMockRow()],
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 2 }] });

      const result = await repository.list('tenant-123', {}, 50);

      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
      expect(result.total).toBe(2);
    });

    it('returns correct cursor for next page', async () => {
      const rows = Array(51).fill(null).map((_, i) =>
        createMockRow({ id: `id-${i}` })
      );
      mockQuery.mockResolvedValueOnce({ rows });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 51 }] });

      const result = await repository.list('tenant-123', {}, 50);

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(50);
      expect(result.cursor).toBe('id-49');
      expect(result.total).toBe(51);
    });
  });

  // Platform-owned agents (CAIO/HRBP, is_system=TRUE) carry tenant_id IS NULL,
  // so the tenant-scoped LEFT JOIN never resolves them and their rows used to
  // render as "Unknown Agent" on the Activity page. The feed shows agents the
  // customer created; these queries must exclude any actor that did not resolve.
  describe('platform-agent exclusion', () => {
    const OWNED = '(aal.internal_agent_id IS NULL OR ia.id IS NOT NULL)';

    it('excludes unresolvable agent rows from the items query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

      await repository.list('tenant-123', {}, 50);

      expect(mockQuery.mock.calls[0][0]).toContain(OWNED);
    });

    it('applies the same predicate to the count so the total cannot over-report', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

      await repository.list('tenant-123', {}, 50);

      const countSql = mockQuery.mock.calls[1][0];
      expect(countSql).toContain(OWNED);
      // The predicate reads ia.id, so the count must join internal_agents even
      // when the free-text search (the join's other consumer) is absent.
      expect(countSql).toContain('LEFT JOIN internal_agents ia');
    });

    it('keeps the predicate on the count when free-text search is active', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

      await repository.list('tenant-123', { q: 'gmail' }, 50);

      expect(mockQuery.mock.calls[1][0]).toContain(OWNED);
    });

    it('excludes them from the single-row fetch behind a deep link', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await repository.findById('tenant-123', 'audit-1');

      expect(mockQuery.mock.calls[0][0]).toContain(OWNED);
      expect(result).toBeNull();
    });

    it('still returns rows whose agent resolves inside the tenant', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({
          internal_agent_id: '123e4567-e89b-12d3-a456-426614174009',
          agent_name: 'Fundraising Campaign Analyst',
        })],
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

      const result = await repository.list('tenant-123', {}, 50);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].agentName).toBe('Fundraising Campaign Analyst');
    });
  });

  // TE-005: Date range filter tests
  describe('date filters', () => {
    it('handles timezone correctly with TIMESTAMPTZ', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

      const startDate = new Date('2024-01-01T00:00:00Z');
      const endDate = new Date('2024-01-31T23:59:59Z');

      await repository.list('tenant-123', { startDate, endDate });

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain(startDate);
      expect(queryCall[1]).toContain(endDate);
    });

    it('handles boundary inclusivity correctly', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

      const startDate = new Date('2024-01-01T00:00:00.000Z');

      await repository.list('tenant-123', { startDate });

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[0]).toContain('created_at >=');
    });
  });

  // TE-008: Error handling tests
  describe('error handling', () => {
    it('returns 400 on invalid UUID format', async () => {
      mockQuery.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));

      await expect(
        repository.findById('tenant-123', 'not-a-uuid')
      ).rejects.toThrow();
    });

    it('throws on FK constraint violation', async () => {
      mockQuery.mockRejectedValueOnce(
        new Error('insert or update on table "agent_audit_logs" violates foreign key constraint')
      );

      await expect(
        repository.insert(createMockInput({ tenantId: 'non-existent-tenant' }))
      ).rejects.toThrow();
    });
  });

  describe('size limits', () => {
    it('throws when input_args exceeds 64KB', async () => {
      // Layer 2 truncates individual strings to 1000 chars, so size must be
      // reached across many fields — an array of 100 sub-cap strings (~100KB
      // serialized) exceeds the 64KB ceiling after sanitization.
      const largeInput = createMockInput({
        inputArgs: { items: Array.from({ length: 100 }, () => 'x'.repeat(1000)) },
      });

      await expect(repository.insert(largeInput)).rejects.toThrow(
        'input_args exceeds maximum size of 65536 bytes'
      );
    });
  });
});

describe('AgentAuditLogsService', () => {
  let service: AgentAuditLogsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentAuditLogsService();
  });

  // TE-006: triggeredBy validation tests (validated at router level, but test service accepts valid formats)
  describe('triggeredBy formats', () => {
    it('accepts valid human:<uuid> format', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({ triggered_by: 'human:123e4567-e89b-12d3-a456-426614174000' })],
      });

      const result = await service.insertAuditLog(createMockInput({
        triggeredBy: 'human:123e4567-e89b-12d3-a456-426614174000',
      }));

      expect(result.triggeredBy).toBe('human:123e4567-e89b-12d3-a456-426614174000');
    });

    it('accepts agent', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({ triggered_by: 'agent' })],
      });

      const result = await service.insertAuditLog(createMockInput({
        triggeredBy: 'agent',
      }));

      expect(result.triggeredBy).toBe('agent');
    });

    it('accepts cron', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({ triggered_by: 'cron' })],
      });

      const result = await service.insertAuditLog(createMockInput({
        triggeredBy: 'cron',
      }));

      expect(result.triggeredBy).toBe('cron');
    });

    it('accepts event:<topic> format', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({ triggered_by: 'event:user_signup' })],
      });

      const result = await service.insertAuditLog(createMockInput({
        triggeredBy: 'event:user_signup',
      }));

      expect(result.triggeredBy).toBe('event:user_signup');
    });
  });

  // TE-011: durationMs edge cases
  describe('durationMs validation', () => {
    it('accepts zero', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({ duration_ms: 0 })],
      });

      const result = await service.insertAuditLog(createMockInput({
        durationMs: 0,
      }));

      expect(result.durationMs).toBe(0);
    });

    it('accepts positive integers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({ duration_ms: 1500 })],
      });

      const result = await service.insertAuditLog(createMockInput({
        durationMs: 1500,
      }));

      expect(result.durationMs).toBe(1500);
    });

    it('accepts null/undefined (optional)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [createMockRow({ duration_ms: null })],
      });

      const result = await service.insertAuditLog(createMockInput({
        durationMs: undefined,
      }));

      expect(result.durationMs).toBeNull();
    });
  });
});

describe('Output sanitization', () => {
  let repository: AgentAuditLogsRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new AgentAuditLogsRepository();
  });

  it('redacts Bearer tokens in output via redactPii', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [createMockRow()] });

    await repository.insert(createMockInput({
      outputSummary: 'Response: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    }));

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1][10]).toBe('Response: Bearer [REDACTED_TOKEN]');
  });

  it('redacts SSN/email PII in output via redactPii', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [createMockRow()] });

    await repository.insert(createMockInput({
      outputSummary: 'Updated SSN 123-45-6789 and emailed alice@example.com',
    }));

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1][10]).toBe('Updated SSN [REDACTED_SSN] and emailed [REDACTED_EMAIL]');
  });

  it('truncates output to 4096 characters', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [createMockRow()],
    });

    const longOutput = 'x'.repeat(5000);
    await repository.insert(createMockInput({
      outputSummary: longOutput,
    }));

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1][10].length).toBe(4096);
  });
});

// Snapshots and externalResponse carry full external HRIS/payroll records.
// Before this change they were JSON.stringify'd raw; now they go through the
// same two-layer sanitizer as input_args. Param order (see INSERT in
// repository.ts): pre_action_snapshot=16, post_action_snapshot=17,
// external_response=18.
describe('Snapshot / externalResponse PII redaction', () => {
  let repository: AgentAuditLogsRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new AgentAuditLogsRepository();
  });

  it('redacts PII in preActionSnapshot', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [createMockRow()] });

    await repository.insert(createMockInput({
      preActionSnapshot: { ssn: '123-45-6789', email: 'alice@x.com', name: 'Alice' },
    }));

    const stored = JSON.parse(mockQuery.mock.calls[0][1][16]);
    expect(stored.ssn).toBe('[REDACTED_SSN]');
    expect(stored.email).toBe('[REDACTED_EMAIL]');
    expect(stored.name).toBe('Alice'); // names not caught — acknowledged
  });

  it('redacts PII in postActionSnapshot and externalResponse', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [createMockRow()] });

    await repository.insert(createMockInput({
      postActionSnapshot: { ssn: '123-45-6789' },
      externalResponse: { ssn: '987-65-4321', notes: 'call 415-555-0123' },
    }));

    const params = mockQuery.mock.calls[0][1];
    expect(JSON.parse(params[17]).ssn).toBe('[REDACTED_SSN]');
    const ext = JSON.parse(params[18]);
    expect(ext.ssn).toBe('[REDACTED_SSN]');
    expect(ext.notes).toBe('call [REDACTED_PHONE]');
  });

  it('leaves snapshot fields null when undefined', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [createMockRow()] });

    await repository.insert(createMockInput({}));

    const params = mockQuery.mock.calls[0][1];
    expect(params[16]).toBeNull();
    expect(params[17]).toBeNull();
    expect(params[18]).toBeNull();
  });
});
