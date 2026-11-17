import { AuditEntry, RawRow } from './types';

export function mapRow(row: RawRow): AuditEntry {
  return {
    id: `${row.source}:${row.row_id}`,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    action: row.action,
    actorId: row.actor_id,
    previousState: row.previous_state,
    newState: row.new_state,
    createdAt: row.occurred_at.toISOString(),
  };
}
