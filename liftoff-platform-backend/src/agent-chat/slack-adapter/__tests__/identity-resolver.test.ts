// Tests for identity-resolver. Covers:
//   - forward cache hit (within TTL)
//   - forward cache miss → API call → cache write
//   - cache expiry → refresh from API
//   - users.lookupByEmail returns !ok → null, no cache write
//   - SlackApiError → null, no cache write
//   - reverse cache hit
//   - reverse cache miss returns null

import { jest } from '@jest/globals';

const queryMock = jest.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();

jest.mock('../../../infrastructure/database', () => ({
  withAdminScope: jest.fn(
    async (
      _ctx: unknown,
      fn: (c: { query: typeof queryMock }) => Promise<unknown>,
    ) => fn({ query: queryMock }),
  ),
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const slackApiFetchMock = jest.fn<(method: string, opts: unknown) => Promise<Record<string, unknown>>>();

class SlackApiErrorMock extends Error {}

jest.mock('../slack-api', () => ({
  slackApiFetch: (...args: unknown[]) => slackApiFetchMock(args[0] as string, args[1]),
  SlackApiError: SlackApiErrorMock,
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveSlackIdentity (forward)', () => {
  it('returns cached identity when within TTL', async () => {
    const { resolveSlackIdentity } = await import('../identity-resolver');
    const now = new Date();
    queryMock.mockResolvedValueOnce({
      rows: [{ slack_user_id: 'U999', resolved_at: now }],
    });

    const result = await resolveSlackIdentity({
      accountId: 'acct_1',
      accountEmail: 'a@example.com',
      slackTeamId: 'T1',
      botToken: 'xoxb-test',
    });

    expect(result).toEqual({ slackTeamId: 'T1', slackUserId: 'U999' });
    expect(slackApiFetchMock).not.toHaveBeenCalled();
  });

  it('on cache miss, calls users.lookupByEmail and writes through', async () => {
    const { resolveSlackIdentity } = await import('../identity-resolver');
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT miss
      .mockResolvedValueOnce({ rows: [] }); // INSERT
    slackApiFetchMock.mockResolvedValueOnce({ ok: true, user: { id: 'U_NEW' } });

    const result = await resolveSlackIdentity({
      accountId: 'acct_2',
      accountEmail: 'b@example.com',
      slackTeamId: 'T2',
      botToken: 'xoxb-test',
    });

    expect(result).toEqual({ slackTeamId: 'T2', slackUserId: 'U_NEW' });
    expect(slackApiFetchMock).toHaveBeenCalledWith(
      'users.lookupByEmail',
      expect.objectContaining({
        authToken: 'xoxb-test',
        body: { kind: 'form', value: { email: 'b@example.com' } },
      }),
    );
    // First call read, second call upsert
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1][0]).toContain('INSERT INTO account_slack_identities');
  });

  it('refreshes when cache is older than TTL', async () => {
    const { resolveSlackIdentity } = await import('../identity-resolver');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    queryMock
      .mockResolvedValueOnce({ rows: [{ slack_user_id: 'U_OLD', resolved_at: eightDaysAgo }] })
      .mockResolvedValueOnce({ rows: [] });
    slackApiFetchMock.mockResolvedValueOnce({ ok: true, user: { id: 'U_FRESH' } });

    const result = await resolveSlackIdentity({
      accountId: 'acct_3',
      accountEmail: 'c@example.com',
      slackTeamId: 'T3',
      botToken: 'xoxb-test',
    });

    expect(result?.slackUserId).toBe('U_FRESH');
    expect(slackApiFetchMock).toHaveBeenCalled();
  });

  it('returns null when Slack response !ok and does NOT write cache', async () => {
    const { resolveSlackIdentity } = await import('../identity-resolver');
    queryMock.mockResolvedValueOnce({ rows: [] });
    slackApiFetchMock.mockResolvedValueOnce({ ok: false, error: 'users_not_found' });

    const result = await resolveSlackIdentity({
      accountId: 'acct_4',
      accountEmail: 'd@example.com',
      slackTeamId: 'T4',
      botToken: 'xoxb-test',
    });

    expect(result).toBeNull();
    // No INSERT call
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on SlackApiError and does NOT write cache', async () => {
    const { resolveSlackIdentity } = await import('../identity-resolver');
    queryMock.mockResolvedValueOnce({ rows: [] });
    slackApiFetchMock.mockRejectedValueOnce(new SlackApiErrorMock('rate limited'));

    const result = await resolveSlackIdentity({
      accountId: 'acct_5',
      accountEmail: 'e@example.com',
      slackTeamId: 'T5',
      botToken: 'xoxb-test',
    });

    expect(result).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('reverseResolveSlackIdentity', () => {
  it('returns account_id on cache hit', async () => {
    const { reverseResolveSlackIdentity } = await import('../identity-resolver');
    queryMock.mockResolvedValueOnce({ rows: [{ account_id: 'acct_xyz' }] });

    const result = await reverseResolveSlackIdentity({
      slackTeamId: 'T7',
      slackUserId: 'U_LOOK',
    });

    expect(result).toBe('acct_xyz');
  });

  it('returns null on cache miss', async () => {
    const { reverseResolveSlackIdentity } = await import('../identity-resolver');
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await reverseResolveSlackIdentity({
      slackTeamId: 'T8',
      slackUserId: 'U_NONE',
    });

    expect(result).toBeNull();
  });
});
