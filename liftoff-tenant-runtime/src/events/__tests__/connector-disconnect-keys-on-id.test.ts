// Regression guard for the connector.disconnected / connector.deleted handler.
//
// The bug it prevents: the handler ran three writes in one transaction and two
// of them keyed on the connector id while the third keyed on an alias it
// derived as `connectorType.replace(/_/g, '-')`. Since migration 252 no row has
// carried that form — connect writes `<type>-<first-8-of-connector-id>` so two
// grants of one type cannot collide on UNIQUE (tenant_id, alias) — so the
// manifest UPDATE matched nothing, for every connector.
//
// Why it goes unnoticed: an UPDATE that matches no row is not an error, and the
// handler's success log named the alias it had just failed to find. The only
// signal available said the manifest had been disabled.
//
// What it leaves: `connectors` says disconnected, `connector_credentials` says
// revoked, and `connector_manifests` still says enabled. The manifest is what
// `getManifestsForAgent` reads and the agent's tool catalog is built from, and
// it filters on `enabled = true` — so a disconnected connector keeps offering
// its tools to every agent bound to that type.
//
// The property asserted here is narrow and is the one that broke: the manifest
// write is keyed by the SAME identifier as its two siblings in the transaction.

const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn();
const mockPoolQuery = jest.fn();
const mockLoggerWarn = jest.fn();

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
  logger: { info: jest.fn(), warn: (...a: unknown[]) => mockLoggerWarn(...a), error: jest.fn(), debug: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { dispatchEvent } from '../subscriber';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CONNECTOR = '7d07a896-89f6-4f5c-8a26-1186c9fcf270';

function buildDisconnectedEvent(eventType: string): Record<string, unknown> {
  return {
    event_id: `evt-${eventType}-${CONNECTOR}`,
    tenant_id: TENANT,
    entity_type: 'connector',
    entity_id: CONNECTOR,
    event_type: eventType,
    event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: { connectorType: 'github' },
  };
}

/** The parameter array of the one UPDATE naming a given table. */
function paramsForUpdate(table: string): unknown[] | undefined {
  const call = mockClientQuery.mock.calls.find(
    (c) => new RegExp(`UPDATE ${table}\\b`, 'i').test(String(c[0])),
  );
  return call?.[1] as unknown[] | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockClientQuery(...args),
    release: () => mockClientRelease(),
  });
});

describe('connector.connected — reconnecting restores the connector status', () => {
  it("sets status back to 'active' on conflict, not only on first insert", async () => {
    // The reconnect drift that made migration 385 wrong. The UPSERT inserted
    // 'active' but its DO UPDATE branch did not restore it, so a connector
    // disconnected and then reconnected under the same id kept 'disconnected'
    // while its manifest and credentials were both correctly refreshed. That
    // state is indistinguishable from a connector that never came back, and a
    // cleanup migration read it as one and withdrew three LIVE connectors in
    // dev.
    const src = readFileSync(join(__dirname, '..', 'subscriber.ts'), 'utf8');
    const upsert = src.split('INSERT INTO connectors (id, tenant_id, type, name, status)')[1] ?? '';
    expect(upsert.slice(0, 300)).toContain("status = 'active'");
  });
});

describe('connector.disconnected — the manifest is withdrawn by id', () => {
  it.each(['connector.disconnected', 'connector.deleted'])(
    'keys the manifest UPDATE on the connector id, not a derived alias (%s)',
    async (eventType) => {
      mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      await dispatchEvent(buildDisconnectedEvent(eventType), 1, 'control-plane-events');

      const manifestParams = paramsForUpdate('connector_manifests');
      expect(manifestParams).toBeDefined();
      expect(manifestParams).toContain(CONNECTOR);

      // The derived alias must not appear anywhere in that statement's
      // parameters. 'github' is what the old code passed, and it matched no
      // row; a future edit that reintroduces any type-derived key fails here.
      expect(manifestParams).not.toContain('github');
    },
  );

  it('uses the same identifier as the two writes beside it', async () => {
    // The transaction's own internal consistency, which is what was violated:
    // two of three writes addressed the connector by id and one did not.
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await dispatchEvent(buildDisconnectedEvent('connector.disconnected'), 1, 'control-plane-events');

    for (const table of ['connector_manifests', 'connector_credentials', 'connectors']) {
      expect(paramsForUpdate(table)).toContain(CONNECTOR);
    }
  });

  it('says so when the manifest write matches nothing', async () => {
    // The defect was survivable only because a zero-row UPDATE was silent and
    // the success log named an alias it had never found. A miss is now loud.
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await dispatchEvent(buildDisconnectedEvent('connector.disconnected'), 1, 'control-plane-events');

    const warned = mockLoggerWarn.mock.calls.some((c) =>
      /no manifest row matched/i.test(String(c[0])),
    );
    expect(warned).toBe(true);
  });
});
