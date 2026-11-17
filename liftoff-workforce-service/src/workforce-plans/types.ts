// Workforce Plans Types
//
// A workforce plan is a draft document the Chief AI Officer (CAIO) co-authors
// with a human leader. It describes a set of agents to provision in a single
// batch, plus an optional org chart. Plans go through a
// lifecycle (draft -> pending_approval -> approved -> provisioning -> completed)
// and can be reopened for amendments without a separate amendments table.

export type AgentType = 'agent' | 'workflow';
export type HitlLevel = 1 | 2 | 3 | 4 | 5;

// Lifecycle states. See migration 085 for the CHECK constraint.
export type WorkforcePlanStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'provisioning'
  | 'completed'
  | 'failed';

// Per-spec provisioning status, tracked inside the agents JSONB array.
// `pending` is the default for newly drafted specs that have not yet
// reached the provisioning step.
export type SpecProvisioningStatus =
  | 'pending'
  | 'provisioning'
  | 'completed'
  | 'failed';

/** Section bodies for the two authored prose fields.
 *
 *  Typed slots rather than a markdown blob: the section set is fixed, so asking
 *  for the sections and rendering the headings in code removes any way to
 *  produce a malformed field. */
export interface AgentProseSlots {
  // → responsibilities
  responsibilities?: string;
  goals?: string;
  workflows?: string;
  instructions?: string;
  outcomes?: string;
  // → additionalContext
  specificInstructions?: string;
  rules?: string;
  constraints?: string;
  edgeCases?: string;
  anythingToAvoid?: string;
}

// A single agent specification within a workforce plan. The CAIO generates
// these during conversation via the workforce_plan__draft tool. The HRBP
// Agent consumes them at provisioning time, partitioning connectors into
// connected vs pending and calling the teambuilder distill + create flow.
export interface WorkforcePlanAgentSpec {
  // Stable identifier across drafts so re-provisioning can diff against
  // already-provisioned specs by specId rather than array index.
  specId: string;
  name: string;
  agentType: AgentType;
  department?: string;
  roleSummary: string;
  /** Canonical markdown, composed from `prose` — see agent-prose.ts. Present on
   *  every spec the CAIO drafts; the field remains optional for older rows. */
  responsibilities?: string;
  /** Canonical markdown, composed from `prose`. The second free-text field the
   *  distiller reads, alongside responsibilities. */
  additionalContext?: string;
  /** The authored section bodies the two markdown fields are composed from.
   *  Held on the spec so a redraft can edit one section without the model
   *  reproducing the rest, and so composition stays deterministic. */
  prose?: AgentProseSlots;
  // Connector type names recommended by the CAIO (e.g. ['google-calendar', 'hubspot']).
  // Connected ones are auto-assigned at provisioning; unconnected ones are stored
  // as pending integrations on the created agent.
  connectors?: string[];

  // Provisioning state, populated by the HRBP Agent.
  provisioningStatus?: SpecProvisioningStatus;
  internalAgentId?: string;
  errorMessage?: string;
}

// Optional org chart structure stored on the plan. The CAIO may emit this as
// an inline visualization block in the conversation; the dashboard renders it
// from this field on the plan detail page.
export interface OrgChartNode {
  id: string;
  label: string;
  type?: string;
  department?: string;
}

export interface OrgChartEdge {
  from: string;
  to: string;
  label?: string;
}

export interface OrgChart {
  nodes: OrgChartNode[];
  edges: OrgChartEdge[];
}

// Snapshot of a spec -> internal_agent link persisted at the end of a
// successful HRBP Agent run. Used on the next approve() to detect which
// specs were previously provisioned (for skip / update / removed diff).
export interface ProvisionedSpecRef {
  specId: string;
  internalAgentId: string;
}

// The persisted workforce plan, as returned by the API.
export interface WorkforcePlan {
  id: string;
  tenantId: string;
  accountId: string;
  title: string | null;
  status: WorkforcePlanStatus;
  agents: WorkforcePlanAgentSpec[];
  orgChart: OrgChart | null;
  threadId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** The approver's answer to the builder's question: start each agent as
   *  soon as it is built (true, Launch Now) or leave them as drafts (false,
   *  Maybe Later). Acted on by the provisioning task that finishes last. */
  launchOnCompletion: boolean;
  rejectedReason: string | null;
  revision: number;
  /** Snapshot of {specId -> internalAgentId} from the most recent
   *  successful HRBP run. Empty until the first provisioning completes.
   *  Used on amendments (reopen + re-approve) to diff specs that were
   *  removed and to detect which specs were previously created. */
  lastProvisionedSpecs: ProvisionedSpecRef[];
  /** specIds that were in `lastProvisionedSpecs` but not in the current
   *  `agents` array at the start of the most recent HRBP run. Populated
   *  by the HRBP during re-provisioning and surfaced to the UI as "these
   *  specs were removed from the plan - delete the agents manually on
   *  /teams/update if you want them gone" (no auto-delete). */
  removedSpecIds: string[];
  createdAt: string;
  updatedAt: string;
}

// Inputs

export interface CreateWorkforcePlanInput {
  tenantId: string;
  accountId: string;
  title?: string | null;
  agents?: WorkforcePlanAgentSpec[];
  orgChart?: OrgChart | null;
  threadId?: string | null;
}

// Patch shape for PATCH /workforce-plans/:id. All fields optional. Only
// usable while the plan is in `draft`.
export interface UpdateWorkforcePlanInput {
  title?: string | null;
  agents?: WorkforcePlanAgentSpec[];
  orgChart?: OrgChart | null;
  threadId?: string | null;
}

// Listing

export interface ListWorkforcePlansOptions {
  status?: WorkforcePlanStatus;
  cursor?: string | null;
  limit?: number;
}

export interface PaginatedWorkforcePlans {
  plans: WorkforcePlan[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Lifecycle errors

/**
 * Thrown when a state transition is rejected by the lifecycle state machine.
 * The router maps this to HTTP 409 (conflict).
 */
export class WorkforcePlanLifecycleError extends Error {
  constructor(
    public readonly currentStatus: WorkforcePlanStatus,
    public readonly attempted: string,
    message?: string,
  ) {
    super(message ?? `Cannot ${attempted} a plan in status "${currentStatus}"`);
    this.name = 'WorkforcePlanLifecycleError';
  }
}

/**
 * Thrown when a plan is not found or not visible to the caller. The router
 * maps this to HTTP 404 (intentionally indistinguishable from cross-tenant
 * lookups so we never confirm the existence of foreign plans).
 */
export class WorkforcePlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`Workforce plan ${planId} not found`);
    this.name = 'WorkforcePlanNotFoundError';
  }
}
