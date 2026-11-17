// The phrase shown beside the activity pulse.
//
// It used to be DERIVED here, from the tool's own name: a map of ten, and for
// everything else "Using " plus the name with its underscores knocked out. That
// is how the Chief AI Officer's `team__get_config` reached a person as "Using
// Get_config" — the internal name almost verbatim, in a product whose rule is
// that no assistant shows a person its inner workings.
//
// It could not have worked. Three services put tool names into these streams
// (platform-backend, workforce-service's Chief AI Officer, the Tenant Runtime's
// agents); a browser cannot enumerate them, and the names are not written to
// be read. So the phrase is authored once, in @liftoffos/shared-types, attached
// to the `tool_call` frame by whichever service writes it, and rendered here.
//
// There is deliberately NO map in this file. A second copy of the phrases would
// be the drift this whole change removes — the same tool reading one way on one
// page and another way on another — and it is not needed: platform-backend
// attaches the label to every frame it writes, and workforce-service attaches it
// to the Chief AI Officer's own stream, which reaches the browser through a
// proxy that cannot add one. What is left over is the few minutes of a deploy
// when a service is a version behind, and for that the honest answer is a phrase
// that says nothing rather than a stale guess.

/** Says that work is happening, which is all the pulse beside it says. */
export const NEUTRAL_LABEL = 'Working on it'

/**
 * The phrase for the activity pulse, whole.
 *
 * `label` is what the service authored for this tool. `name` is accepted so the
 * call sites read naturally beside the rest of the streaming state, and so a
 * future fallback has somewhere to go — it is never rendered, never taken
 * apart, never shown.
 */
export function activityLabel(_name: string, label?: string | null): string {
  return label?.trim() || NEUTRAL_LABEL
}
