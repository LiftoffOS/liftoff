import { useRef, useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import './Tooltip.css'

interface TooltipProps {
  children: React.ReactNode
  /** Usually a plain string. Richer nodes (e.g. a list of rows) are allowed for
   *  content a single line cannot carry. */
  text: React.ReactNode
  position?: 'top' | 'bottom' | 'right' | 'left'
}

interface TooltipStyle {
  top: number
  left: number
}

export default function Tooltip({ children, text, position = 'bottom' }: TooltipProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [style, setStyle] = useState<TooltipStyle>({ top: 0, left: 0 })

  const updatePosition = useCallback(() => {
    const wrapper = wrapperRef.current
    const tooltip = tooltipRef.current
    if (!wrapper || !tooltip) return

    const rect = wrapper.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    const gap = 6

    let top = 0
    let left = 0

    switch (position) {
      case 'top':
        top = rect.top - tooltipRect.height - gap
        left = rect.left + rect.width / 2 - tooltipRect.width / 2
        break
      case 'bottom':
        top = rect.bottom + gap
        left = rect.left + rect.width / 2 - tooltipRect.width / 2
        break
      case 'right':
        top = rect.top + rect.height / 2 - tooltipRect.height / 2
        left = rect.right + gap
        break
      case 'left':
        top = rect.top + rect.height / 2 - tooltipRect.height / 2
        left = rect.left - tooltipRect.width - gap
        break
    }

    // Edge detection for top/bottom positions
    if (position === 'top' || position === 'bottom') {
      // A tall tooltip (a multi-row list) can run off the viewport on the side it
      // was asked for. Flip to the opposite side when that side has room —
      // clamping instead would slide the tooltip over the element it describes.
      const margin = 8
      if (position === 'top' && top < margin) {
        const flipped = rect.bottom + gap
        if (flipped + tooltipRect.height <= window.innerHeight - margin) top = flipped
      } else if (position === 'bottom' && top + tooltipRect.height > window.innerHeight - margin) {
        const flipped = rect.top - tooltipRect.height - gap
        if (flipped >= margin) top = flipped
      }

      const overflowRight = left + tooltipRect.width - window.innerWidth + 8
      const overflowLeft = -left + 8
      if (overflowRight > 0) left -= overflowRight
      if (overflowLeft > 0) left += overflowLeft
    }

    setStyle({ top, left })
  }, [position])

  useEffect(() => {
    if (visible) updatePosition()
  }, [visible, updatePosition])

  const handlePointerEnter = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    setVisible(true)
  }, [])

  const handlePointerLeave = useCallback(() => {
    setVisible(false)
  }, [])

  return (
    <div
      className="tooltip-wrapper"
      ref={wrapperRef}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {children}
      {createPortal(
        <span
          ref={tooltipRef}
          className={`tooltip-portal ${visible ? 'tooltip-portal--visible' : ''}`}
          style={{ top: style.top, left: style.left }}
        >
          {text}
        </span>,
        document.body
      )}
    </div>
  )
}
