/**
 * usage-ledger-ingester unit tests.
 *
 * Verifies per-tenant iteration, the event-type → cost_attribution_events
 * mapping, cost computation from metadata.cost_micros (browser tools) vs
 * credits*0 (memory ops), and cursor advancement.
 */

const mockResolveAccountIdForTenant = jest.fn();
const mockIngestEventWithBuckets = jest.fn().mockResolvedValue(1);
const mockPoolQuery = jest.fn();
const mockResolveRuntimeBaseUrl = jest.fn();
const mockBuildRuntimeHeaders = jest.fn();

jest.mock('../repository', () => ({
  ingestEventWithBuckets: (...a: unknown[]) => mockIngestEventWithBuckets(...a),
  resolveAccountIdForTenant: (...a: unknown[]) => mockResolveAccountIdForTenant(...a),
  getIngesterPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));

jest.mock('../../connectors/tenant-runtime-url', () => ({
  resolveRuntimeBaseUrl: (...a: unknown[]) => mockResolveRuntimeBaseUrl(...a),
  buildRuntimeHeaders: (...a: unknown[]) => mockBuildRuntimeHeaders(...a),
}));

// INV-PB-009: the ingester translates the runtime agents.id on each event into
// internal_agents.id. Mocked here so the translation is deterministic AND so it
// does not reach the real fetchWithOidc — that would consume a response from the
// global.fetch queue below and desynchronise the feed sequence. (It only bites
// where a metadata server exists, i.e. CI but not a laptop, which is exactly how
// this slipped through local verification.)
const mockGetRuntimeToInternalMap = jest.fn();
jest.mock('../../internal-agents/runtime-agent-id-map', () => ({
  getRuntimeToInternalMap: (...a: unknown[]) => mockGetRuntimeToInternalMap(...a),
  toInternalAgentId: (map: Map<string, string>, id: string | null | undefined) =>
    (id ? (map.get(id) ?? id) : null),
}));

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

import { runUsageLedgerIngester } from '../ingestion/usage-ledger-ingester';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function setActiveTenants(ids: string[]) {
  // The ingester queries SELECT id FROM tenants WHERE ... and then per-tenant
  // cursor SELECT/INSERT. Sequence queries by call order to keep the harness
  // narrow.
  mockPoolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM tenants')) {
      return { rows: ids.map(id => ({ id })) };
    }
    if (sql.includes('cost_attribution_cursors') && sql.toUpperCase().includes('SELECT')) {
      return { rows: [] }; // no prior cursor → since = epoch
    }
    if (sql.includes('cost_attribution_cursors') && sql.toUpperCase().includes('INSERT')) {
      return { rows: [] };
    }
    return { rows: [] };
  });
}

function mockFeedResponseSequence(perCall: Array<{ events: unknown[]; nextCursor: string | null; hasMore: boolean }>) {
  const responses = [...perCall];
  global.fetch = jest.fn(async () => {
    const next = responses.shift();
    if (!next) return { ok: false, status: 500, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => next } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveAccountIdForTenant.mockResolvedValue('acct-1');
  mockResolveRuntimeBaseUrl.mockResolvedValue('https://tr.example.com');
  mockGetRuntimeToInternalMap.mockResolvedValue(new Map());
  mockBuildRuntimeHeaders.mockResolvedValue({ 'X-Service-Auth': 'tok', 'x-tenant-id': 'x' });
});

describe('runUsageLedgerIngester', () => {
  it('maps memory_save → event_type=credit with costUsd=0', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-1', tenant_id: TENANT_A, agent_id: 'a1', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 5, metadata: {},
          created_at: '2025-01-02T00:00:00Z',
        }],
        nextCursor: '2025-01-02T00:00:00Z',
        hasMore: false,
      },
    ]);
    const stats = await runUsageLedgerIngester();
    expect(stats.ingested).toBe(1);
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'evt-1',
      0,
      expect.objectContaining({
        eventType: 'credit', source: 'tenant_runtime',
        connector: null, actionType: null,
      }),
    );
  });

  it('maps web_fetch_advanced → web_tool with vendor + tool_name + cost_micros/1e6', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-2', tenant_id: TENANT_A, agent_id: 'a2', workflow_id: null,
          action_id: null, event_type: 'web_fetch_advanced', credits: 1,
          metadata: { vendor: 'anchor', tool_name: 'web_fetch_advanced', cost_micros: 1_500_000 },
          created_at: '2025-01-03T00:00:00Z',
        }],
        nextCursor: '2025-01-03T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'evt-2',
      1.5,
      expect.objectContaining({
        eventType: 'web_tool', source: 'tenant_runtime',
        connector: 'anchor', actionType: 'web_fetch_advanced',
      }),
    );
  });

  it('maps web_search → web_tool, priced from cost_micros, keyed by its idempotency_key', async () => {
    // The real-time subscriber books the same row under the same key; this
    // backstop must land it identically, or a lost publish loses the charge.
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-search', tenant_id: TENANT_A, agent_id: 'a2', workflow_id: null,
          action_id: 'search-action-1', event_type: 'web_search', credits: 1,
          metadata: {
            vendor: 'perplexity', tool_name: 'web_search', cost_micros: 5_000,
            idempotency_key: 'search-action-1',
          },
          created_at: '2025-01-03T00:00:00Z',
        }],
        nextCursor: '2025-01-03T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'search-action-1',
      0.005,
      expect.objectContaining({
        eventType: 'web_tool', source: 'tenant_runtime',
        connector: 'perplexity', actionType: 'web_search',
      }),
    );
  });

  it('routes a wallet-funded web-tool call (the Browserbase rung) to the x402 branch', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-rung', tenant_id: TENANT_A, agent_id: 'a2', workflow_id: null,
          action_id: null, event_type: 'web_fetch_advanced', credits: 1,
          metadata: {
            vendor: 'browserbase_x402', tool_name: 'web_fetch_advanced',
            cost_micros: 10_000, funding: 'x402_wallet',
          },
          created_at: '2025-01-03T00:00:00Z',
        }],
        nextCursor: '2025-01-03T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'evt-rung',
      0.01,
      expect.objectContaining({
        eventType: 'web_tool', connector: 'browserbase_x402', actionType: 'web_fetch_advanced',
        x402Funded: true, usageQuantity: 1, usageUnit: 'call',
      }),
    );
  });

  it('ingests an x402 connector_call: metadata-priced, routed x402Funded, counted per call (INV-PB-013)', async () => {
    // The x402 vendor path's usage record. Three properties, each silently
    // wrong on its own: the cost must come from metadata.cost_micros (a
    // connector_call priced off `credits` books ~$0 while looking ingested —
    // the browser_session lesson), the funding marker must route the row to
    // the x402 branch (real OUs + cost_bucket='x402_wallet_funded'), and the
    // per-call usage columns are what on-chain reconciliation counts.
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-x402', tenant_id: TENANT_A, agent_id: 'a2', workflow_id: null,
          action_id: 'action-ledger-1', event_type: 'connector_call', credits: 1,
          metadata: {
            vendor: 'gloria', tool_name: 'get_ticker_summary', cost_micros: 11_000,
            funding: 'x402_wallet', thread_id: 'thread-9', invocation_id: 'inv-7',
          },
          created_at: '2025-01-03T00:00:00Z',
        }],
        nextCursor: '2025-01-03T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'evt-x402',
      0.011,
      expect.objectContaining({
        eventType: 'connector_call', source: 'tenant_runtime',
        connector: 'gloria', actionType: 'get_ticker_summary',
        // The full drill-down: the action-ledger id plus the thread and
        // invocation the audit trail is keyed by.
        actionId: 'action-ledger-1', threadId: 'thread-9', invocationId: 'inv-7',
        x402Funded: true, usageQuantity: 1, usageUnit: 'call',
      }),
    );
  });

  it('SKIPS a connector_call with unrecognised funding rather than inventing a charge', async () => {
    // The runtime only publishes x402-funded connector calls; anything else
    // is a producer defect, and routing it to the customer path would start
    // billing for calls whose pricing nobody decided.
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-cc-plain', tenant_id: TENANT_A, agent_id: 'a2', workflow_id: null,
          action_id: null, event_type: 'connector_call', credits: 1,
          metadata: { vendor: 'somevendor', tool_name: 'do_thing', cost_micros: 5_000 },
          created_at: '2025-01-03T00:00:00Z',
        }],
        nextCursor: '2025-01-03T00:00:00Z',
        hasMore: false,
      },
    ]);
    const result = await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('skips events with unmapped event_type but counts them as skipped', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-3', tenant_id: TENANT_A, agent_id: 'a3', workflow_id: null,
          action_id: null, event_type: 'unrelated_event', credits: 1, metadata: {},
          created_at: '2025-01-04T00:00:00Z',
        }],
        nextCursor: '2025-01-04T00:00:00Z',
        hasMore: false,
      },
    ]);
    const stats = await runUsageLedgerIngester();
    expect(stats.ingested).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('drops events for tenants we cannot resolve to an account', async () => {
    setActiveTenants([TENANT_A]);
    mockResolveAccountIdForTenant.mockResolvedValueOnce(null);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-4', tenant_id: TENANT_A, agent_id: 'a4', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-05T00:00:00Z',
        }],
        nextCursor: '2025-01-05T00:00:00Z',
        hasMore: false,
      },
    ]);
    const stats = await runUsageLedgerIngester();
    expect(stats.ingested).toBe(0);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('iterates multiple active tenants', async () => {
    setActiveTenants([TENANT_A, TENANT_B]);
    mockFeedResponseSequence([
      // Tenant A
      {
        events: [{
          id: 'evt-A', tenant_id: TENANT_A, agent_id: 'a', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-06T00:00:00Z',
        }],
        nextCursor: '2025-01-06T00:00:00Z',
        hasMore: false,
      },
      // Tenant B
      {
        events: [{
          id: 'evt-B', tenant_id: TENANT_B, agent_id: 'b', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-07T00:00:00Z',
        }],
        nextCursor: '2025-01-07T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockResolveRuntimeBaseUrl).toHaveBeenCalledWith(TENANT_A);
    expect(mockResolveRuntimeBaseUrl).toHaveBeenCalledWith(TENANT_B);
    expect(mockIngestEventWithBuckets).toHaveBeenCalledTimes(2);
  });

  // PB-1 of the deep-research-realtime-billing plan (D2.3): pre-charge +
  // delta events share a deterministic `idempotency_key` in metadata so
  // the ingester's source_id derivation is stable across the random
  // usage_events.id UUIDs that get generated each time. Falls through to
  // e.id when the metadata field is absent (backward-compatible).
  it('derives source_id from metadata.idempotency_key when present (D2.3)', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-uuid-random', tenant_id: TENANT_A, agent_id: 'a',
          workflow_id: null, action_id: null, event_type: 'web_deep_research',
          credits: 1,
          metadata: {
            vendor: 'perplexity', tool_name: 'web_deep_research',
            cost_micros: 400_000,
            idempotency_key: 'deep-research-id-abc',
          },
          created_at: '2025-01-10T00:00:00Z',
        }],
        nextCursor: '2025-01-10T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'deep-research-id-abc',     // NOT 'evt-uuid-random'
      0.4,
      expect.objectContaining({
        eventType: 'web_tool',
        actionType: 'web_deep_research',
      }),
    );
  });

  it('ingests a pane browser session, priced from metadata like every other browser tool', async () => {
    // A pane session is not a per-call web_* event, so it needed its own entry
    // in BOTH tables. Mapped but absent from TOOL_COST_FROM_METADATA it would
    // have been priced off `credits` — the count 1, not a cost — so every
    // browser session would have billed zero while looking correctly ingested.
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-session', tenant_id: TENANT_A, agent_id: 'a',
          workflow_id: null, action_id: null, event_type: 'browser_session',
          credits: 1,
          metadata: {
            vendor: 'browser_use', tool_name: 'browser_session',
            cost_micros: 500, funding: 'platform',
            idempotency_key: 'browser_use_session:vs-1',
          },
          created_at: '2025-01-11T00:00:00Z',
        }],
        nextCursor: '2025-01-11T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'browser_use_session:vs-1',
      0.0005,
      expect.objectContaining({
        connector: 'browser_use',
        actionType: 'browser_session',
        eventType: 'web_tool',
        // The funding has to survive the BACKSTOP path too. This poll books the
        // same sessions the real-time subscriber does, so a funding fact on only
        // one of them means the charge depends on which arrived first.
        webToolFunding: 'platform',
      }),
    );
  });

  it("leaves a workspace's own-key session on the BYOK bypass", async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-byok', tenant_id: TENANT_A, agent_id: 'a',
          workflow_id: null, action_id: null, event_type: 'browser_session',
          credits: 1,
          metadata: {
            vendor: 'browser_use', tool_name: 'browser_session',
            cost_micros: 500, funding: 'tenant_key',
            idempotency_key: 'browser_use_session:vs-2',
          },
          created_at: '2025-01-11T00:00:00Z',
        }],
        nextCursor: '2025-01-11T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    // undefined, not 'tenant_key': only 'platform' moves a row off the bypass,
    // so anything else leaves it exactly where it has always gone.
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1', 'browser_use_session:vs-2', 0.0005,
      expect.objectContaining({ webToolFunding: undefined }),
    );
  });

  it('falls back to e.id when metadata.idempotency_key is absent (backward-compatible)', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-legacy', tenant_id: TENANT_A, agent_id: 'a',
          workflow_id: null, action_id: null, event_type: 'web_extract',
          credits: 1,
          metadata: { vendor: 'firecrawl', tool_name: 'web_extract', cost_micros: 200_000 },
          created_at: '2025-01-11T00:00:00Z',
        }],
        nextCursor: '2025-01-11T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'evt-legacy',
      0.2,
      expect.anything(),
    );
  });

  // PB-3 of the deep-research-realtime-billing plan: deep_research delta
  // events can carry negative cost_micros (over-estimate true-up or
  // FAILED refund). The ingester maps to a NEGATIVE costUsd and lets
  // ingestEventWithBuckets route it through the refund branch.
  it('passes negative costUsd through for deep_research delta events (PB-3 signed-cost)', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-delta', tenant_id: TENANT_A, agent_id: 'a',
          workflow_id: null, action_id: null, event_type: 'web_deep_research',
          credits: 0,
          metadata: {
            vendor: 'perplexity', tool_name: 'web_deep_research',
            cost_micros: -300_000,                       // refund
            idempotency_key: 'deep-id-1/delta',
            is_delta: true,
          },
          created_at: '2025-01-12T00:00:00Z',
        }],
        nextCursor: '2025-01-12T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'deep-id-1/delta',
      -0.3,                                              // negative
      expect.anything(),
    );
  });

  // INV-PB-009 — usage_events.agent_id is the RUNTIME agents.id (this feed is the
  // tenant runtime's own ledger); cost_attribution_events is keyed by
  // internal_agents.id.
  it('translates the runtime agent id to the control-plane id on each event', async () => {
    setActiveTenants([TENANT_A]);
    mockGetRuntimeToInternalMap.mockResolvedValue(new Map([['runtime-a', 'internal-a']]));
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-1', tenant_id: TENANT_A, agent_id: 'runtime-a', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-08T00:00:00Z',
        }],
        nextCursor: '2025-01-08T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    expect(mockGetRuntimeToInternalMap).toHaveBeenCalledWith(TENANT_A);
    const [, , , template] = mockIngestEventWithBuckets.mock.calls[0];
    expect(template.agentId).toBe('internal-a');
  });

  it('passes an already-internal id through untouched', async () => {
    setActiveTenants([TENANT_A]);
    mockGetRuntimeToInternalMap.mockResolvedValue(new Map([['some-other-id', 'x']]));
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-2', tenant_id: TENANT_A, agent_id: 'already-internal', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-08T00:00:00Z',
        }],
        nextCursor: '2025-01-08T00:00:00Z',
        hasMore: false,
      },
    ]);
    await runUsageLedgerIngester();
    const [, , , template] = mockIngestEventWithBuckets.mock.calls[0];
    expect(template.agentId).toBe('already-internal');
  });

  it('counts a tenant error in the errors total without aborting the sweep', async () => {
    setActiveTenants([TENANT_A, TENANT_B]);
    // Tenant A: resolveAccountIdForTenant throws.
    mockResolveAccountIdForTenant
      .mockImplementationOnce(async () => { throw new Error('boom'); })
      .mockResolvedValueOnce('acct-1');
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-B', tenant_id: TENANT_B, agent_id: 'b', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-08T00:00:00Z',
        }],
        nextCursor: '2025-01-08T00:00:00Z',
        hasMore: false,
      },
    ]);
    const stats = await runUsageLedgerIngester();
    expect(stats.errors).toBe(1);
    expect(stats.ingested).toBe(1);
  });
});

describe('agent id-map is resolved only when there is work', () => {
  // Prod evidence: three tenants with no agents and no usage generated ~500
  // blocked cross-service calls a day between this ingester and the governance
  // one. The map was fetched per tenant per cycle BEFORE the feed was read, so
  // an idle tenant paid the call forever — and for an execution-disabled tenant
  // the runtime answers 503, which the caller swallows into a pass-through that
  // writes runtime ids where internal_agents.id is required.

  it('makes no mapping call for a tenant whose feed is empty', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([{ events: [], nextCursor: null, hasMore: false }]);

    const stats = await runUsageLedgerIngester();

    expect(stats.ingested).toBe(0);
    expect(mockGetRuntimeToInternalMap).not.toHaveBeenCalled();
  });

  it('resolves the map once when the feed does have events', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [{
          id: 'evt-1', tenant_id: TENANT_A, agent_id: 'a1', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-02T00:00:00Z',
        }],
        nextCursor: '2025-01-02T00:00:00Z',
        hasMore: true,
      },
      {
        events: [{
          id: 'evt-2', tenant_id: TENANT_A, agent_id: 'a1', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-03T00:00:00Z',
        }],
        nextCursor: '2025-01-03T00:00:00Z',
        hasMore: false,
      },
    ]);

    await runUsageLedgerIngester();

    // Two pages, one fetch: memoised for the rest of the cycle.
    expect(mockGetRuntimeToInternalMap).toHaveBeenCalledTimes(1);
    expect(mockGetRuntimeToInternalMap).toHaveBeenCalledWith(TENANT_A);
  });

  it('skips the mapping call for idle tenants while still making it for busy ones', async () => {
    setActiveTenants([TENANT_A, TENANT_B]);
    mockFeedResponseSequence([
      { events: [], nextCursor: null, hasMore: false }, // A: idle
      {
        events: [{
          id: 'evt-3', tenant_id: TENANT_B, agent_id: 'a1', workflow_id: null,
          action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
          created_at: '2025-01-02T00:00:00Z',
        }],
        nextCursor: '2025-01-02T00:00:00Z',
        hasMore: false,
      },
    ]);

    await runUsageLedgerIngester();

    expect(mockGetRuntimeToInternalMap).toHaveBeenCalledTimes(1);
    expect(mockGetRuntimeToInternalMap).toHaveBeenCalledWith(TENANT_B);
  });
});

describe('the feed is consumed per tenant, not globally', () => {
  // The runtime's /api/usage-ledger/feed had no tenant filter, so every tenant's
  // poll returned the whole fleet's events. This loop then translated each
  // event's agent id with the map of the tenant it was ITERATING while writing
  // the row under the EVENT's tenant — so whenever those differed the lookup
  // missed and fell through to pass-through, writing a runtime id into a column
  // that must hold internal_agents.id.

  it('asks the feed for one tenant', async () => {
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([{ events: [], nextCursor: null, hasMore: false }]);

    await runUsageLedgerIngester();

    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain(`tenantId=${TENANT_A}`);
  });

  it('does not ingest an event belonging to a different tenant', async () => {
    // Defence in depth: correct on this side too, so neither end alone can
    // reintroduce the mis-translation if the feed ever regresses.
    setActiveTenants([TENANT_A]);
    mockFeedResponseSequence([
      {
        events: [
          {
            id: 'evt-mine', tenant_id: TENANT_A, agent_id: 'a1', workflow_id: null,
            action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
            created_at: '2025-01-02T00:00:00Z',
          },
          {
            id: 'evt-theirs', tenant_id: TENANT_B, agent_id: 'b1', workflow_id: null,
            action_id: null, event_type: 'memory_save', credits: 1, metadata: {},
            created_at: '2025-01-02T00:00:01Z',
          },
        ],
        nextCursor: '2025-01-02T00:00:01Z',
        hasMore: false,
      },
    ]);

    await runUsageLedgerIngester();

    const ingestedIds = mockIngestEventWithBuckets.mock.calls.map((c) => c[1]);
    expect(ingestedIds).toContain('evt-mine');
    expect(ingestedIds).not.toContain('evt-theirs');
  });
});
