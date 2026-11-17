// Picks up the ?unsubscribe_token=... query param emitted by an email-body
// unsubscribe link, POSTs it to the public backend endpoint, shows a toast with
// the friendly label, and strips the token from the URL. Mounted at the top of
// <BrowserRouter> so it runs on every route — including /login for logged-out
// users.
//
// Cross-component coordination: dispatches a `notification-preferences-changed`
// CustomEvent on success so an open Settings page can refresh its view.

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { useToast } from '../contexts/ToastContext'
import { publicFetch } from '../services/api'

interface UnsubscribeResponse {
  success: boolean
  action?: string
  friendlyLabel?: string
  error?: string
}

export function GlobalUnsubscribeHandler(): null {
  const [searchParams, setSearchParams] = useSearchParams()
  const { showToast } = useToast()
  const processedRef = useRef<string | null>(null)

  useEffect(() => {
    const token = searchParams.get('unsubscribe_token')
    if (!token || token === processedRef.current) return
    processedRef.current = token

    publicFetch<UnsubscribeResponse>('/api/notifications/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((data) => {
        if (data?.success) {
          showToast(`You've been unsubscribed from ${data.friendlyLabel}`, 'success')
          window.dispatchEvent(new CustomEvent('notification-preferences-changed'))
        } else {
          showToast(
            data?.error || 'Could not update your notification preference. Please try again.',
            'error',
          )
        }
      })
      .catch(() => {
        showToast('Could not update your notification preference. Please try again.', 'error')
      })
      .finally(() => {
        searchParams.delete('unsubscribe_token')
        setSearchParams(searchParams, { replace: true })
      })
  }, [searchParams, setSearchParams, showToast])

  return null
}
