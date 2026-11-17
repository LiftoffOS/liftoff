// Governance Behavioral Invariant Suite — Level 1 (deterministic, code-graded, CI-blocking).
//
// Properties that must hold unconditionally under the governance policy:
//   - Level 1 gates ALL tool calls without exception
//   - Super-destructive ops gate at ALL 5 levels
//   - Empty tool call list never gates at any level
//   - Level 5 allows non-super-destructive tools
//   - Level 2 gates ⚠️ DESTRUCTIVE tools; allows non-destructive
//   - escalation=exceptions disables sensitive-work gating at level 3
//
// Failure mode invariants (DB unreachable):
//   - resolveHitlLevel() returns 1 (fail-closed), never propagates error
//   - Level 1 response gates all tool calls with reason 'level_1_gate'
//   - Level returned is never >= 3 under DB failure

import { hitlEnforcementService } from '../hitl-enforcement/service.js';
import type { OversightSettings, ToolCallRequest, ModelTool } from '../hitl-enforcement/types.js';

// Mock audit logging so checkHitlGate audit calls don't reach the DB mock.
// This lets DB-unreachable tests verify the gate decision itself, not audit path.
jest.mock('../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

// The global setup.ts mock returns { rows: [], rowCount: 0 } by default.
// Override here so rate-limit queries (SELECT COUNT from hitl_rate_limit_events) return
// 0 ops, preventing Level 4/5 from gating on rate limit during invariant checks.
// All other queries resolve silently.
const { pool: mockPool } = jest.requireMock('../infrastructure/database') as {
  pool: { query: jest.Mock };
};

beforeEach(() => {
  mockPool.query.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('hitl_rate_limit_events')) {
      return Promise.resolve({ rows: [{ count: '0' }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
});

const SUPER_DESTRUCTIVE = [
  'delete_tenant',
  'bulk_delete_users',
  'export_all_data',
  'modify_billing',
  'delete_all_memories',
  'revoke_all_api_keys',
] as const;

const ALL_LEVELS = [1, 2, 3, 4, 5] as const;

const NEUTRAL_OVERSIGHT: OversightSettings = {
  tenantId: 'inv-test-tenant',
  autonomy: 'balanced',
  escalation: 'important',
  sensitiveWork: {
    customerCommunication: false,
    financialActions: false,
    dataChanges: false,
    externalPublishing: false,
    hiringDecisions: false,
  },
  communication: 'review',
};

const makeCall = (name: string): ToolCallRequest => ({ id: 'tc-1', name, input: {} });
const makeTool = (name: string, extra: Partial<ModelTool> = {}): ModelTool => ({
  name,
  description: name,
  ...extra,
});
const randomName = (): string => `tool_${Math.random().toString(36).slice(2, 10)}`;

describe('Behavioral Invariants', () => {
  // ── Level 1 gates everything ─────────────────────────────────────────────
  describe('Level 1 gates ALL tool calls', () => {
    const names = Array.from({ length: 500 }, randomName);

    test.each(names)('level 1 gates %s', async (name) => {
      const r = await hitlEnforcementService.checkHitlGate(
        [makeCall(name)],
        NEUTRAL_OVERSIGHT,
        1,
        [makeTool(name)],
        'inv-test-tenant',
      );
      expect(r.shouldGate).toBe(true);
    });

    it('level 1 gates even with escalation=exceptions', async () => {
      const o = { ...NEUTRAL_OVERSIGHT, escalation: 'exceptions' as const };
      const r = await hitlEnforcementService.checkHitlGate(
        [makeCall('read_file')],
        o,
        1,
        [makeTool('read_file')],
        'inv-test-tenant',
      );
      expect(r.shouldGate).toBe(true);
    });
  });

  // ── Super-destructive gates at all levels ────────────────────────────────
  describe('Super-destructive ops gate at every level', () => {
    const cases = SUPER_DESTRUCTIVE.flatMap((op) =>
      ALL_LEVELS.map((level) => ({ op, level })),
    );

    test.each(cases)('$op gates at level $level', async ({ op, level }) => {
      const r = await hitlEnforcementService.checkHitlGate(
        [makeCall(op)],
        NEUTRAL_OVERSIGHT,
        level,
        [makeTool(op)],
        'inv-test-tenant',
        { dryRun: true }, // dryRun: no audit log at level 4/5
      );
      expect(r.shouldGate).toBe(true);
      expect(r.reason).toBe('super_destructive_gate');
    });
  });

  // ── Empty list never gates ───────────────────────────────────────────────
  it('empty tool call list never gates at any level', async () => {
    for (const level of ALL_LEVELS) {
      const r = await hitlEnforcementService.checkHitlGate(
        [],
        NEUTRAL_OVERSIGHT,
        level,
        [],
        'inv-test-tenant',
        { dryRun: true },
      );
      expect(r.shouldGate).toBe(false);
    }
  });

  // ── Level 5 allows ordinary tools ───────────────────────────────────────
  it('level 5 allows non-super-destructive tool calls', async () => {
    const r = await hitlEnforcementService.checkHitlGate(
      [makeCall('read_file')],
      NEUTRAL_OVERSIGHT,
      5,
      [makeTool('read_file')],
      'inv-test-tenant',
      { dryRun: true },
    );
    expect(r.shouldGate).toBe(false);
  });

  // ── Level 2 destructive marker ───────────────────────────────────────────
  it('level 2 gates ⚠️ DESTRUCTIVE tools', async () => {
    const r = await hitlEnforcementService.checkHitlGate(
      [makeCall('delete_file')],
      NEUTRAL_OVERSIGHT,
      2,
      [makeTool('delete_file', { description: '⚠️ DESTRUCTIVE: removes file permanently' })],
      'inv-test-tenant',
    );
    expect(r.shouldGate).toBe(true);
  });

  it('level 2 allows non-destructive tools', async () => {
    const r = await hitlEnforcementService.checkHitlGate(
      [makeCall('read_file')],
      NEUTRAL_OVERSIGHT,
      2,
      [makeTool('read_file', { description: 'Read a file safely' })],
      'inv-test-tenant',
    );
    expect(r.shouldGate).toBe(false);
  });

  // ── escalation=exceptions disables sensitive-work gating ─────────────────
  it('escalation=exceptions disables sensitive-work gating at level 3', async () => {
    const o = {
      ...NEUTRAL_OVERSIGHT,
      escalation: 'exceptions' as const,
      sensitiveWork: { ...NEUTRAL_OVERSIGHT.sensitiveWork, financialActions: true },
    };
    const r = await hitlEnforcementService.checkHitlGate(
      [makeCall('process_payment')],
      o,
      3,
      [makeTool('process_payment', { categories: ['financialActions'] })],
      'inv-test-tenant',
    );
    expect(r.shouldGate).toBe(false);
  });
});

// ── Failure mode invariants ──────────────────────────────────────────────────
// These tests verify that governance fails CLOSED when the DB is unreachable.
// The fix in resolveHitlLevel() makes this explicit rather than relying on the
// indirect "Preflight 500 → no token → Authorize blocks" path.

describe('Failure mode: DB unreachable', () => {
  beforeEach(() => {
    mockPool.query.mockRejectedValue(
      Object.assign(new Error('DB unreachable'), { code: 'ECONNREFUSED' }),
    );
  });

  it('resolveHitlLevel() returns 1 (fail-closed) when DB is unreachable', async () => {
    const level = await hitlEnforcementService.resolveHitlLevel('any-tenant');
    expect(level).toBe(1);
  });

  it('a level-1 response from resolveHitlLevel gates all tool calls', async () => {
    const level = await hitlEnforcementService.resolveHitlLevel('any-tenant');
    const r = await hitlEnforcementService.checkHitlGate(
      [makeCall('read_file')],
      undefined,
      level,
      [makeTool('read_file')],
      'any-tenant',
    );
    expect(r.shouldGate).toBe(true);
    expect(r.reason).toBe('level_1_gate');
  });

  it('DB failure never silently defaults to a permissive level (3, 4, or 5)', async () => {
    const level = await hitlEnforcementService.resolveHitlLevel('any-tenant');
    expect(level).toBeLessThanOrEqual(2);
  });
});
