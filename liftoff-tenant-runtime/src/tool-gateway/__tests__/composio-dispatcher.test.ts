// Composio cutover-completion (C5 + C6 + C9): composio-dispatcher tests.
//
// The Composio SDK is mocked so the tests run hermetically. We assert:
//   - tools.execute called with userId == tenantId AND connectedAccountId
//   - response shape unwrap (resp.data → translateOutput)
//   - successful=false → throw via translateError
//   - reportComposioToolCall fires on success AND on failure
//   - canonical-shape violation throws
//   - missing connectedAccountId throws composio_dispatch_missing_connection
//   - quota denial throws with the platform's explanation
//   - polling: completes on completeWhen true, throws polling_timeout
//
// We do NOT import the real `@composio/core` package in tests — the
// jest.mock at the top swaps in a stub before the dispatcher module
// initialises its private client.

const mockExecute = jest.fn();
jest.mock('@composio/core', () => ({
  Composio: jest.fn().mockImplementation(() => ({
    tools: { execute: mockExecute },
  })),
}));

const mockReport = jest.fn().mockResolvedValue(undefined);
jest.mock('../../billing/composio-call-reporter', () => ({
  reportComposioToolCall: (...a: unknown[]) => mockReport(...a),
}));

import { dispatchComposio, dispatchComposioWithPolling, _resetForTesting } from '../composio-dispatcher';
import { _resetForTesting as _resetLimiter } from '../composio-rate-limiter';
import {
  _resetQuotaCacheForTesting as _resetQuotaCache,
  _seedAllocationForTesting as _seedAllocation,
} from '../composio-quota-client';
import type { NormalizedToolError } from '@liftoffos/composio-overlays';

const baseTranslateError = (e: { code: number; message: string; data?: unknown }): NormalizedToolError => {
  const err = new Error(e.message) as NormalizedToolError;
  err.code = 'internal_error';
  err.retryable = false;
  err.vendorPayload = e;
  return err;
};

beforeEach(() => {
  process.env.COMPOSIO_API_KEY = 'test-key';
  mockExecute.mockReset();
  mockReport.mockReset().mockResolvedValue(undefined);
  _resetForTesting();
  _resetLimiter();
});

describe('dispatchComposio', () => {
  it('calls composio.tools.execute with userId == tenantId AND connectedAccountId from manifest.externalAccountId', async () => {
    mockExecute.mockResolvedValue({ data: { items: [], nextPageToken: undefined }, error: null, successful: true });
    await dispatchComposio({
      tenantId: 'tenant-1', agentId: null, invocationId: null,
      connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
      toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
      canonicalKey: 'gmail.list_messages',
      composioConnectedAccountId: 'ca_abc',
      args: { user_id: 'me' },
      translateOutput: (d) => d,
      translateError: baseTranslateError,
    });
    expect(mockExecute).toHaveBeenCalledWith('GMAIL_FETCH_EMAILS', {
      userId: 'tenant-1',
      connectedAccountId: 'ca_abc',
      arguments: { user_id: 'me' },
      dangerouslySkipVersionCheck: true,
    });
  });

  it('throws composio_dispatch_missing_connection when manifest has no externalAccountId', async () => {
    await expect(
      dispatchComposio({
        tenantId: 'tenant-1', agentId: null, invocationId: null,
        connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
        toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
        canonicalKey: 'gmail.list_messages',
        composioConnectedAccountId: '',
        args: {},
        translateError: baseTranslateError,
      }),
    ).rejects.toThrow(/composio_dispatch_missing_connection/);
  });

  // The canonical shape is the contract, and validateCanonical returns
  // `parsed.data` — so a key the shape does not declare is STRIPPED, not passed
  // through. composio-overlays 0.2.15 removed `payload` from gmailMessage "so
  // Gmail listings stop carrying raw MIME", which is exactly this mechanism
  // working: the vendor still sends it and an overlay may still map it, and it
  // still does not reach the agent. Asserted here rather than deleted from the
  // fixture, because "raw MIME goes in and does not come out" is the property
  // 0.2.15 bought and the one worth failing on if it regresses.
  it('returns translateOutput(resp.data) parsed to the canonical shape, NOT the raw resp envelope', async () => {
    mockExecute.mockResolvedValue({
      data: { messages: [{ messageId: 'm1', threadId: 't1', payload: {} }], nextPageToken: 'cur' },
      error: null,
      successful: true,
    });
    const result = await dispatchComposio({
      tenantId: 'tenant-1', agentId: null, invocationId: null,
      connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
      toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
      canonicalKey: 'gmail.list_messages',
      composioConnectedAccountId: 'ca_abc',
      args: {},
      translateOutput: (data) => {
        const d = data as { messages?: Array<{ messageId: string; threadId: string; payload: unknown }>; nextPageToken?: string };
        return {
          items: (d.messages ?? []).map((m) => ({ id: m.messageId, threadId: m.threadId, payload: m.payload })),
          nextPageToken: d.nextPageToken,
        };
      },
      translateError: baseTranslateError,
    });
    // Not the {data, error, successful} envelope — the translated value...
    expect(result).toEqual({
      items: [{ id: 'm1', threadId: 't1' }],
      nextPageToken: 'cur',
    });
    // ...with the undeclared key dropped on the way through the shape.
    expect((result as { items: Array<Record<string, unknown>> }).items[0])
      .not.toHaveProperty('payload');
  });

  it('throws translated error when resp.successful === false', async () => {
    mockExecute.mockResolvedValue({ data: {}, error: 'vendor 401', successful: false });
    await expect(
      dispatchComposio({
        tenantId: 'tenant-1', agentId: null, invocationId: null,
        connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
        toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
        canonicalKey: 'gmail.list_messages',
        composioConnectedAccountId: 'ca_abc',
        args: {},
        translateError: baseTranslateError,
      }),
    ).rejects.toThrow('vendor 401');
  });

  it('reports composio cost via reportComposioToolCall on success', async () => {
    mockExecute.mockResolvedValue({ data: { items: [] }, error: null, successful: true });
    await dispatchComposio({
      tenantId: 'tenant-1', agentId: 'agent-1', invocationId: 'inv-1',
      connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
      toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
      canonicalKey: 'gmail.list_messages',
      composioConnectedAccountId: 'ca_abc',
      args: {},
      translateOutput: (d) => d,
      translateError: baseTranslateError,
    });
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1', agentId: 'agent-1', invocationId: 'inv-1',
        connectorType: 'google_mail', toolName: 'GMAIL_FETCH_EMAILS',
      }),
    );
  });

  it('reports composio cost on SDK transport failure (Composio bills per attempt)', async () => {
    mockExecute.mockRejectedValue(new Error('network error'));
    await expect(
      dispatchComposio({
        tenantId: 'tenant-1', agentId: null, invocationId: null,
        connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
        toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
        canonicalKey: 'gmail.list_messages',
        composioConnectedAccountId: 'ca_abc',
        args: {},
        translateError: baseTranslateError,
      }),
    ).rejects.toThrow('network error');
    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it('throws canonical_shape_violation when translateOutput produces a non-conforming result', async () => {
    mockExecute.mockResolvedValue({ data: {}, error: null, successful: true });
    await expect(
      dispatchComposio({
        tenantId: 'tenant-1', agentId: null, invocationId: null,
        connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
        toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
        canonicalKey: 'gmail.list_messages',
        composioConnectedAccountId: 'ca_abc',
        args: {},
        translateOutput: () => ({ not_a_list: true }),
        translateError: baseTranslateError,
      }),
    ).rejects.toThrow(/canonical_shape_violation: gmail.list_messages/);
  });
});

describe('dispatchComposioWithPolling', () => {
  it('polls until completeWhen satisfied and returns final canonical response', async () => {
    // The polling overlay refers by stableName, which resolves to a vendor
    // tool via resolveOverlayByStableName. We seed Gmail's list_messages
    // overlay as the status tool for test purposes (any registered overlay
    // works — we override translateOutput in the dispatch call).
    mockExecute
      .mockResolvedValueOnce({ data: { job_id: 'job-1' }, error: null, successful: true })
      .mockResolvedValueOnce({ data: { state: 'running' }, error: null, successful: true })
      .mockResolvedValueOnce({ data: { state: 'done', items: [] }, error: null, successful: true });

    const result = await dispatchComposioWithPolling({
      tenantId: 'tenant-1', agentId: null, invocationId: null,
      connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
      toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
      canonicalKey: 'gmail.list_messages',
      composioConnectedAccountId: 'ca_abc',
      args: {},
      translateOutput: (d) => ({ items: (d as { items?: unknown[] }).items ?? [] }),
      translateError: baseTranslateError,
      polling: {
        statusToolStableName: 'list_messages',       // any stable name in 'gmail' overlay
        stateField: 'state',
        completeWhen: (s) => s === 'done',
        maxAttempts: 3,
        intervalMs: 1,
        jobIdField: 'job_id',
        statusToolJobIdField: 'id',
      },
    });
    expect(result).toEqual({ items: [] });
    expect(mockExecute).toHaveBeenCalledTimes(3);  // initial + 2 polls
    expect(mockReport).toHaveBeenCalledTimes(3);    // one per attempt
  });

  it('throws polling_timeout after maxAttempts', async () => {
    mockExecute
      .mockResolvedValueOnce({ data: { job_id: 'job-1' }, error: null, successful: true })
      .mockResolvedValue({ data: { state: 'running' }, error: null, successful: true });

    await expect(
      dispatchComposioWithPolling({
        tenantId: 'tenant-1', agentId: null, invocationId: null,
        connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
        toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
        canonicalKey: 'gmail.list_messages',
        composioConnectedAccountId: 'ca_abc',
        args: {},
        translateError: baseTranslateError,
        polling: {
          statusToolStableName: 'list_messages',
          stateField: 'state',
          completeWhen: (s) => s === 'done',
          maxAttempts: 2,
          intervalMs: 1,
          jobIdField: 'job_id',
          statusToolJobIdField: 'id',
        },
      }),
    ).rejects.toThrow(/polling_timeout: gmail.list_messages did not complete/);
  });

  it('throws via translateError when failedWhen returns true', async () => {
    mockExecute
      .mockResolvedValueOnce({ data: { job_id: 'job-1' }, error: null, successful: true })
      .mockResolvedValueOnce({ data: { state: 'failed' }, error: null, successful: true });

    await expect(
      dispatchComposioWithPolling({
        tenantId: 'tenant-1', agentId: null, invocationId: null,
        connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
        toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
        canonicalKey: 'gmail.list_messages',
        composioConnectedAccountId: 'ca_abc',
        args: {},
        translateError: baseTranslateError,
        polling: {
          statusToolStableName: 'list_messages',
          stateField: 'state',
          completeWhen: (s) => s === 'done',
          failedWhen: (s) => s === 'failed',
          maxAttempts: 5,
          intervalMs: 1,
          jobIdField: 'job_id',
          statusToolJobIdField: 'id',
        },
      }),
    ).rejects.toThrow(/composio operation failed \(state="failed"\)/);
  });

  it('quota check consumes one unit per poll tick (initial + each status call)', async () => {
    // Composio bills per attempt, and a poll tick is an attempt. Seed a
    // three-call allocation: initial dispatch + 2 status calls exhaust it, and
    // the third status call is refused.
    _resetLimiter();
    _resetQuotaCache();
    _seedAllocation('tenant-rl', {
      orgRemaining: 10_000,
      reservedHeadroom: 2_000,
      backgroundAllowed: true,
      tenantMonthlySlice: 9_000,
      tenantRemaining: 9_000,
      perMinuteLimit: 3,
      orgPerMinuteLimit: 100,
      periodEnd: '2026-09-01T00:00:00.000Z',
    });
    const freshPoll = dispatchComposioWithPolling;
    mockExecute
      .mockResolvedValueOnce({ data: { job_id: 'job-1' }, error: null, successful: true })
      .mockResolvedValueOnce({ data: { state: 'running' }, error: null, successful: true })
      .mockResolvedValueOnce({ data: { state: 'running' }, error: null, successful: true })
      .mockResolvedValueOnce({ data: { state: 'running' }, error: null, successful: true });

    await expect(
      freshPoll({
        tenantId: 'tenant-rl', agentId: null, invocationId: null,
        connectorInstanceId: 'mfst-1', connectorType: 'google_mail',
        toolkitSlug: 'gmail', vendorToolName: 'GMAIL_FETCH_EMAILS',
        canonicalKey: 'gmail.list_messages',
        composioConnectedAccountId: 'ca_abc',
        args: {},
        translateError: baseTranslateError,
        polling: {
          statusToolStableName: 'list_messages',
          stateField: 'state',
          completeWhen: (s: unknown) => s === 'done',
          maxAttempts: 10,
          intervalMs: 1,
          jobIdField: 'job_id',
          statusToolJobIdField: 'id',
        },
      }),
    ).rejects.toThrow(/faster than its share of the platform's rate limit/);

    // Three attempts reached the vendor; the fourth never did.
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });
});
