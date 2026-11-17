import { useEffect, useRef } from 'react'
import { Footer, Navbar } from '../components'
import { PageHead } from '../components/common'
import { track } from '../lib/analytics'
import './AccountDeletedPage.css'

export default function AccountDeletedPage() {
  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('account_deleted_page_viewed', {})
  }, [])
  return (
    <div className="account-deleted-page">
      <PageHead title="Account deleted" description="Your account has been deleted." noindex />
      <Navbar />
      <section className="account-deleted-content">
        <h1>Your account has been deleted.</h1>
        <p>If this was a mistake or you have questions, <a href="/support">contact support</a>.</p>
      </section>
      <Footer />
    </div>
  )
}
