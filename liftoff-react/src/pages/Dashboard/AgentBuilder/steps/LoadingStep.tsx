import { useState, useEffect } from 'react'
import Button from '../../../../components/Button'
import CheckIcon from '../../../../assets/icons/check.svg?react'
import type { DistillStage } from '../../../../services/internalAgents'
// Imported here, not by the callers. Two screens render this component and
// only one of them loads the builder's stylesheet.
import './LoadingStep.css'
// Shared with CompletionStep, which shows the same stage line while a decision
// waits on the artifact. See distillStageMessages.ts for why it is not copied.
import {
  STAGE_TO_RANGE,
  distillSteps,
  STILL_RUNNING,
  distillWaitMessage,
  type DistillVariant,
} from './distillStageMessages'

/** How long a row holds before the checklist walks to the next within a stage. */
const BEAT_MS = 6000

/**
 * How long a row may be the active one before it admits it is taking a while.
 *
 * Longer than a beat on purpose. A row that advances on schedule must never
 * show this, or the reassurance becomes the normal state and stops meaning
 * anything. It is for the stage that has genuinely stalled past its span,
 * which in practice is a slow `generating`.
 */
const PATIENCE_MS = 15000

interface LoadingStepProps {
  role: string
  stage: DistillStage | null
  error: string | null
  onRetry: () => void
  /** Building a new team, or re-optimizing one that already exists. Changes
   *  two of the seven rows and the line under the header. */
  variant?: DistillVariant
}

export default function LoadingStep({ role, stage, error, onRetry, variant = 'build' }: LoadingStepProps) {
  const steps = distillSteps(variant)
  const [activeIndex, setActiveIndex] = useState(0)
  // Which row has outstayed its welcome, rather than a flag that has to be
  // reset on every advance. Same information, no synchronous reset in an
  // effect, and it cannot get out of step with the row it describes.
  const [patientIndex, setPatientIndex] = useState<number | null>(null)

  // The window the current stage permits: `floor` is the row it opens on,
  // `ceiling` the furthest it may walk before the next stage arrives.
  //
  // The lookup can miss, and a miss must not take the screen down. The service
  // casts whatever the server puts in `data.stage` straight to DistillStage
  // without checking it, so a stage this map has never heard of reaches here
  // as a real string, and destructuring the resulting undefined threw
  // "is not iterable" out of a render, which the route error boundary turned
  // into "Something went wrong" on top of a distillation that was running
  // perfectly well. The previous version of this screen guarded it with a
  // `!== undefined` check; the rewrite to spans dropped that by accident.
  //
  // An unknown stage falls back to the same window as no stage at all: the
  // whole list, walked on the timer. Progress keeps moving, and the worst case
  // is pacing that ignores the server rather than a screen that is gone.
  const range = stage ? STAGE_TO_RANGE[stage] : undefined
  const [floor, ceiling] = range ?? [0, steps.length - 1]

  // Never backwards. A stage whose span opens behind where the checklist has
  // already reached advances no further than it must, and a span already
  // exhausted holds its last row until the next stage arrives.
  const nextIndex = Math.min(Math.max(activeIndex + 1, floor), ceiling)

  // A stage arriving is news, so its first row ticks over at once. Walking
  // within a stage is not news, so those rows wait their turn.
  const delay = activeIndex < floor ? 0 : BEAT_MS

  useEffect(() => {
    if (error) return
    if (nextIndex <= activeIndex) return

    const beatTimer = setTimeout(() => setActiveIndex(nextIndex), delay)
    return () => clearTimeout(beatTimer)
  }, [activeIndex, nextIndex, delay, error])

  // The patience line is per row: every advance restarts the clock, so it
  // follows whichever row is actually stuck rather than the build as a whole.
  useEffect(() => {
    if (error) return
    const t = setTimeout(() => setPatientIndex(activeIndex), PATIENCE_MS)
    return () => clearTimeout(t)
  }, [activeIndex, error])

  const beenPatient = patientIndex === activeIndex

  if (error) {
    return (
      <div className="loading-step loading-step--error">
        <h1 className="loading-step__header">Something went wrong</h1>
        <p className="loading-step__error-message">{error}</p>
        <Button variant="primary" onClick={onRetry}>
          Try Again
        </Button>
      </div>
    )
  }

  return (
    <div className="loading-step">
      <h1 className="loading-step__header">
        On it.
        {/* The two trailing dots animate; the period in the text above never
            does. A cycle that blanks all three leaves the header reading
            "On it" with no punctuation at all for a third of every second.
            They are opacity-only, so the centred header cannot shift as they
            come and go, and aria-hidden so this is announced as one sentence. */}
        <span className="loading-step__dots" aria-hidden="true">
          <span className="loading-step__dot">.</span>
          <span className="loading-step__dot">.</span>
        </span>
      </h1>
      <p className="loading-step__wait">{distillWaitMessage(role, variant)}</p>

      {/* Rows are a list, not a <table>: there is one column of prose and no
          header, so table semantics would announce a grid that is not there. */}
      <ol className="loading-step__steps">
        {steps.map((label, i) => {
          const done = i < activeIndex
          const active = i === activeIndex
          return (
            <li
              key={label}
              className={[
                'loading-step__step',
                done && 'loading-step__step--done',
                active && 'loading-step__step--active',
              ].filter(Boolean).join(' ')}
              // The whole list is on screen from the first frame, so the rows
              // below the active one are announced as upcoming rather than as
              // things that have happened.
              aria-current={active ? 'step' : undefined}
            >
              {/* Three states, three marks. A row that has not started shows
                  nothing at all: a spinner is a claim that work is happening,
                  and on a queued row that claim is false. The box keeps its
                  width either way so the labels stay in one column. */}
              <span className="loading-step__mark" aria-hidden="true">
                {done && <CheckIcon className="loading-step__check" />}
                {active && (
                  <span className="loading-spinner loading-spinner--sm loading-step__spinner" />
                )}
              </span>
              <span className="loading-step__label">
                {label}
                {/* Rendered on every active row and revealed by opacity, so the
                    row does not change height when it appears and push the
                    rest of the list down mid-wait. */}
                <span
                  className={`loading-step__patience ${
                    active && beenPatient ? 'loading-step__patience--shown' : ''
                  }`}
                >
                  {STILL_RUNNING}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
