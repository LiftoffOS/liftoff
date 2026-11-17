// Oversight Provider Tests
//
// Point-in-time provider — single SELECT against
// internal_agent_oversight_settings, no time range needed.
// The sensitive_work field can be either a JSON string or an object
// (depending on how the row was inserted), and we transform the
// {category: bool} map into a list of enabled categories.

const mockQuery = jest.fn();
(global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery = mockQuery;

jest.mock('../../../infrastructure/database', () => {
  const __db: any = {
  getPool: () => ({
    query: (...args: unknown[]) =>
      (global as unknown as { __mockQuery: typeof mockQuery }).__mockQuery(...args),
  }),
};
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__db.getPool());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__db.getPool());
  return __db;
});

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { getOversightSettings } from '../../data-providers/oversight-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('getOversightSettings', () => {
  it('returns the settings row with sensitive_work as object', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          autonomy: 'cautious',
          escalation: { rules: ['hitl_for_pii'] },
          sensitive_work: { financial: true, legal: true, hr: false },
          communication: { tone: 'professional' },
        },
      ],
    });

    const result = await getOversightSettings(tenantId);

    expect(result).not.toBeNull();
    expect(result!.autonomyLevel).toBe('cautious');
    // Only `true` categories should appear
    expect(result!.sensitiveWorkCategories.sort()).toEqual(['financial', 'legal']);
    expect(result!.escalationRules).toEqual({
      escalation: { rules: ['hitl_for_pii'] },
      communication: { tone: 'professional' },
    });
  });

  it('parses sensitive_work when stored as a JSON string', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          autonomy: 'balanced',
          escalation: null,
          sensitive_work: '{"financial":true,"hr":true}',
          communication: null,
        },
      ],
    });

    const result = await getOversightSettings(tenantId);

    expect(result!.sensitiveWorkCategories.sort()).toEqual(['financial', 'hr']);
  });

  it('defaults autonomy to "balanced" when null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          autonomy: null,
          escalation: null,
          sensitive_work: {},
          communication: null,
        },
      ],
    });

    const result = await getOversightSettings(tenantId);
    expect(result!.autonomyLevel).toBe('balanced');
  });

  it('returns empty sensitiveWorkCategories when sensitive_work is empty', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          autonomy: 'balanced',
          escalation: null,
          sensitive_work: {},
          communication: null,
        },
      ],
    });

    const result = await getOversightSettings(tenantId);
    expect(result!.sensitiveWorkCategories).toEqual([]);
  });

  it('returns null when no oversight settings row exists for the tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getOversightSettings(tenantId);
    expect(result).toBeNull();
  });

  it('returns null when the query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    const result = await getOversightSettings(tenantId);
    expect(result).toBeNull();
  });

  it('passes tenantId for tenant isolation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getOversightSettings(tenantId);
    expect(mockQuery.mock.calls[0][1]).toEqual([tenantId]);
    expect(mockQuery.mock.calls[0][0]).toContain('WHERE tenant_id = $1');
  });
});
