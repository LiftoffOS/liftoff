import { buildIdentityConfig } from './identity-config.js';
import type { ExternalIdentity } from './identity-fetchers.js';

describe('buildIdentityConfig', () => {
  const githubIdentity: ExternalIdentity = {
    externalAccountId: '12345',
    externalAccountLabel: 'octobot',
  };

  it('records externalAccountId + externalAccountLabel for every provider', () => {
    const cfg = buildIdentityConfig('slack', {
      externalAccountId: 'T1',
      externalAccountLabel: 'Acme',
    });
    expect(cfg).toEqual({ externalAccountId: 'T1', externalAccountLabel: 'Acme' });
  });

  it('records bot_login (= the github login) for github so the self-event exclusion can be built', () => {
    const cfg = buildIdentityConfig('github', githubIdentity);
    expect(cfg).toEqual({
      externalAccountId: '12345',
      externalAccountLabel: 'octobot',
      bot_login: 'octobot',
    });
  });

  it('records github scopes so team-provisioning can validate a role s required scopes', () => {
    const cfg = buildIdentityConfig('github', githubIdentity, { scopes: ['repo', 'workflow'] });
    expect(cfg).toMatchObject({ bot_login: 'octobot', scopes: ['repo', 'workflow'] });
  });

  it('omits scopes when none were granted / for non-github providers', () => {
    expect(buildIdentityConfig('github', githubIdentity, { scopes: [] })).not.toHaveProperty('scopes');
    expect(buildIdentityConfig('github', githubIdentity, { scopes: null })).not.toHaveProperty('scopes');
    expect(buildIdentityConfig('slack', githubIdentity, { scopes: ['chat:write'] })).not.toHaveProperty('scopes');
  });

  it('records bot_login (= the gitlab username) + scopes for gitlab — SWE-team parity with github', () => {
    const gitlabScopes = ['api', 'read_user', 'read_repository', 'write_repository'];
    const cfg = buildIdentityConfig('gitlab', { externalAccountId: '77', externalAccountLabel: 'tanukibot' }, { scopes: gitlabScopes });
    expect(cfg).toMatchObject({ externalAccountId: '77', externalAccountLabel: 'tanukibot', bot_login: 'tanukibot', scopes: gitlabScopes });
  });

  it('does NOT set bot_login for non-version-control providers', () => {
    const cfg = buildIdentityConfig('slack', githubIdentity);
    expect(cfg).not.toHaveProperty('bot_login');
  });

  it('omits bot_login when github somehow has no login label (fail-closed downstream)', () => {
    // team-provisioning then 422s rather than provisioning a team that would
    // react to its own PRs — the exclusion has no login to compare against.
    const cfg = buildIdentityConfig('github', {
      externalAccountId: '999',
      externalAccountLabel: null,
    });
    expect(cfg).not.toHaveProperty('bot_login');
    expect(cfg.externalAccountId).toBe('999');
  });
});
