// The grant lifecycle — unit tests. One place decides whether a (client,
// person, workspace, resource) tuple reuses its grant or retires the old
// family and builds a new one; both approval paths (the consent page and the
// /activate page) call it and must get the same answer. One place retires a
// family, and one place takes the id-ordered multi-row grant lock.
//
// What a scripted client can show is the statement sequence, which is the
// lock order: tier 1 (the client row FOR SHARE) precedes tier 3 (the grant
// FOR UPDATE OF g), and every write follows the lock that guards it.

import type { PoolClient } from 'pg';
import { ensureGrant, lockActiveGrants, retireGrantFamily } from '../grant-lifecycle';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const SUBJECT = { tenantId: TENANT_ID, accountId: ACCOUNT_ID, clientId: 'liftoff_oc_abc', clientName: 'Codex', resource: 'https://api-test.example.com/mcp' };

function scopedClient(): { client: PoolClient; query: jest.Mock; sqls: () => string[] } {
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  return {
    client: { query } as unknown as PoolClient,
    query,
    sqls: () => query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ')),
  };
}

const registered = { rows: [{ deleted_at: null }] };

const liveGrant = (overrides: Record<string, unknown> = {}) => ({
  grant_id: 'grant-old',
  mcp_token_id: 'anchor-old',
  anchor_status: 'active',
  anchor_deleted_at: null,
  anchor_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  ...overrides,
});

describe('ensureGrant', () => {
  it('holds the client row FOR SHARE first (tier 1), then the grant FOR UPDATE OF g (tier 3), and reuses a live one creating nothing', async () => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce(registered).mockResolvedValueOnce({ rows: [liveGrant()] });
    expect(await ensureGrant(client, SUBJECT)).toBe('grant-old');
    const s = sqls();
    expect(s).toHaveLength(2);
    expect(s[0]).toBe('SELECT deleted_at FROM oauth_clients WHERE client_id = $1 FOR SHARE');
    expect(query.mock.calls[0][1]).toEqual(['liftoff_oc_abc']);
    expect(s[1]).toContain("AND g.resource = $4 AND g.status = 'active' FOR UPDATE OF g");
    expect(query.mock.calls[1][1]).toEqual(['liftoff_oc_abc', ACCOUNT_ID, TENANT_ID, SUBJECT.resource]);
  });

  it('answers null with nothing else issued when the client is deprovisioned, or does not exist', async () => {
    for (const tier1 of [{ rows: [{ deleted_at: new Date().toISOString() }] }, { rows: [] }]) {
      const { client, query, sqls } = scopedClient();
      query.mockResolvedValueOnce(tier1);
      expect(await ensureGrant(client, SUBJECT)).toBeNull();
      expect(sqls()).toHaveLength(1);
      expect(sqls()[0]).toContain('FOR SHARE');
    }
  });

  it('builds anchor, assignment and grant when the tuple has none', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce(registered)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'anchor-new' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'grant-new' }] });
    expect(await ensureGrant(client, SUBJECT)).toBe('grant-new');
    const s = sqls();
    expect(s.some((q) => q.includes("UPDATE oauth_grants SET status = 'revoked'"))).toBe(false);
    expect(s[2]).toContain('INSERT INTO mcp_tokens');
    expect(query.mock.calls[2][1]).toEqual([TENANT_ID, ACCOUNT_ID, 'Codex']);
    expect(s[3]).toContain('INSERT INTO person_agent_assignments');
    expect(s[4]).toContain('INSERT INTO oauth_grants');
    expect(query.mock.calls[4][1]).toEqual([TENANT_ID, 'liftoff_oc_abc', ACCOUNT_ID, 'anchor-new', SUBJECT.resource]);
  });

  it('retires the whole old family under the grant lock, each statement bound to that grant or anchor, when the anchor has expired', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce(registered)
      .mockResolvedValueOnce({ rows: [liveGrant({ anchor_expires_at: new Date(Date.now() - 1000).toISOString() })] })
      .mockResolvedValueOnce({ rows: [] }) // grant revoked
      .mockResolvedValueOnce({ rows: [] }) // access tokens
      .mockResolvedValueOnce({ rows: [] }) // refresh tokens
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // anchor
      .mockResolvedValueOnce({ rows: [] }) // assignment
      .mockResolvedValueOnce({ rows: [{ id: 'anchor-new' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'grant-new' }] });
    expect(await ensureGrant(client, SUBJECT)).toBe('grant-new');
    const s = sqls();
    expect(s[1]).toContain('FOR UPDATE OF g');
    const revoking = query.mock.calls.slice(2, 7);
    expect(revoking.map((c) => String(c[0]).replace(/\s+/g, ' '))).toEqual([
      expect.stringContaining("UPDATE oauth_grants SET status = 'revoked'"),
      expect.stringContaining('UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()'),
      expect.stringContaining('UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()'),
      expect.stringContaining("UPDATE mcp_tokens SET status = 'revoked', deleted_at = NOW() WHERE id = $1 AND status = 'active' AND deleted_at IS NULL"),
      expect.stringContaining('UPDATE person_agent_assignments SET deleted_at = NOW() WHERE agent_id = $1'),
    ]);
    expect(revoking.map((c) => c[1])).toEqual([['grant-old'], ['grant-old'], ['grant-old'], ['anchor-old'], ['anchor-old']]);
    expect(s[7]).toContain('INSERT INTO mcp_tokens');
  });

  it('a revoked or deleted anchor is not live either', async () => {
    for (const dead of [{ anchor_status: 'revoked' }, { anchor_deleted_at: new Date().toISOString() }]) {
      const { client, query } = scopedClient();
      query
        .mockResolvedValueOnce(registered)
        .mockResolvedValueOnce({ rows: [liveGrant(dead)] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'anchor-new' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'grant-new' }] });
      expect(await ensureGrant(client, SUBJECT)).toBe('grant-new');
      expect(query.mock.calls.some((c) => String(c[0]).includes("UPDATE oauth_grants SET status = 'revoked'"))).toBe(true);
    }
  });
});

describe('retireGrantFamily', () => {
  it('runs branch B\'s five statements in order, each bound to the grant or anchor, marking only live tokens', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await retireGrantFamily(client, { grantId: 'g1', anchorId: 'a1' })).toEqual({ anchorRetired: 1 });
    expect(sqls()).toEqual([
      "UPDATE oauth_grants SET status = 'revoked', revoked_at = NOW() WHERE id = $1",
      'UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()',
      'UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()',
      "UPDATE mcp_tokens SET status = 'revoked', deleted_at = NOW() WHERE id = $1 AND status = 'active' AND deleted_at IS NULL",
      'UPDATE person_agent_assignments SET deleted_at = NOW() WHERE agent_id = $1 AND deleted_at IS NULL',
    ]);
    expect(query.mock.calls.map((c) => c[1])).toEqual([['g1'], ['g1'], ['g1'], ['a1'], ['a1']]);
  });

  it('returns anchorRetired 0 when the anchor was already retired (the statement is idempotent)', async () => {
    const { client, query } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await retireGrantFamily(client, { grantId: 'g1', anchorId: 'a1' })).toEqual({ anchorRetired: 0 });
  });
});

describe('lockActiveGrants', () => {
  it('locks a client\'s active grants in id order and returns each with its anchor', async () => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce({ rows: [{ id: 'g1', mcp_token_id: 'a1' }, { id: 'g2', mcp_token_id: 'a2' }] });
    expect(await lockActiveGrants(client, { clientId: 'liftoff_oc_abc' })).toEqual([
      { grantId: 'g1', anchorId: 'a1' },
      { grantId: 'g2', anchorId: 'a2' },
    ]);
    expect(sqls()[0]).toBe("SELECT id, mcp_token_id FROM oauth_grants WHERE client_id = $1 AND status = 'active' ORDER BY id FOR UPDATE");
    expect(query.mock.calls[0][1]).toEqual(['liftoff_oc_abc']);
  });

  it('locks a person\'s active grants in one workspace the same way', async () => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await lockActiveGrants(client, { accountId: ACCOUNT_ID, tenantId: TENANT_ID })).toEqual([]);
    expect(sqls()[0]).toBe("SELECT id, mcp_token_id FROM oauth_grants WHERE account_id = $1 AND tenant_id = $2 AND status = 'active' ORDER BY id FOR UPDATE");
    expect(query.mock.calls[0][1]).toEqual([ACCOUNT_ID, TENANT_ID]);
  });
});
