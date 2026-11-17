// Tool Gateway — executeBatch() tests
//
// Phase 1a-ii perf fix #2: parallel connector tool calls in a single LLM
// turn should be coalesced into exactly one ConnectorService.ExecuteBatch
// RPC instead of N serial Execute RPCs.

// ── Mocks (must come before imports of the subject-under-test) ──────────

const mockExecuteBatch = jest.fn();
const mockExecute = jest.fn();

jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({
    execute: mockExecute,
    executeBatch: mockExecuteBatch,
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The gateway reads the database through `getPool()` and nothing else. This
// mock once covered `getPool` but not the bare `pool` export the duplicate
// guard actually read, so its lookup threw, failed open, and these tests passed
// against a check that never ran. One accessor is one thing to mock.
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
  getPoolForService: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));

jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({
    getByIdempotencyKey: jest.fn().mockResolvedValue(null),
    recordIntent: jest.fn().mockResolvedValue('action-123'),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    recordPostActionSnapshot: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../state-fetcher', () => ({
  stateFetcherRegistry: {
    fetchState: jest.fn().mockResolvedValue({
      data: { id: 'row-1', value: 41 },
      fetchedAt: new Date(),
      versionToken: 'v1',
    }),
  },
  ExternalStateFetcherRegistry: jest.fn(),
}));

const mockIndexToolResult = jest.fn().mockResolvedValue(undefined);
jest.mock('../content-indexer', () => ({
  contentIndexer: { indexToolResult: (...a: unknown[]) => mockIndexToolResult(...a) },
}));

const mockRecordUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: (...a: unknown[]) => mockRecordUsage(...a) },
}));

jest.mock('../permission-validator', () => ({
  permissionValidator: {
    validate: jest.fn().mockResolvedValue({ allowed: true, appliedEntry: null }),
  },
}));

// conflict-policy-registry returns a default policy shape from .get()
// The fast path now runs the same capability and repository-scope guards the
// serial path does, and both are LOOKUPS. Mocked empty here because this file is
// about batching and duplicate suppression: left real, each guard consumes one
// of the queued `mockQuery` values and the duplicate lookup below reads someone
// else's row — which is how an ordered pool mock turns "a query was added" into
// a failure that looks like a behaviour change.
jest.mock('../capability-states-lookup', () => ({
  capabilityStatesFor: jest.fn(async () => ({})),
  repoScopeFor: jest.fn(async () => null),
}));

jest.mock('../conflict-policy-registry', () => ({
  ConflictPolicyRegistry: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({
      connector: 'slack',
      entityType: 'message',
      actionType: 'send',
      freshnessTTL: null,
      freshReadBeforeWriteRequired: false,
      versionTokenField: null,
      fieldComparisonSet: [],
      conflictResolutionMode: 'last-write-wins',
      escalateOnConflict: false,
      undoSupportMode: 'none',
    }),
  })),
}));

import { ToolGatewayService } from '../service';
import type { ExecuteInput } from '../types';

const baseInput = (overrides: Partial<ExecuteInput>): ExecuteInput => ({
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  instructionVersion: 1,
  traceId: 'trace-abc',
  idempotencyKey: 'idk',
  connector: 'slack',
  entityType: 'message',
  actionType: 'send_message',
  payload: { channel: '#test', text: 'hi' },
  ...overrides,
});

describe('ToolGatewayService.executeBatch', () => {
  let svc: ToolGatewayService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    svc = new ToolGatewayService();
  });

  it('issues exactly one executeBatch RPC for 3 parallel connector calls', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [
        { success: true, result: { ok: 1 }, error: '' },
        { success: true, result: { ok: 2 }, error: '' },
        { success: true, result: { ok: 3 }, error: '' },
      ],
    });

    const inputs: ExecuteInput[] = [
      baseInput({ idempotencyKey: 'k1', connector: 'slack', actionType: 'send_message' }),
      baseInput({ idempotencyKey: 'k2', connector: 'slack', actionType: 'list_channels' }),
      baseInput({ idempotencyKey: 'k3', connector: 'google_mail', actionType: 'get_thread' }),
    ];

    const results = await svc.executeBatch(inputs);

    expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
    expect(mockExecute).not.toHaveBeenCalled();

    const call = mockExecuteBatch.mock.calls[0][0];
    expect(call.operations).toHaveLength(3);
    expect(call.operations.map((o: { idempotencyKey: string }) => o.idempotencyKey)).toEqual([
      'k1',
      'k2',
      'k3',
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ success: true, data: { ok: 1 }, traceId: 'trace-abc' });
    expect(results[1]).toEqual({ success: true, data: { ok: 2 }, traceId: 'trace-abc' });
    expect(results[2]).toEqual({ success: true, data: { ok: 3 }, traceId: 'trace-abc' });
  });

  it('ledgers a wallet-funded batch slot exactly like the single path (INV-PB-013)', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [
        { success: true, result: { ok: 1 }, error: '' },
        { success: true, result: { items: [] }, error: '', costUsd: 0.031, fundingSource: 'x402_wallet' },
      ],
    });

    const results = await svc.executeBatch([
      baseInput({ idempotencyKey: 'k1', connector: 'slack', actionType: 'send_message' }),
      baseInput({ idempotencyKey: 'k2', connector: 'gloria', actionType: 'get_ticker_summary' }),
    ]);

    expect(results.every((r) => r.success)).toBe(true);
    // Only the paid slot books; the free one records nothing.
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    const event = mockRecordUsage.mock.calls[0][0] as {
      actionId: string; eventType: string; metadata: Record<string, unknown>;
    };
    expect(event.eventType).toBe('connector_call');
    // The slot's recordIntent id, so the cost row joins the actions row.
    expect(event.actionId).toBe('action-123');
    expect(event.metadata.cost_micros).toBe(31_000);
    expect(event.metadata.funding).toBe('x402_wallet');
  });

  it('still uses executeBatch (batch-of-1) when a turn has a single connector call', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{ success: true, result: { ok: true }, error: '' }],
    });

    const inputs: ExecuteInput[] = [baseInput({ idempotencyKey: 'solo' })];
    const results = await svc.executeBatch(inputs);

    expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
    expect(mockExecuteBatch.mock.calls[0][0].operations).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('preserves per-operation error semantics — one failure does not drag siblings', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [
        { success: true, result: { ok: 1 }, error: '' },
        { success: false, result: null, error: 'rate limited' },
        { success: true, result: { ok: 3 }, error: '' },
      ],
    });

    // Three DIFFERENT channels. They used to be three identical sends, which
    // is the duplicate the within-run guard exists to refuse — so the batch
    // never reached the RPC and this test measured the guard instead of the
    // error semantics it is named for.
    const inputs: ExecuteInput[] = [
      baseInput({ idempotencyKey: 'a', payload: { channel: '#a', text: 'hi' } }),
      baseInput({ idempotencyKey: 'b', payload: { channel: '#b', text: 'hi' } }),
      baseInput({ idempotencyKey: 'c', payload: { channel: '#c', text: 'hi' } }),
    ];

    const results = await svc.executeBatch(inputs);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[1].error).toBe('rate limited');
    expect(results[2].success).toBe(true);
  });

  // THE GUARD ON THE FAST PATH.
  //
  // `executeToolCalls` sends every batchable connector call through
  // `executeBatch`, so a guard that lives only in `execute()` never runs on a
  // real dispatch. These pin both halves: the ledger lookup, and the sibling
  // that has not reached the ledger yet because it is in the same batch.
  it('answers a repeat with what the FIRST call returned, and does not dispatch', async () => {
    // Not a refusal. `executeToolStep` reads `success: false` and takes the
    // step's onFailure branch, so refusing a step whose postcondition is
    // already satisfied routed the workflow somewhere else — worse than the
    // duplicate it prevents. Not a stub success either: the data is the first
    // call's recorded external_response.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'action-1',
        created_at: '2026-08-28T05:54:29Z',
        external_response: { review_id: 5049944673 },
      }],
      rowCount: 1,
    });
    // No `mockExecuteBatch` value queued on purpose: nothing should reach the
    // wire, and a queued one would leak into the next test if it did not.

    const results = await svc.executeBatch([baseInput({ idempotencyKey: 'again' })]);

    expect(results[0].success).toBe(true);
    expect(results[0].data).toEqual({ review_id: 5049944673 });
    // The model is still told, so it learns it repeated itself.
    expect(results[0].notice).toContain('Already done in this run');
    expect(results[0].notice).toContain('nothing was sent a second time');
    expect(mockExecuteBatch).not.toHaveBeenCalled();
  });

  it('refuses the second of two identical calls inside ONE batch', async () => {
    // Neither has dispatched, so neither is `completed` and the ledger lookup
    // cannot see either one. Only the in-batch claim catches this.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{ success: true, result: { ok: 1 }, error: '' }],
    });

    const results = await svc.executeBatch([
      baseInput({ idempotencyKey: 'first' }),
      baseInput({ idempotencyKey: 'second' }),
    ]);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    // Not "already done" — the twin has not dispatched either.
    expect(results[1].error).toContain('Already being done in this run');
    // One survivor reached the wire, not two.
    expect(mockExecuteBatch.mock.calls[0][0].operations).toHaveLength(1);
  });

  it('lets a multiplexed tool run each of its operations once', async () => {
    // `pull_request_review_write { method: 'create' }` opens the draft and
    // `{ method: 'submit_pending' }` publishes it, on the same pull request in
    // the same run. Keyed on the action name alone the publish is refused and
    // every review ends as an unpublished draft.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockExecuteBatch.mockResolvedValueOnce({
      results: [
        { success: true, result: { ok: 1 }, error: '' },
        { success: true, result: { ok: 2 }, error: '' },
      ],
    });

    const pr = { owner: 'acme', repo: 'webapp', pullNumber: 42 };
    const results = await svc.executeBatch([
      baseInput({
        idempotencyKey: 'open',
        connector: 'github',
        entityType: 'pull_request',
        actionType: 'pull_request_review_write',
        payload: { ...pr, method: 'create' },
      }),
      baseInput({
        idempotencyKey: 'publish',
        connector: 'github',
        entityType: 'pull_request',
        actionType: 'pull_request_review_write',
        payload: { ...pr, method: 'submit_pending', event: 'COMMENT', body: 'summary' },
      }),
    ]);

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(mockExecuteBatch.mock.calls[0][0].operations).toHaveLength(2);
  });

  // THE OUTPUT GUARDRAILS ON THE FAST PATH.
  //
  // The guardrail loop lived in `executeInner`, which a batched connector call
  // never reaches, so `secret-scrub` never ran on a batched tool result.
  it('scrubs credentials out of a batched tool result before the model reads it', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{
        success: true,
        result: { file: 'token = ghp_' + 'a'.repeat(36) + ' and AKIA1234567890ABCDEF' },
        error: '',
      }],
    });

    const results = await svc.executeBatch([
      baseInput({ idempotencyKey: 'read', actionType: 'get_file_contents' }),
    ]);

    const data = results[0].data as { file: string };
    expect(data.file).not.toMatch(/ghp_/);
    expect(data.file).not.toMatch(/AKIA/);
    expect(data.file).toContain('[REDACTED:');
  });

  // THE RETRIEVAL INDEX ON THE FAST PATH.
  //
  // `connector_content` held one row in the whole life of the table while the
  // kill switch was on in both environments, because the indexer lived in
  // `executeInner` and a batched read never reaches it.
  it('indexes a batched read result, with the SCRUBBED text', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{
        success: true,
        result: { body: 'deploy key ghp_' + 'b'.repeat(36) + ' in the runbook' },
        error: '',
      }],
    });

    await svc.executeBatch([
      baseInput({ idempotencyKey: 'read', actionType: 'get_file_contents' }),
    ]);

    expect(mockIndexToolResult).toHaveBeenCalledTimes(1);
    const indexed = mockIndexToolResult.mock.calls[0][0] as { data: { body: string } };
    // Ordering matters: indexing before the guardrail would persist the
    // credential into a table built to be searched.
    expect(indexed.data.body).not.toMatch(/ghp_/);
    expect(indexed.data.body).toContain('[REDACTED:github-token]');
  });

  it('does not index a failed batch slot', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{ success: false, result: null, error: 'rate limited' }],
    });

    await svc.executeBatch([baseInput({ idempotencyKey: 'x', actionType: 'get_thread' })]);
    expect(mockIndexToolResult).not.toHaveBeenCalled();
  });

  it('falls back to serial execute() for update/delete actions (write-path semantics)', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{ success: true, result: { ok: 1 }, error: '' }],
    });
    mockExecute.mockResolvedValueOnce({
      success: true,
      result: { updated: true },
      error: '',
    });

    const inputs: ExecuteInput[] = [
      baseInput({ idempotencyKey: 'batch', actionType: 'send_message' }),
      baseInput({
        idempotencyKey: 'fallback',
        actionType: 'update',
        entityType: 'row',
        payload: { id: 'row-1', newValue: 42 },
      }),
    ];

    const results = await svc.executeBatch(inputs);

    expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
    expect(mockExecuteBatch.mock.calls[0][0].operations).toHaveLength(1);
    expect(mockExecute).toHaveBeenCalledTimes(1); // serial path for 'update'
    expect(results).toHaveLength(2);
  });

  it('returns empty array when given no inputs (no RPC issued)', async () => {
    const results = await svc.executeBatch([]);
    expect(results).toEqual([]);
    expect(mockExecuteBatch).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('SSRF gate fires on the fast-path: untrusted_inbound batch with private-IP URL is refused without an RPC', async () => {
    // No mockResolvedValueOnce — if we hit the RPC, executeBatch would
    // explode. The point is the gate runs BEFORE the RPC for batched items.
    const results = await svc.executeBatch([
      baseInput({
        idempotencyKey: 'ssrf-1',
        connector: 'http',
        actionType: 'fetch',
        payload: { url: 'http://169.254.169.254/computeMetadata/v1/' },
        trustLevel: 'untrusted_inbound',
      } as unknown as ExecuteInput),
    ]);
    expect(mockExecuteBatch).not.toHaveBeenCalled();
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/private\/metadata/);
  });

  it('SSRF gate does NOT fire on trusted-batch tool calls (regression: cron/human invocations stay fast)', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{ success: true, result: { ok: true }, error: '' }],
    });
    const results = await svc.executeBatch([
      baseInput({
        idempotencyKey: 'safe-1',
        payload: { url: 'http://169.254.169.254/' },
        // trustLevel omitted → defaults to trusted
      }),
    ]);
    expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
    expect(results[0].success).toBe(true);
  });

  it('passes all operations under a single shared tenantContext', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [
        { success: true, result: {}, error: '' },
        { success: true, result: {}, error: '' },
      ],
    });

    await svc.executeBatch([
      baseInput({ idempotencyKey: 'a' }),
      baseInput({ idempotencyKey: 'b' }),
    ]);

    const call = mockExecuteBatch.mock.calls[0][0];
    expect(call.tenantContext).toEqual({ tenantId: 'tenant-1' });
  });
});

// #4: executeConnectorCall (single Execute) must produce a self-consistent
// tool-error contract — trust the wire when it carries a valid code, and derive
// retryable + recovery from the fallback code when it doesn't (older
// connector-service build with an empty error_code), matching executeBatch.
describe('ToolGatewayService.executeConnectorCall — ingress contract mapping (#4)', () => {
  let svc: ToolGatewayService;
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    svc = new ToolGatewayService();
  });

  const callConnector = (input: ExecuteInput) =>
    (svc as unknown as {
      executeConnectorCall: (i: ExecuteInput) => Promise<{
        success: boolean; error?: string; errorCode?: string;
        retryable?: boolean; retryAfterMs?: number; recovery?: string;
      }>;
    }).executeConnectorCall(input);

  it('empty wire error_code (legacy sender) → internal_error + derived retryable/recovery', async () => {
    mockExecute.mockResolvedValueOnce({
      success: false, result: null, error: 'boom',
      errorCode: '', retryable: false, recovery: '',
    });
    const r = await callConnector(baseInput({ connector: 'salesforce', actionType: 'read_record' }));
    expect(r.success).toBe(false);
    expect(r.error).toBe('boom');
    expect(r.errorCode).toBe('internal_error');
    expect(r.retryable).toBe(false);                     // derived from internal_error
    expect((r.recovery ?? '').length).toBeGreaterThan(0); // derived via recoveryFor, never empty
  });

  it('valid wire code → passes code/retryable/retryAfterMs/recovery through verbatim', async () => {
    mockExecute.mockResolvedValueOnce({
      success: false, result: null, error: 'slow down',
      errorCode: 'rate_limited', retryable: true, retryAfterMs: BigInt(1500), recovery: 'wait then retry',
    });
    const r = await callConnector(baseInput({ connector: 'salesforce', actionType: 'read_record' }));
    expect(r.errorCode).toBe('rate_limited');
    expect(r.retryable).toBe(true);
    expect(r.retryAfterMs).toBe(1500);
    expect(r.recovery).toBe('wait then retry');
  });

  it('success passes through with no contract fields', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: { ok: 1 }, error: '' });
    const r = await callConnector(baseInput({ connector: 'salesforce', actionType: 'read_record' }));
    expect(r.success).toBe(true);
    expect(r.errorCode).toBeUndefined();
  });
});

// The connector-service RPC carries a deadline. The HTTP/2 transport pings a
// live session but set no per-call timeout, so an RPC on a session that died
// in a network reset waited forever. The deadline is the tool-call ceiling the
// MCP bridge applies (dispatchTimeoutMs), so it never cuts a call the caller is
// still waiting for; the transport honouring it is pinned in
// connectors/__tests__/connector-service-deadline.test.ts.
describe('connector-service RPC deadline', () => {
  let svc: ToolGatewayService;
  const callConnector = (input: ExecuteInput) =>
    (svc as unknown as {
      executeConnectorCall: (_i: ExecuteInput) => Promise<{ success: boolean; error?: string; errorCode?: string; retryable?: boolean }>;
    }).executeConnectorCall(input);

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    svc = new ToolGatewayService();
  });

  it('a single Execute is sent with the tool-call ceiling as its deadline', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: {}, error: '' });
    await callConnector(baseInput({ connector: 'salesforce', actionType: 'read_record' }));
    expect(mockExecute.mock.calls[0][1]).toEqual({ timeoutMs: 180_000 });
  });

  it('a call that declares a longer budget gets it, plus the margin', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: {}, error: '' });
    await callConnector(baseInput({ connector: 'salesforce', actionType: 'read_record', payload: { timeout_seconds: 400 } }));
    expect(mockExecute.mock.calls[0][1]).toEqual({ timeoutMs: 460_000 });
  });

  it('a batch is sent with the longest of its operations\' deadlines', async () => {
    mockExecuteBatch.mockResolvedValueOnce({ results: [{ success: true, result: {} }, { success: true, result: {} }] });
    await svc.executeBatch([
      baseInput({ idempotencyKey: 'b1' }),
      baseInput({ idempotencyKey: 'b2', actionType: 'list_channels', payload: { timeout_seconds: 300 } }),
    ]);
    expect(mockExecuteBatch.mock.calls[0][1]).toEqual({ timeoutMs: 360_000 });
  });

  it('an expired deadline is a failed, retryable tool result, not a hang or a throw', async () => {
    const { ConnectError, Code } = jest.requireActual('@connectrpc/connect');
    mockExecute.mockRejectedValueOnce(new ConnectError('the operation timed out', Code.DeadlineExceeded));
    const r = await callConnector(baseInput({ connector: 'salesforce', actionType: 'read_record' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/timed out/);
    expect(r.retryable).toBe(true);
  });
});
