// Deployment Types

export interface Deployment {
  id: string;
  tenantId: string;
  version: number;
  status: 'pending' | 'approved' | 'deployed' | 'rolled_back';
  artifactRef: string;
  createdAt: Date;
  approvedAt: Date | null;
  deployedAt: Date | null;
}

export interface CreateDeploymentInput {
  tenantId: string;
  artifactRef: string;
}
