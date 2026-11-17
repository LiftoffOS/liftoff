// Last-activity derivation for developer proxy credentials.
//
// developer_proxy_credentials.last_used_at cannot be written from the proxy hot
// path: a no-GUC UPDATE on the raw pool meets only the table's sole no-GUC
// policy (auth_lookup_bypass, migration 005), which is FOR SELECT, so it matches
// zero rows on every proxied request and the Teams page shows "Never" for every
// Claude Code and Codex connection. Last activity is read off
// developer_proxy_usage_log instead, whose reporter_bypass policy is FOR ALL and
// which therefore has the real history.

import { jest } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import * as repository from '../credentials/repository.js';

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

function fakeQuery(rows: Record<string, unknown>[]) {
  return jest.fn((..._args: unknown[]): Promise<QueryResult> =>
    Promise.resolve({ rows, rowCount: rows.length }));
}

function fakeClient(rows: Record<string, unknown>[]) {
  const query = fakeQuery(rows);
  return { client: { query } as unknown as PoolClient, query };
}

const TENANT = '00000000-0000-0000-0000-0000000000t1'.replace(/t/g, 'a');
const USER = 'user-1';

function credentialRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenant_id: TENANT,
    user_id: USER,
    vendor: 'openai',
    key_prefix: 'liftoff_sk_abcd1234',
    key_hint: 'wxyz',
    secret_name: 'projects/YOUR_PROJECT/secrets/y',
    label: 'Alex Rivera (Codex)',
    status: 'active',
    last_used_at: null,
    revoked_at: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

describe('credential last-activity derivation', () => {
  it('listByTenant derives last activity from the usage log', async () => {
    const { client, query } = fakeClient([credentialRow()]);

    await repository.listByTenant(client, TENANT);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('developer_proxy_usage_log');
    expect(sql).toContain('MAX(started_at)');
    expect(sql).toContain('GREATEST');
    expect(sql).toContain('effective_last_used_at');
  });

  it('listByTenant derives it for the user-scoped variant too', async () => {
    const { client, query } = fakeClient([credentialRow()]);

    await repository.listByTenant(client, TENANT, USER);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('developer_proxy_usage_log');
    expect(sql).toContain('MAX(started_at)');
  });

  it('findByIdForTenant derives it as well, so the detail view agrees with the list', async () => {
    const { client, query } = fakeClient([credentialRow()]);

    await repository.findByIdForTenant(client, '11111111-1111-1111-1111-111111111111', TENANT);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('developer_proxy_usage_log');
    expect(sql).toContain('MAX(started_at)');
  });

  it('surfaces the derived timestamp even when the stored column is null', async () => {
    const used = new Date('2026-07-28T10:30:00Z');
    const { client } = fakeClient([
      credentialRow({ last_used_at: null, effective_last_used_at: used }),
    ]);

    const [credential] = await repository.listByTenant(client, TENANT);

    // This is the reported bug: post-cutover credentials have a null stored
    // column, and used to render as "Never" no matter how much they were used.
    expect(credential.lastUsedAt).toEqual(used);
  });

  it('keeps the stored timestamp for pre-cutover rows with no usage history', async () => {
    // tools/migration/backfill.ts carried last_used_at across from the dropped
    // claude_code_proxy_keys table, so those rows have a real value that no
    // usage row can explain. GREATEST ignores NULLs, so SQL hands back the
    // stored one.
    const backfilled = new Date('2026-01-15T09:00:00Z');
    const { client } = fakeClient([
      credentialRow({ last_used_at: backfilled, effective_last_used_at: backfilled }),
    ]);

    const [credential] = await repository.listByTenant(client, TENANT);

    expect(credential.lastUsedAt).toEqual(backfilled);
  });

  it('still reports never-used when there is neither a stored value nor usage', async () => {
    const { client } = fakeClient([
      credentialRow({ last_used_at: null, effective_last_used_at: null }),
    ]);

    const [credential] = await repository.listByTenant(client, TENANT);

    expect(credential.lastUsedAt).toBeNull();
  });

  it('leaves the proxy hot path alone — the key-hash lookup does not join usage', async () => {
    // findByKeyHash runs on every proxied request under auth_lookup_bypass.
    // Joining the usage log here would put an aggregate in front of every token.
    const query = fakeQuery([credentialRow()]);
    const pool = { query } as unknown as Pool;

    await repository.findByKeyHash(pool, 'hash');

    const sql = String(query.mock.calls[0][0]);
    expect(sql).not.toContain('developer_proxy_usage_log');
    expect(sql).not.toContain('MAX(');
  });

  it('no longer exposes an updateLastUsed writer', () => {
    // A no-GUC writer could never match a row under RLS.
    expect((repository as Record<string, unknown>).updateLastUsed).toBeUndefined();
  });
});
