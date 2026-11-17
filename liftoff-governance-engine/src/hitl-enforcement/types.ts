// HITL Enforcement Types — governance-engine-local.
//
// Single source of truth for shared shapes is @liftoffos/governance-types
// (packages/governance-types in liftoff-platform-backend). Adding a new
// gate reason, sensitivity category, or super-destructive operation
// happens THERE; every consumer reads it through that package. This
// file declares only what is genuinely gov-engine-specific:
//
//   - `HitlGateError` — runtime control-flow exception; class lives in
//     the service that throws it.
//   - `HitlApprovalPolicy` — gov-engine-specific persistence shape for
//     the hitl_approval_policies table that backs standing-approval
//     auto-resolution. TR doesn't see this shape; it reads decisions
//     via getGovernanceApprovalPolicy() which returns just the
//     decision string.

export {
  ToolCallRequest,
  ModelTool,
  ApprovalStatus,
  ApprovalDecision,
  RejectionCategory,
  ResolveApprovalInput,
  CreateApprovalInput,
  HitlApprovalRequest,
  SensitivityCategory,
  GateReason,
  GateResult,
  OversightSettings,
  SUPER_DESTRUCTIVE_OPERATIONS,
  MERGE_TO_MAIN_TOOL_NAMES,
} from '@liftoffos/governance-types';

import type {
  ToolCallRequest,
  GateReason,
} from '@liftoffos/governance-types';

// HITL gate error — thrown when human approval is required. Local
// because it's a runtime control-flow primitive, not a wire shape.
// `reason` types against the shared `GateReason` union so adding a new
// reason in the shared package automatically flows here.
export class HitlGateError extends Error {
  constructor(
    public readonly pendingToolCalls: ToolCallRequest[],
    public readonly reason: GateReason,
    public readonly matchedCategory?: string,
  ) {
    super('HITL gate: human approval required');
    this.name = 'HitlGateError';
  }
}

// Standing approval policy — persisted to hitl_approval_policies table.
// Gov-engine-specific: TR consumers see only the resolved decision via
// getGovernanceApprovalPolicy() RPC.
export interface HitlApprovalPolicy {
  id: string;
  tenantId: string;
  agentId: string;
  gateReason: string;
  decision: 'approved' | 'rejected';
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  /** Class-scoped grant. NULL/absent = a reason-wide policy (does not clear the
   *  external_content_write gate); a non-null array clears only calls whose bare
   *  action name is in the set. */
  actionClasses?: string[] | null;
}
