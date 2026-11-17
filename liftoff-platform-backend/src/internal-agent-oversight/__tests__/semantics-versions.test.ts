// The transition rule (migration 508): each semantics column moves to 2 ONLY
// on a save whose input names its own setting; a new workspace starts at 2
// for both; an absent or unparseable value reads as 1.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../events/publisher', () => ({ publishEvent: jest.fn().mockResolvedValue(undefined) }));

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => mockQuery(...a) },
  withTenantScope: async (_t: string, fn: (c: { query: typeof mockQuery }) => Promise<unknown>) => fn({ query: mockQuery }),
}));

import { OversightService } from '../service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NEW_TENANT = '22222222-2222-4222-8222-222222222222';
const OLD_TENANT = '33333333-3333-4333-8333-333333333333';
const PAYLOAD_TENANT = '44444444-4444-4444-8444-444444444444';

function row(over: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT, current_version: 3, autonomy: 'balanced', escalation: 'important',
    sensitive_work: { customerCommunication: true }, communication: 'review',
    escalation_semantics: 1, communication_semantics: 1,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', ...over,
  };
}

/** The UPDATE's params: [tenantId, newVersion, autonomy, escalation, sensitive_work, communication, escalation_semantics, communication_semantics]. */
function updateParams(): unknown[] {
  const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE internal_agent_oversight_settings SET'));
  return call![1] as unknown[];
}

describe('oversight semantics versions', () => {
  let service: OversightService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new OversightService();
    // getOversightSettings SELECT, then UPDATE ... RETURNING, then the versions INSERT.
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT * FROM internal_agent_oversight_settings WHERE')) return { rows: [row()] };
      if (sql.includes('UPDATE internal_agent_oversight_settings SET')) {
        return { rows: [row({ escalation: params[3], communication: params[5], escalation_semantics: params[6], communication_semantics: params[7] })] };
      }
      return { rows: [] };
    });
  });

  it('an autonomy-only save leaves both at 1', async () => {
    const s = await service.updateOversightSettings(TENANT, { autonomy: 'supervised' });
    expect(updateParams().slice(6)).toEqual([1, 1]);
    expect(s.escalationSemantics).toBe(1);
    expect(s.communicationSemantics).toBe(1);
  });

  it('a sensitive-work-only save leaves both at 1', async () => {
    await service.updateOversightSettings(TENANT, { sensitiveWork: { financialActions: false } });
    expect(updateParams().slice(6)).toEqual([1, 1]);
  });

  it('a save naming escalation moves only escalation_semantics', async () => {
    await service.updateOversightSettings(TENANT, { escalation: 'exceptions' });
    expect(updateParams().slice(6)).toEqual([2, 1]);
  });

  it('a save naming communication moves only communication_semantics', async () => {
    await service.updateOversightSettings(TENANT, { communication: 'auto' });
    expect(updateParams().slice(6)).toEqual([1, 2]);
  });

  it('a workspace already at 2 stays at 2 on an unrelated save', async () => {
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT * FROM internal_agent_oversight_settings WHERE')) return { rows: [row({ escalation_semantics: 2 })] };
      if (sql.includes('UPDATE')) return { rows: [row({ escalation_semantics: params[6], communication_semantics: params[7] })] };
      return { rows: [] };
    });
    await service.updateOversightSettings(TENANT, { autonomy: 'supervised' });
    expect(updateParams().slice(6)).toEqual([2, 1]);
  });

  it('the versions table carries both columns', async () => {
    await service.updateOversightSettings(TENANT, { escalation: 'exceptions' });
    const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO internal_agent_oversight_settings_versions'));
    expect(String(insert![0])).toContain('escalation_semantics, communication_semantics');
    expect((insert![1] as unknown[]).slice(8)).toEqual([2, 1]);
  });

  it('a new workspace starts at 2 for both', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM internal_agent_oversight_settings WHERE')) return { rows: [] };
      if (sql.includes('INSERT INTO internal_agent_oversight_settings ') || sql.includes('INSERT INTO internal_agent_oversight_settings\n')) {
        expect(sql).toContain("VALUES ($1, 1, 'balanced', 'important', $2, 'review', 2, 2)");
        return { rows: [row({ tenant_id: NEW_TENANT, escalation_semantics: 2, communication_semantics: 2 })] };
      }
      return { rows: [] };
    });
    const s = await service.getOrCreateOversightSettings(NEW_TENANT);
    expect(s.escalationSemantics).toBe(2);
    expect(s.communicationSemantics).toBe(2);
  });

  it('an absent or unparseable value reads as 1', async () => {
    // The service caches per tenant for five minutes; a fresh tenant id reads the row.
    mockQuery.mockResolvedValueOnce({ rows: [row({ tenant_id: OLD_TENANT, escalation_semantics: undefined, communication_semantics: 'x' })] });
    const s = await service.getOversightSettings(OLD_TENANT);
    expect(s?.escalationSemantics).toBe(1);
    expect(s?.communicationSemantics).toBe(1);
  });

  it('the payload the runtime fetches carries both fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ tenant_id: PAYLOAD_TENANT, escalation_semantics: 2, communication_semantics: 1 })] });
    const s = await service.getOversightSettings(PAYLOAD_TENANT);
    expect(s).toEqual(expect.objectContaining({ escalationSemantics: 2, communicationSemantics: 1 }));
  });
});
