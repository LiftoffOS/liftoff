// Data Residency Types
// Per Section 21: GDPR data residency controls

export type DataRegion =
  | 'us-west1'      // US West (Oregon)
  | 'us-central1'   // US Central (Iowa)
  | 'us-east1'      // US East (South Carolina)
  | 'europe-west1'  // EU (Belgium)
  | 'europe-west2'  // EU (London)
  | 'europe-west3'  // EU (Frankfurt)
  | 'asia-east1'    // Asia (Taiwan)
  | 'asia-northeast1'; // Asia (Tokyo)

export type RegionGroup =
  | 'us'      // United States
  | 'eu'      // European Union
  | 'asia';   // Asia Pacific

export interface DataResidencyPolicy {
  id: string;
  tenantId: string;
  primaryRegion: DataRegion;
  allowedRegions: DataRegion[];
  regionGroup: RegionGroup;
  enforcementLevel: EnforcementLevel;
  gdprCompliant: boolean;
  crossRegionTransferAllowed: boolean;
  dataProcessingAgreementId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EnforcementLevel =
  | 'strict'    // No data can leave the region
  | 'standard'  // Data can be processed in allowed regions
  | 'flexible'; // No restrictions (non-GDPR)

export interface DataResidencyViolation {
  id: string;
  tenantId: string;
  policyId: string;
  violationType: ViolationType;
  sourceRegion: DataRegion;
  targetRegion: DataRegion;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  remediation: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export type ViolationType =
  | 'cross_region_transfer'
  | 'unauthorized_region_storage'
  | 'processing_outside_region'
  | 'backup_region_violation';

export interface RegionConfig {
  region: DataRegion;
  regionGroup: RegionGroup;
  gcpProject: string;
  cloudSqlInstance: string;
  storageBucket: string;
  pubsubTopic: string;
  available: boolean;
}

export interface CrossRegionTransferRequest {
  id: string;
  tenantId: string;
  sourceRegion: DataRegion;
  targetRegion: DataRegion;
  purpose: TransferPurpose;
  entityTypes: string[];
  requestedBy: string;
  approvedBy: string | null;
  status: TransferStatus;
  legalBasis: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  approvedAt: Date | null;
}

export type TransferPurpose =
  | 'disaster_recovery'
  | 'data_migration'
  | 'analytics'
  | 'user_request'
  | 'legal_requirement';

export type TransferStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'completed';

// Input types
export interface CreateResidencyPolicyInput {
  tenantId: string;
  primaryRegion: DataRegion;
  regionGroup: RegionGroup;
  enforcementLevel: EnforcementLevel;
  crossRegionTransferAllowed?: boolean;
  dataProcessingAgreementId?: string;
}

export interface UpdateResidencyPolicyInput {
  allowedRegions?: DataRegion[];
  enforcementLevel?: EnforcementLevel;
  crossRegionTransferAllowed?: boolean;
  dataProcessingAgreementId?: string;
}

export interface CreateTransferRequestInput {
  tenantId: string;
  targetRegion: DataRegion;
  purpose: TransferPurpose;
  entityTypes: string[];
  requestedBy: string;
  legalBasis?: string;
  expiresAt?: Date;
}
