// The gate that decides whether the chat notification prompt renders.
//
// AgentChatPage has too many hooks for a full render test, the same reason
// AgentChatPage.deepLink.test.ts exists, so this covers the predicate verbatim.
//
// One rule lives here and it is easy to lose in a refactor: a stopped run
// outranks an offer. The column has a single sticky slot, and HitlPendingIndicator
// owns it whenever an approval is pending.
//
// Note what is NOT in the condition. An earlier version also required the AI
// team to have replied first, which sounded careful and was backwards: it hid
// the offer from exactly the person who has not yet seen what notifications are
// for. Whether the prompt has anything to say is decided inside
// NotificationPromptBar, by this browser's permission.

import { describe, it, expect } from 'vitest'

/** Mirrors the render condition in AgentChatPage: `!pendingApproval`. */
function shouldShowPrompt(pendingApproval: unknown | null): boolean {
  return !pendingApproval
}

describe('chat notification prompt gate', () => {
  it('shows on a conversation that is not blocked', () => {
    expect(shouldShowPrompt(null)).toBe(true)
  })

  // Nothing has been said yet, and that is still the right moment to offer:
  // the person is on a chat page, which is where notifications matter.
  it('shows on an empty conversation', () => {
    expect(shouldShowPrompt(null)).toBe(true)
  })

  // One sticky slot in the column, and a run that has stopped outranks an offer
  // to turn notifications on.
  it('yields to a pending approval', () => {
    expect(shouldShowPrompt({ approvalId: 'a1' })).toBe(false)
  })
})
