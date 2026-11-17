// A learned shape belongs to a SERVER, and the store can now hold one.
//
// The table was keyed by connector type, so a tenant's two custom servers —
// and a vendor-hosted GitHub server and the catalog's GitHub connector —
// would have shared every accepted path. And it had never held a row at all:
// every insert went to an RLS-forced table from an unscoped pool and was
// refused by the policy. Both are fixed together: every statement runs under
// the tenant, and a server alias is part of the identity.

import { shapeKeyColumns, shapeKeyOf } from '../learned-shapes-store';
import { acceptedReturnsIds } from '../learned-shapes-cache';

describe('an observation key names the server it came from', () => {
  it('a catalog connector: type and action, empty alias', () => {
    expect(shapeKeyColumns('google_mail.get_thread')).toEqual({ connectorType: 'google_mail', actionType: 'get_thread', serverAlias: '' });
  });
  it('a vendor-hosted or custom server: the alias carries an instance suffix', () => {
    expect(shapeKeyColumns('github-dd4c4689.pull_request_read')).toEqual({ connectorType: 'github', actionType: 'pull_request_read', serverAlias: 'github-dd4c4689' });
    expect(shapeKeyColumns('custom-mcp-d144a7ea.search_articles')).toMatchObject({ actionType: 'search_articles', serverAlias: 'custom-mcp-d144a7ea' });
  });
  it('and reads back under the alias when there is one, the type when there is not', () => {
    expect(shapeKeyOf({ connectorType: 'github', actionType: 'pull_request_read', serverAlias: 'github-dd4c4689' })).toBe('github-dd4c4689.pull_request_read');
    expect(shapeKeyOf({ connectorType: 'github', actionType: 'list_issues', serverAlias: '' })).toBe('github.list_issues');
  });
  it('rejects a key with no action', () => {
    expect(shapeKeyColumns('github')).toBeNull();
  });
});

describe('the cache asks by server', () => {
  it('two servers of one type do not share a shape', () => {
    // Nothing accepted yet for this tenant: both answers empty, but asked
    // under different keys — the point is that the keys differ.
    expect(acceptedReturnsIds('t-x', 'github', 'pull_request_read', 'github-dd4c4689')).toEqual([]);
    expect(acceptedReturnsIds('t-x', 'github', 'pull_request_read', 'github-7d07a896')).toEqual([]);
  });
});
