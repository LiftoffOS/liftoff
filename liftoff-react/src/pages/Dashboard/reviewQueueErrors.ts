// What the queue says when a decision or a clarification does not land.
import { ApiError, apiErrorCode } from '../../services/api'

export function decisionErrorMessage(error: unknown, verb: 'approve' | 'reject'): string {
  switch (apiErrorCode(error)) {
    case 'ALREADY_DECIDED':
      return 'Someone else already decided this request'
    case 'EXPIRED':
      return 'This request expired before it could be decided'
    default:
      return `Failed to ${verb} request`
  }
}

/** What to say when a clarification action does not land.
 *
 *  The same problem approvals already solved. The queue is shared and the
 *  window is finite, so the ordinary failure here is not a fault: a colleague
 *  answered it, or it lapsed, while this panel sat open. Reporting that as
 *  "Failed to send" sends the reader back to retry something already settled.
 *
 *  Keyed on status rather than an error code because these routes answer with
 *  a message, not the machine-readable code the approval routes carry. */
export function clarificationErrorMessage(error: unknown, verb: 'answer' | 'decline'): string {
  const status = error instanceof ApiError ? error.status : undefined
  if (status === 404) return 'This question is no longer waiting for an answer'
  if (status === 409) {
    if (error instanceof ApiError && /cannot be declined/i.test(error.message)) {
      return 'This question cannot be declined'
    }
    return 'Someone else already answered this question'
  }
  return verb === 'decline' ? 'Failed to send' : 'Failed to send reply'
}
