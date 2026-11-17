// C.2 — Connector-tool smoke unit tests.
//
// The smoke runner has FIVE invariants that matter:
//   1. Bucket-sharding picks ~1/6 of tenants per hour (load cap).
//   2. Read-only function picker excludes write/destructive/outbound/sensitive.
//   3. Semaphore caps concurrent probes per vendor at 5.
//   4. Dispatch failures + timeouts are recorded, not thrown.
//   5. Kill switch (CONNECTOR_TOOL_SMOKE_DISABLED=1) short-circuits cleanly.

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
}));

const mockGetSchemas = jest.fn();
jest.mock('../tool-schema-cache', () => ({
  getToolSchemas: mockGetSchemas,
}));

import {
  Semaphore,
  currentBucket,
  tenantBucket,
  pickReadOnlyAction,
  runConnectorToolSmoke,
} from '../tool-smoke';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CONNECTOR_TOOL_SMOKE_DISABLED;
});

describe('C.2 — currentBucket', () => {
  it('returns a value in [0, 6)', () => {
    expect(currentBucket()).toBeGreaterThanOrEqual(0);
    expect(currentBucket()).toBeLessThan(6);
  });

  it('cycles 0..5 across 6 hours (UTC)', () => {
    const expected: number[] = [];
    for (let h = 0; h < 24; h++) {
      const d = new Date(Date.UTC(2026, 5, 1, h, 0, 0));
      expected.push(currentBucket(d));
    }
    // Each hour should be h % 6
    for (let h = 0; h < 24; h++) {
      expect(expected[h]).toBe(h % 6);
    }
  });
});

describe('C.2 — tenantBucket', () => {
  it('is deterministic for the same tenant', () => {
    const id = '12345678-1234-1234-1234-123456789012';
    expect(tenantBucket(id)).toBe(tenantBucket(id));
  });

  it('returns a value in [0, 6)', () => {
    const tenants = ['a', 'b', 'c', 'tenant-1', 'tenant-2', 'tenant-deadbeef'];
    for (const t of tenants) {
      const b = tenantBucket(t);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(6);
    }
  });

  it('distributes tenants ~evenly across buckets', () => {
    const buckets = new Array(6).fill(0);
    for (let i = 0; i < 600; i++) buckets[tenantBucket(`tenant-${i}`)]++;
    // No bucket should be wildly off from the expected ~100. Allow 60..150.
    for (const c of buckets) {
      expect(c).toBeGreaterThan(60);
      expect(c).toBeLessThan(150);
    }
  });
});

describe('C.2 — pickReadOnlyAction', () => {
  it('returns null for an empty function list', () => {
    expect(pickReadOnlyAction([])).toBeNull();
    expect(pickReadOnlyAction(null)).toBeNull();
  });

  it('picks the first function tagged ["read"]', () => {
    const fn = pickReadOnlyAction([
      { name: 'send_message', categories: ['write', 'outbound'] },
      { name: 'list_channels', categories: ['read'] },
      { name: 'archive_channel', categories: ['destructive'] },
    ]);
    expect(fn?.name).toBe('list_channels');
  });

  it('skips functions tagged ["read", "write"] (mixed)', () => {
    const fn = pickReadOnlyAction([
      { name: 'upsert', categories: ['read', 'write'] },
      { name: 'list', categories: ['read'] },
    ]);
    expect(fn?.name).toBe('list');
  });

  it('skips functions tagged ["read", "destructive"]', () => {
    const fn = pickReadOnlyAction([
      { name: 'delete_after_read', categories: ['read', 'destructive'] },
    ]);
    expect(fn).toBeNull();
  });

  it('skips ["read", "outbound"] (e.g. a "list-and-send" hybrid)', () => {
    const fn = pickReadOnlyAction([
      { name: 'list_and_notify', categories: ['read', 'outbound'] },
    ]);
    expect(fn).toBeNull();
  });

  it('skips a read that requires an input, and prefers the one that takes nothing', () => {
    const fn = pickReadOnlyAction([
      { name: 'combined_enrichment', categories: ['read'], inputSchema: { required: ['email'], properties: { email: { type: 'string' } } } },
      { name: 'get_account', categories: ['read'], inputSchema: { required: [], properties: {} } },
    ]);
    expect(fn?.name).toBe('get_account');
    expect(pickReadOnlyAction([
      { name: 'autocomplete_fields', categories: ['read'], inputSchema: { required: ['field'], properties: { field: { type: 'string' } } } },
    ])).toBeNull();
  });

  it('skips ["read", "sensitive"] (PII reads bypass the smoke)', () => {
    const fn = pickReadOnlyAction([
      { name: 'list_pii', categories: ['read', 'sensitive'] },
    ]);
    expect(fn).toBeNull();
  });
});

describe('C.2 — Semaphore', () => {
  it('admits up to `slots` callers concurrently', async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    let r3Resolved = false;
    const p3 = s.acquire().then(r => { r3Resolved = true; return r; });
    // r3 should NOT have resolved yet
    await new Promise(r => setTimeout(r, 10));
    expect(r3Resolved).toBe(false);
    // Releasing one slot lets r3 acquire
    r1();
    const r3 = await p3;
    expect(r3Resolved).toBe(true);
    r2();
    r3();
  });
});

describe('connector tool smoke — agentId resolution', () => {
  beforeEach(() => {
    delete process.env.CONNECTOR_SMOKE_AGENT_ID;
    delete process.env.SCHEDULED_INVOCATION_AGENT_ID;
  });

  it('uses CONNECTOR_SMOKE_AGENT_ID when set to a valid UUID', async () => {
    process.env.CONNECTOR_SMOKE_AGENT_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
    let tenant = `tenant-bucket-${currentBucket()}-resolve-1`;
    for (let i = 0; tenantBucket(tenant) !== currentBucket() && i < 20; i++) {
      tenant = `tenant-bucket-${currentBucket()}-resolve-${i}`;
    }
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'slack' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'list_channels', categories: ['read'] }]);

    const tg = { execute: jest.fn().mockResolvedValue({ success: true, data: {} }) };
    await runConnectorToolSmoke(tg);
    expect(tg.execute).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'aaaaaaaa-1111-2222-3333-444444444444',
    }));
  });

  it('rejects malformed CONNECTOR_SMOKE_AGENT_ID and falls back', async () => {
    process.env.CONNECTOR_SMOKE_AGENT_ID = 'not-a-uuid';
    process.env.SCHEDULED_INVOCATION_AGENT_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
    let tenant = `tenant-bucket-${currentBucket()}-resolve-fallback`;
    for (let i = 0; tenantBucket(tenant) !== currentBucket() && i < 20; i++) {
      tenant = `tenant-bucket-${currentBucket()}-resolve-fb-${i}`;
    }
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'slack' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'list_channels', categories: ['read'] }]);

    const tg = { execute: jest.fn().mockResolvedValue({ success: true }) };
    await runConnectorToolSmoke(tg);
    expect(tg.execute).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'bbbbbbbb-1111-2222-3333-444444444444',
    }));
  });

  it('does NOT use the all-zeros placeholder UUID', async () => {
    let tenant = `tenant-bucket-${currentBucket()}-resolve-no-zero`;
    for (let i = 0; tenantBucket(tenant) !== currentBucket() && i < 20; i++) {
      tenant = `tenant-bucket-${currentBucket()}-resolve-no-zero-${i}`;
    }
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'slack' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'list_channels', categories: ['read'] }]);

    const tg = { execute: jest.fn().mockResolvedValue({ success: true }) };
    await runConnectorToolSmoke(tg);
    // Whatever ID we use, it must not be the all-zeros UUID.
    expect(tg.execute).not.toHaveBeenCalledWith(expect.objectContaining({
      agentId: '00000000-0000-0000-0000-000000000000',
    }));
  });
});

describe('C.2 — runConnectorToolSmoke kill switch', () => {
  it('short-circuits when CONNECTOR_TOOL_SMOKE_DISABLED=1', async () => {
    process.env.CONNECTOR_TOOL_SMOKE_DISABLED = '1';
    const r = await runConnectorToolSmoke({ execute: jest.fn() });
    expect(r.disabled).toBe(true);
    expect(r.probed).toBe(0);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('C.2 — runConnectorToolSmoke happy / failure paths', () => {
  beforeEach(() => {
    // Default: empty bindings — smoke completes with zeros.
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('records ok=true when toolGateway.execute succeeds', async () => {
    // Pick a tenant whose bucket matches THIS hour so the binding is in scope.
    let tenant = `tenant-bucket-${currentBucket()}-aaa`;
    for (let i = 0; tenantBucket(tenant) !== currentBucket() && i < 20; i++) {
      tenant = `tenant-bucket-${currentBucket()}-${i}`;
    }
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'slack' }],
        rowCount: 1,
      })
      // insert
      .mockResolvedValueOnce({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'list_channels', categories: ['read'] }]);

    const tg = { execute: jest.fn().mockResolvedValue({ success: true, data: { channels: [] } }) };
    const r = await runConnectorToolSmoke(tg);
    expect(r.disabled).toBe(false);
    expect(tg.execute).toHaveBeenCalled();
    // Find the smoke result insert in the recorded queries
    const inserts = mockPoolQuery.mock.calls.filter(c => /INSERT INTO connector_tool_smoke_results/.test(c[0]));
    expect(inserts.length).toBe(1);
    expect(inserts[0][1][3]).toBe(true); // ok=true bound parameter
  });

  it('records NO_READ_FUNCTION when no qualifying function exists', async () => {
    let tenant = `tenant-bucket-${currentBucket()}-aaa`;
    for (let i = 0; tenantBucket(tenant) !== currentBucket() && i < 20; i++) {
      tenant = `tenant-bucket-${currentBucket()}-${i}`;
    }
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'write_only_connector' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'send', categories: ['outbound'] }]);

    const tg = { execute: jest.fn() };
    const r = await runConnectorToolSmoke(tg);
    expect(tg.execute).not.toHaveBeenCalled();
    expect(r.skipped_no_read_function).toBe(1);
    const inserts = mockPoolQuery.mock.calls.filter(c => /INSERT INTO connector_tool_smoke_results/.test(c[0]));
    expect(inserts.length).toBe(1);
    expect(inserts[0][1][4]).toBe('NO_READ_FUNCTION'); // error_code
  });

  it('records TIMEOUT when the dispatch hangs past the 10s budget', async () => {
    let tenant = `tenant-bucket-${currentBucket()}-aaa`;
    for (let i = 0; tenantBucket(tenant) !== currentBucket() && i < 20; i++) {
      tenant = `tenant-bucket-${currentBucket()}-${i}`;
    }
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'slack' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'list_channels', categories: ['read'] }]);

    // Simulate timeout by rejecting with a timeout-shaped error (we don't
    // actually wait 10s in the test).
    const tg = { execute: jest.fn().mockRejectedValue(new Error('connector-service timeout')) };
    await runConnectorToolSmoke(tg);
    const inserts = mockPoolQuery.mock.calls.filter(c => /INSERT INTO connector_tool_smoke_results/.test(c[0]));
    expect(inserts.length).toBe(1);
    expect(inserts[0][1][4]).toBe('TIMEOUT');
  });

  it('records DISPATCH_ERROR when the dispatch returns success=false', async () => {
    let tenant = `tenant-bucket-${currentBucket()}-aaa`;
    for (let i = 0; tenantBucket(tenant) !== currentBucket() && i < 20; i++) {
      tenant = `tenant-bucket-${currentBucket()}-${i}`;
    }
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'slack' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'list_channels', categories: ['read'] }]);

    const tg = { execute: jest.fn().mockResolvedValue({ success: false, error: 'token revoked' }) };
    await runConnectorToolSmoke(tg);
    const inserts = mockPoolQuery.mock.calls.filter(c => /INSERT INTO connector_tool_smoke_results/.test(c[0]));
    expect(inserts.length).toBe(1);
    expect(inserts[0][1][4]).toBe('DISPATCH_ERROR');
  });

  it('records PAYLOAD_REJECTED, not DISPATCH_ERROR, when the vendor says the request was malformed', async () => {
    let tenant = `tenant-bucket-${currentBucket()}-aaa`;
    for (let i = 0; tenantBucket(tenant) !== currentBucket() && i < 20; i++) {
      tenant = `tenant-bucket-${currentBucket()}-${i}`;
    }
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'pdl' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'enrich_person', categories: ['read'], inputSchema: { required: [], properties: { email: { type: 'string' } } } }]);

    const tg = { execute: jest.fn().mockResolvedValue({ success: false, error: 'pdl.enrich_person: at least one of email, phone, name is required' }) };
    await runConnectorToolSmoke(tg);
    expect(tg.execute).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'enrich_person', payload: {} }));
    const inserts = mockPoolQuery.mock.calls.filter(c => /INSERT INTO connector_tool_smoke_results/.test(c[0]));
    expect(inserts[0][1][4]).toBe('PAYLOAD_REJECTED');
  });

  it('caps per-vendor concurrent dispatches at 5 (semaphore integration)', async () => {
    // Build 10 distinct tenants ALL in the current bucket, ALL bound to
    // the same connector_type. If the per-vendor semaphore isn't honoured,
    // all 10 toolGateway.execute() calls would fire simultaneously. With
    // the semaphore (slots=5), no more than 5 should be in flight at once.
    const tenants: string[] = [];
    for (let i = 0; tenants.length < 10 && i < 200; i++) {
      const t = `tenant-bucket-${currentBucket()}-conc-${i}`;
      if (tenantBucket(t) === currentBucket()) tenants.push(t);
    }
    expect(tenants).toHaveLength(10);

    const rows = tenants.map((t, i) => ({
      id: `mfst-${i}`, tenant_id: t, connector_type: 'slack',
    }));
    mockPoolQuery
      .mockResolvedValueOnce({ rows, rowCount: rows.length })
      // 10 inserts after dispatch.
      .mockResolvedValue({ rowCount: 1 });
    mockGetSchemas.mockReturnValue([{ name: 'list_channels', categories: ['read'] }]);

    let inFlight = 0;
    let peakInFlight = 0;
    const tg = {
      execute: jest.fn().mockImplementation(async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Yield to event loop so concurrent calls can stack up before
        // anyone releases. Without this, the synchronous fast-path could
        // serialise everything regardless of the semaphore.
        await new Promise(r => setImmediate(r));
        inFlight--;
        return { success: true, data: {} };
      }),
    };

    await runConnectorToolSmoke(tg);
    expect(tg.execute).toHaveBeenCalledTimes(10);
    // The cap is 5 — peak in-flight must NEVER exceed it.
    expect(peakInFlight).toBeLessThanOrEqual(5);
    // And we should have actually exercised the semaphore boundary — if
    // peak<2 the test isn't proving anything (would also pass without
    // the semaphore). Demand at least 2 to ensure parallelism happened.
    expect(peakInFlight).toBeGreaterThanOrEqual(2);
  });

  it('skips bindings whose tenant_bucket does not match the current hour', async () => {
    // Pick a tenant whose bucket is NOT the current bucket
    let tenant = 'tenant-other-bucket-a';
    const want = (currentBucket() + 3) % 6;
    for (let i = 0; tenantBucket(tenant) !== want && i < 50; i++) {
      tenant = `tenant-other-bucket-${i}`;
    }
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'mfst-1', tenant_id: tenant, connector_type: 'slack' }],
      rowCount: 1,
    });
    const tg = { execute: jest.fn() };
    const r = await runConnectorToolSmoke(tg);
    expect(r.probed).toBe(0);
    expect(tg.execute).not.toHaveBeenCalled();
  });
});
