import { Link } from 'react-router'
import './Button.css'

interface ButtonProps {
  children: React.ReactNode
  href?: string
  variant?: 'primary' | 'outline' | 'secondary' | 'destructive' | 'text'
  size?: 'default' | 'sm'
  className?: string
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  type?: 'button' | 'submit' | 'reset'
}

export default function Button({
  children,
  href,
  variant = 'primary',
  size = 'default',
  className = '',
  onClick,
  disabled = false,
  loading = false,
  // Default to "button" so the element doesn't accidentally submit. Browsers
  // default <button> to type="submit" when omitted, which fires Chrome's
  // "Form submission canceled because the form is not connected" warning
  // every time a Button outside a <form> is clicked.
  type = 'button',
}: ButtonProps) {
  const isDisabled = disabled || loading
  const classes = `btn btn--${variant} ${size === 'sm' ? 'btn--sm' : ''} ${isDisabled ? 'btn--disabled' : ''} ${loading ? 'btn--loading' : ''} ${className}`.trim()

  const content = loading ? (
    <>
      <span className="btn__text--hidden">{children}</span>
      <div className="btn__spinner" />
    </>
  ) : children

  if (href) {
    // Use React Router Link for internal paths, regular anchor for hash links and external URLs
    if (href.startsWith('/') && !href.startsWith('/#')) {
      return (
        <Link to={href} className={classes} onClick={onClick}>
          {content}
        </Link>
      )
    }
    return (
      <a href={href} className={classes} onClick={onClick}>
        {content}
      </a>
    )
  }

  return (
    <button type={type} className={classes} onClick={onClick} disabled={isDisabled}>
      {content}
    </button>
  )
}
