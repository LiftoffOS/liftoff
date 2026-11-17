// Inline "waiting for approval" status shown at the top of the chat conversation
// while a tool call is paused for HITL approval (durable MCP HITL, Option 1).
//
// It does NOT approve/reject — that lives on /dashboard/review. The primary CTA
// button points the user there, deep-linked to the pending approval. Kept
// presentational (the parent, AgentChatPage, wires the navigation).
//
// It names whoever the approval was routed to. Threads are shared, so the
// person who triggers a gate is often not the person who can clear it: this
// used to say "waiting on your review" to them regardless, and said nothing to
// anyone else in the thread, leaving a stalled conversation that looked broken
// rather than blocked.
import Button from '../Button'

interface HitlPendingIndicatorProps {
  /** Opens /dashboard/review focused on the pending approval. */
  onOpenReview: () => void
  /** Names of the people it was routed to. Empty when it went to the admins. */
  routedTo?: string[]
  /** True when no assignee could approve and it fell through to the admins. */
  routedToAdmins?: boolean
  /** True when the agent has nobody assigned, so this is open to the workspace
   *  rather than escalated past specific people. */
  unassigned?: boolean
  /** Whether the reader is one of the people being asked. */
  isForYou?: boolean
  /** Whether the reader can actually approve at this gate's level. Telling
   *  somebody a decision is theirs when they cannot make it is the same broken
   *  promise as offering them a button that throws. */
  canApprove?: boolean
}

/** "Ada", "Ada and Grace", "Ada, Grace and 2 others". */
function describePeople(names: string[]): string {
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`
}

interface Wording {
  routedTo: string[]
  routedToAdmins: boolean
  unassigned: boolean
  isForYou: boolean
  canApprove: boolean
}

function waitingOn({ routedTo, routedToAdmins, unassigned, isForYou, canApprove }: Wording): string {
  // Asked, alongside others: name them, so you know somebody else may already
  // be on it. Without this the people responsible learn less than a bystander.
  if (isForYou && routedTo.length > 1) {
    const others = routedTo.filter((_, i) => i > 0)
    return `Waiting on you and ${describePeople(others)}`
  }
  if (isForYou) return 'Waiting on your review to continue'

  // Nobody is assigned, so it belongs to whoever is looking. Second person on
  // purpose: "a workspace member" describes somebody else, and when nobody owns
  // a thing, everybody assuming somebody else will act is how it sits forever.
  if (unassigned && canApprove) return 'Waiting on your review to continue'

  if (routedTo.length > 0) return `Waiting on ${describePeople(routedTo)} to approve`
  // Either escalated past assignees who could not act, or open to a workspace
  // this reader cannot act in. Naming the role is honest in both cases.
  if (routedToAdmins || unassigned) return 'Waiting on a workspace admin to approve'
  // No route resolved. Say what is true rather than naming the wrong person.
  return 'Waiting on a review to continue'
}

export function HitlPendingIndicator({
  onOpenReview,
  routedTo = [],
  routedToAdmins = false,
  unassigned = false,
  isForYou = false,
  canApprove = false,
}: HitlPendingIndicatorProps) {
  // Yours to clear when you were asked directly, or when nobody was asked and
  // you are able to act.
  const yours = isForYou || (unassigned && canApprove)
  return (
    <div className="chat-page__hitl-indicator" role="status" aria-live="polite">
      <span className="chat-page__hitl-indicator__label">
        <span className="chat-page__hitl-indicator__dot" aria-hidden="true" />
        <span className="chat-page__hitl-indicator__text">
          {waitingOn({ routedTo, routedToAdmins, unassigned, isForYou, canApprove })}
        </span>
      </span>
      {/* Anyone may open the queue: admins and owners can act on anything, and
          seeing why a thread stopped is not privileged. The call to action is
          softened when it is somebody else's to clear. */}
      <Button variant={yours ? 'primary' : 'outline'} size="sm" onClick={onOpenReview}>
        {yours ? 'Review' : 'View'}
      </Button>
    </div>
  )
}
