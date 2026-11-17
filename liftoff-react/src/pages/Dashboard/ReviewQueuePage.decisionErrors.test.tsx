// What the queue says when a decision does not land.
//
// Two admins can both open the same request. Only one decision lands: the
// runtime's UPDATE is guarded on `status = 'pending'`, and the loser comes back
// 409 ALREADY_DECIDED. The queue used to report that as "Failed to approve
// request", which tells the second person to retry something a colleague has
// already handled, and makes a lapsed window (410 EXPIRED) look like a broken
// button.
//
// The code only reaches here because the backend now sends it as `code`, the
// field ApiError parses. It was previously sent only as `error`, so
// apiErrorCode() returned undefined and no caller could branch at all.
import { describe, it, expect } from 'vitest'
import { ApiError, apiErrorCode } from '../../services/api'
import { decisionErrorMessage } from './reviewQueueErrors'

describe('apiErrorCode reads what the oversight routes send', () => {
  it('reads the code off an ApiError', () => {
    const err = new ApiError('Cannot approve: request status is approved', 409, undefined, 'ALREADY_DECIDED')
    expect(apiErrorCode(err)).toBe('ALREADY_DECIDED')
  })

  it('returns undefined for a plain Error, which a network failure throws', () => {
    expect(apiErrorCode(new Error('network down'))).toBeUndefined()
  })
})

describe('decision failure messages', () => {
  it('names the colleague case rather than telling someone to retry', () => {
    const err = new ApiError('Cannot approve: request status is approved', 409, undefined, 'ALREADY_DECIDED')

    expect(decisionErrorMessage(err, 'approve')).toBe('Someone else already decided this request')
    // Same message whichever button was pressed: the cause is not the verb.
    expect(decisionErrorMessage(err, 'reject')).toBe('Someone else already decided this request')
  })

  it('distinguishes a lapsed window from a failure', () => {
    const err = new ApiError('Approval has expired', 410, undefined, 'EXPIRED')

    expect(decisionErrorMessage(err, 'approve')).toBe('This request expired before it could be decided')
  })

  it('falls back to the generic message for a real failure', () => {
    expect(decisionErrorMessage(new Error('boom'), 'approve')).toBe('Failed to approve request')
    expect(decisionErrorMessage(new Error('boom'), 'reject')).toBe('Failed to reject request')
  })

  it('falls back for a coded error the queue does not special-case', () => {
    const err = new ApiError('Tampered', 409, undefined, 'TAMPER_DETECTED')

    expect(decisionErrorMessage(err, 'approve')).toBe('Failed to approve request')
  })

  it('obeys the copy rules', () => {
    const messages = [
      decisionErrorMessage(new ApiError('x', 409, undefined, 'ALREADY_DECIDED'), 'approve'),
      decisionErrorMessage(new ApiError('x', 410, undefined, 'EXPIRED'), 'approve'),
    ]
    for (const m of messages) {
      expect(m).not.toMatch(/\bagent\b/i)
      expect(m).not.toContain('—')
      expect(m).not.toMatch(/\w'\w/)
    }
  })
})
