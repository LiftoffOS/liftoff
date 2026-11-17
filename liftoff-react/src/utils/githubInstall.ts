/**
 * Readers for the GitHub App installation fields the connector-service writes
 * onto a `github` connector's `config`.
 *
 * A row with no `installationId` predates the App and keeps using its stored
 * user token exactly as before, so every reader here returns undefined rather
 * than a default: absent means "this connection has no App", not "zero".
 */

interface ConnectorLike {
  config?: Record<string, unknown> | null
}

export interface GitHubInstallConfig {
  installationId?: number
  /** 'all' means every repository the account has today AND every one it gains
   *  tomorrow, which is why no list is stored for it. */
  repositorySelection?: 'all' | 'selected'
  /** Only present under `repositorySelection: 'selected'`. */
  repositoryNames?: string[]
  /** Only present under `repositorySelection: 'selected'`. */
  repositoryCount?: number
  installState?: 'installed' | 'awaiting_org_approval' | 'uninstalled'
  /** The organisation a pending install is waiting on. */
  awaitingOrgLogin?: string
}

export function githubInstallConfig(connector: ConnectorLike | undefined | null): GitHubInstallConfig {
  return (connector?.config ?? {}) as GitHubInstallConfig
}

/** `'awaiting_org_approval'` is the one that changes what the user sees. */
export function installState(connector: ConnectorLike | undefined | null): string | undefined {
  return githubInstallConfig(connector).installState
}

/** True once the App is installed on this connection, so its writes carry the
 *  Liftoff identity rather than a person's. */
export function hasGitHubApp(connector: ConnectorLike | undefined | null): boolean {
  return githubInstallConfig(connector).installationId !== undefined
}

/**
 * What the installation can reach, for the card subtitle.
 *
 * Deliberately never renders "n of N": we know how many repositories were
 * selected but not how many the account has, and inventing the denominator
 * would be a number the user could check and find wrong.
 */
export function repositoryScopeLabel(
  connector: ConnectorLike | undefined | null,
): string | undefined {
  const config = githubInstallConfig(connector)
  if (config.repositorySelection === 'all') return 'All repositories'
  if (config.repositorySelection !== 'selected') return undefined

  const count = config.repositoryCount ?? config.repositoryNames?.length
  if (count === undefined) return 'Selected repositories'
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}
