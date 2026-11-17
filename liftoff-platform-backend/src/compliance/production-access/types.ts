// Production Access Types
// Per Section 19: SOC 2 and GDPR readiness - production-access workflow

export type AccessLevel = 'read' | 'write' | 'admin' | 'breakglass';
export type AccessReason = 'incident' | 'maintenance' | 'investigation' | 'deployment' | 'other';
export type AccessStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'revoked' | 'active';

export interface AccessRequest {
  id: string;
  requesterId: string;
  requesterEmail: string;
  accessLevel: AccessLevel;
  reason: AccessReason;
  justification: string;
  targetResources: string[];
  targetEnvironment: 'staging' | 'production';
  durationMinutes: number;
  status: AccessStatus;
  approverId?: string;
  approverEmail?: string;
  approvedAt?: Date;
  denialReason?: string;
  grantedAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  revokedBy?: string;
  revokedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BreakglassRequest {
  id: string;
  requesterId: string;
  requesterEmail: string;
  incidentId: string;
  incidentSeverity: 'P1' | 'P2' | 'P3' | 'P4';
  targetResources: string[];
  targetEnvironment: 'staging' | 'production';
  justification: string;
  status: 'active' | 'expired' | 'revoked';
  grantedAt: Date;
  expiresAt: Date;
  durationMinutes: number;
  actionsPerformed: BreakglassAction[];
  revokedAt?: Date;
  revokedBy?: string;
  revokedReason?: string;
  postIncidentReviewId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BreakglassAction {
  id: string;
  breakglassId: string;
  actionType: string;
  targetResource: string;
  actionDetails: Record<string, any>;
  performedAt: Date;
  performedBy: string;
}

export interface AccessAuditEntry {
  id: string;
  eventType:
    | 'access_requested'
    | 'access_approved'
    | 'access_denied'
    | 'access_granted'
    | 'access_expired'
    | 'access_revoked'
    | 'breakglass_activated'
    | 'breakglass_action'
    | 'breakglass_expired'
    | 'breakglass_revoked';
  requestId?: string;
  breakglassId?: string;
  userId: string;
  userEmail: string;
  targetResources: string[];
  targetEnvironment: 'staging' | 'production';
  details: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
}

export interface ApprovalGate {
  id: string;
  name: string;
  description: string;
  requiredApprovers: number;
  approverRoles: string[];
  autoExpireMinutes: number;
  requiresMfa: boolean;
  requiresJustification: boolean;
  allowedAccessLevels: AccessLevel[];
  allowedReasons: AccessReason[];
  targetEnvironments: ('staging' | 'production')[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAccessRequestInput {
  requesterId: string;
  requesterEmail: string;
  accessLevel: AccessLevel;
  reason: AccessReason;
  justification: string;
  targetResources: string[];
  targetEnvironment: 'staging' | 'production';
  durationMinutes: number;
}

export interface CreateBreakglassInput {
  requesterId: string;
  requesterEmail: string;
  incidentId: string;
  incidentSeverity: 'P1' | 'P2' | 'P3' | 'P4';
  targetResources: string[];
  targetEnvironment: 'staging' | 'production';
  justification: string;
}

export interface ApproveAccessInput {
  requestId: string;
  approverId: string;
  approverEmail: string;
}

export interface DenyAccessInput {
  requestId: string;
  approverId: string;
  approverEmail: string;
  reason: string;
}

export interface RevokeAccessInput {
  requestId?: string;
  breakglassId?: string;
  revokedBy: string;
  reason: string;
}

export interface AccessStats {
  totalRequests: number;
  pendingRequests: number;
  approvedRequests: number;
  deniedRequests: number;
  activeAccesses: number;
  breakglassActivations: number;
  averageApprovalTimeMinutes: number;
}
