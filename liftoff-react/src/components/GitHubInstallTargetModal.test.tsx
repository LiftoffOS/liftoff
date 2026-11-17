// The account picker that runs before GitHub's own install screen.
//
// Two things here are load-bearing. The popup must be opened by the click
// itself, not after the install-start round trip, or the browser blocks it.
// And a row the user cannot install on directly must stay selectable: GitHub
// records a request for a non-owner, and requesting is a supported outcome
// rather than a dead end.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '../test/utils'
import userEvent from '@testing-library/user-event'
import GitHubInstallTargetModal from './GitHubInstallTargetModal'
import {
  listGitHubInstallTargets,
  startGitHubAppInstall,
  watchGitHubAppInstall,
} from '../services/connections'

vi.mock('../services/connections', () => ({
  listGitHubInstallTargets: vi.fn(),
  startGitHubAppInstall: vi.fn(),
  watchGitHubAppInstall: vi.fn(),
}))

const TARGETS = [
  { id: 1, login: 'octocat', type: 'User' as const, canInstall: true },
  { id: 2, login: 'acme', type: 'Organization' as const, canInstall: true },
  { id: 3, login: 'acme-corp', type: 'Organization' as const, canInstall: false },
]

let openedPopup: { closed: boolean; close: () => void; location: { href: string } }
let openSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listGitHubInstallTargets).mockResolvedValue(TARGETS)
  openedPopup = { closed: false, close: () => {}, location: { href: 'about:blank' } }
  openSpy = vi.spyOn(window, 'open').mockReturnValue(openedPopup as unknown as Window)
  vi.mocked(watchGitHubAppInstall).mockReturnValue({
    promise: Promise.resolve({ status: 'installed', connectorId: 'c-1' }),
    cancel: vi.fn(),
  })
})

afterEach(() => {
  openSpy.mockRestore()
})

describe('GitHubInstallTargetModal', () => {
  it('labels every account and leaves the non-owner selectable', async () => {
    render(<GitHubInstallTargetModal tenantId="t1" onCancel={vi.fn()} onComplete={vi.fn()} />)

    expect(await screen.findByText('octocat')).toBeInTheDocument()
    expect(screen.getByText('Personal account')).toBeInTheDocument()
    expect(screen.getByText('You are an owner')).toBeInTheDocument()
    expect(screen.getByText('Needs owner approval')).toBeInTheDocument()

    // Selectable, not disabled: asking is an outcome we support.
    const acme = screen.getByRole('radio', { name: /acme-corp/ })
    expect(acme).not.toBeDisabled()
  })

  it('defaults to the personal account', async () => {
    render(<GitHubInstallTargetModal tenantId="t1" onCancel={vi.fn()} onComplete={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /octocat/ })).toBeChecked(),
    )
  })

  it('opens the popup inside the click, before the install URL is known', async () => {
    // Awaiting install-start and opening afterwards is exactly what popup
    // blockers stop, and it fails silently on the user.
    let releaseInstallUrl: (url: string) => void = () => {}
    vi.mocked(startGitHubAppInstall).mockReturnValue(
      new Promise<string>((resolve) => { releaseInstallUrl = resolve }),
    )

    render(<GitHubInstallTargetModal tenantId="t1" onCancel={vi.fn()} onComplete={vi.fn()} />)
    await screen.findByText('octocat')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // Still waiting on the backend, and the window is already open.
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy.mock.calls[0][0]).toBe('about:blank')
    expect(openedPopup.location.href).toBe('about:blank')

    releaseInstallUrl('https://github.com/apps/dev/installations/new/permissions?state=x')
    await waitFor(() =>
      expect(openedPopup.location.href).toContain('installations/new/permissions'),
    )
  })

  it('sends the picked login so a later approval can be attributed', async () => {
    vi.mocked(startGitHubAppInstall).mockResolvedValue('https://github.com/apps/dev')

    render(<GitHubInstallTargetModal tenantId="t1" onCancel={vi.fn()} onComplete={vi.fn()} />)
    await screen.findByText('acme-corp')
    await userEvent.click(screen.getByRole('radio', { name: /acme-corp/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(startGitHubAppInstall).toHaveBeenCalledWith({
        tenantId: 't1',
        targetLogin: 'acme-corp',
        targetId: 3,
      }),
    )
  })

  it('falls back to the picked login when a pending result carries no organisation', async () => {
    vi.mocked(startGitHubAppInstall).mockResolvedValue('https://github.com/apps/dev')
    vi.mocked(watchGitHubAppInstall).mockReturnValue({
      promise: Promise.resolve({ status: 'pending' }),
      cancel: vi.fn(),
    })
    const onComplete = vi.fn()

    render(<GitHubInstallTargetModal tenantId="t1" onCancel={vi.fn()} onComplete={onComplete} />)
    await screen.findByText('acme-corp')
    await userEvent.click(screen.getByRole('radio', { name: /acme-corp/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({ status: 'pending', org: 'acme-corp' }),
    )
  })

  it('reports a blocked popup rather than failing silently', async () => {
    openSpy.mockReturnValue(null)
    const onComplete = vi.fn()

    render(<GitHubInstallTargetModal tenantId="t1" onCancel={vi.fn()} onComplete={onComplete} />)
    await screen.findByText('octocat')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(onComplete).toHaveBeenCalledWith({ status: 'error', error: 'popup_blocked' })
    expect(startGitHubAppInstall).not.toHaveBeenCalled()
  })

  it('explains a connector that has no usable GitHub token', async () => {
    const { ApiError } = await import('../services/api')
    vi.mocked(listGitHubInstallTargets).mockRejectedValue(
      new ApiError('github_no_user_token', 409),
    )

    render(<GitHubInstallTargetModal tenantId="t1" onCancel={vi.fn()} onComplete={vi.fn()} />)

    expect(
      await screen.findByText(/GitHub authorization is no longer valid/i),
    ).toBeInTheDocument()
  })
})
