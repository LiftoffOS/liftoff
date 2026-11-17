import { Link } from 'react-router'
import LiftoffLogo from '../assets/logo.svg?react'
import './Footer.css'

const scrollToTop = () => window.scrollTo(0, 0)

export default function Footer() {
  const currentYear = new Date().getFullYear()

  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__grid">
          <div className="footer__brand">
            <Link to="/" className="footer__logo" onClick={scrollToTop}>
              <LiftoffLogo />
            </Link>
            <p className="footer__tagline">
              The Operating System for Agents
            </p>
            <p className="footer__copyright">
              &copy; {currentYear} Liftoff OS, Inc.
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
