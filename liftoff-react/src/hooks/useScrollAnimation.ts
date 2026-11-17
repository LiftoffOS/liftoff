import { useEffect, useRef, useState, RefObject } from 'react'

interface ScrollAnimationOptions {
  threshold?: number
  rootMargin?: string
  once?: boolean
}

// Elements driven by these hooks start at `opacity: 0` (.animate-on-scroll in
// index.css) and only become visible once the observer fires. That makes the
// reveal margin a visibility concern as well as a motion one: anything that
// renders a page without scrolling only ever sees what the observer already
// released.
//
// The old default was '-50px 0px', a NEGATIVE margin that shrinks the root, so
// an element had to be 50px *inside* the viewport before it revealed. This
// expands the root 400px past the bottom edge instead, releasing content just
// before it scrolls into view. Search crawlers render at a very tall viewport
// without scrolling, so a bottom expansion is what lets them resolve the whole
// page in one pass.
const DEFAULT_ROOT_MARGIN = '0px 0px 400px 0px'

export function useScrollAnimation(options: ScrollAnimationOptions = {}): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          if (options.once !== false) {
            observer.unobserve(element)
          }
        } else if (options.once === false) {
          setIsVisible(false)
        }
      },
      {
        threshold: options.threshold || 0.1,
        rootMargin: options.rootMargin || DEFAULT_ROOT_MARGIN
      }
    )

    observer.observe(element)

    return () => observer.disconnect()
  }, [options.threshold, options.rootMargin, options.once])

  return [ref, isVisible]
}

export function useStaggeredAnimation(itemCount: number, baseDelay = 100): [RefObject<HTMLDivElement | null>, number[]] {
  const [visibleItems, setVisibleItems] = useState<number[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          for (let i = 0; i < itemCount; i++) {
            setTimeout(() => {
              setVisibleItems(prev => [...prev, i])
            }, i * baseDelay)
          }
          observer.unobserve(container)
        }
      },
      { threshold: 0.1, rootMargin: DEFAULT_ROOT_MARGIN }
    )

    observer.observe(container)

    return () => observer.disconnect()
  }, [itemCount, baseDelay])

  return [containerRef, visibleItems]
}
