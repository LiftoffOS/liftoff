// The microphone button's ring is the only part of these controls with any
// behaviour, and it is the part that answers the question people actually ask
// of a live microphone: not "is it on" but "can it hear me".

import { render, screen, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { VoiceInputButton } from './VoiceControls'

/** Animation frames, run when the test says so rather than when the clock does. */
const frames: FrameRequestCallback[] = []

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => vi.unstubAllGlobals())

/** Run the pending frame, as the browser would, `count` times. */
function paint(count: number) {
  act(() => {
    for (let i = 0; i < count; i += 1) frames.pop()?.(0)
  })
}

function micButton() {
  return screen.getByRole('button')
}

describe('VoiceInputButton', () => {
  it('rings with the level while listening', () => {
    const levelRef = createRef<number>() as React.RefObject<number>
    levelRef.current = 0
    render(<VoiceInputButton isListening onToggle={() => {}} levelRef={levelRef} />)

    levelRef.current = 1
    paint(20)

    const ring = Number(micButton().style.getPropertyValue('--voice-level'))
    expect(ring).toBeGreaterThan(0.9)
  })

  it('follows the voice down as well as up', () => {
    const levelRef = createRef<number>() as React.RefObject<number>
    levelRef.current = 1
    render(<VoiceInputButton isListening onToggle={() => {}} levelRef={levelRef} />)
    paint(20)

    levelRef.current = 0
    paint(20)

    expect(Number(micButton().style.getPropertyValue('--voice-level'))).toBeLessThan(0.1)
  })

  it('eases rather than snapping, so speech breathes instead of flickering', () => {
    const levelRef = createRef<number>() as React.RefObject<number>
    levelRef.current = 0
    render(<VoiceInputButton isListening onToggle={() => {}} levelRef={levelRef} />)

    // One frame after a syllable starts, the ring is on its way, not there.
    levelRef.current = 1
    paint(1)
    const afterOneFrame = Number(micButton().style.getPropertyValue('--voice-level'))
    expect(afterOneFrame).toBeGreaterThan(0)
    expect(afterOneFrame).toBeLessThan(0.5)
  })

  it('leaves no ring behind when the microphone is disarmed', () => {
    const levelRef = createRef<number>() as React.RefObject<number>
    levelRef.current = 1
    const { rerender } = render(
      <VoiceInputButton isListening onToggle={() => {}} levelRef={levelRef} />,
    )
    paint(20)
    expect(micButton().style.getPropertyValue('--voice-level')).not.toBe('')

    rerender(<VoiceInputButton isListening={false} onToggle={() => {}} levelRef={levelRef} />)
    expect(micButton().style.getPropertyValue('--voice-level')).toBe('')
  })

  it('draws nothing at all when no level is offered', () => {
    render(<VoiceInputButton isListening onToggle={() => {}} />)
    paint(5)
    expect(micButton().style.getPropertyValue('--voice-level')).toBe('')
  })
})
