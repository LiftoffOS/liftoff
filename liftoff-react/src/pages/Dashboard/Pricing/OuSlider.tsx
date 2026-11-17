import { useRef, useCallback } from 'react'

interface OuSliderProps {
  values: number[]
  value: number
  onChange: (v: number) => void
}

export default function OuSlider({ values, value, onChange }: OuSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const idx = Math.max(0, values.indexOf(value))
  const pct = values.length > 1 ? (idx / (values.length - 1)) * 100 : 0

  const valueFromX = useCallback((clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const rawIdx = ratio * (values.length - 1)
    return values[Math.round(rawIdx)]
  }, [values])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    onChange(valueFromX(e.clientX))
    const onMove = (me: MouseEvent) => onChange(valueFromX(me.clientX))
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [onChange, valueFromX])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    onChange(valueFromX(e.touches[0].clientX))
    const onMove = (te: TouchEvent) => onChange(valueFromX(te.touches[0].clientX))
    const onEnd = () => { window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onEnd) }
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd)
  }, [onChange, valueFromX])

  // The track carries the slider semantics because it is what the pointer
  // drags and what the arrow keys move. Values are a fixed list, so a step is
  // one index either way rather than an arithmetic increment.
  const step = useCallback((delta: number) => {
    const next = values[Math.max(0, Math.min(values.length - 1, idx + delta))]
    if (next !== value) onChange(next)
  }, [values, idx, value, onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': e.preventDefault(); step(-1); break
      case 'ArrowRight': case 'ArrowUp': e.preventDefault(); step(1); break
      case 'Home': e.preventDefault(); onChange(values[0]); break
      case 'End': e.preventDefault(); onChange(values[values.length - 1]); break
    }
  }, [step, onChange, values])

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Operating units"
      aria-valuemin={values[0]}
      aria-valuemax={values[values.length - 1]}
      aria-valuenow={value}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      style={{
        position: 'relative', height: 4, borderRadius: 9999, cursor: 'pointer',
        background: `linear-gradient(to right, #FB411F ${pct}%, #e5e7eb ${pct}%)`,
        userSelect: 'none', margin: '20px 0',
      }}
    >
      <div style={{ position: 'absolute', inset: '-18px 0' }} />
      <div style={{
        position: 'absolute', top: '50%', left: `${pct}%`,
        transform: 'translate(-50%, -50%)',
        width: 24, height: 24, borderRadius: '50%', background: '#FB411F',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)', cursor: 'grab', flexShrink: 0,
      }} />
    </div>
  )
}
