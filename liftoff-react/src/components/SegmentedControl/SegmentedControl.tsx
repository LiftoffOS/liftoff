import './SegmentedControl.css'

interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}

export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: SegmentedControlProps<T>) {
  return (
    <div className={`segmented-control ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented-control__option ${value === option.value ? 'segmented-control__option--active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  )
}
