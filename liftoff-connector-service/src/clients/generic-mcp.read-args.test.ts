// A read must forward the caller's ARGUMENTS to the vendor tool.
//
// THE DEFECT. `GenericMCPClient.read` was declared `(entityType, entityId)` and
// sent `{ id }` — or `{}` when no id could be extracted from the payload. The
// executor has always CALLED it with three arguments:
//
//     client.read(entityType, entityId, payload)     // adapter.ts
//
// Passing an extra argument to a shorter function is legal JavaScript and does
// not fail a structural interface check, so the payload was discarded in
// silence. No error, no log, no type complaint.
//
// WHICH TOOLS. `inferCrudOp` decides by NAME: every `get|read|list|fetch|
// search|find|query` prefix routes to `read`. On a generic-MCP connector —
// github, datadog, sentry, granola — that is a large fraction of the surface,
// and all of it reached the vendor with no arguments. The write verbs were
// unaffected, since `create` and `update` do take the payload. So one connector
// could post a comment and not read a file: a shape that reads like a scopes
// problem and is not one.
//
// EXAMPLE. `get_commit` dispatched with owner, repo, sha and detail — all four
// present in the action ledger row — gets "missing required parameter: owner"
// from GitHub, while the identical arguments succeed against the same server
// through a direct `tools/call`. `pull_request_read` works meanwhile: it starts
// with neither verb, so `inferCrudOp` falls through to `create`, which forwards.
//
// The same applies to the GitHub `search_*` actions, which fail with empty
// error text — `search` is on that prefix list too.

import { GenericMCPClient } from './generic-mcp.js';
import { inferCrudOp } from './adapter.js';

function clientCapturingArgs(): {
  client: GenericMCPClient;
  callTool: jest.Mock;
} {
  const client = new GenericMCPClient({
    tenantId: 'tenant-1',
    connectorType: 'github',
    mcpUrl: 'https://api.githubcopilot.com/mcp/',
    credentialStore: {} as never,
  });
  const callTool = jest.fn().mockResolvedValue({
    content: [{ type: 'text', text: '{"ok":true}' }],
  });
  (client as unknown as { mcpClient: { callTool: jest.Mock } }).mcpClient = {
    callTool,
  } as never;
  return { client, callTool };
}

/** The arguments the runtime built for `trigger__pr_get_diff_since`, exactly as
 *  the action ledger recorded them on the failing run. */
const GET_COMMIT_ARGS = {
  owner: 'acme',
  repo: 'webapp',
  sha: 'c6d160f7b7760a17d88aea369e139f9e7d3d24c2',
  detail: 'full_patch',
};

describe('a generic-MCP read forwards its arguments', () => {
  it('sends every argument the executor passed', async () => {
    const { client, callTool } = clientCapturingArgs();
    // entityId is '' because get_commit's payload carries no id/targetRef —
    // which is exactly why the old signature sent `{}`.
    await client.read('get_commit', '', GET_COMMIT_ARGS);
    expect(callTool).toHaveBeenCalledWith('get_commit', GET_COMMIT_ARGS);
  });

  it('does NOT send an empty object when there is no id', async () => {
    // The regression in one line. `{}` is what GitHub answered
    // "missing required parameter: owner" to.
    const { client, callTool } = clientCapturingArgs();
    await client.read('get_commit', '', GET_COMMIT_ARGS);
    expect(callTool.mock.calls[0][1]).not.toEqual({});
    expect(callTool.mock.calls[0][1]).toHaveProperty('owner', 'acme');
  });

  it('still sends a bare id for a tool that only takes one', async () => {
    // Strictly wider than the old behaviour: everything that used to arrive
    // still arrives, so a vendor tool keyed on `id` is unaffected.
    const { client, callTool } = clientCapturingArgs();
    await client.read('get_thing', 'thing-1');
    expect(callTool).toHaveBeenCalledWith('get_thing', { id: 'thing-1' });
  });

  it('merges the id on top of the payload rather than instead of it', async () => {
    const { client, callTool } = clientCapturingArgs();
    await client.read('get_thing', 'thing-1', { include: 'all' });
    expect(callTool).toHaveBeenCalledWith('get_thing', { include: 'all', id: 'thing-1' });
  });

  it('delete forwards its arguments too', async () => {
    // Same signature defect, same call shape from the executor. GitHub's
    // delete_file needs owner/repo/path/branch and could never be addressed.
    const { client, callTool } = clientCapturingArgs();
    await client.delete('delete_file', '', {
      owner: 'acme', repo: 'webapp', path: 'a.ts', branch: 'main',
    });
    expect(callTool.mock.calls[0][1]).toHaveProperty('path', 'a.ts');
  });
});

describe('the routing that makes this reachable', () => {
  // Pinned because the defect is only visible as the JOIN of two facts: which
  // op a name infers, and whether that op forwards arguments.
  it('routes the read verbs to the read path', () => {
    for (const name of [
      'get_commit', 'read_file', 'list_commits', 'fetch_thing',
      'search_code', 'find_thing', 'query_thing',
    ]) {
      expect(inferCrudOp(name, undefined)).toBe('read');
    }
  });

  it('routes pull_request_read to create, which is why it kept working', () => {
    // Not an endorsement of the classification — it is a read. But it is the
    // reason one GitHub tool worked while its neighbours did not, and that
    // asymmetry is what made the defect look like a per-tool permissions issue.
    expect(inferCrudOp('pull_request_read', undefined)).toBe('create');
  });
});
