import { ValidationError } from '../tenant-members/service';
import { getPool, withTenantScope } from '../infrastructure/database';
import { auditLogRepository } from './repository';
import { encodeCursor, decodeCursor } from './cursor';
import { mapRow } from './mappers';
import type { PaginatedAuditResponse } from './types';

export class AuditLogService {
  constructor(private repo = auditLogRepository) {}

  async list(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    options: { cursor?: string; limit?: number },
  ): Promise<PaginatedAuditResponse> {
    const daysDiff = (endDate.getTime() - startDate.getTime()) / 86_400_000;
    if (daysDiff > 90) throw new ValidationError('Date range cannot exceed 90 days');
    if (startDate > endDate) throw new ValidationError('Start date must be before end date');
    // CHANGE FROM LEGACY: clamp instead of throw — frontend commit 4b6b97a already clamps.
    const now = new Date();
    const effectiveEnd = endDate > now ? now : endDate;

    const limit = Math.min(options.limit ?? 50, 100);
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;

    const { rows, rawCount } = await withTenantScope(tenantId, (client) =>
      this.repo.listUnifiedAuditEntries(
        client,
        tenantId,
        startDate,
        effectiveEnd,
        cursor,
        limit,
      ),
    );
    // `rawCount > limit` means the DB had at least one more row beyond the
    // requested page — that's the authoritative hasMore signal. Don't rely
    // on `rows.length` because the dedup pass may have trimmed the boundary
    // row, masking real pagination state.
    const hasMore = rawCount > limit;
    const page = rows.slice(0, limit);
    const entries = page.map(mapRow);
    const nextCursor = hasMore && page.length > 0
      ? encodeCursor({
          occurredAt: page[page.length - 1].occurred_at.toISOString(),
          source: page[page.length - 1].source,
          rowId: page[page.length - 1].row_id,
        })
      : null;
    return { entries, nextCursor, hasMore };
  }

  // Audit Logs is an Enterprise-plan feature. Gate on billing_controls.billing_tier;
  // tenants.account_id -> billing_controls.account_id (see billing/startup-checks.ts).
  async isEnterprise(tenantId: string): Promise<boolean> {
    const { rows } = await getPool().query<{ billing_tier: string }>(
      `SELECT bc.billing_tier
         FROM tenants t
         JOIN billing_controls bc ON bc.account_id = t.account_id
        WHERE t.id = $1`,
      [tenantId],
    );
    return rows[0]?.billing_tier === 'enterprise';
  }
}

export const auditLogService = new AuditLogService();
