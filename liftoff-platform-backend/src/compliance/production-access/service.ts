// Production Access Service
// Per Section 19: SOC 2 and GDPR readiness - production-access workflow

import { ProductionAccessRepository } from './repository';
import {
  AccessRequest,
  BreakglassRequest,
  BreakglassAction,
  AccessAuditEntry,
  CreateAccessRequestInput,
  CreateBreakglassInput,
  ApproveAccessInput,
  DenyAccessInput,
  RevokeAccessInput,
  AccessStats,
} from './types';
import { log } from '../../infrastructure/logging';
import { PubSubPublisher } from '../../infrastructure/pubsub';

// Default breakglass durations by severity
const BREAKGLASS_DURATIONS: Record<string, number> = {
  P1: 240, // 4 hours for critical incidents
  P2: 120, // 2 hours for high severity
  P3: 60,  // 1 hour for medium severity
  P4: 30,  // 30 minutes for low severity
};

export class ProductionAccessService {
  private repository = new ProductionAccessRepository();
  private publisher = new PubSubPublisher();

  // Request production access (requires approval)
  async requestAccess(
    input: CreateAccessRequestInput,
    requestContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<AccessRequest> {
    // Validate request
    if (!input.justification || input.justification.length < 20) {
      throw new Error('Justification must be at least 20 characters');
    }

    if (input.targetEnvironment === 'production' && input.durationMinutes > 480) {
      throw new Error('Production access duration cannot exceed 8 hours');
    }

    // Find applicable approval gate
    const gate = await this.repository.findApplicableGate(
      input.accessLevel,
      input.reason,
      input.targetEnvironment
    );

    // Create the access request
    const request = await this.repository.createAccessRequest({
      ...input,
      status: 'pending',
    });

    // Record audit entry
    await this.recordAudit({
      eventType: 'access_requested',
      requestId: request.id,
      userId: input.requesterId,
      userEmail: input.requesterEmail,
      targetResources: input.targetResources,
      targetEnvironment: input.targetEnvironment,
      details: {
        accessLevel: input.accessLevel,
        reason: input.reason,
        justification: input.justification,
        durationMinutes: input.durationMinutes,
        gateId: gate?.id,
      },
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      timestamp: new Date(),
    });

    log.info('Production access requested', {
      requestId: request.id,
      requesterId: input.requesterId,
      accessLevel: input.accessLevel,
      environment: input.targetEnvironment,
    });

    // Notify approvers
    await this.publisher.publish('access-requests', {
      type: 'access_request_created',
      requestId: request.id,
      requesterEmail: input.requesterEmail,
      accessLevel: input.accessLevel,
      environment: input.targetEnvironment,
      gateId: gate?.id,
      timestamp: new Date().toISOString(),
    });

    return request;
  }

  // Approve an access request
  async approveAccess(
    input: ApproveAccessInput,
    requestContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<AccessRequest> {
    const request = await this.repository.findAccessRequestById(input.requestId);
    if (!request) {
      throw new Error('Access request not found');
    }

    if (request.status !== 'pending') {
      throw new Error(`Cannot approve request with status: ${request.status}`);
    }

    // Cannot self-approve
    if (request.requesterId === input.approverId) {
      throw new Error('Cannot approve your own access request');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + request.durationMinutes * 60 * 1000);

    const updatedRequest = await this.repository.updateAccessRequestStatus(
      input.requestId,
      'active',
      {
        approverId: input.approverId,
        approverEmail: input.approverEmail,
        approvedAt: now,
        grantedAt: now,
        expiresAt,
      }
    );

    // Record audit entry
    await this.recordAudit({
      eventType: 'access_approved',
      requestId: input.requestId,
      userId: input.approverId,
      userEmail: input.approverEmail,
      targetResources: request.targetResources,
      targetEnvironment: request.targetEnvironment,
      details: {
        requesterId: request.requesterId,
        accessLevel: request.accessLevel,
        expiresAt: expiresAt.toISOString(),
      },
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      timestamp: now,
    });

    // Record grant event
    await this.recordAudit({
      eventType: 'access_granted',
      requestId: input.requestId,
      userId: request.requesterId,
      userEmail: request.requesterEmail,
      targetResources: request.targetResources,
      targetEnvironment: request.targetEnvironment,
      details: {
        accessLevel: request.accessLevel,
        expiresAt: expiresAt.toISOString(),
        approvedBy: input.approverEmail,
      },
      timestamp: now,
    });

    log.info('Production access approved', {
      requestId: input.requestId,
      approverId: input.approverId,
      expiresAt,
    });

    // Notify requester
    await this.publisher.publish('access-requests', {
      type: 'access_request_approved',
      requestId: input.requestId,
      requesterEmail: request.requesterEmail,
      approverEmail: input.approverEmail,
      expiresAt: expiresAt.toISOString(),
      timestamp: new Date().toISOString(),
    });

    return updatedRequest;
  }

  // Deny an access request
  async denyAccess(
    input: DenyAccessInput,
    requestContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<AccessRequest> {
    const request = await this.repository.findAccessRequestById(input.requestId);
    if (!request) {
      throw new Error('Access request not found');
    }

    if (request.status !== 'pending') {
      throw new Error(`Cannot deny request with status: ${request.status}`);
    }

    const updatedRequest = await this.repository.updateAccessRequestStatus(
      input.requestId,
      'denied',
      {
        approverId: input.approverId,
        approverEmail: input.approverEmail,
        denialReason: input.reason,
      }
    );

    // Record audit entry
    await this.recordAudit({
      eventType: 'access_denied',
      requestId: input.requestId,
      userId: input.approverId,
      userEmail: input.approverEmail,
      targetResources: request.targetResources,
      targetEnvironment: request.targetEnvironment,
      details: {
        requesterId: request.requesterId,
        accessLevel: request.accessLevel,
        denialReason: input.reason,
      },
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      timestamp: new Date(),
    });

    log.info('Production access denied', {
      requestId: input.requestId,
      approverId: input.approverId,
      reason: input.reason,
    });

    // Notify requester
    await this.publisher.publish('access-requests', {
      type: 'access_request_denied',
      requestId: input.requestId,
      requesterEmail: request.requesterEmail,
      reason: input.reason,
      timestamp: new Date().toISOString(),
    });

    return updatedRequest;
  }

  // Activate breakglass access (immediate access for incidents)
  async activateBreakglass(
    input: CreateBreakglassInput,
    requestContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<BreakglassRequest> {
    // Validate incident severity
    if (!['P1', 'P2', 'P3', 'P4'].includes(input.incidentSeverity)) {
      throw new Error('Invalid incident severity');
    }

    // Validate justification
    if (!input.justification || input.justification.length < 20) {
      throw new Error('Justification must be at least 20 characters');
    }

    const now = new Date();
    const durationMinutes = BREAKGLASS_DURATIONS[input.incidentSeverity];
    const expiresAt = new Date(now.getTime() + durationMinutes * 60 * 1000);

    // Create breakglass request - immediately active
    const breakglass = await this.repository.createBreakglassRequest({
      ...input,
      status: 'active',
      grantedAt: now,
      expiresAt,
      durationMinutes,
    });

    // Record audit entry
    await this.recordAudit({
      eventType: 'breakglass_activated',
      breakglassId: breakglass.id,
      userId: input.requesterId,
      userEmail: input.requesterEmail,
      targetResources: input.targetResources,
      targetEnvironment: input.targetEnvironment,
      details: {
        incidentId: input.incidentId,
        incidentSeverity: input.incidentSeverity,
        justification: input.justification,
        durationMinutes,
        expiresAt: expiresAt.toISOString(),
      },
      ipAddress: requestContext?.ipAddress,
      userAgent: requestContext?.userAgent,
      timestamp: now,
    });

    log.warn('BREAKGLASS ACCESS ACTIVATED', {
      breakglassId: breakglass.id,
      requesterId: input.requesterId,
      incidentId: input.incidentId,
      incidentSeverity: input.incidentSeverity,
      expiresAt,
    });

    // Alert security team
    await this.publisher.publish('security-alerts', {
      type: 'breakglass_activated',
      severity: 'high',
      breakglassId: breakglass.id,
      requesterEmail: input.requesterEmail,
      incidentId: input.incidentId,
      incidentSeverity: input.incidentSeverity,
      targetResources: input.targetResources,
      environment: input.targetEnvironment,
      expiresAt: expiresAt.toISOString(),
      timestamp: new Date().toISOString(),
    });

    return breakglass;
  }

  // Record an action performed during breakglass access
  async recordBreakglassAction(
    breakglassId: string,
    actionType: string,
    targetResource: string,
    actionDetails: Record<string, any>,
    performedBy: string
  ): Promise<BreakglassAction> {
    const breakglass = await this.repository.findBreakglassById(breakglassId);
    if (!breakglass) {
      throw new Error('Breakglass request not found');
    }

    if (breakglass.status !== 'active') {
      throw new Error('Breakglass access is no longer active');
    }

    if (breakglass.expiresAt < new Date()) {
      throw new Error('Breakglass access has expired');
    }

    const action = await this.repository.recordBreakglassAction({
      breakglassId,
      actionType,
      targetResource,
      actionDetails,
      performedAt: new Date(),
      performedBy,
    });

    // Record audit entry for the action
    await this.recordAudit({
      eventType: 'breakglass_action',
      breakglassId,
      userId: performedBy,
      userEmail: breakglass.requesterEmail,
      targetResources: [targetResource],
      targetEnvironment: breakglass.targetEnvironment,
      details: {
        actionType,
        actionDetails,
        incidentId: breakglass.incidentId,
      },
      timestamp: new Date(),
    });

    log.info('Breakglass action recorded', {
      breakglassId,
      actionType,
      targetResource,
      performedBy,
    });

    return action;
  }

  // Revoke access (either regular or breakglass)
  async revokeAccess(
    input: RevokeAccessInput,
    requestContext?: { ipAddress?: string; userAgent?: string }
  ): Promise<void> {
    if (input.requestId) {
      const request = await this.repository.findAccessRequestById(input.requestId);
      if (!request) {
        throw new Error('Access request not found');
      }

      if (request.status !== 'active') {
        throw new Error('Access is not currently active');
      }

      await this.repository.updateAccessRequestStatus(input.requestId, 'revoked', {
        revokedAt: new Date(),
        revokedBy: input.revokedBy,
        revokedReason: input.reason,
      });

      await this.recordAudit({
        eventType: 'access_revoked',
        requestId: input.requestId,
        userId: input.revokedBy,
        userEmail: input.revokedBy,
        targetResources: request.targetResources,
        targetEnvironment: request.targetEnvironment,
        details: {
          originalRequesterId: request.requesterId,
          revokedReason: input.reason,
        },
        ipAddress: requestContext?.ipAddress,
        userAgent: requestContext?.userAgent,
        timestamp: new Date(),
      });

      log.info('Access revoked', {
        requestId: input.requestId,
        revokedBy: input.revokedBy,
        reason: input.reason,
      });
    }

    if (input.breakglassId) {
      const breakglass = await this.repository.findBreakglassById(input.breakglassId);
      if (!breakglass) {
        throw new Error('Breakglass request not found');
      }

      if (breakglass.status !== 'active') {
        throw new Error('Breakglass access is not currently active');
      }

      await this.repository.revokeBreakglass(
        input.breakglassId,
        input.revokedBy,
        input.reason
      );

      await this.recordAudit({
        eventType: 'breakglass_revoked',
        breakglassId: input.breakglassId,
        userId: input.revokedBy,
        userEmail: input.revokedBy,
        targetResources: breakglass.targetResources,
        targetEnvironment: breakglass.targetEnvironment,
        details: {
          originalRequesterId: breakglass.requesterId,
          incidentId: breakglass.incidentId,
          revokedReason: input.reason,
          actionsPerformed: breakglass.actionsPerformed.length,
        },
        ipAddress: requestContext?.ipAddress,
        userAgent: requestContext?.userAgent,
        timestamp: new Date(),
      });

      log.warn('Breakglass access revoked', {
        breakglassId: input.breakglassId,
        revokedBy: input.revokedBy,
        reason: input.reason,
      });
    }
  }

  // Process expired accesses
  async processExpired(): Promise<{ accessExpired: number; breakglassExpired: number }> {
    const accessExpired = await this.repository.markExpiredAccesses();
    const breakglassExpired = await this.repository.markExpiredBreakglass();

    if (accessExpired > 0 || breakglassExpired > 0) {
      log.info('Processed expired accesses', { accessExpired, breakglassExpired });
    }

    return { accessExpired, breakglassExpired };
  }

  // Query methods
  async getPendingRequests(): Promise<AccessRequest[]> {
    return this.repository.findPendingAccessRequests();
  }

  async getActiveAccesses(): Promise<AccessRequest[]> {
    return this.repository.findActiveAccesses();
  }

  async getActiveBreakglass(): Promise<BreakglassRequest[]> {
    return this.repository.findActiveBreakglassRequests();
  }

  async getAccessRequest(id: string): Promise<AccessRequest | null> {
    return this.repository.findAccessRequestById(id);
  }

  async getBreakglassRequest(id: string): Promise<BreakglassRequest | null> {
    return this.repository.findBreakglassById(id);
  }

  async getAuditTrail(options: {
    userId?: string;
    requestId?: string;
    breakglassId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AccessAuditEntry[]> {
    return this.repository.findAuditEntries(options);
  }

  async getStats(): Promise<AccessStats> {
    return this.repository.getStats();
  }

  // Private helper to record audit entries
  private async recordAudit(entry: Omit<AccessAuditEntry, 'id'>): Promise<void> {
    await this.repository.createAuditEntry(entry);
  }
}
