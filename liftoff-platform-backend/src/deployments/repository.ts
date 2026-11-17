// Deployment Repository
// Per Section 1: Control plane owns approved deployment revisions
//
// RLS note (FORCE census): `deployments` is RLS-enabled. tenantId-bearing reads
// + create → withTenantScope. The operator by-PK lifecycle ops (approve/deploy/
// rollback) and list-all carry no tenant context → withAdminScope. findById
// branches on the optional tenantId.

import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { Deployment, CreateDeploymentInput } from './types';

export class DeploymentRepository {
  async findAll(): Promise<Deployment[]> {
    const result = await withAdminScope(
      { caller: 'deployments.findAll', reason: 'operator list-all deployments across tenants (no tenant filter)' },
      (client) => client.query(`SELECT * FROM deployments ORDER BY created_at DESC`),
    );
    return result.rows.map(this.mapRow);
  }

  async findById(id: string, tenantId?: string): Promise<Deployment | null> {
    const query = tenantId
      ? `SELECT * FROM deployments WHERE id = $1 AND tenant_id = $2`
      : `SELECT * FROM deployments WHERE id = $1`;
    const params = tenantId ? [id, tenantId] : [id];
    const result = tenantId
      ? await withTenantScope(tenantId, (client) => client.query(query, params))
      : await withAdminScope(
          { caller: 'deployments.findById', reason: 'operator by-PK deployment lookup (no tenant context)' },
          (client) => client.query(query, params),
        );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByTenantId(tenantId: string): Promise<Deployment[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM deployments WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    ));
    return result.rows.map(this.mapRow);
  }

  async findPendingByTenantId(tenantId: string): Promise<Deployment[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM deployments WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
      [tenantId]
    ));
    return result.rows.map(this.mapRow);
  }

  /** The artifact this tenant is approved to run.
   *
   *  The tenant runtime caches a deployment when `tenant.deployment.approved`
   *  arrives, keyed (tenant_id, deployment_id), and nothing ever clears that
   *  row: there is no `deployed` event handler on the other side. So a
   *  cache-miss refetch has to reconstruct the same answer the event path would
   *  have left behind.
   *
   *  That is why 'deployed' counts as well as 'approved'. A deployment that has
   *  since been rolled out was still approved, and the runtime's cache would
   *  still be holding it; excluding it would make a cold cache report "nothing
   *  approved" for a tenant that is actively running something. Ordered by
   *  approved_at because that is the moment being reconstructed, and
   *  'rolled_back' is excluded because it is precisely the state where the
   *  approval was withdrawn.
   *
   *  Distinct from findLatestDeployed above, which answers "what is live now". */
  async findLatestApproved(tenantId: string): Promise<Deployment | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM deployments
        WHERE tenant_id = $1 AND status IN ('approved', 'deployed')
        ORDER BY approved_at DESC NULLS LAST
        LIMIT 1`,
      [tenantId]
    ));
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findLatestDeployed(tenantId: string): Promise<Deployment | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM deployments WHERE tenant_id = $1 AND status = 'deployed' ORDER BY deployed_at DESC LIMIT 1`,
      [tenantId]
    ));
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async create(input: CreateDeploymentInput): Promise<Deployment> {
    return withTenantScope(input.tenantId, async (client) => {
      // Get next version for this tenant
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM deployments WHERE tenant_id = $1`,
        [input.tenantId]
      );
      const nextVersion = versionResult.rows[0].next_version;

      const result = await client.query(
        `INSERT INTO deployments (tenant_id, version, artifact_ref, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING *`,
        [input.tenantId, nextVersion, input.artifactRef]
      );
      return this.mapRow(result.rows[0]);
    });
  }

  async approve(id: string): Promise<Deployment> {
    const result = await withAdminScope(
      { caller: 'deployments.approve', reason: 'operator by-PK deployment approval (no tenant context)' },
      (client) => client.query(
        `UPDATE deployments
         SET status = 'approved', approved_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id]
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Deployment not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async deploy(id: string): Promise<Deployment> {
    const result = await withAdminScope(
      { caller: 'deployments.deploy', reason: 'operator by-PK deployment promotion (no tenant context)' },
      (client) => client.query(
        `UPDATE deployments
         SET status = 'deployed', deployed_at = NOW()
         WHERE id = $1 AND status = 'approved'
         RETURNING *`,
        [id]
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Deployment not found or not approved: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async rollback(id: string): Promise<Deployment> {
    const result = await withAdminScope(
      { caller: 'deployments.rollback', reason: 'operator by-PK deployment rollback (no tenant context)' },
      (client) => client.query(
        `UPDATE deployments
         SET status = 'rolled_back'
         WHERE id = $1 AND status = 'deployed'
         RETURNING *`,
        [id]
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Deployment not found or not deployed: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: Record<string, unknown>): Deployment {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      version: row.version as number,
      status: row.status as 'pending' | 'approved' | 'deployed' | 'rolled_back',
      artifactRef: row.artifact_ref as string,
      createdAt: row.created_at as Date,
      approvedAt: row.approved_at as Date | null,
      deployedAt: row.deployed_at as Date | null,
    };
  }
}
