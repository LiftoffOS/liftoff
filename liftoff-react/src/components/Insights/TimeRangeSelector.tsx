import { useState, useRef, useEffect } from 'react'
import type { InsightsTimeRangePreset } from '../../services/insights'
import ClockIcon from '../../assets/icons/clock.svg?react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import './TimeRangeSelector.css'

const TIME_RANGE_PRESETS: { value: InsightsTimeRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'this_year', label: 'This year' },
]

interface TimeRangeSelectorProps {
  value: InsightsTimeRangePreset
  onChange: (preset: InsightsTimeRangePreset) => void
}

export default function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  const [open, setOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)

  const selectedLabel = TIME_RANGE_PRESETS.find(p => p.value === value)?.label || value

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div className="insights-time-filter" ref={filterRef}>
      <button
        className="insights-time-filter__trigger"
        onClick={() => setOpen(!open)}
      >
        <ClockIcon width="16" height="16" />
        {selectedLabel}
        <ChevronDownIcon width="12" height="12" />
      </button>

      {open && (
        <div className="insights-time-filter__dropdown">
          {TIME_RANGE_PRESETS.map(preset => (
            <button
              key={preset.value}
              className={`insights-time-filter__option ${preset.value === value ? 'insights-time-filter__option--active' : ''}`}
              onClick={() => {
                onChange(preset.value)
                setOpen(false)
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
