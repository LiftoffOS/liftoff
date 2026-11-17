import { useState, useEffect, useRef, useCallback, ReactNode } from 'react'
import './agentBuilderInput.css'

// Must be verbatim agent-template `displayName`s: submitting carries the role to
// the Explore gallery as `?role=`, which substring-matches it against the catalog,
// so an invented title (the former 'Sales Engineer', 'Recruiter') lands on an
// empty gallery. The longest, 'Sales Development Representative', sets the mobile
// placeholder type scale in agentBuilderInput.css.
const ROLES = [
  'Sales Development Representative',
  'Inbound Lead Qualifier',
  'Cold Outreach Specialist',
  'Prospect Research Analyst',
  'CRM Operations Specialist',
  'Customer Success Manager',
  'Customer Support Representative',
  'Support Operations Analyst',
  'Accounts Receivable Specialist',
  'Billing Operations Specialist',
  'Revenue Operations Analyst',
  'Recruiting Coordinator',
  'Employee Onboarding Specialist',
  'HR Policy Specialist',
  'NDA Analyst',
  'Contract Specialist',
  'Incident Manager',
  'Competitive Intelligence Analyst',
  'Email Campaign Analyst',
  'Code Reviewer',
  'Software Quality Analyst',
]

function shuffledRoles(): string[] {
  const bag = [...ROLES]
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[bag[i], bag[j]] = [bag[j], bag[i]]
  }
  return bag
}

interface RoleInputProps {
  value: string
  onChange: (value: string) => void
  title?: string
  titleAs?: 'h1' | 'h2' | 'h3'
  titleClassName?: string
  animated?: boolean
  /** Take focus as soon as this appears. Named for what it does rather than
   *  after the DOM attribute: this is a component prop, and the field it ends
   *  up on is one of several inside. */
  focusOnMount?: boolean
  className?: string
  trailingAction?: ReactNode
}

export default function RoleInput({
  value,
  onChange,
  title = 'Who do you need on your team?',
  titleAs: TitleTag = 'h2',
  titleClassName,
  animated = true,
  focusOnMount = false,
  className = '',
  trailingAction
}: RoleInputProps) {
  const [isFocused, setIsFocused] = useState(false)

  // The field is one of several elements here, so focus goes to it by name.
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus()
  }, [focusOnMount])

  // Draw without replacement. Picking independently each cycle only excluded the
  // role just shown, so 85% of visitors saw a repeat inside 35s while a third of
  // the list never appeared at all. Walking a shuffled bag shows every role once
  // before any of them comes back.
  // The bag and the first draw are made together, in a state initializer, so
  // the very first role already comes off the shuffled bag. Building it here
  // rather than writing the ref mid-render also keeps the draw out of a phase
  // React is free to run twice.
  const [initialDraw] = useState(() => {
    const bag = shuffledRoles()
    return { first: bag.shift() as string, bag }
  })
  const bagRef = useRef<string[]>(initialDraw.bag)
  const nextRole = useCallback((previous?: string): string => {
    if (bagRef.current.length === 0) {
      bagRef.current = shuffledRoles()
      // Reshuffling can land the role just shown at the front of the new bag.
      if (previous && bagRef.current[0] === previous && bagRef.current.length > 1) {
        ;[bagRef.current[0], bagRef.current[1]] = [bagRef.current[1], bagRef.current[0]]
      }
    }
    return bagRef.current.shift() as string
  }, [])

  const [currentRole, setCurrentRole] = useState(initialDraw.first)
  const [displayedText, setDisplayedText] = useState('')
  const [isTyping, setIsTyping] = useState(true)
  const [opacity, setOpacity] = useState(1)

  // A new role types from the start, visible. Both already initialise to these
  // values, so this covers the TRANSITIONS the effect used to: putting them in
  // the effect meant the frame that switched role still showed the previous
  // one faded out.
  const [typingRole, setTypingRole] = useState(currentRole)
  if (currentRole !== typingRole) {
    setTypingRole(currentRole)
    setIsTyping(true)
    setOpacity(1)
  }

  const inputRef = useRef<HTMLInputElement>(null)
  const animationRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)

  const isAnimating = animated && !isFocused && !value

  // Typewriter effect - types role then "..."
  useEffect(() => {
    if (!isAnimating) return

    const fullText = currentRole + '...'
    let charIndex = 0

    const typeNextChar = () => {
      if (charIndex <= fullText.length) {
        setDisplayedText(fullText.slice(0, charIndex))
        charIndex++
        animationRef.current = window.setTimeout(typeNextChar, 50)
      } else {
        // Done typing, pause then fade
        setIsTyping(false)
        timeoutRef.current = window.setTimeout(() => {
          // Start fade out
          setOpacity(0)
          timeoutRef.current = window.setTimeout(() => {
            // Reset with new role
            setCurrentRole(nextRole(currentRole))
            setDisplayedText('')
            setIsTyping(true)
            setOpacity(1)
          }, 500)
        }, 1500)
      }
    }

    typeNextChar()

    return () => {
      if (animationRef.current) clearTimeout(animationRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [currentRole, isAnimating, nextRole])

  const handleFocus = () => {
    setIsFocused(true)
    if (animationRef.current) clearTimeout(animationRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }

  const handleBlur = () => {
    if (!value) {
      setIsFocused(false)
      // Reset animation
      setCurrentRole(nextRole(currentRole))
      setDisplayedText('')
      setIsTyping(true)
      setOpacity(1)
    }
  }

  const showAnimatedPlaceholder = animated && !isFocused && !value
  const staticPlaceholder = !showAnimatedPlaceholder && !value ? 'Type a role or team...' : ''

  return (
    <>
      {title && <TitleTag className={titleClassName}>{title}</TitleTag>}
      <div className={`agent-builder-input agent-builder-input--narrow ${showAnimatedPlaceholder ? 'agent-builder-input--animated' : ''} ${className}`}>
        <input
          ref={inputRef}
          type="text"
          className="agent-builder-input__field"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={staticPlaceholder}
        />
        {showAnimatedPlaceholder && (
          <div
            className="agent-builder-input__animated-placeholder"
            style={{ opacity, transition: 'opacity 0.5s ease-in-out' }}
          >
            <span className="agent-builder-input__animated-wrapper">
              <span className="agent-builder-input__animated-text">
                {displayedText}
                {isTyping && <span className="agent-builder-input__cursor">|</span>}
              </span>
              <span className="agent-builder-input__animated-sizer">{currentRole}</span>
            </span>
          </div>
        )}
        {trailingAction}
      </div>
    </>
  )
}
