// GitLabClient.list() — multi-scope UNION over REST /merge_requests + /issues.
// GitLab has no involves:@me scope, so list() sequences per-user scopes
// (created_by_me, assigned_to_me, and reviews_for_me for MRs) through pageToken
// encoded as "<scopeIndex>:<page>". Plus GitLabNormalizer .results discrimination.

import { GitLabClient } from './gitlab.js';
import { GitLabNormalizer } from '../normalizers/gitlab.js';
import type { CredentialStore } from '../mcp/credential-store.js';

// OAuthTokenProvider (used by GitLabClient) calls credentialStore.getCredentials.
const credentialStore = {
  getCredentials: async () => ({ accessToken: 'glpat_test' }),
  refreshOAuthToken: async () => ({ accessToken: 'glpat_test', expiresInMs: 3600_000 }),
} as unknown as CredentialStore;

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function newClient() {
  return new GitLabClient({ tenantId: 't1', credentialStore });
}

describe('GitLabClient.list (multi-scope union)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('first call (no pageToken) hits scope=created_by_me on /merge_requests + updated_after + order_by/sort', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse([
        { id: 101, iid: 7, title: 'a MR', state: 'opened', source_branch: 'feat', target_branch: 'main', updated_at: '2026-06-26T10:00:00Z' },
      ]),
    );
    const res = await newClient().list('PullRequest', { since: new Date('2026-06-25T00:00:00Z'), limit: 100 });

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('/api/v4/merge_requests?');
    expect(url).toContain('scope=created_by_me'); // union starts at scope 0
    expect(url).not.toContain('scope=all'); // scope=all times out on gitlab.com
    expect(url).toContain('order_by=updated_at');
    expect(url).toContain('sort=desc');
    expect(url).toContain('per_page=100');
    expect(url).toContain('page=1');
    expect(decodeURIComponent(url)).toContain('updated_after=2026-06-25T00:00:00.000Z');

    // Bearer token from the OAuth provider is forwarded.
    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer glpat_test');

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('101');
    expect(res.records[0].data.iid).toBe(7);
    // Short page on scope 0 -> advance to scope 1's first page.
    expect(res.nextPageToken).toBe('1:1');
    expect(res.hasMore).toBe(true);
  });

  it('a partial page advances to the next scope ("0:1" -> nextPageToken "1:1")', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse([{ id: 1, iid: 1, source_branch: 'x', target_branch: 'main', updated_at: 't' }]),
    );
    const res = await newClient().list('PullRequest', { pageToken: '0:1', limit: 100 });

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('scope=created_by_me');
    expect(url).toContain('page=1');
    expect(res.nextPageToken).toBe('1:1'); // 1 record < perPage 100 -> next scope
    expect(res.hasMore).toBe(true);
  });

  it('a full page stays in the same scope with page+1 ("1:3" -> "1:4")', async () => {
    const items = Array.from({ length: 2 }, (_, i) => ({ id: i + 1, iid: i + 1, source_branch: 'x', target_branch: 'main', updated_at: 't' }));
    const spy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse(items));
    const res = await newClient().list('PullRequest', { pageToken: '1:3', limit: 2 });

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('scope=assigned_to_me'); // scope index 1
    expect(url).toContain('page=3');
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('1:4'); // full page -> same scope, page+1
  });

  it('the last scope draining (short page on reviews_for_me) returns undefined nextPageToken', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse([]));
    const res = await newClient().list('PullRequest', { pageToken: '2:1', limit: 100 });

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('scope=reviews_for_me'); // scope index 2 (MR-only)
    expect(res.nextPageToken).toBeUndefined(); // all scopes drained
    expect(res.hasMore).toBe(false);
  });

  it('Issue unions only created_by_me + assigned_to_me (reviews_for_me is never queried)', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse([{ id: 55, iid: 3, title: 'a bug', state: 'opened', updated_at: '2026-06-26T10:00:00Z' }])) // scope 0 short
      .mockResolvedValueOnce(mockResponse([])); // scope 1 short -> union ends

    const client = newClient();
    const first = await client.list('Issue', { since: new Date('2026-06-25T00:00:00Z') });
    const firstUrl = spy.mock.calls[0][0] as string;
    expect(firstUrl).toContain('/api/v4/issues?');
    expect(firstUrl).toContain('scope=created_by_me');
    expect(firstUrl).not.toContain('scope=all');
    expect(decodeURIComponent(firstUrl)).toContain('updated_after=2026-06-25T00:00:00.000Z');
    expect(first.records[0].id).toBe('55');
    expect(first.nextPageToken).toBe('1:1'); // advances to assigned_to_me

    const second = await client.list('Issue', { pageToken: first.nextPageToken });
    const secondUrl = spy.mock.calls[1][0] as string;
    expect(secondUrl).toContain('scope=assigned_to_me');
    // Only two scopes for issues: reviews_for_me is never reached, so the union ends.
    expect(second.nextPageToken).toBeUndefined();
    expect(second.hasMore).toBe(false);
  });

  it('returns empty for an unsupported entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    expect((await newClient().list('Comment')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('GitLabNormalizer .results polling path', () => {
  it('emits PullRequest for a merge request and Issue for an issue', () => {
    const n = new GitLabNormalizer();
    const recs = n.normalize({
      results: [
        { id: 55, iid: 3, title: 'a bug', state: 'opened', author: { id: 9, username: 'dev' }, created_at: '2026-06-26T09:00:00Z', updated_at: '2026-06-26T10:00:00Z' },
        { id: 101, iid: 7, title: 'a MR', state: 'merged', author: { id: 9, username: 'dev' }, source_branch: 'feat', target_branch: 'main', merged_at: '2026-06-26T12:00:00Z', created_at: '2026-06-26T09:30:00Z', updated_at: '2026-06-26T11:00:00Z' },
      ],
    });
    expect(recs.map(r => r.entityType)).toEqual(['Issue', 'PullRequest']);
    expect(recs[0].externalId).toBe('55');
    expect(recs[1].externalId).toBe('101');
    // A GitLab merge request MUST publish as entityType 'PullRequest'.
    expect(recs[1].entityType).toBe('PullRequest');
    expect(recs[1].data.merged).toBe(true);
    expect(recs[1].data.headRef).toBe('feat');
    expect(recs[1].data.baseRef).toBe('main');
  });
});
