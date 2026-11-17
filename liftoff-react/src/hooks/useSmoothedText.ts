// Smooth streaming text hook
//
// Decouples the bursty SSE text_delta reception rate from the rendering
// rate. The LLM emits tokens in variable-sized chunks (sometimes one word,
// sometimes half a sentence). Without smoothing, text appears in jerky
// phrase-by-phrase bursts. This hook buffers incoming text and releases it
// word-by-word at an adaptive pace using requestAnimationFrame.
//
// Adaptive pacing:
//   - Buffer nearly empty (LLM is slow): slow down, ~100ms per word
//   - Buffer backing up (LLM sent a burst): speed up, ~30ms per word
//   - Buffer exhausted: pause naturally (the LLM is "thinking")
//   - Stream complete: flush remaining words quickly but not instantly
//
// Used by ChatMessages.tsx for all streaming chat UIs (/teams/plan,
// /insights, and any future chat page).

import { useState, useRef, useEffect, useCallback } from 'react'

// Pacing constants (milliseconds per word)
const SLOW_PACE_MS = 90      // buffer nearly empty — let words breathe
const NORMAL_PACE_MS = 50     // moderate buffer — steady flow
const FAST_PACE_MS = 25       // buffer backing up — drain faster
const FLUSH_PACE_MS = 12      // stream complete — flush quickly

// Buffer depth thresholds (in words)
const BUFFER_LOW = 3          // below this: slow pace
const BUFFER_HIGH = 12        // above this: fast pace

/**
 * Returns a smoothed version of `rawText` that advances word-by-word
 * at an adaptive rate. `completed` signals that the stream has finished
 * and the remaining buffer should flush quickly.
 */
export function useSmoothedText(
  rawText: string,
  completed: boolean,
): string {
  const [displayedText, setDisplayedText] = useState('')

  // Track the words we've received vs the words we've displayed.
  // We split into words on whitespace boundaries so partial words
  // from mid-token SSE chunks get buffered until the next space lands.
  const rawWordsRef = useRef<string[]>([])
  const displayedIndexRef = useRef(0)
  const lastFrameTimeRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  // Update the raw words array whenever rawText changes (SSE chunk arrived).
  useEffect(() => {
    if (!rawText) {
      rawWordsRef.current = []
      displayedIndexRef.current = 0
      return
    }
    // Split on whitespace, preserving the whitespace as part of each word
    // so we reconstruct the exact original text when joining. We match
    // each "word + trailing whitespace" group.
    rawWordsRef.current = rawText.match(/\S+\s*/g) || []
  }, [rawText])

  const animate = useCallback(function tick(timestamp: number) {
    const words = rawWordsRef.current
    const idx = displayedIndexRef.current

    if (idx >= words.length) {
      // Buffer exhausted — nothing to render. Don't schedule next frame;
      // the useEffect below will restart animation when new text arrives.
      rafIdRef.current = null
      return
    }

    const elapsed = timestamp - lastFrameTimeRef.current
    const bufferedWords = words.length - idx

    // Pick pace based on buffer depth and completion state.
    let pace: number
    if (completed) {
      pace = FLUSH_PACE_MS
    } else if (bufferedWords <= BUFFER_LOW) {
      pace = SLOW_PACE_MS
    } else if (bufferedWords >= BUFFER_HIGH) {
      pace = FAST_PACE_MS
    } else {
      pace = NORMAL_PACE_MS
    }

    if (elapsed >= pace) {
      // Release one word.
      displayedIndexRef.current = idx + 1
      const newText = words.slice(0, idx + 1).join('')
      setDisplayedText(newText)
      lastFrameTimeRef.current = timestamp
    }

    rafIdRef.current = requestAnimationFrame(tick)
  }, [completed])

  // Start/restart the animation loop whenever new text arrives or
  // the completed flag changes.
  useEffect(() => {
    // If there's nothing buffered beyond what we've displayed, skip.
    if (displayedIndexRef.current >= rawWordsRef.current.length && !completed) {
      return
    }
    // If animation is already running, let it continue — it'll pick up
    // the new buffer depth on the next frame.
    if (rafIdRef.current !== null) return

    rafIdRef.current = requestAnimationFrame(animate)

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [rawText, completed, animate])

  // When the stream completes AND the buffer is fully drained, snap to
  // the exact raw text to catch any trailing whitespace or edge cases.
  useEffect(() => {
    if (completed && displayedIndexRef.current >= rawWordsRef.current.length && rawText) {
      setDisplayedText(rawText)
    }
  }, [completed, rawText, displayedText])

  // Stop the animation when rawText is cleared (new conversation). The text
  // itself needs no reset: see the return below.
  useEffect(() => {
    if (!rawText) {
      displayedIndexRef.current = 0
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [rawText])

  // Derived, not reset. With no raw text there is nothing to be part-way
  // through showing, so the answer is the empty string whatever the animation
  // last left behind — and two effects no longer have to remember to clear it.
  return rawText ? displayedText : ''
}
