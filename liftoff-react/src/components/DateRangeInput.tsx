import './DateRangeInput.css'

interface DateRangeInputProps {
  startDate: string
  endDate: string
  onStartDateChange: (value: string) => void
  onEndDateChange: (value: string) => void
  startLabel?: string
  endLabel?: string
  disabled?: boolean
}

export function DateRangeInput({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  startLabel = 'From',
  endLabel = 'To',
  disabled = false,
}: DateRangeInputProps) {
  return (
    <div className="date-range-input">
      <div className="date-range-input__field">
        <label className="date-range-input__label">{startLabel}</label>
        <input
          type="text"
          className="date-range-input__input"
          value={startDate}
          onChange={e => onStartDateChange(e.target.value)}
          placeholder="MM/DD/YYYY"
          disabled={disabled}
        />
      </div>
      <div className="date-range-input__field">
        <label className="date-range-input__label">{endLabel}</label>
        <input
          type="text"
          className="date-range-input__input"
          value={endDate}
          onChange={e => onEndDateChange(e.target.value)}
          placeholder="MM/DD/YYYY"
          disabled={disabled}
        />
      </div>
    </div>
  )
}
