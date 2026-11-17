import ArrowLeftIcon from '../assets/icons/arrow-left.svg?react'
import './BackButton.css'

interface BackButtonProps {
  onClick: () => void
  className?: string
}

export default function BackButton({ onClick, className = '' }: BackButtonProps) {
  return (
    <button
      type="button"
      className={`back-button ${className}`.trim()}
      onClick={onClick}
      aria-label="Go back"
    >
      <ArrowLeftIcon />
    </button>
  )
}
