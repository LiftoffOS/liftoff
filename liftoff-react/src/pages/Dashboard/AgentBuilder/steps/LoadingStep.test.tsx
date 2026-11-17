// The distillation progress checklist.
//
// This screen used to be a single rotating line, and it carried two bugs that
// the rewrite has to keep fixed rather than reintroduce. Six backend stages
// were mapped to single indices, so several lines were unreachable on any run
// that streamed stages; and the same map pinned `generating`, over half the
// wall-clock of a real build, to one line for around twenty-five seconds.
//
// As a checklist the first bug changes shape: every row is on screen from the
// first frame, so nothing is unreachable in the old sense. What must hold is
// that each row actually becomes active and then ticks, because a row that
// jumps straight from pending to done never showed anybody anything.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import LoadingStep from './LoadingStep'
import { DISTILL_STEPS, STILL_RUNNING, distillSteps } from './distillStageMessages'
import type { DistillStage } from '../../../../services/internalAgents'

const ROLE = 'Recruiter'
const BEAT = 6500
const PATIENCE = 16000

function renderStep(stage: DistillStage | null) {
  const utils = render(<LoadingStep role={ROLE} stage={stage} error={null} onRetry={vi.fn()} />)

  const rows = () => [...utils.container.querySelectorAll('.loading-step__step')]
  const active = () => rows().findIndex(r => r.classList.contains('loading-step__step--active'))
  const doneCount = () => rows().filter(r => r.classList.contains('loading-step__step--done')).length
  const settle = (times = 1) => {
    for (let i = 0; i < times; i++) act(() => void vi.advanceTimersByTime(BEAT))
  }
  const setStage = (next: DistillStage) => {
    utils.rerender(<LoadingStep role={ROLE} stage={next} error={null} onRetry={vi.fn()} />)
    settle()
  }
  // Advanced only after settle(), never in the same tick: the patience timer
  // is scheduled by an effect keyed on the active row, so it does not exist
  // until React has flushed the advance that created it.
  const waitPatience = () => act(() => void vi.advanceTimersByTime(PATIENCE))
  return { ...utils, rows, active, doneCount, settle, setStage, waitPatience }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('LoadingStep checklist', () => {
  it('shows the whole job up front, with who it is for', () => {
    const { container, rows } = renderStep('connected')

    expect(container.textContent).toContain('On it.')
    expect(container.textContent).toContain(
      'Hang tight while we get your Recruiter ready. This takes a moment.',
    )
    // All seven visible from the first frame, not revealed one at a time.
    expect(rows()).toHaveLength(DISTILL_STEPS.length)
    DISTILL_STEPS.forEach(label => expect(container.textContent).toContain(label))
  })

  it('marks exactly one row active and ticks the ones behind it', () => {
    const step = renderStep('connected')
    expect(step.active()).toBe(0)
    expect(step.doneCount()).toBe(0)

    step.setStage('generating')

    expect(step.active()).toBe(4)
    expect(step.doneCount()).toBe(4)
    // A row is either done, active, or still to come. Never two at once.
    expect(step.rows().filter(r => r.classList.contains('loading-step__step--active'))).toHaveLength(1)
  })

  it('marks a row by what is true of it: done, working, or not started', () => {
    const step = renderStep('connected')
    step.setStage('generating')

    const mark = (i: number) => {
      const row = step.rows()[i]
      if (row.querySelector('.loading-step__check')) return 'check'
      if (row.querySelector('.loading-step__spinner')) return 'spinner'
      return 'none'
    }

    // A spinner on a queued row claims work is happening that is not.
    expect([0, 1, 2, 3].map(mark)).toEqual(['check', 'check', 'check', 'check'])
    expect(mark(4)).toBe('spinner')
    expect([5, 6].map(mark)).toEqual(['none', 'none'])
  })

  it('keeps the mark column a fixed width so labels do not jog', () => {
    const step = renderStep('generating')

    // Every row has the box, whether or not it has a mark in it.
    expect(step.container.querySelectorAll('.loading-step__mark')).toHaveLength(
      DISTILL_STEPS.length,
    )
  })

  it('gives the longest stage two rows rather than holding one still', () => {
    const step = renderStep('analyzing')
    step.setStage('generating')
    expect(step.active()).toBe(4)

    // The regression: generating owned one row and sat on it for ~25s.
    step.settle()
    expect(step.active()).toBe(5)
  })

  it('holds the last row of a stage until the next stage arrives', () => {
    const step = renderStep('generating')
    step.settle(10)
    expect(step.active()).toBe(5)

    step.setStage('finalizing')
    expect(step.active()).toBe(6)
  })

  it('never moves backwards when a stage opens behind the active row', () => {
    const step = renderStep('analyzing')
    step.settle(2) // span [2,3]: one beat to enter it, one to walk it
    expect(step.active()).toBe(3)

    // absorbing's span is [2,2], which closes behind where analyzing reached.
    step.setStage('absorbing')
    expect(step.active()).toBe(3)
  })

  it('walks the whole list when the stream reports no stage at all', () => {
    const step = renderStep(null)
    expect(step.active()).toBe(0)

    step.settle(DISTILL_STEPS.length)

    expect(step.active()).toBe(DISTILL_STEPS.length - 1)
    expect(step.doneCount()).toBe(DISTILL_STEPS.length - 1)
  })

  describe('the patience line', () => {
    it('stays hidden while rows advance on schedule', () => {
      const step = renderStep('connected')
      step.setStage('generating')

      const shown = step.container.querySelector('.loading-step__patience--shown')
      expect(shown).toBeNull()
    })

    it('appears under the active row once it has run long', () => {
      const step = renderStep('finalizing')
      step.settle()
      step.waitPatience()

      const shown = step.container.querySelector('.loading-step__patience--shown')
      expect(shown?.textContent).toBe(STILL_RUNNING)
      expect(shown?.closest('.loading-step__step')).toBe(step.rows()[6])
    })

    it('is always in the DOM, so revealing it cannot shift the rows', () => {
      const step = renderStep('connected')

      // One per row: reserved height, revealed by opacity. A row that only
      // rendered this on demand would push the list down mid-wait.
      expect(step.container.querySelectorAll('.loading-step__patience')).toHaveLength(
        DISTILL_STEPS.length,
      )
    })

    it('follows the row that is stuck, not the build as a whole', () => {
      const step = renderStep('generating')
      step.settle(2) // walk to the end of generating's span, then stall there
      step.waitPatience()
      expect(step.container.querySelector('.loading-step__patience--shown')).not.toBeNull()

      // Moving on is the answer to "still running", so it goes away again.
      step.setStage('finalizing')
      expect(step.container.querySelector('.loading-step__patience--shown')).toBeNull()
    })
  })

  describe('the update variant', () => {
    it('does not promise day one to a team that already has one', () => {
      const { container } = render(
        <LoadingStep role={ROLE} stage="generating" error={null} onRetry={vi.fn()} variant="update" />,
      )

      expect(container.textContent).toContain('Getting the rest of the changes ready')
      expect(container.textContent).not.toContain('day one')
      expect(container.textContent).toContain('Hang tight while we update your Recruiter.')
      expect(container.textContent).not.toContain('get your Recruiter ready')
    })

    it('changes only the two rows that would otherwise be untrue', () => {
      const build = distillSteps('build')
      const update = distillSteps('update')

      expect(update).toHaveLength(build.length)
      const differing = build.filter((label, i) => label !== update[i])
      expect(differing).toEqual(['Getting the rest ready for day one'])
    })

    it('keeps the stage spans valid, so both read the same progress', () => {
      const step = renderStep('connected')
      step.setStage('generating')
      const buildActive = step.active()

      const updated = render(
        <LoadingStep role={ROLE} stage="generating" error={null} onRetry={vi.fn()} variant="update" />,
      )
      // A fresh mount starts at row 0 and needs one tick to jump to the floor
      // of the stage it was handed.
      act(() => void vi.advanceTimersByTime(BEAT))
      const rows = [...updated.container.querySelectorAll('.loading-step__step')]
      expect(rows.findIndex(r => r.classList.contains('loading-step__step--active')))
        .toBe(buildActive)
    })
  })

  it('maps fetching_tools, the stage the union was missing', () => {
    // The server has always emitted this between `analyzing` and `generating`.
    // The frontend union did not list it, so it arrived unmapped and crashed
    // the render. Every stage the backend can send must resolve to a span.
    const step = renderStep('analyzing')
    step.settle(2)
    const afterAnalyzing = step.active()

    step.setStage('fetching_tools')

    // Continues the analysis window rather than jumping or falling back.
    expect(step.active()).toBe(afterAnalyzing)
    expect(step.container.querySelector('.loading-step__steps')).not.toBeNull()
  })

  it('survives a stage the map has never heard of', () => {
    // The service casts `data.stage` to DistillStage without checking, so the
    // server can hand this component any string. It used to destructure the
    // resulting undefined and throw out of render, which the route error
    // boundary showed as "Something went wrong" over a healthy distillation.
    const rogue = 'queued' as DistillStage

    expect(() =>
      render(<LoadingStep role={ROLE} stage={rogue} error={null} onRetry={vi.fn()} />),
    ).not.toThrow()
  })

  it('keeps walking through an unknown stage rather than freezing', () => {
    const step = renderStep('reticulating' as DistillStage)
    expect(step.active()).toBe(0)

    // Falls back to the no-stage window: the whole list, on the timer.
    step.settle()
    expect(step.active()).toBe(1)
  })

  it('shows the failure and its retry instead of the checklist', () => {
    const onRetry = vi.fn()
    const { container, getByRole } = render(
      <LoadingStep role={ROLE} stage="generating" error="Could not build." onRetry={onRetry} />,
    )

    expect(container.querySelector('.loading-step__steps')).toBeNull()
    expect(container.textContent).toContain('Could not build.')
    act(() => getByRole('button', { name: /try again/i }).click())
    expect(onRetry).toHaveBeenCalled()
  })
})
