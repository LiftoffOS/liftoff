import { useEffect, useState } from 'react'
import XIcon from '../../assets/icons/x.svg?react'
import './Toast.css'

export type ToastType = 'success' | 'error'

interface ToastProps {
  message: string
  type: ToastType
  duration?: number
  onClose: () => void
}

export default function Toast({ message, type, duration = 5000, onClose }: ToastProps) {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    // Trigger entry animation
    requestAnimationFrame(() => {
      setIsVisible(true)
    })

    const timer = setTimeout(() => {
      setIsVisible(false)
      setTimeout(onClose, 300) // Wait for fade out animation
    }, duration)

    return () => clearTimeout(timer)
  }, [duration, onClose])

  const handleClose = () => {
    setIsVisible(false)
    setTimeout(onClose, 300)
  }

  return (
    <div
      className={`toast ${isVisible ? 'toast--visible' : ''}`}
      role="alert"
      aria-live="polite"
    >
      <span className={`toast__indicator toast__indicator--${type}`} />
      <span className="toast__message">{message}</span>
      <button
        className="toast__close"
        onClick={handleClose}
        aria-label="Close notification"
      >
        <XIcon width={10} height={10} />
      </button>
    </div>
  )
}
