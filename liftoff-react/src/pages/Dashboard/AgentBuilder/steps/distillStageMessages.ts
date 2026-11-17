import type { DistillStage } from '../../../../services/internalAgents'

/**
 * The progress copy for a running distillation, and the stage it maps from.
 *
 * Extracted from LoadingStep because two screens now show it. Under the waved
 * strategy the confirmation screen renders as soon as the summary lands, while
 * the rest of the artifact is still being generated — so someone who decides
 * quickly is held on the Launch button with work still in flight. The plan
 * (docs/distill-split-plan.md section 4) requires that wait to show the stage
 * rather than a bare spinner: a spinning button reads as stuck, where named
 * progress reads as working.
 *
 * One source, not two copies. The same reason the split plan insists the
 * per-branch tool schemas share one field-description source: the moment the
 * same sentence exists in two files, the two screens start telling the person
 * different things about the same job.
 */

/**
 * The span of messages each backend stage owns, inclusive.
 *
 * This was a stage-to-single-index map, and that was a bug with two faces.
 * The six stages named indices 0, 1, 2, 2, 4 and 7, so messages 3, 5 and 6
 * were unreachable on any run where the backend streamed stages: copy we
 * wrote, shipped, and no customer ever saw. And because a stage pinned
 * exactly one line, `generating` (over half the wall-clock of a real build)
 * sat on one sentence for around twenty-five seconds and then jumped two
 * beats at once. Static text for that long reads as hung.
 *
 * A span fixes both at once. Every message now belongs to exactly one stage,
 * so all eight are reachable, and a long stage has several beats to walk
 * instead of one to sit on. `generating` owning three is the point: it is the
 * longest stage, so it gets the most to say.
 *
 * The contract LoadingStep relies on: spans never move backwards, and
 * together they cover every index of the bank exactly once.
 */
export const STAGE_TO_RANGE: Record<DistillStage, readonly [number, number]> = {
  connected: [0, 0],
  validating: [1, 1],
  // Sorting imported files: it happens before analysis and is usually brief,
  // so it opens the analysis span rather than owning a row of its own.
  absorbing: [2, 2],
  analyzing: [2, 3],
  // Fires back to back with `analyzing`, so it continues that window instead
  // of owning a row that would flash past in the same instant.
  fetching_tools: [2, 3],
  // The longest stage by a wide margin, so it owns two rows rather than
  // holding one still for half the build.
  generating: [4, 5],
  finalizing: [6, 6],
}

/**
 * The seven steps of a build, in the order they happen.
 *
 * These are checklist rows, not a rotating status line: all seven are on
 * screen from the first frame, so someone waiting can see the whole shape of
 * the job and where in it they are. That is a different writing problem from
 * the single line these replaced. A row has to read as a discrete piece of
 * work that finishes, because a tick is about to appear next to it.
 */
/**
 * Which side of the same job this is.
 *
 * The distiller does not care, but the copy has to: five of the seven rows
 * read correctly either way, and two would be a lie on the wrong one. A team
 * being re-optimized has no day one, and is not being got ready, because it
 * already exists and is already running.
 */
export type DistillVariant = 'build' | 'update'

export function distillSteps(variant: DistillVariant = 'build'): readonly string[] {
  return [
    'Initializing',
    'Giving them your context',
    'Showing them what they should work with',
    'Defining the boundaries and setting guardrails for them',
    'Aligning their scope and priorities',
    variant === 'update'
      ? 'Getting the rest of the changes ready'
      : 'Getting the rest ready for day one',
    'Wrapping up',
  ]
}

/** The build wording, for callers with no variant to pass. */
export const DISTILL_STEPS = distillSteps('build')

/** The line under the header, which names who the wait is for. */
export function distillWaitMessage(role: string, variant: DistillVariant = 'build'): string {
  const who = role || 'team member'
  return variant === 'update'
    ? `Hang tight while we update your ${who}. This takes a moment.`
    : `Hang tight while we get your ${who} ready. This takes a moment.`
}

/** Shown under a row that has outstayed its welcome. See LoadingStep. */
export const STILL_RUNNING = 'Still running - thanks for your patience'


/**
 * The single line to show while a decision waits on the artifact.
 *
 * Deliberately not the whole eight-beat animation. By the time this is on
 * screen the person has already read the summary and committed; they need to
 * know the work is moving, not to be walked through it again. A null stage
 * (the stream has not reported one yet) still returns a line, because the
 * alternative is the bare spinner this exists to avoid.
 */
export function distillStageMessage(stage: DistillStage | null): string {
  if (!stage) return DISTILL_STEPS[DISTILL_STEPS.length - 1]
  const range = STAGE_TO_RANGE[stage]
  if (range === undefined) return DISTILL_STEPS[DISTILL_STEPS.length - 1]
  // The span's first row, which is the one LoadingStep marks active on
  // entering the stage. This screen does not walk the span: see the note above.
  return DISTILL_STEPS[Math.min(range[0], DISTILL_STEPS.length - 1)]
}
