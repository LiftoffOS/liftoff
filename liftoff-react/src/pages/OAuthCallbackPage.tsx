import { useEffect, useState } from 'react'

/**
 * OAuth callback page - handles OAuth redirects in popup window.
 * Sends result to parent window via BroadcastChannel and closes itself.
 *
 * BroadcastChannel is used instead of window.opener.postMessage because
 * navigating through external OAuth providers (Google, etc.) clears the
 * window.opener reference for security reasons.
 */
export default function OAuthCallbackPage() {
  const [status, setStatus] = useState<'sending' | 'done' | 'pending'>('sending')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    const connectorId = params.get('connectorId')
    const error = params.get('error')
    const pending = params.get('pending')
    const org = params.get('org')

    const channel = new BroadcastChannel('oauth_callback')

    // GitHub App install leg, non-owner path: GitHub recorded a REQUEST, not an
    // install. Neither success nor failure — treating it as either produces a
    // lie, so it gets its own result shape and the opener decides what to say.
    if (pending) {
      channel.postMessage({
        type: 'oauth_callback',
        success: false,
        pending: true,
        connectorType: pending,
        connectorId: connectorId ?? undefined,
        org: org ?? undefined,
      })
      setTimeout(() => { channel.close(); setStatus('pending'); window.close() }, 100)
      return
    }

    const result = connected && connectorId
      ? { success: true, connectorType: connected, connectorId }
      : { success: false, error: error || 'unknown_error' }

    // Use BroadcastChannel to communicate with parent window
    channel.postMessage({ type: 'oauth_callback', ...result })

    // Give time for message delivery before closing
    setTimeout(() => {
      channel.close()
      setStatus('done')

      // Try to close the popup
      window.close()
    }, 100)
  }, [])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontFamily: 'system-ui, sans-serif',
      gap: '8px'
    }}>
      <p>
        {status === 'sending' && 'Completing connection...'}
        {status === 'done' && 'Connection complete!'}
        {status === 'pending' && 'Request sent to the organization owners.'}
      </p>
      {status !== 'sending' && (
        <p style={{ fontSize: '14px', color: '#666' }}>You can close this window.</p>
      )}
    </div>
  )
}
