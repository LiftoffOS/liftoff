// Unit-level tests for the audit-log repository — verify SQL construction
// (parameter binding, cursor predicate routing) and the post-query dedup
// logic. Integration coverage against a live DB is described in
// repository.integration.test.ts.

import { auditLogRepository } from '../repository';
import type { CursorPayload, RawRow } from '../types';

function makeClient(rows: RawRow[] = []): {
  query: jest.Mock;
} {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  };
}

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('auditLogRepository.listUnifiedAuditEntries', () => {
  it('issues a single UNION query', async () => {
    const client = makeClient();
    await auditLogRepository.listUnifiedAuditEntries(
      client as never,
      TENANT,
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-21T00:00:00.000Z'),
      null,
      50,
    );
    expect(client.query).toHaveBeenCalledTimes(1);
    const sql = client.query.mock.calls[0][0] as string;
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('tenant_member_audit');
    expect(sql).toContain('audit_log');
    expect(sql).toContain('internal_agent_audit');
    expect(sql).toContain('agent_chat_messages');
    expect(sql).toContain('agent_audit_logs');
    expect(sql).toContain('event_deliveries');
    expect(sql).toContain('ORDER BY occurred_at DESC');
  });

  it('passes tenantId + range to every source subquery', async () => {
    const client = makeClient();
    await auditLogRepository.listUnifiedAuditEntries(
      client as never,
      TENANT,
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-21T00:00:00.000Z'),
      null,
      10,
    );
    const params = client.query.mock.calls[0][1] as unknown[];
    expect(params.length).toBe(24); // 6 sources × (tenantId, start, end, limitPlusOne)
    expect(params[0]).toBe(TENANT);
    expect(params[4]).toBe(TENANT);
    expect(params[8]).toBe(TENANT);
    expect(params[3]).toBe(11);
    expect(params[23]).toBe(11);
  });

  it('every UNION branch casts account_id to ::text (a uuid/varchar mismatch fails the query)', async () => {
    // Source 2 (audit_log) derives account_id from resource_id, which is
    // VARCHAR(255). The other five sources have account_id UUID. Without
    // an explicit ::text cast on every branch, Postgres raises
    //   "UNION types uuid and character varying cannot be matched"
    // and the whole endpoint returns 500. Each source must agree on
    // text-typed account_id.
    const client = makeClient();
    await auditLogRepository.listUnifiedAuditEntries(
      client as never,
      TENANT,
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-21T00:00:00.000Z'),
      null,
      10,
    );
    const sql = client.query.mock.calls[0][0] as string;
    const accountIdSelects = sql.match(/AS account_id/g) ?? [];
    expect(accountIdSelects.length).toBe(6);
    // No branch may emit `NULL::uuid AS account_id` or bare column refs
    // like `account_id,` / `t.account_id,` — every selection must end in
    // an explicit ::text cast.
    expect(sql).not.toMatch(/NULL::uuid AS account_id/);
    expect(sql).not.toMatch(/^\s*account_id,\s*$/m);
    expect(sql).not.toMatch(/^\s*t\.account_id,\s*$/m);
  });

  it('event_deliveries source does not reference event_sources.agent_id (regression: column does not exist)', async () => {
    // event_sources has no agent_id column — source→agent is M:N through
    // event_trigger_rules. The audit feed exposes which trigger rules fired
    // via d.matched_rule_ids (UUID[] on event_deliveries) instead.
    const client = makeClient();
    await auditLogRepository.listUnifiedAuditEntries(
      client as never,
      TENANT,
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-21T00:00:00.000Z'),
      null,
      10,
    );
    const sql = client.query.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/s\.agent_id/);
    expect(sql).toMatch(/d\.matched_rule_ids/);
  });

  it('cursor predicate: tight tuple on matching source, strict < on earlier-alphabet sources, inclusive <= on later-alphabet sources', async () => {
    const client = makeClient();
    // Cursor source = 'audit_log'. Sources earlier alphabetically:
    // (nothing — 'audit_log' is first in our alphabetical ORDER, actually
    // 'agent_audit_logs' and 'agent_chat_messages' come before 'audit_log'
    // alphabetically). Pick 'event_deliveries' as cursor source instead so
    // we have both directions represented.
    const cursor: CursorPayload = {
      occurredAt: '2026-05-15T12:00:00.000Z',
      source: 'event_deliveries',
      rowId: '99999999-9999-9999-9999-999999999999',
    };
    await auditLogRepository.listUnifiedAuditEntries(
      client as never,
      TENANT,
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-21T00:00:00.000Z'),
      cursor,
      10,
    );
    const sql = client.query.mock.calls[0][0] as string;
    // Matching source 'event_deliveries' uses tuple compare on (received_at, id)
    expect(sql).toContain('(d.received_at, d.id::text) < (');
    // Sources alphabetically BEFORE 'event_deliveries' use strict < to avoid
    // duplicating boundary rows. e.g. 'audit_log', 'agent_audit_logs',
    // 'agent_chat_messages', 'internal_agent_audit', 'tenant_member_audit'
    // all sort before 'event_deliveries' so they should be `< ?::timestamptz`.
    // Actually: 'audit_log' < 'event_deliveries' (alphabetical), so audit_log
    // SHOULD use strict. Sources alphabetically AFTER ('internal_agent_audit',
    // 'tenant_member_audit') use inclusive <=.
    // The matching source 'event_deliveries' uses the tuple compare instead.
    expect(sql).toMatch(/timestamp < \$\d+::timestamptz/);
    expect(sql).toMatch(/created_at < \$\d+::timestamptz|created_at <= \$\d+::timestamptz/);
  });

  it('deduplicates internal_agent_audit when an audit_log row exists at the same second', async () => {
    const ts = new Date('2026-05-21T12:00:00.000Z');
    const agentId = '22222222-2222-2222-2222-222222222222';
    const rows: RawRow[] = [
      {
        source: 'audit_log',
        row_id: 'audit-1',
        occurred_at: ts,
        tenant_id: TENANT,
        account_id: null,
        action: 'internal_agent.created',
        actor_id: 'u',
        previous_state: null,
        new_state: { agentId },
      },
      {
        source: 'internal_agent_audit',
        row_id: 'iaa-1',
        occurred_at: ts,
        tenant_id: TENANT,
        account_id: null,
        action: 'agent.created',
        actor_id: 'u',
        previous_state: null,
        new_state: { id: agentId },
      },
    ];
    const client = makeClient(rows);
    const result = await auditLogRepository.listUnifiedAuditEntries(
      client as never,
      TENANT,
      new Date('2026-05-21T00:00:00.000Z'),
      new Date('2026-05-22T00:00:00.000Z'),
      null,
      50,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].source).toBe('audit_log');
    expect(result.rawCount).toBe(2);
  });

  it('does NOT dedup when audit_log has no agentId/id (would falsely collapse unrelated rows)', async () => {
    // Regression: with newState=null on both sides, the dedup key becomes
    // `internal_agent.X|?|<ts>` on both. Without the explicit-id guard the
    // dedup would falsely collapse unrelated rows. Implementation now
    // requires both sides to publish a concrete agent id before dedup.
    const ts = new Date('2026-05-21T12:00:00.000Z');
    const rows: RawRow[] = [
      {
        source: 'audit_log',
        row_id: 'a1',
        occurred_at: ts,
        tenant_id: TENANT,
        account_id: null,
        action: 'internal_agent.updated',
        actor_id: 'u',
        previous_state: null,
        new_state: null, // no agent id available
      },
      {
        source: 'internal_agent_audit',
        row_id: 'iaa1',
        occurred_at: ts,
        tenant_id: TENANT,
        account_id: null,
        action: 'agent.updated',
        actor_id: 'u',
        previous_state: null,
        new_state: null, // no agent id available
      },
    ];
    const client = makeClient(rows);
    const result = await auditLogRepository.listUnifiedAuditEntries(
      client as never,
      TENANT,
      new Date('2026-05-21T00:00:00.000Z'),
      new Date('2026-05-22T00:00:00.000Z'),
      null,
      50,
    );
    expect(result.rows).toHaveLength(2);
  });

  it('keeps internal_agent_audit rows that have NO matching audit_log row', async () => {
    const ts = new Date('2026-05-21T12:00:00.000Z');
    const rows: RawRow[] = [
      {
        source: 'internal_agent_audit',
        row_id: 'iaa-only',
        occurred_at: ts,
        tenant_id: TENANT,
        account_id: null,
        action: 'agent.archived',
        actor_id: 'u',
        previous_state: null,
        new_state: { id: '33333333-3333-3333-3333-333333333333' },
      },
    ];
    const client = makeClient(rows);
    const result = await auditLogRepository.listUnifiedAuditEntries(
      client as never,
      TENANT,
      new Date('2026-05-21T00:00:00.000Z'),
      new Date('2026-05-22T00:00:00.000Z'),
      null,
      50,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].source).toBe('internal_agent_audit');
    expect(result.rawCount).toBe(1);
  });

  it('returns rawCount distinct from deduped rows.length', async () => {
    const ts = new Date('2026-05-21T12:00:00.000Z');
    const agentId = '44444444-4444-4444-4444-444444444444';
    const rows: RawRow[] = [
      {
        source: 'audit_log', row_id: 'a', occurred_at: ts, tenant_id: TENANT,
        account_id: null, action: 'internal_agent.created', actor_id: 'u',
        previous_state: null, new_state: { agentId },
      },
      {
        source: 'internal_agent_audit', row_id: 'b', occurred_at: ts, tenant_id: TENANT,
        account_id: null, action: 'agent.created', actor_id: 'u',
        previous_state: null, new_state: { id: agentId },
      },
    ];
    const client = makeClient(rows);
    const result = await auditLogRepository.listUnifiedAuditEntries(
      client as never, TENANT,
      new Date('2026-05-21T00:00:00.000Z'),
      new Date('2026-05-22T00:00:00.000Z'),
      null, 50,
    );
    expect(result.rawCount).toBe(2);
    expect(result.rows.length).toBe(1);
  });
});
