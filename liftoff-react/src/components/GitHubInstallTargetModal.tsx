import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Button from './Button'
import ModalOverlay from './ModalOverlay'
import { ApiError } from '../services/api'
import {
  listGitHubInstallTargets,
  startGitHubAppInstall,
  watchGitHubAppInstall,
  type GitHubAppInstallHandle,
  type GitHubAppInstallResult,
  type GitHubInstallTarget,
} from '../services/connections'

interface GitHubInstallTargetModalProps {
  tenantId: string
  /** User cancelled the picker. The GitHub connection itself is unaffected. */
  onCancel: () => void
  /** The install leg finished, one way or another. */
  onComplete: (result: GitHubAppInstallResult) => void
}

/** Secondary label for a row. `canInstall` labels the row; it never disables
 *  it, because a non-owner is allowed to request and requesting is a supported
 *  outcome rather than a dead end. */
function targetHint(target: GitHubInstallTarget): string {
  if (target.type === 'User') return 'Personal account'
  return target.canInstall ? 'You are an owner' : 'Needs owner approval'
}

/** Load failures the endpoint distinguishes, in the user's terms. The backend
 *  sends `{ error: '<code>' }`, which apiFetch surfaces as the message. */
function loadErrorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.message : ''
  switch (code) {
    case 'github_not_connected':
      return 'GitHub is not connected yet. Connect GitHub first, then install the Liftoff app.'
    case 'github_no_user_token':
      return 'Your GitHub authorization is no longer valid. Reconnect GitHub and try again.'
    case 'github_unreachable':
      return 'GitHub could not be reached. Please try again in a moment.'
    default:
      return 'We could not load your GitHub accounts. Please try again.'
  }
}

/**
 * Asks which account the GitHub App should be installed on, BEFORE handing the
 * user to GitHub.
 *
 * This screen is not decoration. When the chosen organisation belongs to
 * someone else, GitHub records a request instead of installing, and reports it
 * back with no organisation name at all. The approval webhook that arrives
 * later, possibly weeks later from a different person, carries no reference to
 * whoever asked. The login picked here is the only thing that webhook can be
 * matched against, so removing this step is what makes a pending install
 * unattributable.
 */
export default function GitHubInstallTargetModal({
  tenantId,
  onCancel,
  onComplete,
}: GitHubInstallTargetModalProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const installRef = useRef<GitHubAppInstallHandle | null>(null)

  const { data: targets, isPending, error } = useQuery({
    queryKey: ['github-install-targets', tenantId],
    queryFn: () => listGitHubInstallTargets(tenantId),
    retry: false,
    staleTime: 0,
  })

  // `selected` holds the user's explicit choice and stays null until they make
  // one; the default is derived rather than written back into state, so it
  // cannot fight the user once the list re-resolves. The personal account is
  // always first and always installable, which makes it the safe default.
  const activeLogin = selected ?? targets?.[0]?.login ?? null

  // A popup left watching after this modal goes away would keep polling and
  // resolve into a handler nobody is listening to.
  useEffect(() => () => { installRef.current?.cancel() }, [])

  const handleCancel = () => {
    installRef.current?.cancel()
    installRef.current = null
    onCancel()
  }

  const handleContinue = async () => {
    const target = (targets ?? []).find((t) => t.login === activeLogin)
    if (!target) return

    // Opened synchronously inside the click, and pointed at the real URL only
    // once we have it. Awaiting the install-start call first and opening after
    // is precisely what popup blockers stop.
    const width = 1020
    const height = 760
    const left = window.screenX + (window.outerWidth - width) / 2
    const top = window.screenY + (window.outerHeight - height) / 2
    const popup = window.open(
      'about:blank',
      'github_app_install',
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`,
    )
    if (!popup) {
      onComplete({ status: 'error', error: 'popup_blocked' })
      return
    }

    setStarting(true)
    setStartError(null)
    const handle = watchGitHubAppInstall(popup)
    installRef.current = handle

    try {
      const installUrl = await startGitHubAppInstall({
        tenantId,
        targetLogin: target.login,
        targetId: target.id,
      })
      popup.location.href = installUrl
    } catch (err) {
      handle.cancel()
      installRef.current = null
      setStarting(false)
      setStartError(
        err instanceof ApiError && err.message === 'github_app_not_configured'
          ? 'The Liftoff GitHub app is not available in this environment.'
          : 'We could not start the installation. Please try again.',
      )
      return
    }

    const result = await handle.promise
    installRef.current = null
    setStarting(false)
    // Only the pending path falls back to the picked login, and only so the
    // toast can name the organisation. A card is never labelled from this:
    // GitHub lets the user switch accounts on its own screen, so the backend's
    // reading of the real installation is the only trustworthy source.
    onComplete(
      result.status === 'pending' ? { ...result, org: result.org ?? target.login } : result,
    )
  }

  return (
    <ModalOverlay onClose={handleCancel} disableClose={starting} ariaLabelledBy="github-install-title">
      <h2 className="connection-modal__title" id="github-install-title">
        Where should Liftoff be installed?
      </h2>
      <p className="connection-modal__description">
        Choose the account whose repositories your agents will work in. You can install on
        more accounts later.
      </p>

      {isPending ? (
        <p className="connection-modal__loading">Loading your GitHub accounts...</p>
      ) : error ? (
        <p className="connection-modal__field-error">{loadErrorMessage(error)}</p>
      ) : (targets ?? []).length === 0 ? (
        <p className="connection-modal__field-error">
          This GitHub account has nowhere to install the Liftoff app.
        </p>
      ) : (
        <div className="install-target-list" role="radiogroup" aria-labelledby="github-install-title">
          {(targets ?? []).map((target) => (
            <label
              key={target.id}
              className={`install-target${activeLogin === target.login ? ' install-target--selected' : ''}`}
            >
              <input
                type="radio"
                name="github-install-target"
                className="install-target__radio"
                value={target.login}
                checked={activeLogin === target.login}
                onChange={() => setSelected(target.login)}
                disabled={starting}
              />
              <span className="install-target__login">{target.login}</span>
              <span className="install-target__hint">{targetHint(target)}</span>
            </label>
          ))}
        </div>
      )}

      {startError && <p className="connection-modal__field-error">{startError}</p>}

      <div className="connection-modal__actions">
        <Button variant="outline" onClick={handleCancel}>Cancel</Button>
        <Button
          variant="primary"
          onClick={handleContinue}
          disabled={!activeLogin || starting}
          loading={starting}
        >
          Continue
        </Button>
      </div>
    </ModalOverlay>
  )
}
