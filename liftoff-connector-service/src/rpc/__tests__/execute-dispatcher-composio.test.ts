// Composio dispatch branch tests.
//
// Regression for the silent failure of every composio_managed tool call:
// the catalog cutover stamped functions with definitionSource='composio'
// but execute-dispatcher still routed them through the native REST
// executor, which switches on entityType. Composio overlays don't carry
// entityType (the vendor tool name + Composio dispatch IS the contract),
// so the native client fell into "Unsupported entity type: <stable name>"
// on every Gmail/Outlook/etc. call.

const mockGetCredentials = jest.fn();
const mockGetConnectorConfig = jest.fn();
const mockComposioToolsExecute = jest.fn();

jest.mock('../../credentials/service.js', () => ({
  credentialService: {
    getCredentials: (...a: unknown[]) => mockGetCredentials(...a),
    getConnectorConfig: (...a: unknown[]) => mockGetConnectorConfig(...a),
  },
  OAuthRefreshError: class OAuthRefreshError extends Error {},
}));

jest.mock('../../oauth/composio-client.js', () => ({
  getComposio: () => ({ tools: { execute: (...a: unknown[]) => mockComposioToolsExecute(...a) } }),
}));

jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runConnectorExecution } from '../execute-dispatcher.js';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCredentials.mockResolvedValue({ flowKind: 'static_oauth', accessToken: 'ignored' });
});

describe('runConnectorExecution — Composio dispatch branch', () => {
  it('routes a composio_managed Gmail tool call through composio.tools.execute and returns the translated result', async () => {
    mockGetConnectorConfig.mockResolvedValueOnce({
      connectorType: 'google_mail',
      config: { composioConnectedAccountId: 'ca_TEST_acct' },
    });
    // GMAIL_MODIFY_THREAD_LABELS responds with the modified thread; the
    // overlay's translateOutput projects it down to { id, labelIds }.
    mockComposioToolsExecute.mockResolvedValueOnce({
      successful: true,
      data: {
        id: 'threadA',
        threadId: 'threadA',
        messages: [{ id: 'msgA', labelIds: ['INBOX'] }],
      },
    });

    const res = await runConnectorExecution({
      tenantId: 'tenant-1',
      connectorId: 'conn-uuid',
      functionName: 'mark_as_read',
      input: { threadId: 'threadA' },
      idempotencyKey: 'idem-1',
      traceId: 'trace-1',
    });

    expect(res.success).toBe(true);
    // Composio SDK called with the vendor tool name + userId == tenantId.
    expect(mockComposioToolsExecute).toHaveBeenCalledWith(
      'GMAIL_MODIFY_THREAD_LABELS',
      expect.objectContaining({
        userId: 'tenant-1',
        connectedAccountId: 'ca_TEST_acct',
        arguments: expect.objectContaining({
          user_id: 'me',
          thread_id: 'threadA',
          add_label_ids: [],
          remove_label_ids: ['UNREAD'],
        }),
      }),
    );
    // Output passes through the overlay translator (id + labelIds, NOT the raw
    // Composio response shape).
    expect(res.result).toEqual({ id: 'threadA', labelIds: ['INBOX'] });
  });

  it('returns success=false with the translated error when Composio reports successful=false', async () => {
    mockGetConnectorConfig.mockResolvedValueOnce({
      connectorType: 'google_mail',
      config: { composioConnectedAccountId: 'ca_TEST_acct' },
    });
    mockComposioToolsExecute.mockResolvedValueOnce({
      successful: false,
      error: 'thread not found',
    });

    const res = await runConnectorExecution({
      tenantId: 'tenant-1',
      connectorId: 'conn-uuid',
      functionName: 'mark_as_read',
      input: { threadId: 'thread-missing' },
      idempotencyKey: 'idem-2',
      traceId: 'trace-2',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('thread not found');
  });

  it('returns a clear missing_connection error when composioConnectedAccountId is empty', async () => {
    mockGetConnectorConfig.mockResolvedValueOnce({
      connectorType: 'google_mail',
      config: {}, // no composioConnectedAccountId
    });

    const res = await runConnectorExecution({
      tenantId: 'tenant-1',
      connectorId: 'conn-uuid',
      functionName: 'mark_as_read',
      input: { threadId: 'threadA' },
      idempotencyKey: 'idem-3',
      traceId: 'trace-3',
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/composio_dispatch_missing_connection/);
    expect(mockComposioToolsExecute).not.toHaveBeenCalled();
  });

  it('falls through to native dispatch for non-composio-sourced functions on a composio_managed connector', async () => {
    // We expect the native path to throw because no executor is registered
    // in this test fixture for 'google_mail'. The point is to assert that
    // tryComposioDispatch returned null (didn't intercept) and the existing
    // executor-lookup branch took over.
    mockGetConnectorConfig.mockResolvedValueOnce({
      connectorType: 'google_mail',
      config: { composioConnectedAccountId: 'ca_TEST_acct' },
    });

    await expect(
      runConnectorExecution({
        tenantId: 'tenant-1',
        connectorId: 'conn-uuid',
        functionName: 'definitely_not_a_real_function',
        input: {},
        idempotencyKey: 'idem-4',
        traceId: 'trace-4',
      }),
    ).rejects.toThrow(/no executor registered for connector type "google_mail"/);
    expect(mockComposioToolsExecute).not.toHaveBeenCalled();
  });

  it('returns a transport-error response when the Composio SDK throws', async () => {
    mockGetConnectorConfig.mockResolvedValueOnce({
      connectorType: 'google_mail',
      config: { composioConnectedAccountId: 'ca_TEST_acct' },
    });
    mockComposioToolsExecute.mockRejectedValueOnce(new Error('network down'));

    const res = await runConnectorExecution({
      tenantId: 'tenant-1',
      connectorId: 'conn-uuid',
      functionName: 'mark_as_read',
      input: { threadId: 'threadA' },
      idempotencyKey: 'idem-5',
      traceId: 'trace-5',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/composio_transport_error/);
    expect(res.error).toMatch(/network down/);
  });
});
