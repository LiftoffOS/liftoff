import { useCallback } from 'react'

/** Move focus to an element as soon as it appears.
 *
 *  This is what the `autoFocus` attribute does. jsx-a11y flags that attribute
 *  because on a page load it drops a screen reader somewhere it never asked to
 *  go. Every use of this hook is the other case: a dialog, a picker or a
 *  single-field step that exists because someone just asked for it, where
 *  moving focus in is the expected behaviour and leaving it behind is the bug.
 *
 *  A callback ref rather than an effect, so the timing matches the attribute it
 *  replaces: focus lands when the node attaches, which is also the moment a
 *  conditionally rendered field first appears. The identity is stable, so a
 *  re-render does not re-focus and steal the caret back.
 */
export function useAutoFocus<T extends HTMLElement>() {
  return useCallback((node: T | null) => {
    node?.focus()
  }, [])
}
