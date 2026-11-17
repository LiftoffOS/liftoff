import { describe, it, expect } from 'vitest'
import { groupRunProgress, collapsedLabel } from './runProgressGrouping'
import { RUN_NARRATION_MESSAGE_TYPES } from './runNarration'

const P = 'run_progress'
/** The terminal row: the run stopped without an answer. Its own type on the
 *  wire, the same run on screen. */
const F = 'run_failed'
const N = RUN_NARRATION_MESSAGE_TYPES
const m = (id: string, role: string, content = id, messageType?: string) => ({ id, role, content, messageType })

describe('groupRunProgress', () => {
  it('folds a run’s lines into ONE item even though the summary follows the reply', () => {
    // The real shape. The closing summary is written after the answer, so a
    // run's rows are not contiguous. Grouping on adjacency split this in two and
    // left "This run took 1 minute" sitting alone after the answer — the exact
    // thing the folding was meant to remove.
    const out = groupRunProgress([
      m('q', 'user'),
      m('p1', 'assistant', 'Step 2 of 4', P),
      m('p2', 'assistant', 'Step 3 of 4', P),
      m('reply', 'assistant', 'The browser has navigated to Hodinkee.'),
      m('p3', 'assistant', 'This run took 1 minute.', P),
    ], N)
    expect(out.map((i) => i.kind)).toEqual(['message', 'progress', 'message'])
    const group = out[1] as { kind: 'progress'; rows: { id: string }[]; answered: boolean }
    expect(group.rows.map((r) => r.id)).toEqual(['p1', 'p2', 'p3'])
    expect(group.answered).toBe(true)
  })

  it('renders the group where the run STARTED, so the answer stays last', () => {
    const out = groupRunProgress([
      m('q', 'user'),
      m('p1', 'assistant', 'working', P),
      m('reply', 'assistant', 'the answer'),
      m('p2', 'assistant', 'This run took 1 minute.', P),
    ], N)
    const last = out[out.length - 1]
    expect(last.kind).toBe('message')
    expect(last.kind === 'message' && last.message.id).toBe('reply')
  })

  it('keeps two runs separate, on the question between them', () => {
    // A new QUESTION starts a new run. A reply does not, because a run's own
    // summary lands after its reply.
    const out = groupRunProgress([
      m('q1', 'user'),
      m('p1', 'assistant', 'run one', P),
      m('r1', 'assistant', 'answer one'),
      m('q2', 'user'),
      m('p2', 'assistant', 'run two', P),
      m('r2', 'assistant', 'answer two'),
    ], N)
    const groups = out.filter((i) => i.kind === 'progress') as { rows: { id: string }[] }[]
    expect(groups).toHaveLength(2)
    expect(groups[0].rows.map((r) => r.id)).toEqual(['p1'])
    expect(groups[1].rows.map((r) => r.id)).toEqual(['p2'])
  })

  it('leaves every non-progress message untouched and in order', () => {
    const out = groupRunProgress([m('q', 'user'), m('a', 'assistant')], N)
    expect(out).toEqual([
      { kind: 'message', message: m('q', 'user') },
      { kind: 'message', message: m('a', 'assistant') },
    ])
  })
})

describe('whether a group may collapse', () => {
  it('collapses when a reply followed, so the thread ends on the answer', () => {
    const out = groupRunProgress([
      m('p1', 'assistant', 'Step 2 of 4', P),
      m('reply', 'assistant', 'Here is your answer.'),
    ], N)
    expect(out[0]).toMatchObject({ kind: 'progress', answered: true })
  })

  it('stays open when the run ended WITHOUT an answer', () => {
    // A dead turn that looks like a live one is the bug these rows exist to
    // kill. Folding a failure away would bring "three states, one appearance"
    // straight back.
    const out = groupRunProgress([
      m('q', 'user'),
      m('p1', 'assistant', 'This run hit its time limit at step 8 of 16.', P),
    ], N)
    expect(out[1]).toMatchObject({ kind: 'progress', answered: false })
  })

  it('groups the TERMINAL row with the run it closes', () => {
    // The terminal row carries its own type (`run_failed`) because the backend
    // has to find it: the turn after a failed run is told the run stopped, or
    // the model writes its next reply against a promise with no outcome. On
    // screen it is the last line of the same run.
    //
    // Read as an ordinary row it falls through to the assistant BUBBLE, with an
    // avatar and a name, so the thread shows the team saying "This run stopped
    // on an error before it could answer." That is the one thing these rows
    // exist to prevent.
    const out = groupRunProgress([
      m('q', 'user'),
      m('p1', 'assistant', 'Step 2 of 4', P),
      m('f1', 'assistant', 'This run stopped on an error before it could answer.', F),
    ], N)
    expect(out.map((i) => i.kind)).toEqual(['message', 'progress'])
    const group = out[1] as { kind: 'progress'; rows: { id: string }[]; answered: boolean }
    expect(group.rows.map((r) => r.id)).toEqual(['p1', 'f1'])
    // A failure is not an answer, so the group never folds away.
    expect(group.answered).toBe(false)
  })

  it('groups a terminal row that is the run\'s ONLY line', () => {
    // A turn that dies before it narrates anything writes exactly one row.
    const out = groupRunProgress([
      m('q', 'user'),
      m('f1', 'assistant', 'This run stopped before it could answer.', F),
    ], N)
    expect(out.map((i) => i.kind)).toEqual(['message', 'progress'])
    expect(out[1]).toMatchObject({ answered: false })
  })

  it('does not let a terminal row count as the reply that folds its own group', () => {
    // `answered` is read from the transcript: a row inside the group is not a
    // reply to it. Counting one would fold a dead run away.
    const out = groupRunProgress([
      m('q', 'user'),
      m('p1', 'assistant', 'Step 2 of 4', P),
      m('f1', 'assistant', 'This run stopped on an error.', F),
      m('q2', 'user'),
    ], N)
    expect(out[1]).toMatchObject({ kind: 'progress', answered: false })
  })

  it('stays open while the run is still going', () => {
    // Same question, same answer: there is no reply yet, so the person needs to
    // see the work rather than a blank thread.
    const out = groupRunProgress([m('p1', 'assistant', 'This run is still working.', P)], N)
    expect(out[0]).toMatchObject({ answered: false })
  })

  it('does not count a LATER run’s progress as this run’s answer', () => {
    // Only a real reply closes a run. Progress rows are not speech.
    const out = groupRunProgress([
      m('p1', 'assistant', 'run one', P),
      m('p2', 'assistant', 'still run one', P),
    ], N)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ answered: false })
  })

  it('does not treat the USER’s next message as an answer', () => {
    // The person asking again does not mean the run replied.
    const out = groupRunProgress([
      m('p1', 'assistant', 'still working', P),
      m('q2', 'user', 'are you there?'),
    ], N)
    expect(out[0]).toMatchObject({ answered: false })
  })
})

describe('collapsedLabel', () => {
  it('shows the run’s own closing summary rather than re-deriving one', () => {
    // Re-deriving would be a second opinion that can disagree with the counters
    // the backend already settled.
    expect(collapsedLabel([
      m('p1', 'assistant', 'Step 2 of 4', P),
      m('p2', 'assistant', 'This run took 1 minute. Work done: 6 actions.', P),
    ])).toBe('This run took 1 minute. Work done: 6 actions.')
  })

  it('shows the current state while a run is still going', () => {
    expect(collapsedLabel([m('p1', 'assistant', 'This run is still working. Step 3 of 4.', P)]))
      .toBe('This run is still working. Step 3 of 4.')
  })

  it('is empty for no rows rather than throwing', () => {
    expect(collapsedLabel([])).toBe('')
  })
})
