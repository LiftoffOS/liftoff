// Oversight Settings Service
// Manages tenant-level oversight configuration for HITL enforcement

import { api } from './api'

// Oversight setting types
export type AutonomyLevel = 'autonomous' | 'balanced' | 'controlled'
export type EscalationLevel = 'exceptions' | 'important' | 'sensitive'
export type CommunicationMode = 'draft' | 'auto' | 'review'

export interface SensitiveWorkSettings {
  customerCommunication: boolean
  financialActions: boolean
  dataChanges: boolean
  externalPublishing: boolean
  hiringDecisions: boolean
  mergeToMain: boolean
}

export interface OversightSettings {
  tenantId: string
  currentVersion: number
  autonomy: AutonomyLevel
  escalation: EscalationLevel
  sensitiveWork: SensitiveWorkSettings
  communication: CommunicationMode
  createdAt: string
  updatedAt: string
}

export interface UpdateOversightInput {
  autonomy?: AutonomyLevel
  escalation?: EscalationLevel
  sensitiveWork?: SensitiveWorkSettings
  communication?: CommunicationMode
}

// HITL Approval types
/** How an approval ended.
 *
 *  Mirrors `ApprovalStatus` in @liftoffos/governance-types, which is the
 *  authoritative copy — this is a hand-typed duplicate, so it drifts unless
 *  someone remembers. Same hazard as `GateReason` below.
 *
 *  `withdrawn` is written by the SYSTEM, never a person, when the run a question
 *  was raised for ended without it: there is no paused run left to release and
 *  no action left to authorise, so no answer could change anything. The other
 *  four all claim something about a person — approved, refused, or ignored — and
 *  every one of those claims is false for a question that stopped mattering.
 *
 *  It does not appear in the actionable queue, which selects `status = 'pending'`
 *  server-side. That is the intended outcome: the question is closed, so it
 *  leaves. The record of it lives in the audit log rather than the queue. */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'withdrawn'
// The closed set the tenant runtime writes to hitl_approval_requests.reason.
// `external_content_write` is the gate on a run that is working from content
// which arrived from outside the workspace (inbound mail, a webhook payload)
// and now wants to make an effectful call.
// `blast_radius` is the only one about SIZE rather than kind: the change is
// large, measured across the whole run. How large is in the approval's detail
// line, since a single label cannot carry a count.
// `contract_deviation` is a write, outbound or destructive call a confident
// check judged outside what the team was built and approved to do: the
// approved step it dispatches from, or its instructions. Add-only on the
// runtime: it can pause a call that would otherwise have run and never clears
// a pause the category rule raised.
export type GateReason = 'level_1_gate' | 'destructive_gate' | 'super_destructive_gate' | 'sensitive_work' | 'communication_review' | 'rate_limit_exceeded' | 'merge_to_main' | 'external_content_write' | 'blast_radius' | 'contract_deviation'

// Gate reasons too high-risk to offer a standing "always apply" decision — each must get
// a fresh human decision. Mirror of tenant-runtime's standingApprovalAllowed (the backend
// enforces this authoritatively; this only hides the affordance in the UI).
// `blast_radius` belongs here for the reason it exists: a standing "always
// approve" on a gate that fires BECAUSE the change is large would switch the
// feature off on its first use.
const STANDING_APPROVAL_SUPPRESSED: ReadonlySet<GateReason> = new Set<GateReason>([
  'super_destructive_gate', 'merge_to_main', 'sensitive_work', 'blast_radius',
])
export function standingApprovalAllowed(reason: GateReason): boolean {
  return !STANDING_APPROVAL_SUPPRESSED.has(reason)
}

export interface PendingToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface HitlApproval {
  id: string
  tenantId: string
  /** The tenant runtime's own `agents.id`, NOT the `internal_agents.id` the
   *  Teams pages address a team by. The two spaces are disjoint, so this id
   *  matches nothing the client holds and can only be sent back as the queue's
   *  server-side filter. Use `agentName` for anything a person reads. */
  agentId: string
  /** Display name of the agent, resolved by the runtime because only the
   *  runtime can (see `agentId`). Absent from a runtime that predates it, null
   *  when the team's runtime row is gone. */
  agentName?: string | null
  hitlLevel: number
  pendingToolCalls: PendingToolCall[]
  /** What the approver rewrote before saying yes, keyed by tool call id.
   *
   *  Absent on a pending approval (nothing has been decided) and on an ordinary
   *  approval taken as proposed. Present, it is what was actually dispatched,
   *  and `pendingToolCalls` is what the agent wanted to dispatch. The passed
   *  queue needs both: an approval that reads exactly like the agent's draft,
   *  when a person changed it first, misreports what the review did. */
  editedToolInputs?: Record<string, Record<string, unknown>> | null
  reason: GateReason
  status: ApprovalStatus
  decidedBy?: string
  decidedByRole?: string
  decision?: 'approved' | 'rejected'
  rejectionReason?: string
  decidedAt?: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  // Generic HITL card summary generated at the gate (tenant-runtime hitl-card-content.ts)
  // and stored on the approval. Present when the generic-card flag was on; otherwise the
  // page falls back to the raw pending-tool-call list.
  actionSummary?: string | null
  whySummary?: string | null
  detail?: string | null
  /** Free-form provenance attached at the gate by the tenant runtime.
   *
   *  It has always been written and always been forwarded — the runtime sets
   *  `{ origin: 'external_content', screenVerdict? }` on an external-content
   *  gate, and platform-backend's DTO says in as many words that it is "passed
   *  straight through to the /review surface". This type simply never declared
   *  it, so the value arrived in the browser and was dropped: wired at two ends
   *  and discarded at the third.
   *
   *  `declaredStep` says WHICH step of the approved workflow is asking. A card
   *  raised for work that IS in declared scope means something specific now that
   *  declared scope clears the category gate — a hard invariant, level 1, or a
   *  destructive marker — rather than "the gate could not tell". Absent on the
   *  conversational path, where no step declared anything, and on approvals
   *  raised before the runtime carried it. */
  context?: {
    origin?: string
    screenVerdict?: unknown
    declaredStep?: { stepId: string; description?: string | null }
    inDeclaredScope?: boolean
  } | null
}

// PR0: discriminated queue items. The /review queue surfaces both HITL
// approvals AND pending recovery-LLM / Anchor clarification questions.
export interface ApprovalItem extends HitlApproval {
  kind: 'approval'
  /** Set only on the passed view: true when this approval already carries late
   *  feedback, so the card renders as answered instead of offering the form
   *  again and discovering it on submit. */
  lateFeedbackSubmitted?: boolean
}

/** Which view of the queue to fetch: what still needs a person, or the
 *  approvals whose decision window closed without one. */
export type QueueWindow = 'actionable' | 'passed'

export interface ClarificationItem {
  kind: 'clarification'
  id: string
  tenantId: string
  /** Runtime `agents.id`, same caveat as on `HitlApproval`. */
  agentId: string
  /** Display name of the agent. See `HitlApproval.agentName`. */
  agentName?: string | null
  threadId: string
  question: string
  source: 'recovery_llm' | 'anchor_intervention'
  vendorRequestId: string | null
  createdAt: string
  expiresAt: string
}

/** The review queue holds parked runs: an approval waiting on a decision, or a
 *  clarification waiting on an answer. Both resume the run they belong to when
 *  a person supplies one input.
 *
 *  Escalations used to be a third kind here and are deliberately gone. An
 *  escalated run has already ended, so there was nothing an answer could
 *  restart and "Mark resolved" only flipped a row. The runtime now parks a
 *  blocker someone in the workspace can clear as a clarification, and keeps one
 *  only we can clear as an operator record. */
export type QueueItem = ApprovalItem | ClarificationItem

/** Bucketed count of the review queue, computed by the tenant runtime from the
 *  same SQL predicate that produces the page. The buckets partition `total`, so
 *  no surface has to add them up itself: approvals are split Standard (level 1),
 *  Critical (level 2) and Other, because the level runs 1 to 5. */
export interface QueueCounts {
  total: number
  approvalsStandard: number
  approvalsCritical: number
  approvalsOther: number
  clarifications: number
}

export interface PaginatedApprovalsResponse {
  items: QueueItem[]
  cursor: string | null
  hasMore: boolean
  /** Size of the whole queue, not of this page. Null when the backend could not
   *  reach the tenant runtime, so no number is better than a wrong one. */
  total: number | null
  counts: QueueCounts | null
}

/** The pending-count body. `count` repeats `total`; both are null when the
 *  backend could not reach the tenant runtime. */
export interface PendingCountResponse extends Partial<QueueCounts> {
  count: number | null
}

export interface ApproveInput {
  approvalId: string
  approvalNote?: string
}

export interface RejectInput {
  approvalId: string
  reason?: string
}

// Get oversight settings for a tenant
export async function getOversightSettings(tenantId: string): Promise<OversightSettings> {
  return await api.get<OversightSettings>(`/api/internal-agent-oversight/${tenantId}`)
}

// Update oversight settings
export async function updateOversightSettings(
  tenantId: string,
  data: UpdateOversightInput
): Promise<OversightSettings> {
  return await api.put<OversightSettings>(`/api/internal-agent-oversight/${tenantId}`, data)
}

// List the review queue with pagination. There is no status filter: the runtime
// decides what is actionable, and asking for anything else was a parameter the
// backend never read.
export async function listApprovals(
  tenantId: string,
  options?: { cursor?: string; limit?: number; agentId?: string; window?: QueueWindow }
): Promise<PaginatedApprovalsResponse> {
  const params = new URLSearchParams({ tenantId })

  if (options?.cursor) {
    params.append('cursor', options.cursor)
  }
  if (options?.limit) {
    params.append('limit', options.limit.toString())
  }
  if (options?.agentId) {
    params.append('agentId', options.agentId)
  }
  if (options?.window) {
    params.append('window', options.window)
  }

  return await api.get<PaginatedApprovalsResponse>(`/api/internal-agent-oversight/hitl-approvals?${params.toString()}`)
}

// Approve a HITL request
export async function approveRequest(
  approvalId: string,
  tenantId: string,
  /** `approvalNote` is why the approver said yes. Optional, and the mirror of
   *  the rejection reason: until it existed only a refusal could explain
   *  itself, so the learning loop heard half of every decision. */
  options?: {
    alwaysApply?: boolean
    approvalNote?: string
    /** Tool arguments the reviewer rewrote, keyed by pending tool call id.
     *
     *  Whole inputs, not patches: an edit REPLACES a call's arguments, which is
     *  what lets someone take a recipient off a thread rather than only add
     *  one. The decision is still an approval; only which arguments get
     *  dispatched changes. */
    editedToolInputs?: Record<string, Record<string, unknown>>
  }
): Promise<HitlApproval> {
  return await api.post<HitlApproval>(
    `/api/internal-agent-oversight/hitl-approvals/${approvalId}/approve?tenantId=${tenantId}`,
    options ?? {}
  )
}

// Reject a HITL request
export async function rejectRequest(
  approvalId: string,
  tenantId: string,
  reason?: string,
  options?: { alwaysApply?: boolean }
): Promise<HitlApproval> {
  return await api.post<HitlApproval>(
    `/api/internal-agent-oversight/hitl-approvals/${approvalId}/reject?tenantId=${tenantId}`,
    { reason, ...options }
  )
}

// Get the count of review-queue items awaiting a person, bucketed by kind.
// `count` is null when the backend could not reach the tenant runtime: the
// number's job is to be believed, so an unknown count says so rather than
// reporting a zero that reads as "nothing needs you".
export async function getPendingCount(
  tenantId: string,
  options?: { agentId?: string }
): Promise<PendingCountResponse> {
  const params = new URLSearchParams({ tenantId })
  if (options?.agentId) {
    params.append('agentId', options.agentId)
  }

  return await api.get<PendingCountResponse>(
    `/api/internal-agent-oversight/hitl-approvals/pending-count?${params.toString()}`
  )
}

// Late feedback types and function
export type LateFeedbackDecision = 'would_approve' | 'would_reject'

export interface LateFeedbackInput {
  decision: LateFeedbackDecision
  reason?: string
}

export interface LateFeedbackResponse {
  id: string
  approvalId: string
  decision: LateFeedbackDecision
  feedbackProvidedAt: string
  alreadySubmitted?: boolean
}

// Submit late feedback for an expired approval (for agent learning)
export async function submitLateFeedback(
  approvalId: string,
  tenantId: string,
  input: LateFeedbackInput
): Promise<LateFeedbackResponse> {
  return await api.post<LateFeedbackResponse>(
    `/api/internal-agent-oversight/hitl-approvals/${approvalId}/late-feedback?tenantId=${tenantId}`,
    input
  )
}

// Respond to a pending clarification question via the /review queue.
export async function respondToClarification(
  tenantId: string,
  clarificationId: string,
  response: string,
): Promise<void> {
  await api.post(
    `/api/internal-agent-oversight/clarifications/${clarificationId}/respond?tenantId=${tenantId}`,
    { response },
  )
}

/** Decline to answer a pending clarification.
 *
 *  The other half of answering. Until this existed the only way to say no was
 *  to let the ask sit until it expired, which told the team nothing for a day
 *  (a week for a parked blocker) and filed an operator-only record nobody
 *  reads. Declining resumes the run now with no answer available, so the team
 *  can proceed on its own judgement or close the work out.
 *
 *  The reason is optional and follows the rejection reason: it is what the
 *  learning loop reads, not something the run waits on. */
export async function declineClarification(
  tenantId: string,
  clarificationId: string,
  reason?: string,
): Promise<void> {
  await api.post(
    `/api/internal-agent-oversight/clarifications/${clarificationId}/decline?tenantId=${tenantId}`,
    { reason },
  )
}
