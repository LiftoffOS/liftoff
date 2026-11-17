// Data Residency Repository
// Per Section 21: GDPR data residency controls

import { getPool } from '../../infrastructure/database';
import {
  DataResidencyPolicy,
  DataResidencyViolation,
  CrossRegionTransferRequest,
  RegionConfig,
  DataRegion,
  RegionGroup,
  CreateResidencyPolicyInput,
  UpdateResidencyPolicyInput,
  CreateTransferRequestInput,
} from './types';

export class DataResidencyRepository {
  // Region configurations
  async getRegionConfigs(): Promise<RegionConfig[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM region_configs WHERE available = true ORDER BY region`
    );
    return result.rows;
  }

  async getRegionConfig(region: DataRegion): Promise<RegionConfig | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM region_configs WHERE region = $1`,
      [region]
    );
    return result.rows[0] || null;
  }

  // Residency policies
  async findPolicyByTenantId(tenantId: string): Promise<DataResidencyPolicy | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM data_residency_policies WHERE tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      primaryRegion: row.primary_region,
      allowedRegions: row.allowed_regions,
      regionGroup: row.region_group,
      enforcementLevel: row.enforcement_level,
      gdprCompliant: row.gdpr_compliant,
      crossRegionTransferAllowed: row.cross_region_transfer_allowed,
      dataProcessingAgreementId: row.data_processing_agreement_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createPolicy(input: CreateResidencyPolicyInput): Promise<DataResidencyPolicy> {
    const pool = getPool();
    const allowedRegions = this.getDefaultAllowedRegions(input.regionGroup, input.primaryRegion);
    const gdprCompliant = input.regionGroup === 'eu';

    const result = await pool.query(
      `INSERT INTO data_residency_policies (
        tenant_id, primary_region, allowed_regions, region_group,
        enforcement_level, gdpr_compliant, cross_region_transfer_allowed,
        data_processing_agreement_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING *`,
      [
        input.tenantId,
        input.primaryRegion,
        allowedRegions,
        input.regionGroup,
        input.enforcementLevel,
        gdprCompliant,
        input.crossRegionTransferAllowed ?? false,
        input.dataProcessingAgreementId ?? null,
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      primaryRegion: row.primary_region,
      allowedRegions: row.allowed_regions,
      regionGroup: row.region_group,
      enforcementLevel: row.enforcement_level,
      gdprCompliant: row.gdpr_compliant,
      crossRegionTransferAllowed: row.cross_region_transfer_allowed,
      dataProcessingAgreementId: row.data_processing_agreement_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async updatePolicy(
    tenantId: string,
    input: UpdateResidencyPolicyInput
  ): Promise<DataResidencyPolicy> {
    const pool = getPool();
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.allowedRegions !== undefined) {
      updates.push(`allowed_regions = $${paramIndex}`);
      values.push(input.allowedRegions);
      paramIndex++;
    }
    if (input.enforcementLevel !== undefined) {
      updates.push(`enforcement_level = $${paramIndex}`);
      values.push(input.enforcementLevel);
      paramIndex++;
    }
    if (input.crossRegionTransferAllowed !== undefined) {
      updates.push(`cross_region_transfer_allowed = $${paramIndex}`);
      values.push(input.crossRegionTransferAllowed);
      paramIndex++;
    }
    if (input.dataProcessingAgreementId !== undefined) {
      updates.push(`data_processing_agreement_id = $${paramIndex}`);
      values.push(input.dataProcessingAgreementId);
      paramIndex++;
    }

    updates.push('updated_at = NOW()');
    values.push(tenantId);

    const result = await pool.query(
      `UPDATE data_residency_policies
       SET ${updates.join(', ')}
       WHERE tenant_id = $${paramIndex}
       RETURNING *`,
      values
    );

    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      primaryRegion: row.primary_region,
      allowedRegions: row.allowed_regions,
      regionGroup: row.region_group,
      enforcementLevel: row.enforcement_level,
      gdprCompliant: row.gdpr_compliant,
      crossRegionTransferAllowed: row.cross_region_transfer_allowed,
      dataProcessingAgreementId: row.data_processing_agreement_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // Violations
  async recordViolation(violation: Omit<DataResidencyViolation, 'id' | 'createdAt'>): Promise<DataResidencyViolation> {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO data_residency_violations (
        tenant_id, policy_id, violation_type, source_region, target_region,
        entity_type, entity_id, details, remediation, resolved_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *`,
      [
        violation.tenantId,
        violation.policyId,
        violation.violationType,
        violation.sourceRegion,
        violation.targetRegion,
        violation.entityType,
        violation.entityId,
        JSON.stringify(violation.details),
        violation.remediation,
        violation.resolvedAt,
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      policyId: row.policy_id,
      violationType: row.violation_type,
      sourceRegion: row.source_region,
      targetRegion: row.target_region,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      remediation: row.remediation,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    };
  }

  async findViolationsByTenantId(tenantId: string, unresolved = true): Promise<DataResidencyViolation[]> {
    const pool = getPool();
    const query = unresolved
      ? `SELECT * FROM data_residency_violations WHERE tenant_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC`
      : `SELECT * FROM data_residency_violations WHERE tenant_id = $1 ORDER BY created_at DESC`;

    const result = await pool.query(query, [tenantId]);

    return result.rows.map(row => ({
      id: row.id,
      tenantId: row.tenant_id,
      policyId: row.policy_id,
      violationType: row.violation_type,
      sourceRegion: row.source_region,
      targetRegion: row.target_region,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      remediation: row.remediation,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    }));
  }

  async resolveViolation(violationId: string, remediation: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE data_residency_violations
       SET resolved_at = NOW(), remediation = $1
       WHERE id = $2`,
      [remediation, violationId]
    );
  }

  // Transfer requests
  async createTransferRequest(input: CreateTransferRequestInput): Promise<CrossRegionTransferRequest> {
    const pool = getPool();
    const policy = await this.findPolicyByTenantId(input.tenantId);
    const sourceRegion = policy?.primaryRegion || 'us-west1';

    const result = await pool.query(
      `INSERT INTO cross_region_transfer_requests (
        tenant_id, source_region, target_region, purpose, entity_types,
        requested_by, status, legal_basis, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NOW())
      RETURNING *`,
      [
        input.tenantId,
        sourceRegion,
        input.targetRegion,
        input.purpose,
        input.entityTypes,
        input.requestedBy,
        input.legalBasis ?? null,
        input.expiresAt ?? null,
      ]
    );

    const row = result.rows[0];
    return this.mapTransferRequestRow(row);
  }

  async findTransferRequest(requestId: string): Promise<CrossRegionTransferRequest | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM cross_region_transfer_requests WHERE id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) return null;
    return this.mapTransferRequestRow(result.rows[0]);
  }

  async updateTransferRequestStatus(
    requestId: string,
    status: string,
    approvedBy?: string
  ): Promise<void> {
    const pool = getPool();
    const approvedAt = status === 'approved' ? 'NOW()' : 'approved_at';

    await pool.query(
      `UPDATE cross_region_transfer_requests
       SET status = $1, approved_by = $2, approved_at = ${approvedAt}
       WHERE id = $3`,
      [status, approvedBy ?? null, requestId]
    );
  }

  async findPendingTransferRequests(tenantId?: string): Promise<CrossRegionTransferRequest[]> {
    const pool = getPool();
    const query = tenantId
      ? `SELECT * FROM cross_region_transfer_requests WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at DESC`
      : `SELECT * FROM cross_region_transfer_requests WHERE status = 'pending' ORDER BY created_at DESC`;

    const result = await pool.query(query, tenantId ? [tenantId] : []);
    return result.rows.map(row => this.mapTransferRequestRow(row));
  }

  // Helper methods
  private getDefaultAllowedRegions(regionGroup: RegionGroup, primaryRegion: DataRegion): DataRegion[] {
    const regionsByGroup: Record<RegionGroup, DataRegion[]> = {
      us: ['us-west1', 'us-central1', 'us-east1'],
      eu: ['europe-west1', 'europe-west2', 'europe-west3'],
      asia: ['asia-east1', 'asia-northeast1'],
    };

    return regionsByGroup[regionGroup] || [primaryRegion];
  }

  private mapTransferRequestRow(row: Record<string, unknown>): CrossRegionTransferRequest {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      sourceRegion: row.source_region as DataRegion,
      targetRegion: row.target_region as DataRegion,
      purpose: row.purpose as CrossRegionTransferRequest['purpose'],
      entityTypes: row.entity_types as string[],
      requestedBy: row.requested_by as string,
      approvedBy: row.approved_by as string | null,
      status: row.status as CrossRegionTransferRequest['status'],
      legalBasis: row.legal_basis as string | null,
      expiresAt: row.expires_at as Date | null,
      createdAt: row.created_at as Date,
      approvedAt: row.approved_at as Date | null,
    };
  }
}
