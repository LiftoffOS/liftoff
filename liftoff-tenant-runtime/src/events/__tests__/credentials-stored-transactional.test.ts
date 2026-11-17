// Regression guard for the connector.credentials_stored handler.
//
// The bug it prevents: an earlier implementation ran four sequential
// pool.query() calls (connectors → connector_credentials →
// connector_manifests → action_allowlists). Each call grabbed a fresh
// connection from the pool, so a failure on the third query left the
// first two committed and the third+fourth missing. Pub/Sub does not
// redeliver a message whose handler returned the surfaced error after
// partial commits were already persisted, and the broken-state was
// permanent.
//
// The resulting state (google_mail, for example): connectors row +
// connector_credentials row both present, connector_manifests row +
// action_allowlists row both missing. Every google_mail tool call is then
// rejected at the validator's alias-resolution step.
//
// The fix wraps the handler in a single transaction on a single client
// from the pool. This test asserts that contract:
//   1. BEGIN, the four INSERTs, and COMMIT all run on THE SAME client.
//   2. A failure on ANY of the inner INSERTs triggers ROLLBACK and
//      re-throws so Pub/Sub redelivers.
//   3. The connection is always released back to the pool (no leak).

const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();
const mockPoolQuery = jest.fn();

// The handler reads from subscriberPool which is constructed at module
// import via getPoolForService. Mock the database module to swap in our
// instrumented pool.
jest.mock('../../infrastructure/database', () => {
  const fakePool = {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: () => mockPoolConnect(),
  };
  return {
    getPool: jest.fn(() => fakePool),
    getPoolForService: jest.fn(() => fakePool),
    pool: new Proxy({} as Record<string, unknown>, {
      get(_, prop) { return (fakePool as Record<string, unknown>)[prop as string]; },
    }),
  };
});
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { dispatchEvent } from '../subscriber';

function buildCredentialsStoredEvent(
  connectorId: string = '00000000-0000-0000-0000-0000000000aa',
  connectorType: string = 'google_mail',
): Record<string, unknown> {
  return {
    event_id: `evt-${connectorId}`,
    tenant_id: '00000000-0000-0000-0000-000000000001',
    entity_type: 'connector',
    entity_id: connectorId,
    event_type: 'connector.credentials_stored',
    event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: {
      connectorType,
      secretVersion: '1',
      expiresAt: null,
      scopes: ['gmail.readonly'],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockClientQuery(...args),
    release: () => mockClientRelease(),
  });
});

describe('connector.credentials_stored handler — transactional invariant', () => {
  it('runs BEGIN, all four INSERTs, and COMMIT on a single acquired client (happy path)', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });

    await dispatchEvent(buildCredentialsStoredEvent(), 1, 'control-plane-events');

    // The pool was asked for exactly one client — proves all writes
    // share a single connection, which is what makes the transaction
    // legal in pg.
    expect(mockPoolConnect).toHaveBeenCalledTimes(1);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);

    // Drop the array out of the mock and inspect only the SQL strings.
    const sqls = mockClientQuery.mock.calls.map(c => String(c[0]));
    // BEGIN must come first and COMMIT last. The four INSERTs sit
    // between them, in this order.
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls.some(s => /INSERT INTO connectors\b/i.test(s))).toBe(true);
    expect(sqls.some(s => /INSERT INTO connector_credentials\b/i.test(s))).toBe(true);
    expect(sqls.some(s => /INSERT INTO connector_manifests\b/i.test(s))).toBe(true);
    expect(sqls.some(s => /INSERT INTO action_allowlists\b/i.test(s))).toBe(true);

    // None of the four INSERTs went through pool.query directly — they
    // all routed through the client. This is the actual regression
    // guard: if someone reverts to subscriberPool.query for any of
    // the four statements, transaction guarantees vanish silently.
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows when the manifest INSERT fails — Pub/Sub will redeliver', async () => {
    // The partial-failure scenario: queries 1 and 2 succeed, query 3
    // (manifests) blows up.
    mockClientQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO connector_manifests\b/i.test(sql)) {
        return Promise.reject(new Error('simulated manifest INSERT failure'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      dispatchEvent(buildCredentialsStoredEvent(), 1, 'control-plane-events'),
    ).rejects.toThrow(/manifest INSERT failure/);

    const sqls = mockClientQuery.mock.calls.map(c => String(c[0]));
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    // Connection still released — no pool leak.
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  describe('multi-account aliasing', () => {
    // The same handler had a deeper problem than partial failure: the handler generated the manifest alias
    // from connector_type alone (`replace(_,'-')`), so two OAuth grants
    // of the same type produced colliding aliases and the second's
    // manifest INSERT silently UPSERT-clobbered the first. The fix
    // appends the first 8 hex of the connector_id, giving each account
    // a unique alias.

    it('appends the connector_id prefix to the manifest alias', async () => {
      mockClientQuery.mockResolvedValue({ rows: [] });

      await dispatchEvent(
        buildCredentialsStoredEvent('eaec0c30-9514-448f-8ed0-29b1567de8d3', 'google_mail'),
        1,
        'control-plane-events',
      );

      const manifestCall = mockClientQuery.mock.calls.find(
        (c) => /INSERT INTO connector_manifests\b/i.test(String(c[0])),
      );
      expect(manifestCall).toBeDefined();
      // The alias parameter is the 4th positional arg in the INSERT VALUES
      // ($1=connectorId, $2=tenantId, $3=connectorType, $4=alias, $5=displayName).
      const params = manifestCall![1] as unknown[];
      expect(params[3]).toBe('google-mail-eaec0c30');
    });

    it('produces distinct aliases for two same-type connectors (multi-account)', async () => {
      // The exact scenario the platform claims to support: a tenant with
      // two Gmail accounts (e.g. support@ and sales@). Two consecutive
      // credentials.stored events with the same type but different
      // connector_ids must produce DIFFERENT manifest aliases so neither
      // UPSERT-clobbers the other.
      mockClientQuery.mockResolvedValue({ rows: [] });

      await dispatchEvent(
        buildCredentialsStoredEvent('eaec0c30-9514-448f-8ed0-29b1567de8d3', 'google_mail'),
        1,
        'control-plane-events',
      );
      await dispatchEvent(
        buildCredentialsStoredEvent('14a82d9e-269c-4d56-892a-7d3a9d259c0c', 'google_mail'),
        1,
        'control-plane-events',
      );

      const manifestCalls = mockClientQuery.mock.calls.filter(
        (c) => /INSERT INTO connector_manifests\b/i.test(String(c[0])),
      );
      expect(manifestCalls).toHaveLength(2);
      const aliases = manifestCalls.map((c) => (c[1] as unknown[])[3]);
      expect(aliases).toEqual([
        'google-mail-eaec0c30',
        'google-mail-14a82d9e',
      ]);
      // Critical invariant: the two aliases differ — proves the second
      // event does NOT UPSERT-clobber the first.
      expect(new Set(aliases).size).toBe(2);
    });

    it('also threads the same alias into action_allowlists', async () => {
      // action_allowlists.connector holds the same alias string. If the
      // manifest alias is per-account but action_allowlists isn't, the
      // validator's per-action allowlist lookup misses and every tool
      // call gets denied.
      mockClientQuery.mockResolvedValue({ rows: [] });

      await dispatchEvent(
        buildCredentialsStoredEvent('eaec0c30-9514-448f-8ed0-29b1567de8d3', 'google_mail'),
        1,
        'control-plane-events',
      );

      const allowlistCall = mockClientQuery.mock.calls.find(
        (c) => /INSERT INTO action_allowlists\b/i.test(String(c[0])),
      );
      expect(allowlistCall).toBeDefined();
      // $1=tenantId, $2=connector(alias). The connector value here must
      // match the manifest alias above; otherwise the validator can't
      // resolve the allowlist for incoming tool calls.
      const params = allowlistCall![1] as unknown[];
      expect(params[1]).toBe('google-mail-eaec0c30');
    });
  });

  it('releases the client even when ROLLBACK itself fails', async () => {
    // Defense-in-depth: if the connection is in a bad state and
    // ROLLBACK throws too, we still must release the client back to
    // the pool. Otherwise repeated partial failures leak connections
    // until the pool is exhausted.
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback also failed'));
      return Promise.reject(new Error('inner INSERT failed'));
    });

    await expect(
      dispatchEvent(buildCredentialsStoredEvent(), 1, 'control-plane-events'),
    ).rejects.toThrow(/inner INSERT failed/);

    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });
});
