import { useNavigate } from 'react-router'
import Button from './Button'
import SearchXIcon from '../assets/icons/search-x.svg?react'
import InfoCircleIcon from '../assets/icons/info-circle.svg?react'
import './ErrorState.css'

type ErrorVariant = 'error' | 'notFound'

interface ErrorStateProps {
  variant?: ErrorVariant
  onRetry?: () => void
  title?: string
  subtitle?: string
  buttonLabel?: string
}

const defaultContent: Record<ErrorVariant, { title: string; subtitle: string; buttonLabel: string }> = {
  error: {
    title: 'Something went wrong',
    subtitle: 'We could not load this page. Please try again.',
    buttonLabel: 'Try Again',
  },
  notFound: {
    title: 'Page not found',
    subtitle: "The page you're looking for doesn't exist.",
    buttonLabel: 'Go Back',
  },
}

export default function ErrorState({
  variant = 'error',
  onRetry,
  title,
  subtitle,
  buttonLabel,
}: ErrorStateProps) {
  const navigate = useNavigate()
  const content = defaultContent[variant]

  const handleClick = () => {
    if (variant === 'notFound') {
      navigate(-1)
    } else if (onRetry) {
      onRetry()
    }
  }

  return (
    <div className={`error-state error-state--${variant}`}>
      <div className="error-state__content">
        <div className="error-state__visual">
          <div className="error-state__visual-center">
            {variant === 'notFound' ? (
              <SearchXIcon />
            ) : (
              <InfoCircleIcon />
            )}
          </div>
          {/* Error variant: drifting fragments */}
          {variant === 'error' && (
            <>
              <div className="error-state__fragment error-state__fragment--1" />
              <div className="error-state__fragment error-state__fragment--2" />
              <div className="error-state__fragment error-state__fragment--3" />
              <div className="error-state__fragment error-state__fragment--4" />
              <div className="error-state__fragment error-state__fragment--5" />
            </>
          )}
          {/* NotFound variant: wandering question marks */}
          {variant === 'notFound' && (
            <>
              <span className="error-state__question error-state__question--1">?</span>
              <span className="error-state__question error-state__question--2">?</span>
              <span className="error-state__question error-state__question--3">?</span>
              <span className="error-state__question error-state__question--4">?</span>
              <span className="error-state__question error-state__question--5">?</span>
            </>
          )}
        </div>
        <h1 className="error-state__header">{title || content.title}</h1>
        <p className="error-state__subtext">{subtitle || content.subtitle}</p>
        <div className="error-state__actions">
          <Button variant="primary" onClick={handleClick}>
            {buttonLabel || content.buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
