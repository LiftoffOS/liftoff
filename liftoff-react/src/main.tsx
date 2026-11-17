import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import { initAnalytics } from './lib/analytics'
import { registerChunkErrorReload } from './lib/chunkReload'
import { captureReferralCode } from './lib/referralCapture'
import './index.css'
import './styles/cards.css'
import './components/ui/Toggle.css'
import './components/FormLayout/FormLayout.css'
import App from './App'

function isMswDisabled() {
  const v = import.meta.env.VITE_DISABLE_MSW
  return typeof v === 'string' && v.toLowerCase() === 'true'
}

// The push service worker is ours and must survive this sweep. Everything here
// exists to clear a stale MSW worker that would silently intercept requests;
// unregistering the messaging worker instead just breaks browser notifications
// in local development, with no symptom beyond nothing ever arriving.
const PUSH_SW_PATH = '/firebase-messaging-sw.js'

function isPushServiceWorker(reg: ServiceWorkerRegistration): boolean {
  const script =
    reg.active?.scriptURL ?? reg.waiting?.scriptURL ?? reg.installing?.scriptURL ?? ''
  return script.endsWith(PUSH_SW_PATH)
}

async function unregisterStaleServiceWorkers() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    const stale = regs.filter(r => !isPushServiceWorker(r))
    await Promise.all(stale.map(r => r.unregister()))
    if (stale.length > 0) {
      console.log('[MSW] Disabled — unregistered stale service worker(s). Reloading…')
      window.location.reload()
    }
  } catch (err) {
    console.warn('[MSW] Failed to unregister stale service workers:', err)
  }
}

async function startApp() {
  // Recover automatically when a lazy chunk 404s because the tab outlived a
  // deploy. Registered before render so the listener is in place for the first
  // dynamic import. See src/lib/chunkReload.ts.
  registerChunkErrorReload()

  // GA4 — host-gated; no-op unless served from example.com (or ?ga=1 override).
  initAnalytics()

  // Referral attribution. Reads `?ref=` off the landing URL and holds it for
  // the 30 day window, last touch winning, so the code survives to account
  // creation. It has to run here, before render: the referral link lands on
  // `/` or `/login`, and the router replaces the query string on the first
  // navigation. Storage-only and failure-swallowing — there is no UI.
  captureReferralCode()

  // Start MSW in development mode (unless disabled via env var)
  if (import.meta.env.DEV && !isMswDisabled()) {
    const { startMockServiceWorker } = await import('./mocks')
    await startMockServiceWorker()
  } else if (import.meta.env.DEV) {
    // MSW disabled — make sure no previously registered service worker
    // is still intercepting requests (which would silently break the app).
    await unregisterStaleServiceWorkers()
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <HelmetProvider>
        <App />
      </HelmetProvider>
    </StrictMode>,
  )
}

startApp()
