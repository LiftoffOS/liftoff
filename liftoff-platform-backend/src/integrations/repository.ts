import { withTenantScope } from '../infrastructure/database';

export interface ExternalAgentIntegration {
  id: string;
  tenantId: string;
  type: 'claude_code' | 'codex';
  activeKeyCount: number;
  lastSyncedAt: Date;
}

export async function listByTenantId(tenantId: string): Promise<ExternalAgentIntegration[]> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      type: string;
      active_key_count: number;
      last_synced_at: Date;
    }>(
      `SELECT id, tenant_id, type, active_key_count, last_synced_at
       FROM external_agent_integrations
       WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows.map(r => ({
      id: r.id,
      tenantId: r.tenant_id,
      type: r.type as 'claude_code' | 'codex',
      activeKeyCount: r.active_key_count,
      lastSyncedAt: r.last_synced_at,
    }));
  });
}

export async function upsert(
  tenantId: string,
  type: 'claude_code' | 'codex',
  activeKeyCount: number,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `INSERT INTO external_agent_integrations (tenant_id, type, active_key_count, last_synced_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (tenant_id, type)
       DO UPDATE SET
         active_key_count = EXCLUDED.active_key_count,
         last_synced_at   = EXCLUDED.last_synced_at,
         updated_at       = EXCLUDED.updated_at`,
      [tenantId, type, activeKeyCount],
    );
  });
}
