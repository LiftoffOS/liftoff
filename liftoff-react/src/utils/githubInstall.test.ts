import { describe, it, expect } from 'vitest'
import { hasGitHubApp, installState, repositoryScopeLabel } from './githubInstall'

describe('repositoryScopeLabel', () => {
  it('says "All repositories" rather than counting them', () => {
    // "all" covers every repository the account gains tomorrow too, so any
    // stored number would start going stale the moment it was written.
    expect(repositoryScopeLabel({ config: { repositorySelection: 'all' } })).toBe('All repositories')
  })

  it('never invents the denominator it does not have', () => {
    // We know how many repositories were selected, not how many the account
    // has. "4 of 37" would be a number the user could check and find wrong.
    const label = repositoryScopeLabel({
      config: { repositorySelection: 'selected', repositoryCount: 4 },
    })
    expect(label).toBe('4 repositories')
    expect(label).not.toMatch(/ of /)
  })

  it('falls back to the names array when no count was written', () => {
    expect(
      repositoryScopeLabel({
        config: { repositorySelection: 'selected', repositoryNames: ['api'] },
      }),
    ).toBe('1 repository')
  })

  it('returns nothing for a connection that predates the App', () => {
    expect(repositoryScopeLabel({ config: {} })).toBeUndefined()
    expect(repositoryScopeLabel(undefined)).toBeUndefined()
  })
})

describe('hasGitHubApp / installState', () => {
  it('treats a row with no installationId as having no App', () => {
    // Such a row keeps using its stored user token exactly as before, so the
    // disconnect warning about a lingering installation must not appear.
    expect(hasGitHubApp({ config: { externalAccountLabel: 'octocat' } })).toBe(false)
  })

  it('detects an installed App', () => {
    expect(hasGitHubApp({ config: { installationId: 12345 } })).toBe(true)
  })

  it('reads the awaiting-approval state', () => {
    expect(installState({ config: { installState: 'awaiting_org_approval' } })).toBe(
      'awaiting_org_approval',
    )
  })
})
