// Every dispatched tool call must reach the ACTION ledger.
//
// This is the same defect as governance-audit-coverage.test.ts, in the same
// function. `execute()` already carries a comment explaining that
// `executeInner` has seventeen exit points and that putting the record at the
// bottom of the body leaves `governance_wal` empty. The fix moved the
// GOVERNANCE record into the wrapper — and left the ACTION ledger three hundred
// lines further down the same method, behind the identical set of early
// returns.
//
// With the record down there, `actions` gets rows from the connector path
// alone: agent_slack, agent_teams, custom_mcp_server, external and
// external-agent calls are never recorded. Moving agents off the connector's
// Slack write verbs onto the Liftoff app's `slack_*` tools moves the largest
// action class from the ledgered family to an unledgered one.
//
// These assert the PROPERTY — a call of any shape produces exactly one intent
// record — not the individual fixes. A new early return added later fails them.

const mockExecute = jest.fn();
const mockRecordIntent = jest.fn().mockResolvedValue('action-123');
const mockRecordOutcome = jest.fn().mockResolvedValue(undefined);
const mockRecordFailure = jest.fn().mockResolvedValue(undefined);

jest.mock('../../governance/wal', () => ({ writeWalEntry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../governance/governance-service-flag', () => ({
  getGovernanceServiceMode: () => 'off',
  isGovernanceServiceEnabled: () => false,
  isGovernanceShadowMode: () => false,
}));
jest.mock('../../governance/shadow-mode', () => ({
  withGovernanceShadowAndFallback: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../governance/governance-service-client', () => {
  const actual = jest.requireActual('../../governance/governance-service-client');
  return { ...actual, getGovernanceServiceClient: () => ({ record: jest.fn(), authorize: jest.fn() }) };
});

jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute, executeBatch: jest.fn() }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
    recordIntent: (...a: unknown[]) => mockRecordIntent(...a),
    recordOutcome: (...a: unknown[]) => mockRecordOutcome(...a),
    recordFailure: (...a: unknown[]) => mockRecordFailure(...a),
    recordPostActionSnapshot: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../state-fetcher', () => ({
  stateFetcherRegistry: { fetchState: jest.fn().mockResolvedValue({ data: {}, fetchedAt: new Date() }) },
  ExternalStateFetcherRegistry: jest.fn(),
}));

jest.mock('../permission-validator', () => ({
  permissionValidator: { validate: jest.fn().mockResolvedValue({ allowed: true, appliedEntry: null }) },
}));

jest.mock('../conflict-policy-registry', () => ({
  ConflictPolicyRegistry: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({
      connector: 'slack', entityType: 'message', actionType: 'send',
      freshnessTTL: null, freshReadBeforeWriteRequired: false, versionTokenField: null,
      fieldComparisonSet: [], conflictResolutionMode: 'last-write-wins',
      escalateOnConflict: false, undoSupportMode: 'none',
    }),
  })),
}));

// Each specialised handler returns without touching the main execution body —
// which is exactly why none of them were ever ledgered.
jest.mock('../agent-slack-handler', () => ({
  agentSlackHandler: { execute: jest.fn().mockResolvedValue({ success: true, data: { ok: true }, traceId: 't' }) },
}), { virtual: true });
jest.mock('../agent-teams-handler', () => ({
  agentTeamsHandler: { execute: jest.fn().mockResolvedValue({ success: true, data: { ok: true }, traceId: 't' }) },
}), { virtual: true });
jest.mock('../custom-mcp-server-handler', () => ({
  customMcpServerHandler: { execute: jest.fn().mockResolvedValue({ success: true, data: { ok: true }, traceId: 't' }) },
}), { virtual: true });
jest.mock('../external-agent-handler', () => ({
  externalAgentHandler: { execute: jest.fn().mockResolvedValue({ success: true, data: { ok: true }, traceId: 't' }) },
}), { virtual: true });

import { readFileSync } from 'fs';
import { join } from 'path';
import { ToolGatewayService, legacyGovernanceTargetRef } from '../service';
import type { ExecuteInput } from '../types';

const baseInput = (o: Partial<ExecuteInput>): ExecuteInput => ({
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  instructionVersion: 1,
  traceId: 'trace-abc',
  idempotencyKey: 'idk',
  connector: 'slack-d77db9a0',
  entityType: 'message',
  actionType: 'send_message',
  payload: { channel: 'C01ABCD2EFG', text: 'hi' },
  ...o,
});

describe('action ledger coverage — every family reaches the ledger', () => {
  let svc: ToolGatewayService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordIntent.mockResolvedValue('action-123');
    svc = new ToolGatewayService();
  });

  // Exactly once. The connector path records inside the body and stamps the
  // receipt; a backstop that ignored the receipt would double every row.
  it('records a connector call exactly once', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: { ok: true }, error: '' });

    await svc.execute(baseInput({ idempotencyKey: 'single-1' }));

    expect(mockRecordIntent).toHaveBeenCalledTimes(1);
  });

  // Unrecorded before the fix, and this is the path every agent Slack post
  // takes.
  it('records a per-agent Slack post — previously invisible to the ledger', async () => {
    await svc.execute(baseInput({
      idempotencyKey: 'slack-app-1',
      connector: 'agent_slack',
      entityType: 'agent_slack',
      actionType: 'slack_send_message',
      payload: { channel: 'C01ABCD2EFG', text: 'Review ready' },
    }));

    expect(mockRecordIntent).toHaveBeenCalledTimes(1);
    expect(mockRecordIntent.mock.calls[0][0]).toMatchObject({
      idempotencyKey: 'slack-app-1',
      targetRef: 'slack:C01ABCD2EFG',
    });
  });

  it('records a per-agent Teams post', async () => {
    await svc.execute(baseInput({
      idempotencyKey: 'teams-1',
      connector: 'agent_teams',
      entityType: 'agent_teams',
      actionType: 'teams_send_message',
      payload: { chat_id: '19:abc' },
    }));

    expect(mockRecordIntent).toHaveBeenCalledTimes(1);
  });

  it('records a custom MCP server call', async () => {
    await svc.execute(baseInput({
      idempotencyKey: 'mcp-1',
      connector: 'custom_mcp_server',
      entityType: 'server-uuid',
      actionType: 'create_record',
      payload: { record_id: 'r1' },
    }));

    expect(mockRecordIntent).toHaveBeenCalledTimes(1);
  });

  it('records an external-agent call', async () => {
    await svc.execute(baseInput({
      idempotencyKey: 'ext-1',
      connector: 'external-agent',
      entityType: 'agent-uuid',
      actionType: 'do_thing',
      payload: { id: 'x1' },
    }));

    expect(mockRecordIntent).toHaveBeenCalledTimes(1);
  });

  // The one deliberate exemption. Sandbox primitives have their own audit
  // table, fire hundreds of times per run, and their arguments name no external
  // entity — `{command: "gh pr review …"}` cannot be resolved to a target
  // without parsing a shell line. Recording them would flood the table with
  // rows that can never answer the question it exists to answer.
  it('does NOT record sandbox primitives', async () => {
    await expect(
      svc.execute(baseInput({
        idempotencyKey: 'sandbox-1',
        connector: 'execution_environment',
        entityType: 'sandbox',
        actionType: 'shell_exec',
        payload: { command: 'gh pr review 17 --approve' },
      })),
    ).rejects.toThrow();

    expect(mockRecordIntent).not.toHaveBeenCalled();
  });

  // A refusal is a thing that happened, and the wrapper is the only place that
  // sees the earliest exits — validateIdentity is the first statement in the
  // body, before any ledger write the connector path would do.
  it('records a call refused before any execution', async () => {
    await expect(
      svc.execute(baseInput({ idempotencyKey: 'refused-1', agentId: '' })),
    ).rejects.toThrow('Agent ID required');

    expect(mockRecordIntent).toHaveBeenCalledTimes(1);
    expect(mockRecordFailure).toHaveBeenCalledTimes(1);
  });

  // The ledger records what happened; it does not get to decide whether the
  // call succeeded. Throwing here would turn a Slack post that already landed
  // into a reported failure, and invite a retry that posts twice.
  it('does not fail the tool call when the ledger write fails', async () => {
    mockRecordIntent.mockRejectedValueOnce(new Error('actions table gone'));

    const r = await svc.execute(baseInput({
      idempotencyKey: 'resilient-1',
      connector: 'agent_slack',
      entityType: 'agent_slack',
      actionType: 'slack_send_message',
      payload: { channel: 'C1', text: 'hi' },
    }));

    expect(r.success).toBe(true);
  });
});

describe('action ledger coverage — the target is derived, not guessed', () => {
  let svc: ToolGatewayService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordIntent.mockResolvedValue('action-123');
    svc = new ToolGatewayService();
  });

  // The old rule was `payload?.id || payload?.targetRef || ''`, and a Slack
  // send is {channel, text} — so 333 rows a month recorded ''.
  it('keys a connector Slack send on its channel rather than an absent id', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: { ok: true }, error: '' });

    await svc.execute(baseInput({ idempotencyKey: 'derive-1' }));

    expect(mockRecordIntent.mock.calls[0][0]).toMatchObject({ targetRef: 'slack:C01ABCD2EFG' });
  });

  it('carries the version alongside the ref, not inside it', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: { ok: true }, error: '' });

    await svc.execute(baseInput({
      idempotencyKey: 'derive-2',
      connector: 'github-7d07a896',
      entityType: 'review',
      actionType: 'create_review',
      payload: { owner: 'acme', repo: 'billing', pull_number: 17, commit_id: 'a450b99' },
    }));

    expect(mockRecordIntent.mock.calls[0][0]).toMatchObject({
      targetRef: 'github:acme/billing#17',
      targetVersion: 'a450b99',
    });
  });

  // `actions.target_ref` is NOT NULL, so an underivable target has to store as
  // something. It stores as '' — never the string "null", which is what
  // String(payload?.id ?? …) put in the column when `id` was present and null.
  it('stores an empty target rather than the string "null"', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: { ok: true }, error: '' });

    await svc.execute(baseInput({
      idempotencyKey: 'derive-3',
      actionType: 'list_channels',
      payload: { id: null, limit: 50 },
    }));

    expect(mockRecordIntent.mock.calls[0][0].targetRef).toBe('');
  });
});

// The governance AUTHORIZE call is the one place the target ref is not a
// record. governance-engine gates its in-flight CONFLICT check on a truthy
// `req.targetRef`:
//
//   if (req.connector && req.entityType && req.actionType && req.targetRef)
//     → findInFlightConflicts(...) → decision = CONFLICT
//
// With GOVERNANCE_SERVICE_ENABLED `on`, that branch is live, and it is
// unreachable for almost every call only because the old expression yielded
// '' for nearly all actions. Sending the derived target would
// arm it estate-wide — and its semantics are wrong for a CREATE, which keys on
// its container: two different messages to #code-reviewer share one ref and
// would read as concurrent writes to the same entity.
// A static scan, in the idiom of sandbox-arg-integrity.source.test.ts: the
// authorize RPC sits behind withGovernanceShadowAndFallback, which the mocks
// above stub out, so an assertion on the mock's calls would pass vacuously
// whatever the call site says. The property is a property of the call site.
describe('governance authorize is not armed as a side effect', () => {
  const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
  const authorizeArgs = SERVICE.match(/const authorizeArgs = \{[\s\S]*?\n {8}\};/)?.[0] ?? '';

  it('has an authorizeArgs literal to check', () => {
    // Guards the two assertions below from silently passing on a rename.
    expect(authorizeArgs).toContain('targetRef:');
  });

  it('does not send the derived target to authorize', () => {
    expect(authorizeArgs).not.toMatch(/deriveTarget/);
    expect(authorizeArgs).toMatch(/targetRef:\s*legacyGovernanceTargetRef\(input\)/);
  });

  it('does not build the target with String(), which yields "null"', () => {
    // "null" is truthy, so those calls armed the gate against a target that
    // names nothing — and every one of them collided with every other.
    expect(authorizeArgs).not.toMatch(/targetRef:\s*String\(/);
  });
});

describe('legacyGovernanceTargetRef', () => {
  it('passes through a real scalar id, exactly as before', () => {
    expect(legacyGovernanceTargetRef({ payload: { id: 'account-123' } } as never)).toBe('account-123');
    expect(legacyGovernanceTargetRef({ payload: { id: 42 } } as never)).toBe('42');
    expect(legacyGovernanceTargetRef({ payload: { targetRef: 'ref-9' } } as never)).toBe('ref-9');
  });

  it('yields empty for anything that is not a scalar', () => {
    for (const id of [null, undefined, {}, [], NaN] as unknown[]) {
      expect(legacyGovernanceTargetRef({ payload: { id } } as never)).toBe('');
    }
    expect(legacyGovernanceTargetRef({ payload: undefined } as never)).toBe('');
  });
});
