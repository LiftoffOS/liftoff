// GitHubMCPClient.list() (search_issues / search_pull_requests) + normalizer .results path.

import { GitHubMCPClient } from './github-mcp.js';
import { GitHubNormalizer } from '../normalizers/github.js';

function makeClient(toolResult: unknown) {
  const client = new GitHubMCPClient({ tenantId: 't1', credentialStore: { get: async () => ({}) } as never });
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  (client as unknown as { mcpClient: { callTool: unknown } }).mcpClient = {
    callTool: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return { isError: false, content: [{ type: 'text', text: JSON.stringify(toolResult) }] };
    },
  };
  return { client, calls };
}

describe('GitHubMCPClient.list', () => {
  it('Issue -> search_issues with literal involves:@me + updated:>= query', async () => {
    const { client, calls } = makeClient({ total_count: 1, items: [{ id: 11, number: 7, title: 'bug', state: 'open', updated_at: '2026-06-26T10:00:00Z' }] });
    const res = await client.list('Issue', { since: new Date('2026-06-25T00:00:00Z'), limit: 100 });

    expect(calls[0].tool).toBe('search_issues');
    expect(calls[0].args.query).toContain('is:issue involves:@me');
    expect(calls[0].args.query).toContain('updated:>=2026-06-25T00:00:00.000Z');
    expect(res.records[0].id).toBe('11');
    expect(res.hasMore).toBe(false);
  });

  it('PullRequest -> search_pull_requests with is:pr; paginates when a full page returns', async () => {
    const items = Array.from({ length: 2 }, (_, i) => ({ id: i + 1, number: i + 1, pull_request: { url: 'x' } }));
    const { client, calls } = makeClient({ total_count: 5, items });
    const res = await client.list('PullRequest', { limit: 2 });
    expect(calls[0].tool).toBe('search_pull_requests');
    expect(calls[0].args.query).toContain('is:pr');
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('2');
  });

  it('returns empty for an unsupported entity without calling the MCP', async () => {
    const { client, calls } = makeClient({});
    expect((await client.list('Comment')).records).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('GitHubNormalizer .results polling path', () => {
  it('discriminates Issue vs PullRequest by the nested pull_request field', () => {
    const n = new GitHubNormalizer();
    const recs = n.normalize({
      results: [
        { id: 11, number: 7, title: 'an issue', state: 'open', created_at: '2026-06-26T09:00:00Z', updated_at: '2026-06-26T10:00:00Z', html_url: 'u', user: { login: 'a', id: 101 } },
        { id: 22, number: 8, title: 'a PR', state: 'open', created_at: '2026-06-26T09:30:00Z', updated_at: '2026-06-26T11:00:00Z', html_url: 'u', user: { login: 'b', id: 102 }, pull_request: { url: 'x' } },
      ],
    });
    expect(recs.map(r => r.entityType)).toEqual(['Issue', 'PullRequest']);
    expect(recs[0].externalId).toBe('11');
    expect(recs[1].entityType).toBe('PullRequest');
  });
});
