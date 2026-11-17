import ChevronLeftIcon from '../../assets/icons/chevron-left.svg?react'
import ChevronRightIcon from '../../assets/icons/chevron-right.svg?react'
import './Pagination.css'

interface PaginationProps {
  current: number
  total: number
  onPrevious: () => void
  onNext: () => void
  className?: string
}

export default function Pagination({
  current,
  total,
  onPrevious,
  onNext,
  className = ''
}: PaginationProps) {
  return (
    <div className={`pagination ${className}`}>
      <button
        className="pagination__btn"
        onClick={onPrevious}
        disabled={current <= 1}
        aria-label="Previous"
      >
        <ChevronLeftIcon width={16} height={16} />
        Previous
      </button>
      <span className="pagination__info">
        {current} of {total}
      </span>
      <button
        className="pagination__btn"
        onClick={onNext}
        disabled={current >= total}
        aria-label="Next"
      >
        Next
        <ChevronRightIcon width={16} height={16} />
      </button>
    </div>
  )
}
