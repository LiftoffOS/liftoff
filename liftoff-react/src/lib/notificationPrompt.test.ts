// Dismissal is session-scoped and must fail OPEN.
//
// The failure that matters here is the silent one: sessionStorage throws
// outright in some privacy modes, and a catch that returned `true` would
// suppress the prompt for every one of those users forever, with no error and
// nothing to notice.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isPromptDismissed, dismissPrompt, PROMPT_DISMISS_KEYS } from './notificationPrompt'

describe('notification prompt dismissal', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('is not dismissed until it is dismissed', () => {
    expect(isPromptDismissed('dashboard')).toBe(false)
  })

  it('remembers a dismissal for the session', () => {
    dismissPrompt('dashboard')
    expect(isPromptDismissed('dashboard')).toBe(true)
  })

  // Separate keys per surface: closing the prompt in chat must not silence
  // Settings, where somebody may have gone looking for it deliberately.
  it('keeps the two surfaces independent', () => {
    dismissPrompt('chat')
    expect(isPromptDismissed('chat')).toBe(true)
    expect(isPromptDismissed('dashboard')).toBe(false)
  })

  it('uses distinct storage keys', () => {
    expect(PROMPT_DISMISS_KEYS.chat).not.toBe(PROMPT_DISMISS_KEYS.dashboard)
  })

  it('reports not-dismissed when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is blocked')
    })
    // Fails open. A dismissal is worth less than the prompt, so a storage error
    // must never be the thing that hides it.
    expect(isPromptDismissed('dashboard')).toBe(false)
  })

  it('does not throw when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => dismissPrompt('dashboard')).not.toThrow()
  })
})
