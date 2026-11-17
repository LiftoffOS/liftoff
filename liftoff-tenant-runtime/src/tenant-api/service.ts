// Tenant API Service Implementation
// Per Section 4: Contract between control plane and tenant runtime

import { TenantApiRepository } from './repository';

export class TenantApiService {
  private repository = new TenantApiRepository();

  // Per Section 4: Tenant runtime may pull entitlement snapshot
  async getEntitlement(tenantId: string): Promise<any> {
    return this.repository.getCachedEntitlement(tenantId);
  }

  // Per Section 4: Tenant runtime may pull tenant operational status
  async getOperationalStatus(tenantId: string): Promise<any> {
    return this.repository.getCachedStatus(tenantId);
  }

  // Per Section 4: Tenant runtime may pull approved deployment revision
  async getApprovedDeployment(tenantId: string): Promise<any> {
    return this.repository.getCachedDeployment(tenantId);
  }

  // Per Section 4: Tenant runtime may pull approved model config
  async getModelConfig(tenantId: string): Promise<any> {
    return this.repository.getCachedModelConfig(tenantId);
  }

  // Per Section 4: Tenant runtime may pull approved prompt bundle
  async getPromptBundle(tenantId: string): Promise<any> {
    return this.repository.getCachedPromptBundle(tenantId);
  }

  // Per Section 4: Tenant runtime may pull feature flags
  async getFeatureFlags(tenantId: string): Promise<any> {
    return this.repository.getCachedFeatureFlags(tenantId);
  }

  // Per Section 4: Tenant runtime may pull tenant migration status
  async getMigrationStatus(tenantId: string): Promise<any> {
    return this.repository.getCachedMigrationStatus(tenantId);
  }
}
