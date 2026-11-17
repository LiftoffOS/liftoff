/**
 * Which rows a RUN writes about itself, as opposed to anything the team said.
 *
 * Their own module, not constants hanging off the component that draws one:
 * the grouping helper and its tests need the set without rendering anything,
 * and a `Set` export beside a component breaks fast refresh.
 *
 * These values are the wire contract with the control plane. Each must match
 * the backend constant of the same name in `agent-chat/run-progress.ts`; a row
 * whose type is not listed here falls through to the ordinary assistant bubble
 * and is attributed to the team, with an avatar and a name.
 */

/** Narration of a run's PROGRESS, appended one line per update while the run
 *  works. */
export const RUN_PROGRESS_MESSAGE_TYPE = 'run_progress'

/** The TERMINAL row: the run stopped without an answer.
 *
 *  Its own type because the backend has to FIND it — the turn after a failed
 *  run is told the run stopped, or the model writes its next reply against a
 *  promise with no outcome and narrates work that never happened. Nothing about
 *  that changes what the row IS on screen: a run reporting on itself, never the
 *  team speaking. It renders exactly as the progress lines it closes and is
 *  grouped with them. */
export const RUN_FAILED_MESSAGE_TYPE = 'run_failed'

/** Every row a run writes ABOUT ITSELF.
 *
 *  ONE set rather than a comparison per site, because the failure mode is a
 *  third type added to some readers and not others — the backend keeps the
 *  identical set (`NARRATION_MESSAGE_TYPES`) for the same reason. */
export const RUN_NARRATION_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  RUN_PROGRESS_MESSAGE_TYPE,
  RUN_FAILED_MESSAGE_TYPE,
])
