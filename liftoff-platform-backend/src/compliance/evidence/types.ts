// Compliance Evidence Types
// Per Section 19/20: SOC 2 and GDPR readiness - compliance evidence collection

export type EvidenceType =
  | 'access_review'
  | 'access_logs'
  | 'change_management'
  | 'change_records'
  | 'audit_log'
  | 'security_scan'
  | 'system_config'
  | 'encryption_status'
  | 'backup_verification'
  | 'incident_response'
  | 'training_completion'
  | 'policy_acknowledgement'
  | 'vulnerability_assessment'
  | 'vulnerability_scan'
  | 'penetration_test'
  | 'compliance_certificate'
  | 'business_continuity'
  | 'vendor_assessment'
  | 'data_classification'
  | 'retention_compliance';

export type EvidenceStatus = 'pending' | 'collected' | 'reviewed' | 'approved' | 'expired';
export type ComplianceFramework = 'SOC2' | 'GDPR' | 'HIPAA' | 'ISO27001' | 'PCI_DSS';

export interface EvidenceRecord {
  id: string;
  type: EvidenceType;
  framework: ComplianceFramework;
  controlId: string;
  title: string;
  description: string;
  status: EvidenceStatus;
  collectedBy: string;
  collectedAt: Date;
  reviewedBy?: string;
  reviewedAt?: Date;
  approvedBy?: string;
  approvedAt?: Date;
  expiresAt?: Date;
  artifactPath?: string;
  artifactHash?: string;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccessReviewReport {
  id: string;
  reviewPeriodStart: Date;
  reviewPeriodEnd: Date;
  reviewedBy: string;
  reviewedAt: Date;
  totalUsers: number;
  usersReviewed: number;
  accessChanges: AccessReviewChange[];
  findings: AccessReviewFinding[];
  status: 'in_progress' | 'completed' | 'approved';
  approvedBy?: string;
  approvedAt?: Date;
  createdAt: Date;
}

export interface AccessReviewChange {
  userId: string;
  userEmail: string;
  changeType: 'granted' | 'revoked' | 'modified';
  previousAccess: string[];
  newAccess: string[];
  reason: string;
  changedBy: string;
  changedAt: Date;
}

export interface AccessReviewFinding {
  severity: 'high' | 'medium' | 'low';
  description: string;
  remediation: string;
  remediatedAt?: Date;
}

export interface ChangeManagementRecord {
  id: string;
  changeType: 'code' | 'infrastructure' | 'configuration' | 'access' | 'policy';
  title: string;
  description: string;
  requestedBy: string;
  requestedAt: Date;
  approvedBy?: string;
  approvedAt?: Date;
  implementedBy?: string;
  implementedAt?: Date;
  environment: 'development' | 'staging' | 'production';
  riskLevel: 'high' | 'medium' | 'low';
  rollbackPlan?: string;
  testEvidence?: string;
  status: 'requested' | 'approved' | 'implemented' | 'verified' | 'rejected' | 'rolled_back';
  verifiedBy?: string;
  verifiedAt?: Date;
  artifacts: ChangeArtifact[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ChangeArtifact {
  type: 'commit' | 'pr' | 'ticket' | 'test_result' | 'approval_email' | 'deployment_log';
  reference: string;
  url?: string;
  hash?: string;
}

export interface AuditPackage {
  id: string;
  framework: ComplianceFramework;
  periodStart: Date;
  periodEnd: Date;
  generatedBy: string;
  generatedAt: Date;
  status: 'draft' | 'review' | 'final';
  controls: AuditPackageControl[];
  summary: AuditPackageSummary;
  artifactPath?: string;
  createdAt: Date;
}

export interface AuditPackageControl {
  controlId: string;
  controlName: string;
  category: string;
  evidenceCount: number;
  evidenceIds: string[];
  status: 'complete' | 'partial' | 'missing';
  notes?: string;
}

export interface AuditPackageSummary {
  totalControls: number;
  completeControls: number;
  partialControls: number;
  missingControls: number;
  totalEvidence: number;
  coverage: number; // percentage
}

// SOC 2 Control Categories
export const SOC2_CONTROLS = {
  CC1: { id: 'CC1', name: 'Control Environment', category: 'Common Criteria' },
  CC2: { id: 'CC2', name: 'Communication and Information', category: 'Common Criteria' },
  CC3: { id: 'CC3', name: 'Risk Assessment', category: 'Common Criteria' },
  CC4: { id: 'CC4', name: 'Monitoring Activities', category: 'Common Criteria' },
  CC5: { id: 'CC5', name: 'Control Activities', category: 'Common Criteria' },
  CC6: { id: 'CC6', name: 'Logical and Physical Access', category: 'Common Criteria' },
  CC7: { id: 'CC7', name: 'System Operations', category: 'Common Criteria' },
  CC8: { id: 'CC8', name: 'Change Management', category: 'Common Criteria' },
  CC9: { id: 'CC9', name: 'Risk Mitigation', category: 'Common Criteria' },
  A1: { id: 'A1', name: 'Availability', category: 'Additional Criteria' },
  C1: { id: 'C1', name: 'Confidentiality', category: 'Additional Criteria' },
  PI1: { id: 'PI1', name: 'Processing Integrity', category: 'Additional Criteria' },
};

export interface CollectEvidenceInput {
  type: EvidenceType;
  framework: ComplianceFramework;
  controlId: string;
  title: string;
  description: string;
  collectedBy: string;
  artifactPath?: string;
  metadata?: Record<string, any>;
  expiresAt?: Date;
}

export interface GenerateAccessReviewInput {
  reviewPeriodStart: Date;
  reviewPeriodEnd: Date;
  reviewedBy: string;
}

export interface GenerateAuditPackageInput {
  framework: ComplianceFramework;
  periodStart: Date;
  periodEnd: Date;
  generatedBy: string;
}
