// What the connect flow tells the user when the popup closes without a result.
//
// This used to be a silent branch: popup closed → assume the user cancelled →
// track it, show nothing. That is indistinguishable from the integration being
// completely broken: if the OAuth provider stops redirecting back to us, every
// affected user sees a UI that looks like they had changed their mind.
//
// So: the popup is not evidence. Ask the backend, then tell the truth.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIntegrationConnect } from './useIntegrationConnect'
import { startOAuthFlow } from '../services/connections'

const showToast = vi.fn()
const refetchConnectors = vi.fn()

vi.mock('../services/connections', () => ({
  startOAuthFlow: vi.fn(),
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    currentTenant: { id: 'tenant_1' },
    tenantLoading: false,
    getIdToken: () => Promise.resolve('token'),
  }),
}))

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}))

// `data` is the pre-attempt snapshot source; `refetch` is what we ask
// afterwards. Tests set them independently to model "before" vs "after".
let cachedConnectors: Array<{ id: string; type: string; updatedAt: string }> = []
vi.mock('./useConnectors', () => ({
  useConnectors: () => ({ data: cachedConnectors, refetch: refetchConnectors }),
}))

vi.mock('./useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({
    supportsConnection: () => true,
  }),
}))

vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

/** popup resolves with `popup_closed` after `afterMs` of wall clock. */
function popupClosesAfter(afterMs: number) {
  vi.mocked(startOAuthFlow).mockReturnValue({
    promise: new Promise((resolve) =>
      setTimeout(() => resolve({ success: false, error: 'popup_closed' }), afterMs),
    ),
    cancel: () => {},
  })
}

describe('useIntegrationConnect — popup closed without a result', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    cachedConnectors = []
    refetchConnectors.mockResolvedValue({ data: [] })
  })

  it('reports success when a new connector row appeared', async () => {
    // The callback page can broadcast and close faster than we read it, and a
    // COOP-protected popup reads as closed while still alive. Neither is a
    // failure, and the backend is the one that knows.
    popupClosesAfter(0)
    refetchConnectors.mockResolvedValue({
      data: [{ id: 'c1', type: 'google_mail', updatedAt: 't1' }],
    })

    const { result } = renderHook(() => useIntegrationConnect())
    await act(async () => {
      await result.current.connect('google_mail' as never, 'Gmail')
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Successfully connected Gmail'),
      'success',
    )
  })

  it('reports success when a RECONNECT touched the existing row', async () => {
    cachedConnectors = [{ id: 'c1', type: 'google_mail', updatedAt: 't1' }]
    popupClosesAfter(0)
    refetchConnectors.mockResolvedValue({
      data: [{ id: 'c1', type: 'google_mail', updatedAt: 't2' }],
    })

    const { result } = renderHook(() => useIntegrationConnect())
    await act(async () => {
      await result.current.connect('google_mail' as never, 'Gmail')
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Successfully connected Gmail'),
      'success',
    )
  })

  it('does NOT call an abandoned reconnect a success just because a row exists', async () => {
    // The row was already there and nothing touched it. Presence alone must
    // not read as "connected" or every cancelled reconnect lies to the user.
    cachedConnectors = [{ id: 'c1', type: 'google_mail', updatedAt: 't1' }]
    popupClosesAfter(0)
    refetchConnectors.mockResolvedValue({
      data: [{ id: 'c1', type: 'google_mail', updatedAt: 't1' }],
    })
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValue(45_000)

    const { result } = renderHook(() => useIntegrationConnect())
    await act(async () => {
      await result.current.connect('google_mail' as never, 'Gmail')
    })

    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Successfully connected'),
      'success',
    )
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('could not confirm'),
      'error',
    )
    nowSpy.mockRestore()
  })

  it('warns when a long attempt produced no connector', async () => {
    // 45s in a consent screen and nothing to show for it is not a cancel.
    popupClosesAfter(0)
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValue(45_000)

    const { result } = renderHook(() => useIntegrationConnect())
    await act(async () => {
      await result.current.connect('google_mail' as never, 'Gmail')
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('could not confirm the Gmail connection'),
      'error',
    )
    nowSpy.mockRestore()
  })

  it('stays silent on a quick close — that really is someone backing out', async () => {
    popupClosesAfter(0)
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValue(1_000)

    const { result } = renderHook(() => useIntegrationConnect())
    await act(async () => {
      await result.current.connect('google_mail' as never, 'Gmail')
    })

    expect(showToast).not.toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('stays silent on an explicit cancel regardless of elapsed time', async () => {
    vi.mocked(startOAuthFlow).mockReturnValue({
      promise: Promise.resolve({ success: false, error: 'canceled' }),
      cancel: () => {},
    })
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValue(120_000)

    const { result } = renderHook(() => useIntegrationConnect())
    await act(async () => {
      await result.current.connect('google_mail' as never, 'Gmail')
    })

    expect(showToast).not.toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('does not claim failure when the verification refetch itself errors', async () => {
    popupClosesAfter(0)
    refetchConnectors.mockRejectedValue(new Error('network'))
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(0).mockReturnValue(45_000)

    const { result } = renderHook(() => useIntegrationConnect())
    await act(async () => {
      await result.current.connect('google_mail' as never, 'Gmail')
    })

    // Unconfirmed, not "failed to connect" — we genuinely do not know.
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('could not confirm'),
      'error',
    )
    nowSpy.mockRestore()
  })
})
