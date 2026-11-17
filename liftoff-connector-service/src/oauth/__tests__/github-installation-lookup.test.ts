// The row a caller names is not necessarily the row holding the installation.
//
// Otherwise a reviewing agent can post a review as the human account, after a
// healthy install with installation tokens minting correctly — and cannot
// approve, because approving as the PR author is not something it can do.
//
// Cause: agents are bound to a connector id at distillation time and that id is
// baked into their compiled instructions. An agent pinned to the OAuth row,
// with the installation on a separate per-account row, gets GetCredentials
// asked for the row without an installation, which faithfully returns the user
// token.

const mockQuery = jest.fn();

jest.mock('../../db/pool.js', () => ({
  withTenantScope: async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: (...a: unknown[]) => mockQuery(...a) }),
}));
jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveGithubInstallationId } from '../github-installation-lookup.js';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('resolveGithubInstallationId', () => {
  it("prefers the row's OWN installation without querying", async () => {
    // A caller that named a specific account gets that account.
    expect(await resolveGithubInstallationId('t1', { installationId: 12345678 })).toBe(12345678);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('finds the sibling installation when the named row has none', async () => {
    // THE REGRESSION. An agent pinned to the OAuth row.
    mockQuery.mockResolvedValue({
      rows: [{ installation_id: '12345678', account: 'acme' }],
    });

    const id = await resolveGithubInstallationId('t1', {
      externalAccountLabel: 'octocat',
      bot_login: 'octocat',
    });

    expect(id).toBe(12345678);
  });

  it('only considers active rows carrying an installation', async () => {
    await resolveGithubInstallationId('t1', {});
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status\s*=\s*'active'/);
    expect(sql).toMatch(/config->>'installationId' IS NOT NULL/);
    expect(mockQuery.mock.calls[0][1]).toEqual(['t1']);
  });

  it('returns 0 when the tenant has no installation at all', async () => {
    // The pre-App tenant. Falling through to the user token is correct here and
    // is what lets this ship without a cutover.
    expect(await resolveGithubInstallationId('t1', {})).toBe(0);
  });

  it('falls back rather than guessing when several installations exist', async () => {
    // Personal account plus an org. Which one is right depends on the target
    // repository, which is not known at this call. Acting as the wrong account
    // on somebody else's repositories is worse than a degraded identity, so this
    // returns 0 and the user token is used.
    mockQuery.mockResolvedValue({
      rows: [
        { installation_id: '111', account: 'octocat' },
        { installation_id: '222', account: 'acme' },
      ],
    });

    expect(await resolveGithubInstallationId('t1', {})).toBe(0);
  });

  it('does not treat a non-numeric installation id as usable', async () => {
    mockQuery.mockResolvedValue({ rows: [{ installation_id: 'not-a-number', account: 'x' }] });
    expect(await resolveGithubInstallationId('t1', {})).toBe(0);
  });
});
