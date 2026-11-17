// Oversight Data Provider
// Queries internal_agent_oversight_settings for autonomy and escalation config

import { withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import type { OversightSettings } from '../types';

/**
 * Get current oversight settings for a tenant.
 * Point-in-time query — no time range needed.
 */
export async function getOversightSettings(
  tenantId: string,
): Promise<OversightSettings | null> {

  try {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT autonomy, escalation, sensitive_work, communication
       FROM internal_agent_oversight_settings
       WHERE tenant_id = $1`,
      [tenantId],
    ));

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const sensitiveWork = typeof row.sensitive_work === 'string'
      ? JSON.parse(row.sensitive_work)
      : (row.sensitive_work || {});

    // Convert sensitive_work object to list of enabled categories
    const sensitiveCategories = Object.entries(sensitiveWork)
      .filter(([, enabled]) => enabled)
      .map(([category]) => category);

    return {
      autonomyLevel: (row.autonomy || 'balanced') as string,
      sensitiveWorkCategories: sensitiveCategories,
      escalationRules: { escalation: row.escalation, communication: row.communication },
    };
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch oversight settings');
    return null;
  }
}
