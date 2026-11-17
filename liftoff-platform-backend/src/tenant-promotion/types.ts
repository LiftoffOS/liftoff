// Tenant Promotion Types
// Per Section 22 Phase 5: Tenant promotion tooling

export type DatabaseTier = 'shared' | 'pooled_dedicated' | 'fully_dedicated';

export type InstanceSize = 'small' | 'medium' | 'large' | 'xlarge';

export type PromotionStatusType =
  | 'pending'
  | 'exporting'
  | 'provisioning'
  | 'migrating'
  | 'validating'
  | 'switching'
  | 'completed'
  | 'failed'
  | 'rolled_back';

export interface TenantDatabaseConfig {
  tenantId: string;
  tier: DatabaseTier;
  connectionName: string;
  region: string;
  instanceSize?: InstanceSize;
  highAvailability: boolean;
  pointInTimeRecovery: boolean;
  createdAt: Date;
  promotedAt?: Date;
}

export interface PromotionRequest {
  tenantId: string;
  targetTier: 'pooled_dedicated' | 'fully_dedicated';
  instanceSize: InstanceSize;
  targetRegion: string;
  highAvailability: boolean;
  pointInTimeRecovery: boolean;
  requestedBy: string;
  reason?: string;
}

export interface PromotionValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  estimatedDataSize: number;
  estimatedMigrationTime: number;
  estimatedMonthlyCost: number;
}
