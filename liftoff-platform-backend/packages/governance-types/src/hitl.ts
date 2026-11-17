// HITL (Human-In-The-Loop) approval types — shared between tenant-runtime
// (current home) and the future governance-engine (Phase 3 extraction).

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelTool {
  name: string;
  description?: string;
  categories?: string[];
  draftVariant?: string;
  /** Side-effect class of the tool, used by the external-content write gate.
   *  'read' is the only value that passes ungated when a run's content trust is
   *  untrusted_inbound; 'write' and 'spawn' both gate. Optional on the wire, but
   *  a MISSING effect gates (fail closed) at the runtime check (`effect !== 'read'`)
   *  — platform tools carry a concrete value; vendor tools are classified by
   *  verb-token derivation at catalog-build time. */
  effect?: 'read' | 'write' | 'spawn';
}

/** Sensitivity categories used by the HITL gate.
 *
 *  This union is the source of truth — `OversightSettings.sensitiveWork`
 *  derives from it via `Record<SensitivityCategory, boolean>`, so adding
 *  a category here automatically flows into every consumer that imports
 *  from this package (tenant-runtime gate, governance-engine simulator,
 *  platform-backend oversight router). Adding a category here without
 *  also adding the matching enforcement to BOTH `checkHitlGate` impls
 *  (TR runtime + governance-engine simulator) creates a silent gap. */
export type SensitivityCategory =
  | 'customerCommunication'
  | 'financialActions'
  | 'dataChanges'
  | 'externalPublishing'
  | 'hiringDecisions'
  /** Code merges to main / protected branches. Gated by tool NAME
   *  (MERGE_TO_MAIN_TOOL_NAMES below) rather than by tool category
   *  because GitHub is a vendor-hosted MCP server whose tools are
   *  dynamically discovered and don't carry our category labels. */
  | 'mergeToMain';

/** Why a tool call was gated. */
export type GateReason =
  | 'level_1_gate'
  | 'destructive_gate'
  | 'super_destructive_gate'
  | 'sensitive_work'
  | 'communication_review'
  | 'rate_limit_exceeded'
  | 'merge_to_main'
  /** A write/spawn tool call in a run whose content trust is untrusted_inbound
   *  (external-authored input reached the agent). A platform INVARIANT in the
   *  super_destructive mold — enforced before the level-4/5 autonomy shortcuts,
   *  cleared only by a standing policy whose action_classes cover every pending
   *  call. */
  | 'external_content_write'
  /** The measured SIZE of a change, rather than its kind. Every other reason
   *  here answers "what sort of action is this"; this one answers "how much
   *  does it alter", cumulatively across a run. Carries its measurement in the
   *  approval's detail line, because one static label cannot say how many
   *  records a plan would archive. */
  | 'blast_radius'
  /** A write, outbound or destructive call that a confident contract check
   *  judged OUTSIDE what the agent was built and approved to do — the
   *  declared graph step it dispatches from, or its instructions and role
   *  (tenant-runtime hitl-enforcement/contract-check.ts). Add-only: it can
   *  gate a call that would otherwise have run, and it never clears a gate
   *  the category rule raised. The approval's detail names the contract
   *  checked and the recorded probability. */
  | 'contract_deviation';

/** Tool names that the merge-to-main name-based gate intercepts.
 *
 *  Sourced from PB ADR-003 and matched against the GitHub MCP server's
 *  published tool names. The set is exported so tenant-runtime's
 *  `checkHitlGate` and governance-engine's simulator can both compare
 *  by reference — drift between the two is structurally impossible
 *  because they read the same constant. */
export const MERGE_TO_MAIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'merge_pull_request',
  'squash_and_merge_pull_request',
  'merge_branch',
]);

/** How an approval ended.
 *
 *  `withdrawn` exists because the other four all make a claim about a PERSON,
 *  and one of those claims was always false for a question that should never
 *  have been asked:
 *
 *    approved   a person authorised this
 *    rejected   a person refused this
 *    expired    writes "24h expiry — no operator decision", which reads as a
 *               person who ignored it
 *
 *  An approval raised for work already inside the agent's approved workflow
 *  ends up approved just to unblock the agent, so the record says a human
 *  authorised an action nobody should have been asked about.
 *
 *  `withdrawn` is written by the SYSTEM, never by a person, and only where the
 *  stored row PROVES the question was needless — see `WITHDRAWN_BY_SYSTEM`. It
 *  is not a way to dismiss an awkward decision: an operator cannot set it, so
 *  the queue keeps meaning "these were decided" rather than "these were closed".
 *
 *  A withdrawal is never only a status change. The run that raised the question
 *  is still parked waiting on it, so withdrawing without also releasing the run
 *  leaves it to hit its 24h expiry and write the very "no operator decision"
 *  line this value exists to stop writing — the same falsehood, a few hours
 *  later and out of sight. */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'withdrawn';

/** The only actor permitted on a withdrawal.
 *
 *  Stored in `decided_by` so the audit trail names something that is not a
 *  person. A withdrawal that recorded a human would recreate the exact lie the
 *  value exists to remove. */
export const WITHDRAWN_BY_SYSTEM = 'system:withdrawn' as const;

export type ApprovalDecision = 'approved' | 'rejected';

export type RejectionCategory =
  | 'wrong_recipient'
  | 'incorrect_data'
  | 'wrong_timing'
  | 'too_risky'
  | 'style_mismatch'
  | 'missing_context'
  | 'other';

export interface HitlApprovalRequest {
  id: string;
  tenantId: string;
  workflowId: string;
  taskId: string;
  agentId: string;
  hitlLevel: number;
  pendingToolCalls: ToolCallRequest[];
  toolCallsHash: string;
  reason: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedByRole: string | null;
  decision: ApprovalDecision | null;
  rejectionReason: string | null;
  decidedAt: Date | null;
  idempotencyKey: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  /** Free-form provenance attached at creation — e.g.
   *  `{ origin: 'external_content', screenVerdict?: ... }` for an
   *  external_content_write gate — surfaced on the /review card. */
  context?: Record<string, unknown> | null;
}

export interface CreateApprovalInput {
  tenantId: string;
  workflowId: string;
  taskId: string;
  agentId: string;
  hitlLevel: number;
  pendingToolCalls: ToolCallRequest[];
  reason: string;
  idempotencyKey?: string;
  /** Persisted into hitl_approval_requests.context (JSONB). */
  context?: Record<string, unknown>;
}

export interface ResolveApprovalInput {
  approvalId: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decidedByRole: string;
  rejectionReason?: string;
  rejectionCategory?: RejectionCategory;
  /** Persist a standing-approval policy (`(tenant_id, agent_id,
   *  gate_reason)` row in `hitl_approval_policies`) so future calls
   *  matching the same gate reason auto-resolve without an operator.
   *  Set by the /review UI's "Always apply this decision" checkbox;
   *  consumed by tenant-runtime's resolve handlers when persisting the
   *  policy row. */
  alwaysApply?: boolean;
}

/** Per-tenant oversight settings cached from control plane. */
export interface OversightSettings {
  tenantId: string;
  autonomy: 'autonomous' | 'balanced' | 'controlled';
  escalation: 'exceptions' | 'important' | 'sensitive';
  sensitiveWork: Record<SensitivityCategory, boolean>;
  communication: 'draft' | 'auto' | 'review';
}

export interface GateResult {
  shouldGate: boolean;
  reason?: GateReason;
  matchedCategory?: string;
  message?: string;
}

/** Operations that ALWAYS require HITL regardless of level. */
export const SUPER_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set([
  'delete_tenant',
  'bulk_delete_users',
  'export_all_data',
  'modify_billing',
  'delete_all_memories',
  'revoke_all_api_keys',
]);

// ── Hard invariants, expressed as EFFECTS ────────────────────────────────
//
// Declared scope answers "is this agent doing what it said it would do".
// These answer a different question — "is this an act we never let software
// take alone" — and that question outranks the first. An action carrying one of
// these effects gates whatever an approved workflow declares.
//
// WHY EFFECTS AND NOT NAMES. The two sets above are name lists, and a name list
// has to be remembered once per host, forever. `MERGE_TO_MAIN_TOOL_NAMES` holds
// three GitHub spellings; the runtime declares four code-collaboration hosts
// (github, gitlab, bitbucket, gitea) and resolves trigger-bound review steps on
// all of them. So three of the four have no merge coverage at all, and nothing
// says so — the list looks complete because a list always does.
//
// Naming the EFFECT lets one rule cover hosts whose tool names we have never
// seen. It also makes the gaps sayable, which a list cannot do: see
// KNOWN_UNEXPRESSED_EFFECTS below.
//
// A caution learned while writing this. "Effects, not names" cannot mean "no
// names": vendor-MCP tools are discovered at runtime and carry none of our
// category labels, so a name is the only signal available for a code host. What
// it means is that names are EVIDENCE FOR an effect, and the effect is the unit
// of policy. Matching loosely on a name is how that goes wrong — `merge` as a
// substring appears in `create_merge_request_note` (a comment), in
// `create_merge_request` (which opens one) and in `get_merge_request` (a read),
// none of which merge anything. Gating those would gate a reviewer's own
// commenting step, which is the noise this work exists to remove.

/** Acts no agent takes alone, whatever workflow a human approved. */
export type HardInvariantEffect =
  | 'merge_to_protected_branch'
  | 'destructive_delete'
  | 'money_movement'
  | 'access_change'
  | 'bulk_export';

/** Effects the plan names that this model cannot yet express, and why.
 *
 *  Stated rather than silently missing. A model that lists five effects reads
 *  as complete; these are the two it is not.
 *
 *  force_push — no tool in this estate is known to perform one. Inventing a
 *    name for a tool nobody has enumerated is how `get_pull_request` came to be
 *    referenced for a year on a host that has no such operation.
 *  mass_send — a question of SIZE rather than kind, which `blast-radius-gate`
 *    already answers by measurement. Classifying it by name here would be a
 *    second, worse answer to a question already answered. */
export const KNOWN_UNEXPRESSED_EFFECTS: readonly string[] = ['force_push', 'mass_send'];

/** The effect each already-declared operation carries.
 *
 *  Every member of SUPER_DESTRUCTIVE_OPERATIONS and MERGE_TO_MAIN_TOOL_NAMES
 *  appears here exactly once. That is asserted by a test rather than left to
 *  care: a new super-destructive operation added without an effect would be
 *  gated by the old path and invisible to this one, which is precisely the
 *  half-wired state this model exists to end. */
const EFFECT_BY_OPERATION: ReadonlyMap<string, HardInvariantEffect> = new Map<string, HardInvariantEffect>([
  ['delete_tenant', 'destructive_delete'],
  ['bulk_delete_users', 'destructive_delete'],
  ['delete_all_memories', 'destructive_delete'],
  ['revoke_all_api_keys', 'access_change'],
  ['modify_billing', 'money_movement'],
  ['export_all_data', 'bulk_export'],
  ['merge_pull_request', 'merge_to_protected_branch'],
  ['squash_and_merge_pull_request', 'merge_to_protected_branch'],
  ['merge_branch', 'merge_to_protected_branch'],
]);

/** Leading verbs that MERGE, as opposed to mentioning a merge request. */
const MERGE_VERBS: ReadonlySet<string> = new Set(['merge', 'accept']);

/** Objects a merge verb has to be acting on. `accept_invitation` is not a
 *  merge; `accept_merge_request` is. */
const MERGE_OBJECTS: readonly string[] = ['pull_request', 'merge_request', 'branch'];

/** The bare action from `<alias>__<action>`, or the name itself. */
function bareAction(toolName: string): string {
  const i = toolName.lastIndexOf('__');
  return i < 0 ? toolName : toolName.slice(i + 2);
}

/**
 * The hard-invariant effect a call carries, or undefined.
 *
 * Undefined means "not one of these", NOT "safe" — an unclassified tool is
 * still subject to the ordinary category and level gates, and to declared
 * scope. Only recognised effects are absolute, which keeps the set precise and
 * auditable rather than fail-closed over everything a code host might offer.
 *
 * The merge rule is LEADING VERB plus object, so a host whose spelling we have
 * never seen is still covered: `accept_merge_request` on GitLab resolves the
 * same way `merge_pull_request` does on GitHub, without either being enumerated.
 * `squash_and_merge_pull_request` leads with `squash`, so it stays in the exact
 * map above.
 */
export function hardInvariantEffectOf(toolName: string): HardInvariantEffect | undefined {
  const action = bareAction(toolName).toLowerCase();
  const exact = EFFECT_BY_OPERATION.get(action);
  if (exact) return exact;

  const verb = action.split('_')[0];
  if (MERGE_VERBS.has(verb)) {
    const rest = action.slice(verb.length + 1);
    if (MERGE_OBJECTS.some((o) => rest.includes(o))) return 'merge_to_protected_branch';
  }
  return undefined;
}

// ── The vocabularies, as DATA ────────────────────────────────────────────
//
// `GateReason` and `ApprovalStatus` exist in more places than this package.
// tenant-runtime and governance-engine import them, so they cannot drift. The
// web app CANNOT: liftoff-react has no @liftoffos dependency at all, so it
// carries hand-typed copies in `src/services/oversight.ts`, and nothing
// reconciles them.
//
// That gap has teeth. `ReviewQueuePage` maps a reason through a static
// `Record<GateReason, string>`, and TypeScript checks that record against the
// web app's OWN union — so completeness there is guaranteed only relative to a
// copy that may itself be stale. blast-radius-gate.ts states the consequence
// plainly: an unlabelled reason draws an EMPTY line exactly where the card is
// supposed to say why a person is being asked. `blast_radius` sat unreachable
// in two consumers for two minor versions without anything noticing.
//
// These constants close the half that CAN be closed structurally. A `Record`
// keyed by the union does not compile when a member is added and not listed, so
// the vocabulary cannot grow silently HERE. The test beside them pins the
// resulting member list, and its failure message is what tells whoever adds a
// member that liftoff-react carries a copy needing the same edit.
//
// It does not make drift impossible — only loud, at the moment of the change,
// to the person making it. Making it impossible needs the web app to consume
// this package, which is a deploy-infrastructure change rather than a typing
// one.
//
// `true` rather than a description: a value nobody reads is a value that goes
// stale. The KEYS are the payload.

/** Every `GateReason`. Adding one to the union without listing it here is a
 *  compile error, which is the point. */
export const ALL_GATE_REASONS: Readonly<Record<GateReason, true>> = {
  level_1_gate: true,
  destructive_gate: true,
  super_destructive_gate: true,
  sensitive_work: true,
  communication_review: true,
  rate_limit_exceeded: true,
  merge_to_main: true,
  external_content_write: true,
  blast_radius: true,
  contract_deviation: true,
};

/** Every `ApprovalStatus`, on the same terms. */
export const ALL_APPROVAL_STATUSES: Readonly<Record<ApprovalStatus, true>> = {
  pending: true,
  approved: true,
  rejected: true,
  expired: true,
  withdrawn: true,
};

/** The gate reasons, as a list. Iterable by consumers that need to enumerate
 *  them — a label map, a filter, a migration check — without restating them. */
export const GATE_REASONS = Object.keys(ALL_GATE_REASONS) as readonly GateReason[];

/** The approval statuses, as a list. */
export const APPROVAL_STATUSES = Object.keys(ALL_APPROVAL_STATUSES) as readonly ApprovalStatus[];
