// Tenant Types

export type TenantTier = 'standard' | 'enterprise';
export type HostingMode = 'shared' | 'dedicated';

// Fused-onboarding (migration 260) types.
export type OnboardingPath = 'A' | 'B';

// The onboarding wizard's steps (ADR-050):
//   welcome -> workspace_name -> persona -> plan -> payment -> invite
//
// Skipping at `plan` jumps straight to `invite`, so `payment` is only reached by
// someone who chose a plan. Mirrored by the CHECK constraint in migration 366
// and by the PATCH zod enum in ./router.ts -- all three must stay in step.
//
// 'hire_gallery', 'hire_confirm' and 'provisioning' were removed in migration
// 366 once migration 365 had rewritten every row that held one. 'all_set' went
// the same way in 371, once 370 had normalized its rows and the serving
// revision had stopped producing it -- `invite` is the terminal step and ends
// the wizard from either of its two exits.
export type OnboardingStepId =
  | 'welcome'
  | 'workspace_name'
  | 'persona'
  | 'plan'
  | 'payment'
  | 'invite';
// OnboardingHireChosenStatus, OnboardingFullDistillStatus/Stage, HireSubStep
// and OnboardingHireInput lived here. They described the first hire being
// carried across the payment boundary during onboarding — a shape that no
// longer exists (ADR-050), backed by columns dropped in the follow-up release.

export interface Tenant {
  id: string;
  accountId: string;
  name: string;
  tier: TenantTier;
  hostingMode: HostingMode;
  status: 'pending' | 'active' | 'suspended' | 'churned';
  gcpProjectId: string | null;
  databaseName: string | null;
  runtimeUrl: string | null;
  migrationStatus: 'pending' | 'in_progress' | 'completed' | 'failed';
  hasCreatedInternalAgent: boolean;
  harvestEnabled: boolean;
  // Onboarding wizard state (see /dashboard/onboarding). Lets a tenant resume
  // mid-flow on next sign-in and lets the dashboard gate the full sidebar /
  // routes on whether onboarding has been finished.
  onboardingStep: number;
  onboardingPersona: string | null;
  onboardingCompletedAt: Date | null;

  // Fused-onboarding fields (migration 260). NULL on legacy completed tenants.
  onboardingPath: OnboardingPath | null;
  onboardingStepId: OnboardingStepId | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface OnboardingProgressUpdate {
  step?: number;
  persona?: string | null;
  completed?: boolean;
  // Fused-onboarding fields. These accept partial input — the repository
  // method translates each to a column-level update.
  onboardingPath?: OnboardingPath;
  onboardingStepId?: OnboardingStepId;
}

export interface ProvisionTenantInput {
  accountId: string;
  // Optional. If omitted, the service derives it server-side from
  // onboardingPath + the account's firstName. The hero/auto-provision
  // flow relies on this so the path is the only thing the client asserts.
  name?: string;
  tier?: TenantTier;
  // hostingMode defaults to 'shared' on signup. Dedicated is set later via
  // the admin upgrade endpoint, not at provision time.
  hostingMode?: HostingMode;
  // Persisted onto tenants.onboarding_path at insert time and used to pick
  // the default workspace name when `name` is not provided.
  onboardingPath?: OnboardingPath;
}

export interface MigrationStatus {
  tenant_id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress_percentage: number;
  started_at: Date | null;
  completed_at: Date | null;
  current_step: string | null;
  total_steps: number;
  completed_steps: number;
  error_message: string | null;
}

export interface MigrationHistoryEntry {
  id: string;
  tenant_id: string;
  from_version: string;
  to_version: string;
  status: 'completed' | 'failed' | 'rolled_back';
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  records_migrated: number;
  error_message: string | null;
}

export interface MigrationResponse {
  status: MigrationStatus;
  history: MigrationHistoryEntry[];
}
