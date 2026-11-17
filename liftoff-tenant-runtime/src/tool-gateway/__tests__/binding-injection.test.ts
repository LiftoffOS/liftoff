// Tool Gateway — per-binding config injection tests
//
// These verify resolveBinding-driven behaviour:
//   1. `bindingsByType` alias → connectorId UUID dispatch
//   2. Gmail list_messages injects `q` from binding.gmailQuery
//   3. Gmail send/reply/forward inject `from` from binding.sendAs
//   4. Throws when the agent calls a connector it is not bound to

const mockExecute = jest.fn();
const mockExecuteBatch = jest.fn();

jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({
    execute: mockExecute,
    executeBatch: mockExecuteBatch,
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
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
      data: { id: 'row-1' },
      fetchedAt: new Date(),
      versionToken: 'v1',
    }),
  },
  ExternalStateFetcherRegistry: jest.fn(),
}));

jest.mock('../permission-validator', () => ({
  permissionValidator: {
    validate: jest.fn().mockResolvedValue({ allowed: true, appliedEntry: null }),
  },
}));

jest.mock('../conflict-policy-registry', () => ({
  ConflictPolicyRegistry: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({
      connector: 'google_mail',
      entityType: 'message',
      actionType: 'send_email',
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

const GMAIL_UUID = '11111111-1111-1111-1111-111111111111';

const baseGmailInput = (
  overrides: Partial<ExecuteInput> & {
    bindingsByType?: ExecuteInput['bindingsByType'];
  },
): ExecuteInput => ({
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  instructionVersion: 1,
  traceId: 'trace-abc',
  idempotencyKey: 'idk',
  connector: 'google_mail',
  entityType: 'message',
  actionType: 'list_messages',
  payload: {},
  ...overrides,
});

describe('ToolGatewayService — bindingsByType resolution', () => {
  let svc: ToolGatewayService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ success: true, result: { messages: [] }, error: '' });
    mockExecuteBatch.mockResolvedValue({ results: [{ success: true, result: {}, error: '' }] });
    svc = new ToolGatewayService();
  });

  it('resolves alias "google_mail" to the binding UUID before dispatch', async () => {
    await svc.execute(
      baseGmailInput({
        bindingsByType: {
          google_mail: { connectorId: GMAIL_UUID, config: {} },
        },
      }),
    );

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0]).toMatchObject({ connectorId: GMAIL_UUID });
  });

  it('injects gmailQuery as q when agent omits it (list_messages)', async () => {
    await svc.execute(
      baseGmailInput({
        actionType: 'list_messages',
        payload: {},
        bindingsByType: {
          google_mail: {
            connectorId: GMAIL_UUID,
            config: { gmailQuery: 'label:support-agent' },
          },
        },
      }),
    );

    expect(mockExecute.mock.calls[0][0].input).toMatchObject({
      query: 'label:support-agent',
    });
  });

  it('ANDs user-supplied query with binding gmailQuery', async () => {
    await svc.execute(
      baseGmailInput({
        actionType: 'list_messages',
        payload: { query: 'is:unread' },
        bindingsByType: {
          google_mail: {
            connectorId: GMAIL_UUID,
            config: { gmailQuery: 'label:support-agent' },
          },
        },
      }),
    );

    expect(mockExecute.mock.calls[0][0].input).toMatchObject({
      query: '(is:unread) (label:support-agent)',
    });
  });

  it('injects sendAs as from when agent omits it (send_email)', async () => {
    await svc.execute(
      baseGmailInput({
        actionType: 'send_email',
        payload: { to: 'a@b.com', subject: 'hi', body: 'hello' },
        bindingsByType: {
          google_mail: {
            connectorId: GMAIL_UUID,
            config: { sendAs: 'support@example.com' },
          },
        },
      }),
    );

    expect(mockExecute.mock.calls[0][0].input).toMatchObject({
      from: 'support@example.com',
    });
  });

  it('does NOT overwrite an agent-supplied from on send_email', async () => {
    await svc.execute(
      baseGmailInput({
        actionType: 'send_email',
        payload: { from: 'agent@override.com', to: 'a@b.com', subject: 'hi', body: 'hi' },
        bindingsByType: {
          google_mail: {
            connectorId: GMAIL_UUID,
            config: { sendAs: 'support@example.com' },
          },
        },
      }),
    );

    expect(mockExecute.mock.calls[0][0].input).toMatchObject({
      from: 'agent@override.com',
    });
  });

  it('throws when the agent calls a connector it is not bound to', async () => {
    await expect(
      svc.execute(
        baseGmailInput({
          connector: 'slack',
          actionType: 'send_message',
          payload: { channel: '#x', text: 'hi' },
          bindingsByType: {
            google_mail: { connectorId: GMAIL_UUID, config: {} },
          },
        }),
      ),
    ).rejects.toThrow(/no binding for connector "slack"/);
  });

  it('falls back to legacy behavior when no bindingsByType is provided (UUID passthrough)', async () => {
    await svc.execute(
      baseGmailInput({
        connector: GMAIL_UUID,
        actionType: 'list_messages',
        payload: {},
      }),
    );

    expect(mockExecute.mock.calls[0][0]).toMatchObject({ connectorId: GMAIL_UUID });
  });
});

// ── Outlook (microsoft_outlook_mail) ──────────────────────────────────────

const OUTLOOK_UUID = '22222222-2222-2222-2222-222222222222';

const baseOutlookInput = (
  overrides: Partial<ExecuteInput> & {
    bindingsByType?: ExecuteInput['bindingsByType'];
  },
): ExecuteInput => ({
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  instructionVersion: 1,
  traceId: 'trace-outlook',
  idempotencyKey: 'idk-outlook',
  connector: 'microsoft_outlook_mail',
  entityType: 'message',
  actionType: 'list_messages',
  payload: {},
  ...overrides,
});

describe('ToolGatewayService — Outlook bindingsByType injection', () => {
  let svc: ToolGatewayService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ success: true, result: { messages: [] }, error: '' });
    mockExecuteBatch.mockResolvedValue({ results: [{ success: true, result: {}, error: '' }] });
    svc = new ToolGatewayService();
  });

  it('injects outlookFilter as $filter on list_messages when agent omits it', async () => {
    await svc.execute(
      baseOutlookInput({
        actionType: 'list_messages',
        payload: {},
        bindingsByType: {
          microsoft_outlook_mail: {
            connectorId: OUTLOOK_UUID,
            config: { outlookFilter: "from/emailAddress/address eq 'a@b.com'" },
          },
        },
      }),
    );

    expect(mockExecute.mock.calls[0][0].input).toMatchObject({
      filter: "from/emailAddress/address eq 'a@b.com'",
    });
  });

  it('ANDs user-supplied filter with binding outlookFilter', async () => {
    await svc.execute(
      baseOutlookInput({
        actionType: 'list_messages',
        payload: { filter: "isRead eq false" },
        bindingsByType: {
          microsoft_outlook_mail: {
            connectorId: OUTLOOK_UUID,
            config: { outlookFilter: "from/emailAddress/address eq 'a@b.com'" },
          },
        },
      }),
    );

    expect(mockExecute.mock.calls[0][0].input).toMatchObject({
      filter: "(isRead eq false) and (from/emailAddress/address eq 'a@b.com')",
    });
  });

  it.each(['send_email', 'reply_email', 'forward_email', 'create_draft', 'create_reply_draft'])(
    'injects sendAs as from on %s when agent omits it',
    async (actionType) => {
      await svc.execute(
        baseOutlookInput({
          actionType,
          payload: { to: 'a@b.com' },
          bindingsByType: {
            microsoft_outlook_mail: {
              connectorId: OUTLOOK_UUID,
              config: { sendAs: 'support@example.com' },
            },
          },
        }),
      );

      expect(mockExecute.mock.calls[0][0].input).toMatchObject({
        from: 'support@example.com',
      });
    },
  );

  it('does NOT overwrite an agent-supplied from on send_email', async () => {
    await svc.execute(
      baseOutlookInput({
        actionType: 'send_email',
        payload: { from: 'agent@override.com', to: 'a@b.com' },
        bindingsByType: {
          microsoft_outlook_mail: {
            connectorId: OUTLOOK_UUID,
            config: { sendAs: 'support@example.com' },
          },
        },
      }),
    );

    expect(mockExecute.mock.calls[0][0].input).toMatchObject({
      from: 'agent@override.com',
    });
  });
});
