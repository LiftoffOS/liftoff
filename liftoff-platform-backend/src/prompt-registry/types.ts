// Prompt Registry Types
// Per Section 17: Prompt template versions

export interface PromptBundle {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  status: 'draft' | 'approved' | 'deprecated';
  templates: string[]; // template IDs
  createdAt: Date;
  approvedAt: Date | null;
}

export interface PromptTemplate {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  content: string;
  variables: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBundleInput {
  tenantId: string;
  name: string;
  templates: string[];
}

export interface CreateTemplateInput {
  tenantId: string;
  name: string;
  content: string;
  variables: string[];
}

// Per Section 15: Rollout approvals for prompt bundles

export type PromptRolloutStatus = 'pending' | 'approved' | 'rejected' | 'in_progress' | 'completed' | 'rolled_back';

export type PromptRolloutStrategy = 'immediate' | 'canary' | 'gradual' | 'blue_green';

export interface PromptRollout {
  id: string;
  tenantId: string;
  bundleId: string;
  previousBundleId: string | null;
  version: number;
  status: PromptRolloutStatus;
  strategy: PromptRolloutStrategy;
  config: PromptRolloutConfig;

  // Approval tracking
  requestedBy: string;
  requestedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;

  // Rollout progress
  startedAt: Date | null;
  completedAt: Date | null;
  rollbackedAt: Date | null;
  rollbackReason: string | null;

  // Progressive rollout tracking
  currentStep: number;
  currentPercentage: number;
  nextStepAt: Date | null;

  // Metrics
  metrics: PromptRolloutMetrics;

  createdAt: Date;
  updatedAt: Date;
}

export interface PromptRolloutConfig {
  canaryPercentage?: number;
  canaryDurationMinutes?: number;
  gradualSteps?: number[];
  stepDurationMinutes?: number;
  healthCheckEnabled: boolean;
  errorThresholdPercent?: number;
  latencyThresholdMs?: number;
  notifyOnApproval: string[];
  notifyOnFailure: string[];
}

export interface PromptRolloutMetrics {
  requestsTotal: number;
  requestsSuccess: number;
  requestsFailed: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
}

export interface CreatePromptRolloutInput {
  tenantId: string;
  bundleId: string;
  strategy: PromptRolloutStrategy;
  config: PromptRolloutConfig;
  requestedBy: string;
}

export interface ApprovePromptRolloutInput {
  approvedBy: string;
  comment?: string;
}

export interface RejectPromptRolloutInput {
  rejectedBy: string;
  reason: string;
}
