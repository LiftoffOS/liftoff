// Escalation dedupe keyed on WHAT failed and on WHICH graph version.
//
// createEscalation collapses a repeat escalation into the newest open row for
// (tenant, agent, kind), bumping occurrence_count and overwriting reason. Two
// different defects on one agent therefore folded into one row whose text was
// whichever came last, and a redistill that repaired one of them kept the row
// growing for the other. The fingerprint and instruction version narrow the
// merge to "the same failure on the same graph"; a caller that supplies
// neither merges exactly as before, among the rows that supply neither.
//
// The pool is a small in-memory table that interprets the helper's own
// statements, so what is asserted is rows and counts rather than SQL text.

const mockInsertAuditLog = jest.fn();
const mockLoggerInfo = jest.fn();

interface Row {
  id: string;
  tenant_id: string;
  agent_id: string;
  kind: string;
  status: string;
  reason: string;
  occurrence_count: number;
  reason_fingerprint: string | null;
  instruction_version: number | null;
  created_at: number;
  last_occurred_at: number | null;
}
const table: Row[] = [];
let clock = 0;

function fakeQuery(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
  const text = sql.replace(/\s+/g, ' ');
  if (text.startsWith('UPDATE workflow_escalations')) {
    const [tenant, agent, kind, reason, fingerprint, version] = params as
      [string, string, string, string, string | null, number | null];
    // IS NOT DISTINCT FROM: NULL matches NULL and nothing else.
    const same = (a: unknown, b: unknown) => (a === null || a === undefined) ? (b === null || b === undefined) : a === b;
    const candidates = table
      .filter((r) => r.tenant_id === tenant && r.agent_id === agent && r.kind === kind && r.status === 'pending'
        && same(r.reason_fingerprint, fingerprint) && same(r.instruction_version, version))
      .sort((a, b) => b.created_at - a.created_at);
    const hit = candidates[0];
    if (!hit) return Promise.resolve({ rows: [] });
    hit.occurrence_count += 1;
    hit.reason = reason;
    hit.last_occurred_at = ++clock;
    return Promise.resolve({ rows: [{ id: hit.id, occurrence_count: hit.occurrence_count }] });
  }
  if (text.startsWith('INSERT INTO workflow_escalations')) {
    const [id, , , agent, tenant, reason, kind, fingerprint, version] = params as
      [string, string, string, string, string, string, string, string | null, number | null];
    // The statement stamps last_occurred_at with the same NOW() as created_at;
    // a fake that left it NULL would hide the regression this guards.
    const stampsLastOccurred = /last_occurred_at/.test(text) && /NOW\(\), NOW\(\)/.test(text);
    const now = ++clock;
    table.push({
      id, tenant_id: tenant, agent_id: agent, kind, status: 'pending', reason, occurrence_count: 1,
      reason_fingerprint: fingerprint, instruction_version: version, created_at: now,
      last_occurred_at: stampsLastOccurred ? now : null,
    });
    return Promise.resolve({ rows: [] });
  }
  return Promise.resolve({ rows: [] });
}

jest.mock('../../../infrastructure/database', () => {
  const fakePool = { query: (sql: string, params?: unknown[]) => fakeQuery(sql, params) };
  return {
    getPool: jest.fn(() => fakePool),
    getPoolForService: jest.fn(() => fakePool),
    pool: fakePool,
  };
});
jest.mock('../../../audit/service', () => ({
  insertAuditLog: (...args: unknown[]) => { mockInsertAuditLog(...args); return Promise.resolve(); },
}));
jest.mock('../../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn() },
}));
jest.mock('../../evidence-totals', () => ({ recordEscalationRaised: jest.fn() }));
jest.mock('../../../infrastructure/logging', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

import { createEscalation } from '../escalation-helper';
import type { ExecutionContext } from '../../types';

const ctx = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-0000000000aa',
  invocationId: '00000000-0000-0000-0000-0000000000bb',
  workflowId: '00000000-0000-0000-0000-0000000000cc',
  taskId: '00000000-0000-0000-0000-0000000000dd',
  threadId: null,
} as unknown as ExecutionContext;

const INTERNAL = { kind: 'system_internal' as const };

function recurrenceMetrics(): Array<Record<string, unknown>> {
  return mockLoggerInfo.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((o) => o?.metric === 'hybrid_loop.escalation_recurrence');
}

beforeEach(() => {
  jest.clearAllMocks();
  table.length = 0;
  clock = 0;
});

describe('createEscalation — dedupe by fingerprint and graph version', () => {
  it('two fingerprints → two rows', async () => {
    const a = await createEscalation(ctx, 'step s3 unsatisfied', { ...INTERNAL, fingerprint: 'unsatisfied_output:s3', instructionVersion: 7 });
    const b = await createEscalation(ctx, 'condition at s4', { ...INTERNAL, fingerprint: 'condition_dead_end:s4', instructionVersion: 7 });
    expect(a).not.toBe(b);
    expect(table).toHaveLength(2);
    expect(table.map((r) => r.occurrence_count)).toEqual([1, 1]);
    expect(table.map((r) => r.reason)).toEqual(['step s3 unsatisfied', 'condition at s4']);
  });

  it('same fingerprint and version → one row, count 2, the newer reason', async () => {
    const a = await createEscalation(ctx, 'first wording', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 7 });
    const b = await createEscalation(ctx, 'second wording', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 7 });
    expect(b).toBe(a);
    expect(table).toHaveLength(1);
    expect(table[0].occurrence_count).toBe(2);
    expect(table[0].reason).toBe('second wording');
  });

  it('same fingerprint, new version → a second row: a repaired graph starts fresh', async () => {
    const a = await createEscalation(ctx, 'on v7', { ...INTERNAL, fingerprint: 'unsatisfied_output:s3', instructionVersion: 7 });
    const b = await createEscalation(ctx, 'on v8', { ...INTERNAL, fingerprint: 'unsatisfied_output:s3', instructionVersion: 8 });
    expect(b).not.toBe(a);
    expect(table).toHaveLength(2);
    expect(table.map((r) => r.instruction_version)).toEqual([7, 8]);
    expect(table.map((r) => r.occurrence_count)).toEqual([1, 1]);
  });

  it('no fingerprint → today\'s merge, among the rows that carry none', async () => {
    const a = await createEscalation(ctx, 'the customer must decide', { kind: 'escalation' });
    const b = await createEscalation(ctx, 'still must decide', { kind: 'escalation' });
    expect(b).toBe(a);
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ occurrence_count: 2, reason: 'still must decide', reason_fingerprint: null, instruction_version: null });
  });

  it('a fingerprinted row and an unfingerprinted one of the same kind never merge', async () => {
    const a = await createEscalation(ctx, 'plain', INTERNAL);
    const b = await createEscalation(ctx, 'keyed', { ...INTERNAL, fingerprint: 'recovery_cap:s1', instructionVersion: 2 });
    expect(b).not.toBe(a);
    expect(table).toHaveLength(2);
  });

  it('two clarification-expiry escalations dedupe', async () => {
    // The expiry handler names no version on purpose: its minimal context
    // carries 0, which is not a real version.
    const a = await createEscalation(ctx, 'Clarification request expired without answer (24h)', { ...INTERNAL, fingerprint: 'expiry:clarification' });
    const b = await createEscalation(ctx, 'Clarification request expired without answer (24h)', { ...INTERNAL, fingerprint: 'expiry:clarification' });
    expect(b).toBe(a);
    expect(table).toHaveLength(1);
    expect(table[0].occurrence_count).toBe(2);
    expect(table[0].instruction_version).toBeNull();
  });

  it('an expiry and an unsatisfied_output do not', async () => {
    const a = await createEscalation(ctx, 'expired', { ...INTERNAL, fingerprint: 'expiry:clarification' });
    const b = await createEscalation(ctx, 'unsatisfied', { ...INTERNAL, fingerprint: 'unsatisfied_output:s3', instructionVersion: 7 });
    expect(b).not.toBe(a);
    expect(table).toHaveLength(2);
  });

  it('writes both columns on the insert', async () => {
    await createEscalation(ctx, 'x', { ...INTERNAL, fingerprint: 'permanent:auth_expired:s2', instructionVersion: 3 });
    expect(table[0]).toMatchObject({ reason_fingerprint: 'permanent:auth_expired:s2', instruction_version: 3 });
  });

  it('stamps last_occurred_at on the insert, equal to created_at, and moves it on every bump', async () => {
    // A fresh row used to carry NULL until its second occurrence, so a query
    // ordered on last_occurred_at missed exactly the rows that had just
    // appeared.
    await createEscalation(ctx, 'first', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 1 });
    expect(table[0].last_occurred_at).not.toBeNull();
    expect(table[0].last_occurred_at).toBe(table[0].created_at);
    const before = table[0].last_occurred_at;
    await createEscalation(ctx, 'second', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 1 });
    expect(table[0].last_occurred_at).toBeGreaterThan(before as number);
  });
});

describe('createEscalation — the recurrence metric', () => {
  it('emits hybrid_loop.escalation_recurrence on every dedupe bump, keyed by the fingerprint class', async () => {
    await createEscalation(ctx, 'a', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 1 });
    expect(recurrenceMetrics()).toEqual([]);
    await createEscalation(ctx, 'b', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 1 });
    await createEscalation(ctx, 'c', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 1 });
    expect(recurrenceMetrics()).toEqual([
      expect.objectContaining({ fingerprint_prefix: 'recovery_cap', occurrence_count: '2' }),
      expect.objectContaining({ fingerprint_prefix: 'recovery_cap', occurrence_count: '3' }),
    ]);
  });

  it('labels a bump on an unfingerprinted row as "none"', async () => {
    await createEscalation(ctx, 'a', { kind: 'escalation' });
    await createEscalation(ctx, 'b', { kind: 'escalation' });
    expect(recurrenceMetrics()).toEqual([
      expect.objectContaining({ fingerprint_prefix: 'none', occurrence_count: '2' }),
    ]);
  });

  it('still audits every occurrence, deduped or not', async () => {
    await createEscalation(ctx, 'a', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 1 });
    await createEscalation(ctx, 'b', { ...INTERNAL, fingerprint: 'recovery_cap:s9', instructionVersion: 1 });
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
  });
});
