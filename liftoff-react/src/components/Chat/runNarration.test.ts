import { describe, it, expect } from 'vitest'
import {
  RUN_PROGRESS_MESSAGE_TYPE,
  RUN_FAILED_MESSAGE_TYPE,
  RUN_NARRATION_MESSAGE_TYPES,
} from './runNarration'

// These strings are a WIRE CONTRACT, not a local naming choice.
//
// The control plane writes `message_type` and this client decides what to draw
// from it. A value that disagrees is invisible in both trees: the backend's own
// tests pass, this repo's own tests pass, and the row renders as the team
// SPEAKING — an avatar, a name, and "This run stopped on an error before it
// could answer" attributed to a colleague who said nothing.
//
// Counterpart: `RUN_PROGRESS_MESSAGE_TYPE`, `RUN_FAILED_MESSAGE_TYPE` and
// `NARRATION_MESSAGE_TYPES` in liftoff-platform-backend
// `src/agent-chat/run-progress.ts` and `src/agent-chat/transcript-context.ts`,
// each pinned there by the same kind of assertion. Neither repo can read the
// other's source, so the literals are pinned on both sides instead.
describe('the run-narration wire contract', () => {
  it('names the types the backend actually writes', () => {
    expect(RUN_PROGRESS_MESSAGE_TYPE).toBe('run_progress')
    expect(RUN_FAILED_MESSAGE_TYPE).toBe('run_failed')
  })

  it('draws EVERY row a run writes about itself, not just the progress lines', () => {
    // The set is what ChatMessages groups on. A type missing from it is a row
    // that reaches the ordinary assistant bubble.
    expect([...RUN_NARRATION_MESSAGE_TYPES].sort()).toEqual(['run_failed', 'run_progress'])
  })
})
