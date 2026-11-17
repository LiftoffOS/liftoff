// Deployment Service Implementation
// Per Section 1: Approved deployment revisions

import { Deployment, CreateDeploymentInput } from './types';
import { DeploymentRepository } from './repository';
import { publishEvent } from '../events/publisher';

export class DeploymentService {
  private repository = new DeploymentRepository();

  async listAll(): Promise<Deployment[]> {
    return this.repository.findAll();
  }

  async getById(id: string): Promise<Deployment | null> {
    return this.repository.findById(id);
  }

  async getByTenantId(tenantId: string): Promise<Deployment[]> {
    return this.repository.findByTenantId(tenantId);
  }

  async getPendingByTenantId(tenantId: string): Promise<Deployment[]> {
    return this.repository.findPendingByTenantId(tenantId);
  }

  /** The artifact this tenant is approved to run. Backs the tenant runtime's
   *  cache-miss refetch; see findLatestApproved for why 'deployed' counts. */
  async getLatestApproved(tenantId: string): Promise<Deployment | null> {
    return this.repository.findLatestApproved(tenantId);
  }

  async getLatestDeployed(tenantId: string): Promise<Deployment | null> {
    return this.repository.findLatestDeployed(tenantId);
  }

  async create(input: CreateDeploymentInput): Promise<Deployment> {
    const deployment = await this.repository.create(input);

    await publishEvent({
      entityType: 'deployment',
      entityId: deployment.id,
      eventType: 'tenant.deployment.created',
      entityVersion: deployment.version,
      eventVersion: 1,
      tenantId: deployment.tenantId,
      payload: {
        artifactRef: deployment.artifactRef,
        version: deployment.version,
      },
    });

    return deployment;
  }

  async approve(id: string): Promise<Deployment> {
    const deployment = await this.repository.approve(id);

    // Per Section 4: Publish tenant.deployment.approved event
    await publishEvent({
      entityType: 'deployment',
      entityId: deployment.id,
      eventType: 'tenant.deployment.approved',
      entityVersion: deployment.version,
      eventVersion: 1,
      tenantId: deployment.tenantId,
      payload: {
        artifactRef: deployment.artifactRef,
        version: deployment.version,
        approvedAt: deployment.approvedAt,
      },
    });

    return deployment;
  }

  async deploy(id: string): Promise<Deployment> {
    const deployment = await this.repository.deploy(id);

    // Per Section 4: Publish tenant.deployment.deployed event
    await publishEvent({
      entityType: 'deployment',
      entityId: deployment.id,
      eventType: 'tenant.deployment.deployed',
      entityVersion: deployment.version,
      eventVersion: 1,
      tenantId: deployment.tenantId,
      payload: {
        artifactRef: deployment.artifactRef,
        version: deployment.version,
        deployedAt: deployment.deployedAt,
      },
    });

    return deployment;
  }

  async rollback(id: string): Promise<Deployment> {
    const deployment = await this.repository.rollback(id);

    // Per Section 4: Publish tenant.deployment.rolled_back event
    await publishEvent({
      entityType: 'deployment',
      entityId: deployment.id,
      eventType: 'tenant.deployment.rolled_back',
      entityVersion: deployment.version,
      eventVersion: 1,
      tenantId: deployment.tenantId,
      payload: {
        artifactRef: deployment.artifactRef,
        version: deployment.version,
      },
    });

    return deployment;
  }
}
