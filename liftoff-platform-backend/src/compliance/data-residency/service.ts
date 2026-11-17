// Data Residency Service
// Per Section 21: GDPR data residency controls

import { logger } from '../../infrastructure/logging';
import { publishEvent } from '../../events/publisher';
import { DataResidencyRepository } from './repository';
import {
  DataResidencyPolicy,
  DataResidencyViolation,
  CrossRegionTransferRequest,
  RegionConfig,
  DataRegion,
  CreateResidencyPolicyInput,
  UpdateResidencyPolicyInput,
  CreateTransferRequestInput,
  ViolationType,
} from './types';

export class DataResidencyService {
  private repository = new DataResidencyRepository();

  // Region configuration
  async getAvailableRegions(): Promise<RegionConfig[]> {
    return this.repository.getRegionConfigs();
  }

  async getRegionConfig(region: DataRegion): Promise<RegionConfig | null> {
    return this.repository.getRegionConfig(region);
  }

  // Residency policies
  async getPolicy(tenantId: string): Promise<DataResidencyPolicy | null> {
    return this.repository.findPolicyByTenantId(tenantId);
  }

  async createPolicy(input: CreateResidencyPolicyInput): Promise<DataResidencyPolicy> {
    const existing = await this.repository.findPolicyByTenantId(input.tenantId);
    if (existing) {
      throw new Error(`Data residency policy already exists for tenant: ${input.tenantId}`);
    }

    const policy = await this.repository.createPolicy(input);

    logger.info('Created data residency policy', {
      tenantId: input.tenantId,
      primaryRegion: input.primaryRegion,
      regionGroup: input.regionGroup,
      enforcementLevel: input.enforcementLevel,
    });

    await publishEvent({
      eventType: 'compliance.residency_policy_created',
      entityType: 'residency_policy',
      entityId: policy.id,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: input.tenantId,
      payload: {
        primaryRegion: policy.primaryRegion,
        regionGroup: policy.regionGroup,
        enforcementLevel: policy.enforcementLevel,
        gdprCompliant: policy.gdprCompliant,
      },
    });

    return policy;
  }

  async updatePolicy(
    tenantId: string,
    input: UpdateResidencyPolicyInput
  ): Promise<DataResidencyPolicy> {
    const existing = await this.repository.findPolicyByTenantId(tenantId);
    if (!existing) {
      throw new Error(`Data residency policy not found for tenant: ${tenantId}`);
    }

    const policy = await this.repository.updatePolicy(tenantId, input);

    logger.info('Updated data residency policy', {
      tenantId,
      updates: input,
    });

    await publishEvent({
      eventType: 'compliance.residency_policy_updated',
      entityType: 'residency_policy',
      entityId: policy.id,
      entityVersion: 2,
      eventVersion: 1,
      tenantId,
      payload: { updates: input },
    });

    return policy;
  }

  // Region validation
  async validateRegionAccess(
    tenantId: string,
    targetRegion: DataRegion,
    operation: 'read' | 'write' | 'transfer'
  ): Promise<{ allowed: boolean; reason?: string }> {
    const policy = await this.repository.findPolicyByTenantId(tenantId);

    if (!policy) {
      // No policy = no restrictions
      return { allowed: true };
    }

    // Check if target region is in allowed regions
    if (!policy.allowedRegions.includes(targetRegion)) {
      return {
        allowed: false,
        reason: `Region ${targetRegion} is not in allowed regions for tenant ${tenantId}`,
      };
    }

    // Strict enforcement prevents cross-region operations
    if (policy.enforcementLevel === 'strict' && targetRegion !== policy.primaryRegion) {
      return {
        allowed: false,
        reason: `Strict enforcement prevents access to non-primary region ${targetRegion}`,
      };
    }

    // Transfer operations require explicit permission
    if (operation === 'transfer' && !policy.crossRegionTransferAllowed) {
      return {
        allowed: false,
        reason: 'Cross-region transfers are not allowed for this tenant',
      };
    }

    return { allowed: true };
  }

  // Violation tracking
  async recordViolation(
    tenantId: string,
    violationType: ViolationType,
    sourceRegion: DataRegion,
    targetRegion: DataRegion,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>
  ): Promise<DataResidencyViolation> {
    const policy = await this.repository.findPolicyByTenantId(tenantId);
    if (!policy) {
      throw new Error(`No residency policy found for tenant: ${tenantId}`);
    }

    const violation = await this.repository.recordViolation({
      tenantId,
      policyId: policy.id,
      violationType,
      sourceRegion,
      targetRegion,
      entityType,
      entityId,
      details,
      remediation: null,
      resolvedAt: null,
    });

    logger.warn('Data residency violation recorded', {
      violationId: violation.id,
      tenantId,
      violationType,
      sourceRegion,
      targetRegion,
      entityType,
      entityId,
    });

    await publishEvent({
      eventType: 'compliance.residency_violation',
      entityType: 'residency_violation',
      entityId: violation.id,
      entityVersion: 1,
      eventVersion: 1,
      tenantId,
      payload: {
        violationType,
        sourceRegion,
        targetRegion,
        entityType,
        entityId,
      },
    });

    return violation;
  }

  async getViolations(tenantId: string, unresolvedOnly = true): Promise<DataResidencyViolation[]> {
    return this.repository.findViolationsByTenantId(tenantId, unresolvedOnly);
  }

  async resolveViolation(violationId: string, remediation: string): Promise<void> {
    await this.repository.resolveViolation(violationId, remediation);

    logger.info('Data residency violation resolved', {
      violationId,
      remediation,
    });
  }

  // Cross-region transfer requests
  async requestTransfer(input: CreateTransferRequestInput): Promise<CrossRegionTransferRequest> {
    const policy = await this.repository.findPolicyByTenantId(input.tenantId);

    if (policy && !policy.crossRegionTransferAllowed && policy.enforcementLevel === 'strict') {
      throw new Error('Cross-region transfers are not allowed under strict enforcement');
    }

    const request = await this.repository.createTransferRequest(input);

    logger.info('Cross-region transfer requested', {
      requestId: request.id,
      tenantId: input.tenantId,
      sourceRegion: request.sourceRegion,
      targetRegion: input.targetRegion,
      purpose: input.purpose,
    });

    await publishEvent({
      eventType: 'compliance.transfer_requested',
      entityType: 'transfer_request',
      entityId: request.id,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: input.tenantId,
      payload: {
        sourceRegion: request.sourceRegion,
        targetRegion: input.targetRegion,
        purpose: input.purpose,
        entityTypes: input.entityTypes,
      },
    });

    return request;
  }

  async approveTransfer(requestId: string, approvedBy: string): Promise<CrossRegionTransferRequest> {
    const request = await this.repository.findTransferRequest(requestId);
    if (!request) {
      throw new Error(`Transfer request not found: ${requestId}`);
    }

    if (request.status !== 'pending') {
      throw new Error(`Transfer request is not pending: ${request.status}`);
    }

    await this.repository.updateTransferRequestStatus(requestId, 'approved', approvedBy);

    const updatedRequest = await this.repository.findTransferRequest(requestId);

    logger.info('Cross-region transfer approved', {
      requestId,
      approvedBy,
      tenantId: request.tenantId,
    });

    await publishEvent({
      eventType: 'compliance.transfer_approved',
      entityType: 'transfer_request',
      entityId: requestId,
      entityVersion: 2,
      eventVersion: 1,
      tenantId: request.tenantId,
      payload: { approvedBy },
    });

    return updatedRequest!;
  }

  async rejectTransfer(requestId: string, rejectedBy: string): Promise<void> {
    const request = await this.repository.findTransferRequest(requestId);
    if (!request) {
      throw new Error(`Transfer request not found: ${requestId}`);
    }

    await this.repository.updateTransferRequestStatus(requestId, 'rejected');

    logger.info('Cross-region transfer rejected', {
      requestId,
      rejectedBy,
      tenantId: request.tenantId,
    });
  }

  async getPendingTransfers(tenantId?: string): Promise<CrossRegionTransferRequest[]> {
    return this.repository.findPendingTransferRequests(tenantId);
  }

  // Enforcement helpers
  async enforceRegionOnWrite(
    tenantId: string,
    targetRegion: DataRegion,
    entityType: string,
    entityId: string
  ): Promise<void> {
    const validation = await this.validateRegionAccess(tenantId, targetRegion, 'write');

    if (!validation.allowed) {
      const policy = await this.repository.findPolicyByTenantId(tenantId);

      // Record the violation
      await this.recordViolation(
        tenantId,
        'unauthorized_region_storage',
        policy?.primaryRegion || 'us-west1',
        targetRegion,
        entityType,
        entityId,
        { reason: validation.reason, blocked: true }
      );

      throw new Error(`Data residency violation: ${validation.reason}`);
    }
  }

  async enforceRegionOnTransfer(
    tenantId: string,
    sourceRegion: DataRegion,
    targetRegion: DataRegion,
    entityType: string,
    entityId: string
  ): Promise<void> {
    const validation = await this.validateRegionAccess(tenantId, targetRegion, 'transfer');

    if (!validation.allowed) {
      // Record the violation
      await this.recordViolation(
        tenantId,
        'cross_region_transfer',
        sourceRegion,
        targetRegion,
        entityType,
        entityId,
        { reason: validation.reason, blocked: true }
      );

      throw new Error(`Data residency violation: ${validation.reason}`);
    }
  }
}

export const dataResidencyService = new DataResidencyService();
