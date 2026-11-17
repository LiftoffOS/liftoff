import { useState, useEffect } from 'react'
import { Link } from 'react-router'
import LiftoffLogo from '../assets/logo.svg?react'
import { track } from '../lib/analytics'
import { useOptionalAuth } from '../contexts/AuthContext'
import './Navbar.css'

export default function Navbar() {
  const auth = useOptionalAuth()
  const [scrolled, setScrolled] = useState(false)

  const scrollThreshold = 50

  useEffect(() => {
    let ticking = false

    const handleScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          setScrolled(window.scrollY > scrollThreshold)
          ticking = false
        })
        ticking = true
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const navClasses = ['navbar', scrolled ? 'navbar--scrolled' : ''].filter(Boolean).join(' ')

  // One action, three states. A signed-in user who never finished setup has no
  // dashboard worth landing on, so they keep the signed-out label and are sent
  // to finish setting up instead. Server-rendered markup carries the signed-out
  // label; auth resolves client side and swaps it.
  const onboarded = !!auth?.currentTenant?.onboardingCompletedAt
  const ctaLabel = auth?.user && onboarded ? 'Dashboard' : 'Get Started'
  const ctaHref = !auth?.user ? '/login' : onboarded ? '/dashboard' : '/onboarding'

  return (
    <header className={navClasses}>
      <div className="navbar__glow" aria-hidden="true" />
      <div className="navbar__container">
        <Link to="/" className="navbar__logo" onClick={() => window.scrollTo(0, 0)}>
          <LiftoffLogo />
        </Link>

        <div className="navbar__actions">
          <Link
            to={ctaHref}
            className="navbar__cta"
            onClick={() =>
              track('marketing_cta_clicked', { surface: 'navbar', cta: ctaLabel, destination: ctaHref })}
          >
            {ctaLabel}
          </Link>
        </div>
      </div>
    </header>
  )
}
