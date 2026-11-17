// The GitHub App install leg, which runs after the authorize popup.
//
// The outcome that matters here is `pending`: GitHub records a REQUEST rather
// than an installation when the person asking is not an owner of the
// organisation. Before this leg existed, that would have fallen through to the
// generic unconfirmed toast — "if you finished authorising, it will appear here
// in a few minutes" — which is false for a request. It appears when an owner
// approves, which may be weeks away and may never happen. That toast exists
// because a broken integration once looked like silence for two weeks; it must
// not now be used to tell a different untruth.

import type { ReactElement } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useIntegrationConnect } from './useIntegrationConnect'
import { startOAuthFlow, type GitHubAppInstallResult } from '../services/connections'

const showToast = vi.fn()
const refetchConnectors = vi.fn()

vi.mock('../services/connections', () => ({
  startOAuthFlow: vi.fn(),
  listGitHubInstallTargets: vi.fn(),
  startGitHubAppInstall: vi.fn(),
  watchGitHubAppInstall: vi.fn(),
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

let cachedConnectors: Array<Record<string, unknown>> = []
vi.mock('./useConnectors', () => ({
  useConnectors: () => ({ data: cachedConnectors, refetch: refetchConnectors }),
}))

vi.mock('./useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({
    supportsConnection: () => true,
  }),
}))

vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

interface PickerProps {
  onCancel: () => void
  onComplete: (result: GitHubAppInstallResult) => void
}

/** Runs the authorize leg to completion and hands back the picker's props. */
async function reachInstallPicker() {
  vi.mocked(startOAuthFlow).mockReturnValue({
    promise: Promise.resolve({ success: true, connectorType: 'github', connectorId: 'c-github' }),
    cancel: () => {},
  })

  const { result } = renderHook(() => useIntegrationConnect())
  let connectResult: Promise<boolean> | undefined
  await act(async () => {
    connectResult = result.current.connect('github', 'GitHub')
  })

  await waitFor(() => expect(result.current.installTargetModal).not.toBeNull())
  const picker = result.current.installTargetModal as ReactElement<PickerProps>
  return { result, picker, connectResult: connectResult! }
}

describe('useIntegrationConnect — GitHub App install leg', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cachedConnectors = []
    refetchConnectors.mockResolvedValue({ data: [] })
  })

  it('opens the account picker after the authorize leg lands', async () => {
    const { picker } = await reachInstallPicker()
    expect(picker).toBeTruthy()
  })

  it('does not open the picker for any other connector', async () => {
    vi.mocked(startOAuthFlow).mockReturnValue({
      promise: Promise.resolve({ success: true, connectorType: 'slack', connectorId: 'c-slack' }),
      cancel: () => {},
    })

    const { result } = renderHook(() => useIntegrationConnect())
    await act(async () => {
      await result.current.connect('slack', 'Slack')
    })

    expect(result.current.installTargetModal).toBeNull()
  })

  it('names the organisation a request is waiting on, and promises nothing about timing', async () => {
    const { picker, connectResult } = await reachInstallPicker()

    await act(async () => {
      picker.props.onComplete({ status: 'pending', org: 'acme-corp' })
      await connectResult
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('An owner of acme-corp needs to approve'),
      'success',
    )
    const said = showToast.mock.calls.map((c) => String(c[0])).join(' ')
    expect(said).not.toMatch(/few minutes/i)
    expect(said).not.toMatch(/could not confirm/i)
  })

  it('reports a completed install as a connection', async () => {
    const { picker, connectResult } = await reachInstallPicker()

    await act(async () => {
      picker.props.onComplete({ status: 'installed', connectorId: 'c-github' })
      await connectResult
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Successfully connected GitHub'),
      'success',
    )
  })

  it('still reports the connection when the user dismisses the picker', async () => {
    // The authorize leg already landed, so GitHub IS connected. It just writes
    // as the person until someone installs the app.
    const { picker, connectResult } = await reachInstallPicker()

    await act(async () => {
      picker.props.onCancel()
      await connectResult
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Successfully connected GitHub'),
      'success',
    )
    expect(await connectResult).toBe(true)
  })

  it('asks the backend what happened when the popup closes without a word', async () => {
    // A COOP-protected popup reads as closed while it is still alive, and one
    // that really closed proves nothing. The connector row is the evidence.
    refetchConnectors.mockResolvedValue({
      data: [
        {
          id: 'c-github',
          type: 'github',
          updatedAt: 't2',
          config: { installState: 'awaiting_org_approval', awaitingOrgLogin: 'acme-corp' },
        },
      ],
    })
    const { picker, connectResult } = await reachInstallPicker()

    await act(async () => {
      picker.props.onComplete({ status: 'closed' })
      await connectResult
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('An owner of acme-corp needs to approve'),
      'success',
    )
  })

  it('reads a silently-closed popup as success when the install actually landed', async () => {
    refetchConnectors.mockResolvedValue({
      data: [
        {
          id: 'c-github',
          type: 'github',
          updatedAt: 't2',
          config: { installationId: 4711, installState: 'installed' },
        },
      ],
    })
    const { picker, connectResult } = await reachInstallPicker()

    await act(async () => {
      picker.props.onComplete({ status: 'closed' })
      await connectResult
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Successfully connected GitHub'),
      'success',
    )
  })

  it('says the app was not installed when the install leg failed', async () => {
    const { picker, connectResult } = await reachInstallPicker()

    await act(async () => {
      picker.props.onComplete({ status: 'error', error: 'github_install_failed' })
      await connectResult
    })

    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('was not installed'),
      'error',
    )
  })
})
