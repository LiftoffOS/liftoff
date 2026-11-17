// CollabSkill read service (tenant-scoped).
//
// SHADOW / read-only. Exposes the current per-entity posteriors for a tenant so
// downstream consumers can read collaboration-skill estimates. The rollup job
// (src/jobs/collab-skill-rollup) is the only writer. Mirrors action-trust:
// withTenantScope() on `app.current_tenant_id`, tenant_id pinned in the WHERE.

import { withTenantScope } from '../infrastructure/database';

export interface CollabSkillEntity {
  entityId: string;
  entityType: 'agent' | 'human' | 'backbone';
  scope: string;
  mu: number;
  sigma: number;
  conservative: number; // mu - 3*sigma
  nObservations: number;
  lastMatchAt: string | null;
}

interface Row {
  entity_id: string;
  entity_type: 'agent' | 'human' | 'backbone';
  scope: string;
  mu: number;
  sigma: number;
  n_observations: number;
  last_match_at: Date | string | null;
}

export async function listCollabSkill(
  tenantId: string,
  opts: { entityType?: string; scope?: string; modelVersion?: string },
): Promise<CollabSkillEntity[]> {
  const modelVersion = opts.modelVersion ?? 'mechanical-v0';
  return withTenantScope(tenantId, async (client) => {
    const conditions = ['tenant_id = $1', 'model_version = $2'];
    const params: unknown[] = [tenantId, modelVersion];
    if (opts.entityType) {
      params.push(opts.entityType);
      conditions.push(`entity_type = $${params.length}`);
    }
    if (opts.scope) {
      params.push(opts.scope);
      conditions.push(`scope = $${params.length}`);
    }
    const result = await client.query<Row>(
      `SELECT entity_id, entity_type, scope, mu, sigma, n_observations, last_match_at
         FROM collab_skill
        WHERE ${conditions.join(' AND ')}
        ORDER BY entity_type, entity_id`,
      params,
    );
    return result.rows.map((r) => ({
      entityId: r.entity_id,
      entityType: r.entity_type,
      scope: r.scope,
      mu: Number(r.mu),
      sigma: Number(r.sigma),
      conservative: Number(r.mu) - 3 * Number(r.sigma),
      nObservations: r.n_observations,
      lastMatchAt: r.last_match_at ? new Date(r.last_match_at).toISOString() : null,
    }));
  });
}
