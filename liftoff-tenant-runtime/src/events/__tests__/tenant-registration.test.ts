// The runtime must register a workspace in its own `tenants` table, and must
// not report an event nobody handled as processed.
//
// WHY THIS EXISTS. Every tenant-scoped table here carries
// `tenant_id UUID REFERENCES tenants(id)`. If `tenant.provisioned` matches no
// case in dispatchEvent, the default branch logs a warning and falls through to
// recordProcessedInLedger, and the event is stored as `completed`. The
// platform's outbox reconciler reads that ledger, so provisioning looks green
// from every angle. The first person to open chat then gets
// `insert or update on table "invocations" violates foreign key constraint
// "invocations_tenant_id_fkey"`, an SSE error the UI never renders, and an
// agent that appears to ignore them.
//
// Mocks only subscriberPool, and exercises the real dispatchEvent.

type QueryRecord = { sql: string; params?: unknown[] };
const queries: QueryRecord[] = [];
type Responder = (sql: string, params: unknown[] | undefined) => { rows: unknown[]; rowCount?: number };
let responder: Responder = () => ({ rows: [] });

jest.mock('../../infrastructure/database', () => {
  const sharedPool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const r = responder(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    }),
    connect: jest.fn(async () => ({
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        const r = responder(sql, params);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
      }),
      release: jest.fn(),
    })),
  };
  return {
    subscriberPool: sharedPool,
    getPoolForService: () => sharedPool,
    withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: unknown) => Promise<unknown>) => fn(sharedPool)),
  };
});

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ logger: mockLogger, log: mockLogger }));

import { dispatchEvent } from '../subscriber';

const TENANT = '466fd363-d948-4eaa-9233-2384848fe6eb';

const provisioned = {
  event_id: '02ef915b-3bac-41cd-842e-9bc8061b256a',
  event_type: 'tenant.provisioned',
  entity_type: 'tenant',
  entity_id: TENANT,
  tenant_id: TENANT,
  entity_version: 1,
  occurred_at: new Date().toISOString(),
  schema_version: 1,
  event_version: 1,
  payload: { name: 'Northwind', tier: 'standard', hostingMode: 'shared' },
};

function find(re: RegExp): QueryRecord | undefined {
  return queries.find((q) => re.test(q.sql));
}

beforeEach(() => {
  queries.length = 0;
  Object.values(mockLogger).forEach((s) => s.mockReset());
  responder = () => ({ rows: [] });
});

describe('tenant.provisioned — the workspace must exist in the runtime', () => {
  it('inserts the tenants row every foreign key depends on', async () => {
    await dispatchEvent(provisioned, 1, 'test-sub');

    const insert = find(/INSERT INTO tenants/i);
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
    // external_id is UNIQUE NOT NULL and unread, so the tenant's own id is used.
    expect(insert!.params).toEqual([TENANT, TENANT]);
  });

  it('is idempotent under redelivery — a second dispatch is another no-op upsert', async () => {
    responder = (sql) => (/INSERT INTO tenants/i.test(sql) ? { rows: [], rowCount: 0 } : { rows: [] });
    await dispatchEvent(provisioned, 1, 'test-sub');
    await dispatchEvent(provisioned, 1, 'test-sub');
    expect(queries.filter((q) => /INSERT INTO tenants/i.test(q.sql))).toHaveLength(2);
  });

  it('records the event completed, closing the acknowledgment loop', async () => {
    await dispatchEvent(provisioned, 1, 'test-sub');
    const ledger = find(/INSERT INTO event_processing_ledger/i);
    expect(ledger).toBeDefined();
    expect(ledger!.sql).toMatch(/'completed'/);
  });

  it('registers on tenant.activated too, since either may arrive first', async () => {
    await dispatchEvent({ ...provisioned, event_id: 'evt-act', event_type: 'tenant.activated' }, 1, 'test-sub');
    expect(find(/INSERT INTO tenants/i)).toBeDefined();
  });
});

describe('an event with no handler must not report itself processed', () => {
  const orphan = {
    ...provisioned,
    event_id: 'evt-orphan',
    event_type: 'tenant.something.nobody.wired',
  };

  it('records it FAILED, not completed, so the reconciler republishes and then flags it', async () => {
    await dispatchEvent(orphan, 1, 'test-sub');

    const ledger = find(/INSERT INTO event_processing_ledger/i);
    expect(ledger).toBeDefined();
    expect(ledger!.sql).toMatch(/'failed'/);
    expect(ledger!.sql).not.toMatch(/'completed'/);
    expect(ledger!.params).toContain('no handler wired for event type tenant.something.nobody.wired');
  });

  it('logs at ERROR — a hole is not a warning', async () => {
    await dispatchEvent(orphan, 1, 'test-sub');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled event type'),
      expect.objectContaining({ event_type: 'tenant.something.nobody.wired' }),
    );
  });

  it('does NOT advance the processed version, so a later fix can still catch up', async () => {
    // Advancing it would make the version guard discard the republish as stale
    // and the gap could never self-heal. This is not hypothetical: it is why
    // tenant.activated never reached the switch at all.
    await dispatchEvent(orphan, 1, 'test-sub');
    expect(find(/INTO event_versions|UPDATE event_versions/i)).toBeUndefined();
  });
});

describe('events the runtime deliberately ignores stay completed', () => {
  it.each(['account.created', 'account.updated', 'audit.platform_event', 'data.retention.cleanup_completed'])(
    'records %s as completed without raising a hole',
    async (eventType) => {
      await dispatchEvent(
        { ...provisioned, event_id: `evt-${eventType}`, event_type: eventType, entity_type: 'account' },
        1,
        'test-sub',
      );
      const ledger = find(/INSERT INTO event_processing_ledger/i);
      expect(ledger).toBeDefined();
      expect(ledger!.sql).toMatch(/'completed'/);
      expect(mockLogger.error).not.toHaveBeenCalled();
    },
  );
});
