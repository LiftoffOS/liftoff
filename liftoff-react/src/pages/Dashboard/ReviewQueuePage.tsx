// ReviewQueuePage - HITL Approval Queue
// Per implementation plan: Phase 1.5 Review Queue with pagination and accessibility

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router'
import CheckIcon from '../../assets/icons/check.svg?react'
import FilterIcon from '../../assets/icons/filter.svg?react'
import ClipboardIcon from '../../assets/icons/clipboard.svg?react'
import TriangleAlertIcon from '../../assets/icons/triangle-alert.svg?react'
import { BackButton, Button, Checkbox, Dropdown, EmptyState, Markdown, PageHeader, SegmentedControl, StatusDot } from '../../components'
import { useToast } from '../../contexts/ToastContext'
import { decisionErrorMessage, clarificationErrorMessage } from './reviewQueueErrors'
import {
  useApprovals,
  useApproveRequest,
  useDeclineClarification,
  usePendingApprovalCount,
  useRejectRequest,
  useRespondToClarification,
  useSubmitLateFeedback,
} from '../../hooks/useOversight'
import type {
  ApprovalItem,
  ClarificationItem,
  GateReason,
  HitlApproval,
  QueueItem,
  QueueWindow,
} from '../../services/oversight'
import { standingApprovalAllowed } from '../../services/oversight'
import { track } from '../../lib/analytics'
import { markdownPreviewLine } from '../../utils/markdown'
import { detailNote } from '../../utils/toolCallDetails'
import { TextResponseForm } from './components/TextResponseForm'
import { ToolCallDetails } from './components/ToolCallDetails'
import { hasRealEdits } from '../../utils/editableToolInput'
import './ReviewQueuePage.css'

// Level display labels - meaningful names instead of "Level 1/2"
// Oversight level display labels. Only the levels a person can act on have
// one, and a level with no label renders NOTHING rather than falling back to
// the raw number.
//
// The fallback used to print `Level 3`, which is internal vocabulary: there is
// no setting on this page called "Level 3", and the number changes nothing
// about whether to approve. It was also actively misleading, because 3 is the
// neutral level the runtime substitutes when oversight is unresolved — so a
// reader taking it as "my workspace is set to 3" would be drawing a conclusion
// the value cannot support.
//
// The badge is a label, not a readout. When there is nothing to label, the
// reason line below it already says why the decision is being asked for.
const levelLabels: Record<number, string> = {
  1: 'Standard',
  2: 'Critical',
}

// Reason display labels. Every reason the runtime can write needs one: an
// unlabelled reason renders as an empty line where the card and the panel both
// say why this is being asked, which is the one thing a review row is for.
// Keep in step with `GateReason` in @liftoffos/governance-types, which is the
// authoritative copy. There are THREE: the shared package, the services that
// import it, and this hand-typed union in services/oversight.ts. TypeScript
// checks this Record against OUR copy, so completeness here is only relative to
// a union that can itself be stale.
//
// `reasonLabel()` below is the guard for that. blast-radius-gate.ts states the
// stake plainly: the queue maps reasons through this static record, and an
// unlabelled reason draws an EMPTY line exactly where the card is supposed to
// say why a person is being asked.
const reasonLabels: Record<GateReason, string> = {
  level_1_gate: 'Full review required',
  destructive_gate: 'High-impact change',
  super_destructive_gate: 'Critical change',
  sensitive_work: 'Sensitive action',
  communication_review: 'Review before sending',
  rate_limit_exceeded: 'Rate limit exceeded',
  merge_to_main: 'Merge to main branch',
  external_content_write: 'Acting on outside content',
  blast_radius: 'Large-scale change',
  contract_deviation: 'Outside the approved work',
}

/** The label for a gate reason, degrading rather than rendering nothing.
 *
 *  A reason this build has not been taught is still a real reason a person is
 *  being asked, so it renders as needing review instead of as a blank. Same
 *  choice as the assignee endpoints degrading on an unknown level, and as the
 *  level badge that now renders nothing rather than the internal word "Level 3". */
function reasonLabel(reason: GateReason): string {
  return reasonLabels[reason] ?? 'Needs review'
}

// Filter type - includes 'passed' for items where decision window has passed
type LevelFilter = 'all' | 'standard' | 'critical' | 'passed'

/** Who is asking. The heading on every card and every panel on this page.
 *
 *  The name has to arrive on the item; this page cannot derive it. `agentId`
 *  here is the tenant runtime's own `agents.id`, a different id space from the
 *  `internal_agents.id` the Teams pages address a team by, so looking it up in
 *  anything the client holds matches nothing.
 *
 *  The fallback is for a team whose runtime row is gone. It says so in words
 *  rather than showing an id nobody can act on, and it does not say "agent"
 *  (INV-UI-003). */
function agentLabel(item: { agentName?: string | null }): string {
  return item.agentName?.trim() || 'Unknown agent'
}

// Format relative time
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) {
    return diffMins === 1 ? '1 minute ago' : `${diffMins} minutes ago`
  }
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) {
    return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`
  }
  const diffDays = Math.floor(diffHours / 24)
  return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`
}

// Check if approval is expiring soon (< 1 hour)
function isExpiringSoon(expiresAt: string): boolean {
  const diffMs = new Date(expiresAt).getTime() - Date.now()
  return diffMs > 0 && diffMs < 3600000 // 1 hour
}

// Format decision deadline for user display
// Shows when the human needs to decide before the agent times out
function formatDeadlineTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  // Already expired - agent has been notified of timeout
  if (diffMs <= 0) {
    return 'Decision window passed'
  }

  // Very urgent - less than 15 minutes remaining
  if (diffMins < 15) {
    return 'Decision needed soon'
  }

  // Format time as "2:40 PM"
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  // Check if deadline is today or a future day
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const deadlineDay = new Date(date)
  deadlineDay.setHours(0, 0, 0, 0)

  if (deadlineDay.getTime() >= tomorrow.getTime()) {
    // Include date for future days (e.g., "Decision by Mar 26, 2:40 PM")
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
    return `Decision by ${dateStr}, ${timeStr}`
  }

  return `Decision by ${timeStr}`
}

// Loading skeleton
function ReviewQueueSkeleton() {
  const navigate = useNavigate()
  return (
    <div className="review-queue-page">
      <BackButton onClick={() => navigate('/dashboard/oversight')} />
      <div className="review-queue-page__content">
        <PageHeader title="Review" />

        {/* Filter toggle - same structure as loaded state, counts show as dashes while loading */}
        <div className="review-queue-page__filters-row">
          <SegmentedControl
            value="all"
            onChange={() => {}}
            options={[
              { value: 'all', label: 'All (–)', icon: <StatusDot color="var(--color-black)" /> },
              { value: 'standard', label: 'Standard (–)', icon: <StatusDot variant="warning" /> },
              { value: 'critical', label: 'Critical (–)', icon: <StatusDot variant="error" /> },
              { value: 'passed', label: 'Passed', icon: <StatusDot variant="neutral" /> },
            ]}
          />
          <Dropdown
            value="all"
            onChange={() => {}}
            disabled
            options={[{ value: 'all', label: 'All' }]}
          />
        </div>

        <div className="review-queue-page__layout">
          <div className="approval-list">
            {[1, 2, 3].map((i) => (
              <div key={i} className="approval-card approval-card--skeleton skeleton-pulse">
                <div className="skeleton skeleton--text" style={{ width: '40%' }} />
                <div className="skeleton skeleton--title" style={{ width: '70%' }} />
                <div className="skeleton skeleton--text" style={{ width: '50%' }} />
              </div>
            ))}
          </div>
          <div className="approval-panel">
            <div className="approval-panel__empty">
              <div className="skeleton skeleton--icon skeleton-pulse" />
              <div className="skeleton skeleton--text skeleton-pulse" style={{ width: '140px' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Approval card component
interface ApprovalCardProps {
  approval: HitlApproval
  isSelected: boolean
  onSelect: () => void
}

function ApprovalCard({ approval, isSelected, onSelect }: ApprovalCardProps) {
  return (
    <button
      className={`approval-card ${isSelected ? 'approval-card--selected' : ''}`}
      data-item-id={approval.id}
      onClick={onSelect}
      aria-pressed={isSelected}
    >
      <div className="approval-card__header">
        {levelLabels[approval.hitlLevel] && (
          <span className={`approval-card__level approval-card__level--${approval.hitlLevel}`}>
            {levelLabels[approval.hitlLevel]}
          </span>
        )}
        <span className="approval-card__time">{formatRelativeTime(approval.createdAt)}</span>
      </div>
      <h3 className="approval-card__title">
        {agentLabel(approval)}
      </h3>
      <p className="approval-card__reason">{reasonLabel(approval.reason)}</p>
      <div className="approval-card__footer">
        <span className="approval-card__tools">
          {approval.pendingToolCalls.length} action{approval.pendingToolCalls.length !== 1 ? 's' : ''}
        </span>
        <span className={`approval-card__expiry ${isExpiringSoon(approval.expiresAt) ? 'approval-card__expiry--warning' : ''}`}>
          {formatDeadlineTime(approval.expiresAt)}
        </span>
      </div>
    </button>
  )
}

/** "View branch on GitHub" for a merge approval.
 *
 *  Only for `merge_to_main`, and only when the call carries the three fields a
 *  compare URL needs. A merge is the one gate where the request cannot be
 *  judged from the panel alone: the reader has to see the diff. */
function MergeBranchLink({ approval }: { approval: ApprovalItem }) {
  if (approval.reason !== 'merge_to_main') return null
  const input = approval.pendingToolCalls?.[0]?.input as
    { owner?: string; repo?: string; head?: string } | undefined
  if (!input?.owner || !input?.repo || !input?.head) return null

  return (
    <div className="approval-detail__branch-link">
      <a
        href={`https://github.com/${input.owner}/${input.repo}/compare/${input.head}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => track('review_github_branch_link_clicked', { approval_id: approval.id })}
      >
        View branch on GitHub ↗
      </a>
    </div>
  )
}

// Approval detail panel
interface ApprovalDetailProps {
  approval: ApprovalItem
  onApprove: (
    alwaysApply?: boolean,
    approvalNote?: string,
    editedToolInputs?: Record<string, Record<string, unknown>>,
  ) => void
  onReject: (reason?: string, alwaysApply?: boolean) => void
  isApproving: boolean
  isRejecting: boolean
  /** True when this card came from the passed view. The runtime decides which
   *  view an approval belongs to, and it puts a lapsed-but-unswept approval in
   *  the passed one while the row still reads 'pending' for another half hour. */
  decisionWindowClosed: boolean
  /** Late feedback landed. The page reports it and moves to the next item, the
   *  same as it does for a live decision — this used to be the one action on
   *  the page that left the reader where they were. */
  onFeedbackSubmitted: () => void
}

function ApprovalDetail({
  approval, onApprove, onReject, isApproving, isRejecting, decisionWindowClosed,
  onFeedbackSubmitted,
}: ApprovalDetailProps) {
  const [rejectionReason, setRejectionReason] = useState('')
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [alwaysApply, setAlwaysApply] = useState(false)

  // Late feedback (for expired approvals) - same UI, different backend
  const { mutate: submitFeedback, isPending: isSubmitting } = useSubmitLateFeedback()
  // A late "would have approved" carries a note the same way a rejection does.
  // The backend has always accepted `reason` on both decisions; only the
  // rejection half was ever sending one, so half the signal reaching the
  // reflection engine arrived with no explanation attached.
  const [showApproveForm, setShowApproveForm] = useState(false)
  const [approvalNote, setApprovalNote] = useState('')
  // A live approval can now carry a note too. Kept off the fast path: Approve
  // stays one click, and this only opens when somebody chooses to explain.
  const [showApproveNoteForm, setShowApproveNoteForm] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // What the reader rewrote before approving, keyed by tool call id. Held here
  // rather than inside the card so it survives the card collapsing, and so both
  // Approve buttons send the same thing.
  const [editedToolInputs, setEditedToolInputs] = useState<Record<string, Record<string, unknown>>>({})

  // The runtime's own verdict, not a second opinion formed from the browser
  // clock. Which view this card came from is the answer: a lapsed approval
  // still reads status='pending' for up to half an hour after its window
  // closes, and a clock comparison here could only ever disagree with the
  // predicate that put it in front of the reader.
  const isExpired = decisionWindowClosed || approval.status === 'expired'

  // Already answered, so the form would only lead to "already submitted".
  const alreadyAnswered = approval.lateFeedbackSubmitted === true

  const calls = approval.pendingToolCalls ?? []
  const note = detailNote(approval.detail, calls)

  // Only the calls whose arguments actually differ from what the agent
  // proposed. Somebody who opens the editor, reads, and changes nothing has
  // approved the draft; sending their untouched copy back would record an
  // override that never happened.
  const changed = Object.fromEntries(
    Object.entries(editedToolInputs).filter(([callId, input]) =>
      hasRealEdits(calls.find((c) => c.id === callId)?.input, input),
    ),
  )
  const realEdits = Object.keys(changed).length > 0 ? changed : undefined

  // Switching to a different approval starts the form over. Done while
  // rendering, so the new approval is never shown for a frame carrying the
  // previous one's typed reason and open forms.
  const [formFor, setFormFor] = useState(approval.id)
  if (approval.id !== formFor) {
    setFormFor(approval.id)
    setRejectionReason('')
    setShowRejectForm(false)
    setAlwaysApply(false)
    setShowApproveForm(false)
    setShowApproveNoteForm(false)
    setEditedToolInputs({})
    setApprovalNote('')
    setSubmitError(null)
  }

  const handleReject = () => {
    onReject(rejectionReason || undefined, alwaysApply)
    setShowRejectForm(false)
    setRejectionReason('')
    setAlwaysApply(false)
  }

  // Already on record from a previous visit. This is why the passed page
  // carries lateFeedbackSubmitted at all: without it the form is offered again
  // and the only way to find out is to submit and be told it was already
  // answered. Feedback submitted *here* no longer lands on this branch — the
  // page advances to the next item and reports it with a toast, the same as a
  // live decision.
  if (alreadyAnswered) {
    return (
      <div className="approval-detail approval-detail--feedback-submitted">
        <div className="approval-panel__empty">
          <div className="approval-empty__visual">
            <div className="approval-empty__visual-center">
              <CheckIcon />
            </div>
            <div className="approval-empty__visual-orbit">
              <div className="approval-empty__visual-sparkle" />
              <div className="approval-empty__visual-sparkle" />
              <div className="approval-empty__visual-sparkle" />
              <div className="approval-empty__visual-sparkle" />
              <div className="approval-empty__visual-sparkle" />
            </div>
          </div>
          <p>Feedback submitted</p>
          <span>Your input will help improve Agent decisions</span>
        </div>
      </div>
    )
  }

  // Same layout for both pending and expired - only actions differ
  return (
    <div className="approval-detail">
      <div className="approval-detail__header">
        <h2 className="approval-detail__title">
          {agentLabel(approval)}
        </h2>
        {levelLabels[approval.hitlLevel] && (
          <span className={`approval-detail__level approval-detail__level--${approval.hitlLevel}`}>
            {levelLabels[approval.hitlLevel]}
          </span>
        )}
      </div>

      <div className="approval-detail__meta">
        <span className="approval-detail__reason">{reasonLabel(approval.reason)}</span>
        {/* WHICH part of the approved workflow is asking.
          *
          * Shown ONLY when the action is in declared scope, and then as the
          * step's own description rather than its id.
          *
          * The id was internal vocabulary — the same mistake as the `Level 3`
          * badge `c1bf9f0` removed: a raw step id told an operator nothing they
          * could act on, and sat beside a reason line that already explained the
          * gate.
          *
          * Nothing is rendered for a deviation. It read as a second, competing
          * reason, and it can also be WRONG: an approval can carry "Acting on
          * outside content" (true) above a deviation line (false — the step is
          * a declared step of that very workflow). One line
          * right and one wrong, asserted with equal confidence, is worse than
          * the right line alone. */}
        {approval.context?.declaredStep && approval.context.inDeclaredScope ? (
          <span className="approval-detail__scope">
            {approval.context.declaredStep.description
              ?? 'Part of this agent\'s approved workflow'}
          </span>
        ) : null}
        <span className="approval-detail__time">Requested {formatRelativeTime(approval.createdAt)}</span>
        <span className={`approval-detail__expiry ${!isExpired && isExpiringSoon(approval.expiresAt) ? 'approval-detail__expiry--warning' : ''}`}>
          {formatDeadlineTime(approval.expiresAt)}
        </span>
      </div>

      <section className="approval-detail__section">
        <h3 className="approval-detail__section-title">Requested Actions</h3>
        <div className="approval-detail__summary">
          {/* The prose the gate wrote for this row (hitl-card-content.ts), the
              same Action / Why the Slack and Teams cards show. Older rows and
              a disabled flag have none, and the calls below stand alone. */}
          {approval.actionSummary ? (
            <Markdown className="approval-detail__action">{approval.actionSummary}</Markdown>
          ) : null}
          {approval.whySummary ? (
            <p className="approval-detail__why">
              <strong>Why:</strong>{' '}
              <Markdown inline>{approval.whySummary}</Markdown>
            </p>
          ) : null}
          {/* Only what the stored detail line says that the calls below do not:
              the blast-radius measurement, or an older row's free prose. The
              rest of that line IS the flattened call, and rendering it put a
              cut-off JSON blob under the summary. */}
          {note ? (
            <Markdown className="approval-detail__detail">{note}</Markdown>
          ) : null}
          {/* Editing is offered only while a decision is still open. A passed
              approval is a record of what happened, and an editor on one would
              invite a change that can no longer go anywhere. */}
          <ToolCallDetails
            calls={calls}
            {...(isExpired
              // A decided approval shows what was SENT, which is the approver's
              // version when they rewrote it. Reading the agent's draft here
              // would report that the review passed the call through unchanged.
              ? { edits: approval.editedToolInputs ?? undefined, editsAreRecorded: true }
              : {
                  edits: editedToolInputs,
                  onEdit: (callId: string, input: Record<string, unknown>) =>
                    setEditedToolInputs((prev) => ({ ...prev, [callId]: input })),
                })}
          />
        </div>

        {/* The branch being merged, whichever way the actions above rendered.
            This used to sit inside the fallback only, so the one approval that
            most needs it never showed it: the gate writes a card summary for
            every request now, which is the other branch. */}
        <MergeBranchLink approval={approval} />
      </section>

      {/* Belongs to the panel, not to one branch of it. While it lived inside
          the actions block, a submission that failed with the note form still
          open reported nothing at all: the branch holding the alert was not
          the branch on screen. */}
      {submitError && (
        <div className="late-feedback__error" role="alert">
          {submitError}
        </div>
      )}

      {showApproveNoteForm ? (
        <div className="approval-detail__reject-form">
          <TextResponseForm
            value={approvalNote}
            onChange={setApprovalNote}
            onCancel={() => {
              setShowApproveNoteForm(false)
              setApprovalNote('')
            }}
            onConfirm={() => {
              track('review_approve_clicked', { approval_id: approval.id, always_apply: alwaysApply })
              onApprove(alwaysApply, approvalNote.trim() || undefined, realEdits)
            }}
            label="Why are you approving this (optional)"
            placeholder="Explain what makes this the right call..."
            confirmLabel={isApproving ? 'Approving...' : 'Approve'}
            confirming={isApproving}
            extraControls={standingApprovalAllowed(approval.reason) ? (
              <Checkbox
                checked={alwaysApply}
                onChange={setAlwaysApply}
                label="Always apply this decision for similar requests from this Agent"
              />
            ) : undefined}
          />
        </div>
      ) : showApproveForm ? (
        <div className="approval-detail__reject-form">
          <TextResponseForm
            value={approvalNote}
            onChange={setApprovalNote}
            onCancel={() => {
              setShowApproveForm(false)
              setApprovalNote('')
            }}
            onConfirm={() => {
              track('review_late_feedback_submitted', { approval_id: approval.id, decision: 'would_approve' })
              submitFeedback(
                { approvalId: approval.id, decision: 'would_approve', reason: approvalNote || undefined },
                {
                  onSuccess: onFeedbackSubmitted,
                  onError: (error) => setSubmitError(error instanceof Error ? error.message : 'Failed to submit'),
                }
              )
            }}
            label="What would you have approved, and why (optional)"
            placeholder="Explain what made this the right call..."
            confirmLabel={isSubmitting ? 'Sending...' : 'Confirm'}
            confirming={isSubmitting}
          />
        </div>
      ) : showRejectForm ? (
        <div className="approval-detail__reject-form">
          <TextResponseForm
            value={rejectionReason}
            onChange={setRejectionReason}
            onCancel={() => {
              setShowRejectForm(false)
              setRejectionReason('')
              setAlwaysApply(false)
            }}
            onConfirm={() => {
              if (isExpired) {
                track('review_late_feedback_submitted', { approval_id: approval.id, decision: 'would_reject' })
                submitFeedback(
                  { approvalId: approval.id, decision: 'would_reject', reason: rejectionReason || undefined },
                  {
                    onSuccess: onFeedbackSubmitted,
                    onError: (error) => setSubmitError(error instanceof Error ? error.message : 'Failed to submit'),
                  }
                )
              } else {
                handleReject()
              }
            }}
            label="Rejection reason (optional)"
            placeholder="Explain why this request is being rejected..."
            confirmLabel={(isRejecting || isSubmitting) ? 'Rejecting...' : 'Confirm Reject'}
            confirming={isRejecting || isSubmitting}
            extraControls={(!isExpired && standingApprovalAllowed(approval.reason)) ? (
              <Checkbox
                checked={alwaysApply}
                onChange={setAlwaysApply}
                label="Always apply this decision for similar requests from this Agent"
              />
            ) : undefined}
          />
        </div>
      ) : (
        <div className="approval-detail__actions">
          <div className="approval-detail__action-buttons">
            {!isExpired && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  track('review_approve_note_form_opened', { approval_id: approval.id })
                  setApprovalNote('')
                  setShowApproveNoteForm(true)
                }}
                disabled={isApproving || isRejecting || isSubmitting}
              >
                Add a Note
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                track('review_reject_form_opened', { approval_id: approval.id })
                setShowRejectForm(true)
              }}
              disabled={isApproving || isRejecting || isSubmitting}
            >
              Reject
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (isExpired) {
                  // A note, the same as the rejection half offers. Nothing is
                  // being decided here — the window is closed — so the whole
                  // value of the answer is the explanation it carries.
                  track('review_late_feedback_form_opened', { approval_id: approval.id, decision: 'would_approve' })
                  setShowApproveForm(true)
                } else {
                  track('review_approve_clicked', { approval_id: approval.id, always_apply: alwaysApply })
                  onApprove(alwaysApply, undefined, realEdits)
                }
              }}
              disabled={isApproving || isRejecting || isSubmitting}
            >
              {(isApproving || isSubmitting) ? 'Approving...' : 'Approve'}
            </Button>
          </div>
          {/* A line of its own under the buttons. Sharing their row put a
              sentence of body-sized text beside Approve, and it read as part
              of the button group rather than as the choice it modifies. */}
          {!isExpired && (
            <div className="approval-detail__always-apply">
              <Checkbox
                checked={alwaysApply}
                onChange={setAlwaysApply}
                label="Always apply this decision for similar requests from this Agent"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// PR0: Clarification card variant for the unified /review queue. Renders a
// "Question" badge instead of a level badge, hides tool-call counts, and shows
// the first line of the question text as the body.
interface ClarificationCardProps {
  clarification: ClarificationItem
  isSelected: boolean
  onSelect: () => void
}

function ClarificationCard({ clarification, isSelected, onSelect }: ClarificationCardProps) {
  // The question is markdown. A card has one line to give it, so the preview
  // takes the words without the markup — raw `**` and backticks in a teaser
  // read as broken text, and the panel beside it renders the whole thing.
  const firstLine = markdownPreviewLine(clarification.question)
  return (
    <button
      className={`approval-card ${isSelected ? 'approval-card--selected' : ''}`}
      data-item-id={clarification.id}
      onClick={onSelect}
      aria-pressed={isSelected}
    >
      <div className="approval-card__header">
        <span className="approval-card__level approval-card__level--clarification">
          Question
        </span>
        <span className="approval-card__time">{formatRelativeTime(clarification.createdAt)}</span>
      </div>
      <h3 className="approval-card__title">
        {agentLabel(clarification)}
      </h3>
      <p className="approval-card__reason">{firstLine}</p>
    </button>
  )
}

// Clarification detail panel, laid out as the approval panel is: the same
// header, the same meta row, the same section wrapper, the same action area.
// The two kinds ask a person for different things, but they are the same job
// on this page and reading as one surface matters more than either variant.
//
// There is no "open in chat" link. A clarification raised by an autonomous run
// carries a thread the runtime minted in its own database, which the chat API
// cannot resolve — the link led to a 404 the page renders as an empty
// conversation, telling the reader there is nothing there while the question
// sat in front of them.
interface ClarificationDetailProps {
  clarification: ClarificationItem
  onSubmit: (response: string) => void
  onDecline: (reason?: string) => void
  isSubmitting: boolean
  isDeclining: boolean
}

function ClarificationDetail({
  clarification, onSubmit, onDecline, isSubmitting, isDeclining,
}: ClarificationDetailProps) {
  const [response, setResponse] = useState('')
  const [showDeclineForm, setShowDeclineForm] = useState(false)
  const [declineReason, setDeclineReason] = useState('')

  // Same for clarifications: a different question gets an empty answer box.
  const [answerFor, setAnswerFor] = useState(clarification.id)
  if (clarification.id !== answerFor) {
    setAnswerFor(clarification.id)
    setResponse('')
    setShowDeclineForm(false)
    setDeclineReason('')
  }

  const busy = isSubmitting || isDeclining

  /** An Anchor intervention has no decline.
   *
   *  Every other clarification resumes by handing text to the agent, which can
   *  read "no answer is available" and act on it. An Anchor row resumes by
   *  handing text to a live browser session, and the vendor exposes no abort —
   *  so a decline would type that sentence into somebody's browser as though it
   *  were the instruction they were waiting for. Anchor self-terminates its own
   *  interventions well inside the window, so nothing is stranded by leaving
   *  the affordance out. The backend refuses it too. */
  const canDecline = clarification.source !== 'anchor_intervention'

  return (
    <div className="approval-detail">
      <div className="approval-detail__header">
        <h2 className="approval-detail__title">
          {agentLabel(clarification)}
        </h2>
        <span className="approval-detail__level approval-detail__level--clarification">
          Question
        </span>
      </div>

      <div className="approval-detail__meta">
        <span className="approval-detail__reason">Waiting on an answer</span>
        <span className="approval-detail__time">Asked {formatRelativeTime(clarification.createdAt)}</span>
        <span className={`approval-detail__expiry ${isExpiringSoon(clarification.expiresAt) ? 'approval-detail__expiry--warning' : ''}`}>
          {formatDeadlineTime(clarification.expiresAt)}
        </span>
      </div>

      <section className="approval-detail__section">
        <h3 className="approval-detail__section-title">Question</h3>
        {/* Written by the team as markdown: ids and tool names in backticks,
            the thing being asked in bold, the options as a list. Rendered as
            text it showed the reader the asterisks instead. */}
        <Markdown className="approval-detail__question">{clarification.question}</Markdown>
      </section>

      {showDeclineForm ? (
        <div className="approval-detail__reject-form">
          <TextResponseForm
            value={declineReason}
            onChange={setDeclineReason}
            onCancel={() => {
              setShowDeclineForm(false)
              setDeclineReason('')
            }}
            onConfirm={() => {
              track('review_clarification_declined', {
                clarification_id: clarification.id,
                reason_provided: !!declineReason.trim(),
              })
              onDecline(declineReason.trim() || undefined)
            }}
            label="Reason (optional)"
            placeholder="Say why, or what to do instead"
            confirmLabel={isDeclining ? 'Sending...' : 'Confirm'}
            confirming={isDeclining}
          />
        </div>
      ) : (
        <div className="approval-detail__reject-form">
          <TextResponseForm
            value={response}
            onChange={setResponse}
            onCancel={() => setResponse('')}
            onConfirm={() => {
              if (!response.trim()) return
              track('review_clarification_responded', { clarification_id: clarification.id })
              onSubmit(response)
            }}
            label="Your answer"
            placeholder="Type your reply..."
            confirmLabel={isSubmitting ? 'Sending...' : 'Send'}
            confirming={busy}
            secondaryAction={canDecline ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  track('review_clarification_decline_form_opened', { clarification_id: clarification.id })
                  setShowDeclineForm(true)
                }}
                disabled={busy}
              >
                Continue Anyway
              </Button>
            ) : undefined}
          />
        </div>
      )}
    </div>
  )
}

/** What to say when a decision does not land.
 *
 *  The backend already distinguishes these: a decision that lost a race to a
 *  colleague comes back 409 ALREADY_DECIDED, and a lapsed window comes back 410
 *  EXPIRED. Reporting both as "Failed to approve request" told the second
 *  person to retry something a colleague had already handled, and made a closed
 *  window look like a broken button. The queue refreshes on failure either way,
 *  so the row disappears as they read this.
 *
 *  Exported so its test exercises this function rather than a copy of it. */
export default function ReviewQueuePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { showToast } = useToast()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const viewedRef = useRef(false)

  // Handle deep link selection from dashboard
  const [linkedFrom, setLinkedFrom] = useState(location.state)
  if (location.state !== linkedFrom) {
    setLinkedFrom(location.state)
    const state = location.state as { selectedApprovalId?: string } | null
    if (state?.selectedApprovalId) {
      setSelectedId(state.selectedApprovalId)
    }
  }

  // ARIA live region ref for announcements [FIX: FE-005]
  const announceRef = useRef<HTMLDivElement>(null)

  // Fetch the queue with infinite scroll [FIX: FE-004]. The agent filter is a
  // server-side scope, not a filter over whatever happens to be loaded, so the
  // page and its counts describe the same set.
  //
  // "Passed" is a different view rather than a filter over this one: those
  // approvals are, by definition, the ones the actionable queue excludes.
  const agentIdFilter = agentFilter === 'all' ? undefined : agentFilter
  const queueWindow: QueueWindow = levelFilter === 'passed' ? 'passed' : 'actionable'
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    error,
    refetch,
  } = useApprovals({ agentId: agentIdFilter, window: queueWindow })

  // Counts come from the runtime, bucketed by kind. Nothing here recounts them.
  const { data: queueCounts, isFetched: countsFetched } = usePendingApprovalCount({
    agentId: agentIdFilter,
  })

  const { mutate: approve, isPending: isApproving } = useApproveRequest()
  const { mutate: reject, isPending: isRejecting } = useRejectRequest()
  const { mutate: respondClarification, isPending: isResponding } = useRespondToClarification()
  const { mutate: declineClarificationMutate, isPending: isDeclining } = useDeclineClarification()

  // Show toast on error
  useEffect(() => {
    if (error) {
      showToast('Failed to load review queue.', 'error')
    }
  }, [error, showToast])

  // Announce action results for accessibility [FIX: FE-005]
  const announce = useCallback((message: string) => {
    if (announceRef.current) {
      announceRef.current.textContent = message
    }
  }, [])

  // Flatten pages into single array of discriminated QueueItems.
  const allItems: QueueItem[] = data?.pages.flatMap((page) => page.items) ?? []
  const allApprovals: ApprovalItem[] = allItems.filter(
    (item): item is ApprovalItem => item.kind === 'approval',
  )
  const allClarifications: ClarificationItem[] = allItems.filter(
    (item): item is ClarificationItem => item.kind === 'clarification',
  )
  // Size of the queue, from the runtime. Null while unknown (the backend could
  // not reach it), which reads as "no number" rather than as zero.
  const totalCount = queueCounts?.total ?? null

  /** The queue could not be read, as distinct from having nothing in it.
   *
   *  When the tenant runtime is unreachable the backend's circuit breaker
   *  answers the listing with `{ items: [], nextCursor: null }` while the count
   *  deliberately reports null rather than inventing a zero. Those two halves
   *  of one response disagree, and the page believed the list: a reader with a
   *  full queue was shown the all-clear, which is the one thing a queue must
   *  never say when it does not know.
   *
   *  A null total next to an empty page is that disagreement. A genuinely
   *  empty queue reports zero.
   *
   *  Read from the page itself rather than the separate count query. The count
   *  query takes no window, so on the Passed view its null-ness would be a
   *  statement about the actionable queue; the page's own `total` rides the
   *  same response as the items it is being compared against. */
  const listTotalUnknown = data?.pages?.[0] ? data.pages[0].total === null : false
  const queueUnavailable =
    !isLoading && allItems.length === 0 && (!!error || listTotalUnknown)

  // Reported once the count is known, so the event carries the size of the
  // queue rather than a null that only means "the count had not arrived yet".
  useEffect(() => {
    if (viewedRef.current || isLoading || !countsFetched) return
    viewedRef.current = true
    track('review_viewed', { pending_count: totalCount })
  }, [isLoading, countsFetched, totalCount])

  // Team names for the dropdown, accumulated across everything seen this
  // session. Filtering is server-side now, so a list rebuilt from the current
  // page would collapse to the selected team and strand the reader there.
  const [knownAgents, setKnownAgents] = useState<Record<string, string>>({})
  // allItems is rebuilt every render, so the ids are what actually change.
  const agentIdKey = allItems.map((item) => item.agentId).join(',')
  const [seenAgentIdKey, setSeenAgentIdKey] = useState('')
  if (agentIdKey !== seenAgentIdKey) {
    setSeenAgentIdKey(agentIdKey)
    const discovered: Record<string, string> = {}
    for (const item of allItems) {
      if (knownAgents[item.agentId]) continue
      discovered[item.agentId] = agentLabel(item)
    }
    if (Object.keys(discovered).length > 0) {
      setKnownAgents((previous) => ({ ...discovered, ...previous }))
    }
  }

  const uniqueAgents = useMemo(
    () => Object.entries(knownAgents)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [knownAgents],
  )

  // Infinite scroll. The list is its own scroll container, so the sentinel is
  // observed against it rather than the viewport; reaching the end of what has
  // been loaded is the request for more, and there is nothing to press.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = listRef.current?.querySelector<HTMLDivElement>('.approval-list__sentinel')
    if (!sentinel || !hasNextPage) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isFetchingNextPage) {
          track('review_next_page_loaded', { page_index: data?.pages.length ?? 0 })
          fetchNextPage()
        }
      },
      { root: listRef.current, threshold: 0.1 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // allItems.length: a page landing moves the sentinel, so the observer has
    // to be re-attached to it in its new position.
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, allItems.length, data?.pages.length])

  // Only the level split is left to do here. The agent scope, and which view
  // the feed is (actionable or passed), are both applied server-side, so this
  // no longer re-decides either.
  //
  // Not memoized: allApprovals is rebuilt by a filter on every render, so a
  // useMemo keyed on it recomputed every render anyway while stopping the
  // compiler from memoizing anything else in this component.
  const approvals =
    levelFilter === 'standard' ? allApprovals.filter((a) => a.hitlLevel === 1)
    : levelFilter === 'critical' ? allApprovals.filter((a) => a.hitlLevel === 2)
    // 'all' and 'passed' each render their whole feed.
    : allApprovals

  // No level filter applies to clarifications.
  const clarifications = allClarifications

  // Counts for the filter badges, straight from the runtime.
  const standardCount = queueCounts?.approvalsStandard ?? 0
  const criticalCount = queueCounts?.approvalsCritical ?? 0

  // Resolve selection across the three kinds.
  const selectedApproval = approvals.find((a) => a.id === selectedId)
  const selectedClarification = clarifications.find((c) => c.id === selectedId)

  // The queue in the order it is rendered: approvals, then clarifications when
  // no severity filter is narrowing the feed.
  const renderedIds = useMemo(
    () => [
      ...approvals.map((a) => a.id),
      ...(levelFilter === 'all' ? clarifications.map((c) => c.id) : []),
    ],
    [approvals, clarifications, levelFilter],
  )

  /** Where selection lands once the current item is gone: the next one down, or
   *  the one above it when it was last.
   *
   *  Resolved before the mutation runs, not after. Every decision removes its
   *  row from the cache optimistically, so by the time the success handler
   *  fires this list has already been rebuilt without the item and there is no
   *  longer a position to advance from. */
  const advanceFrom = useCallback(
    (id: string): string | null => {
      const index = renderedIds.indexOf(id)
      if (index === -1) return null
      return renderedIds[index + 1] ?? renderedIds[index - 1] ?? null
    },
    [renderedIds],
  )

  // Handle approve
  const handleApprove = useCallback((
    approvalId: string,
    alwaysApply?: boolean,
    approvalNote?: string,
    editedToolInputs?: Record<string, Record<string, unknown>>,
  ) => {
    const nextId = advanceFrom(approvalId)
    approve({ approvalId, alwaysApply, approvalNote, editedToolInputs }, {
      onSuccess: () => {
        track('approval_decision_made', { approval_id: approvalId, decision: 'approve', always_apply: !!alwaysApply })
        announce('Approval request approved')
        showToast('Request approved', 'success')
        setSelectedId(nextId)
      },
      onError: (error) => {
        const message = decisionErrorMessage(error, 'approve')
        announce(message)
        showToast(message, 'error')
        setSelectedId(null)
      },
    })
  }, [approve, announce, showToast, advanceFrom])

  // Handle reject
  const handleReject = useCallback((approvalId: string, reason?: string, alwaysApply?: boolean) => {
    const nextId = advanceFrom(approvalId)
    reject({ approvalId, reason, alwaysApply }, {
      onSuccess: () => {
        track('review_reject_confirmed', {
          approval_id: approvalId,
          always_apply: !!alwaysApply,
          reason_provided: !!reason,
        })
        track('approval_decision_made', { approval_id: approvalId, decision: 'reject', always_apply: !!alwaysApply })
        announce('Approval request rejected')
        showToast('Request rejected', 'success')
        setSelectedId(nextId)
      },
      onError: (error) => {
        const message = decisionErrorMessage(error, 'reject')
        announce(message)
        showToast(message, 'error')
        setSelectedId(null)
      },
    })
  }, [reject, announce, showToast, advanceFrom])

  // PR0: handle clarification response.
  const handleRespondClarification = useCallback((clarificationId: string, response: string) => {
    const nextId = advanceFrom(clarificationId)
    respondClarification({ clarificationId, response }, {
      onSuccess: () => {
        announce('Reply sent')
        showToast('Reply sent', 'success')
        setSelectedId(nextId)
      },
      onError: (error) => {
        const message = clarificationErrorMessage(error, 'answer')
        announce(message)
        showToast(message, 'error')
      },
    })
  }, [respondClarification, announce, showToast, advanceFrom])

  // Keep the selected card in view. Selection now moves on its own after every
  // decision, and in a long queue the next item is often below the fold: the
  // panel would change while the list looked untouched. `block: 'nearest'` is
  // a no-op when the card is already visible, so clicking one never jumps.
  useEffect(() => {
    if (!selectedId) return
    const card = listRef.current?.querySelector<HTMLElement>(`[data-item-id="${selectedId}"]`)
    // jsdom has neither layout nor scrollIntoView.
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedId])

  /** Late feedback landed on the passed view.
   *
   *  Nothing is removed from the feed — the approval stays passed, it simply
   *  now carries an answer — so this only reports the result and moves on. It
   *  was the one action on the page that left the reader parked on an item
   *  they had finished with. */
  const handleLateFeedbackSubmitted = useCallback((approvalId: string) => {
    const nextId = advanceFrom(approvalId)
    announce('Feedback submitted')
    showToast('Feedback submitted. Your input will help improve Agent decisions', 'success')
    setSelectedId(nextId)
  }, [advanceFrom, announce, showToast])

  /** Decline: the run resumes with no answer available.
   *
   *  Reported as its own outcome rather than borrowing the reply wording. The
   *  team was told something definite and moved on, which is a different thing
   *  from having been answered and a different thing again from being ignored
   *  until the ask expired. */
  const handleDeclineClarification = useCallback((clarificationId: string, reason?: string) => {
    const nextId = advanceFrom(clarificationId)
    declineClarificationMutate({ clarificationId, reason }, {
      onSuccess: () => {
        announce('Marked as cannot answer')
        showToast('The team will proceed without an answer', 'success')
        setSelectedId(nextId)
      },
      onError: (error) => {
        const message = clarificationErrorMessage(error, 'decline')
        announce(message)
        showToast(message, 'error')
      },
    })
  }, [declineClarificationMutate, announce, showToast, advanceFrom])

  const handleBack = () => navigate('/dashboard/oversight')

  // Loading state
  if (isLoading) {
    return <ReviewQueueSkeleton />
  }

  return (
    <div className="review-queue-page">
      {/* ARIA live region for announcements [FIX: FE-005] */}
      <div
        ref={announceRef}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />

      <BackButton onClick={handleBack} />

      <div className="review-queue-page__content">
        <PageHeader title="Review" />

        {/* Filters row - level toggles left, agent dropdown right */}
        <div className="review-queue-page__filters-row">
          <SegmentedControl
            value={levelFilter}
            onChange={(v) => {
              track('review_level_filter_changed', { filter: v })
              setLevelFilter(v)
            }}
            options={[
              {
                // The runtime's total for this view. It used to be assembled
                // here from unfiltered approval counts plus filtered
                // clarifications, which disagreed with the list
                // below it whenever an agent was selected.
                value: 'all',
                label: totalCount ? `All (${totalCount})` : 'All',
                icon: <StatusDot color="var(--color-black)" />,
              },
              {
                value: 'standard',
                label: standardCount > 0 ? `Standard (${standardCount})` : 'Standard',
                icon: <StatusDot variant="warning" />,
              },
              {
                value: 'critical',
                label: criticalCount > 0 ? `Critical (${criticalCount})` : 'Critical',
                icon: <StatusDot variant="error" />,
              },
              {
                value: 'passed',
                label: 'Passed',
                icon: <StatusDot variant="neutral" />,
              },
            ]}
          />

          {/* Agent filter dropdown */}
          {uniqueAgents.length > 1 && (
            <Dropdown
              className="review-queue-page__agent-filter"
              value={agentFilter}
              onChange={(value) => {
                track('review_agent_filter_changed', { agent_id_selected: value !== 'all' })
                setAgentFilter(value)
              }}
              options={[
                { value: 'all', label: 'All' },
                ...uniqueAgents.map((agent) => ({
                  value: agent.id,
                  label: agent.name,
                })),
              ]}
            />
          )}
        </div>

        {/* Two very different facts share this slot: the queue is empty, and
            the queue could not be read. Only the first is good news, and the
            page used to deliver it for both. (Still-loading never reaches here
            — ReviewQueueSkeleton returns above.) */}
        {queueUnavailable ? (
          <div className="review-queue-empty">
            <EmptyState
              className="review-queue-empty__content"
              icon={<TriangleAlertIcon width="32" height="32" />}
              title="This queue could not be loaded"
              description="Items may be waiting. Try again in a moment."
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    track('review_queue_reload_clicked', {})
                    void refetch()
                  }}
                >
                  Try Again
                </Button>
              }
            />
          </div>
        ) : allItems.length === 0 ? (
          <div className="review-queue-empty">
            <div className="review-queue-empty__content">
              <div className="approval-empty__visual approval-empty__visual--large">
                <div className="approval-empty__visual-center">
                  <CheckIcon />
                </div>
                <div className="approval-empty__visual-orbit">
                  <div className="approval-empty__visual-sparkle" />
                  <div className="approval-empty__visual-sparkle" />
                  <div className="approval-empty__visual-sparkle" />
                  <div className="approval-empty__visual-sparkle" />
                  <div className="approval-empty__visual-sparkle" />
                </div>
              </div>
              <h1 className="review-queue-empty__header">All Caught Up!</h1>
              <p className="review-queue-empty__subtext">Check back later.</p>
            </div>
          </div>
        ) : (
          <div className="review-queue-page__layout">
            {/* Approval + clarification list */}
            <div className="approval-list" ref={listRef}>
              {approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  isSelected={selectedId === approval.id}
                  onSelect={() => {
                    track('review_approval_selected', {
                      approval_id: approval.id,
                      hitl_level: approval.hitlLevel,
                      reason: approval.reason,
                    })
                    setSelectedId(approval.id)
                  }}
                />
              ))}
              {/* Clarifications only render in the unfiltered "All" view —
                  Standard / Critical / Passed are approval-specific filters
                  (hitlLevel + decision-window) that don't apply to
                  free-text questions an agent has asked. */}
              {levelFilter === 'all' && clarifications.map((clarification) => (
                <ClarificationCard
                  key={clarification.id}
                  clarification={clarification}
                  isSelected={selectedId === clarification.id}
                  onSelect={() => {
                    track('review_clarification_selected', {
                      clarification_id: clarification.id,
                      source: clarification.source,
                    })
                    setSelectedId(clarification.id)
                  }}
                />
              ))}
              {hasNextPage && (
                <div className="approval-list__sentinel">
                  {isFetchingNextPage && (
                    <div
                      className="loading-spinner loading-spinner--sm"
                      role="status"
                      aria-label="Loading more items"
                    />
                  )}
                </div>
              )}
            </div>

            {/* Detail panel */}
            <div className="approval-panel">
              {selectedApproval ? (
                <ApprovalDetail
                  approval={selectedApproval}
                  onApprove={(alwaysApply, approvalNote, editedToolInputs) =>
                    handleApprove(selectedApproval.id, alwaysApply, approvalNote, editedToolInputs)}
                  onReject={(reason, alwaysApply) => handleReject(selectedApproval.id, reason, alwaysApply)}
                  isApproving={isApproving}
                  isRejecting={isRejecting}
                  decisionWindowClosed={queueWindow === 'passed'}
                  onFeedbackSubmitted={() => handleLateFeedbackSubmitted(selectedApproval.id)}
                />
              ) : selectedClarification ? (
                <ClarificationDetail
                  clarification={selectedClarification}
                  onSubmit={(response) => handleRespondClarification(selectedClarification.id, response)}
                  onDecline={(reason) => handleDeclineClarification(selectedClarification.id, reason)}
                  isSubmitting={isResponding}
                  isDeclining={isDeclining}
                />
              ) : approvals.length === 0 && clarifications.length === 0 ? (
              <EmptyState
                className="approval-panel__empty"
                icon={<FilterIcon />}
                title={`No ${levelFilter === 'all' ? '' : levelFilter} items`}
                description="Try selecting a different filter"
              />
            ) : (
              <EmptyState
                className="approval-panel__empty"
                icon={<ClipboardIcon />}
                title="Select an item"
                description="Pending requests are waiting on your decision"
              />
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
