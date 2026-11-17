// Session-scoped dismissal for the notification prompts.
//
// sessionStorage, not localStorage, and the difference is the whole point: a
// dismissal lasts for this tab and is gone on a new tab, a new window, or a
// fresh login. localStorage would hide the prompt forever after one impatient
// click, which is not what dismissing something means.
//
// Every access is wrapped. sessionStorage throws outright in some privacy
// modes, and reading it can fail even where writing works.

/** Keys are per surface. Closing the prompt in chat must not silence Settings,
 *  where somebody may have gone looking for it deliberately. */
export const PROMPT_DISMISS_KEYS = {
  dashboard: 'liftoff.push-prompt-dismissed.dashboard',
  chat: 'liftoff.push-prompt-dismissed.chat',
} as const

export type PromptSurface = keyof typeof PROMPT_DISMISS_KEYS

/**
 * Has this surface's prompt been dismissed in this session?
 *
 * Fails OPEN: when storage is unreadable the answer is "not dismissed", so the
 * prompt still renders. A dismissal is worth less than the prompt, so a storage
 * error must never be the thing that suppresses it.
 */
export function isPromptDismissed(surface: PromptSurface): boolean {
  try {
    return sessionStorage.getItem(PROMPT_DISMISS_KEYS[surface]) === '1'
  } catch {
    return false
  }
}

/** Record a dismissal. A failure here is silent by design: the user has already
 *  seen the prompt go away, and an error message about storage would be a
 *  second interruption in place of the one they just closed. */
export function dismissPrompt(surface: PromptSurface): void {
  try {
    sessionStorage.setItem(PROMPT_DISMISS_KEYS[surface], '1')
  } catch {
    // Ignored deliberately — see above.
  }
}
