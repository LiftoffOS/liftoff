import { mapRow } from '../mappers';
import { RawRow } from '../types';

describe('audit-log mappers', () => {
  it('prefixes id with source name', () => {
    const row: RawRow = {
      source: 'tenant_member_audit',
      row_id: 'aaa',
      occurred_at: new Date('2026-05-21T12:00:00.000Z'),
      tenant_id: 't',
      account_id: 'acc',
      action: 'member.invited',
      actor_id: 'u',
      previous_state: null,
      new_state: null,
    };
    expect(mapRow(row).id).toBe('tenant_member_audit:aaa');
  });

  it('serializes occurred_at as ISO', () => {
    const row: RawRow = {
      source: 'audit_log',
      row_id: 'x',
      occurred_at: new Date('2026-05-21T12:00:00.000Z'),
      tenant_id: 't',
      account_id: null,
      action: 'tenant.renamed',
      actor_id: 'u',
      previous_state: { name: 'old' },
      new_state: { name: 'new' },
    };
    const out = mapRow(row);
    expect(out.createdAt).toBe('2026-05-21T12:00:00.000Z');
    expect(out.previousState).toEqual({ name: 'old' });
    expect(out.newState).toEqual({ name: 'new' });
  });
});
