// Unit tests for the Connect-RPC router handlers.
//
// Strategy: mount registerGovernanceService onto a stub ConnectRouter
// that captures the handler map, then call each handler directly with
// mocked services. Avoids spinning up the Express app + verifying the
// Connect wire protocol — that's covered by smoke.test.ts.
//
// Every external service (admission, HITL, action-ledger, usage-ledger,
// audit) is replaced via jest.mock so no real DB or Stripe IO happens.

import {
  AuthorizeDecision,
  ActionReadClass,
  type PreflightRequest,
  type AuthorizeRequest,
  type RecordRequest,
} from '@liftoffos/proto-gen/liftoff/governance/v1/governance_service_pb.js';
import { ActionStatus } from '@liftoffos/proto-gen/liftoff/governance/v1/types_pb.js';

// Mock dependencies BEFORE importing the module under test. Each mock
// exports a mutable jest.fn so tests can reconfigure behaviour.
const mockCheckAdmission = jest.fn().mockResolvedValue({ allowed: true });
const mockGetKillSwitchState = jest.fn().mockResolvedValue({
  global: false,
  tenant: false,
  agentIds: [],
  connectorTypes: [],
});
jest.mock('../admission/service', () => {
  return {
    AdmissionService: jest.fn().mockImplementation(() => ({
      checkAdmission: mockCheckAdmission,
      getKillSwitchState: mockGetKillSwitchState,
    })),
  };
});
jest.mock('../admission/service.js', () => {
  return {
    AdmissionService: jest.fn().mockImplementation(() => ({
      checkAdmission: mockCheckAdmission,
      getKillSwitchState: mockGetKillSwitchState,
    })),
  };
});

const mockResolveHitlLevel = jest.fn().mockResolvedValue(4);
const mockCreateApprovalRequest = jest.fn().mockResolvedValue({
  id: 'approval-new-1',
  status: 'pending',
});
const mockListPendingApprovals = jest.fn().mockResolvedValue({
  approvals: [],
  nextCursor: null,
});
jest.mock('../hitl-enforcement/service', () => ({
  hitlEnforcementService: {
    resolveHitlLevel: mockResolveHitlLevel,
    createApprovalRequest: mockCreateApprovalRequest,
    listPendingApprovals: mockListPendingApprovals,
    getOversightSettings: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('../hitl-enforcement/service.js', () => ({
  hitlEnforcementService: {
    resolveHitlLevel: mockResolveHitlLevel,
    createApprovalRequest: mockCreateApprovalRequest,
    listPendingApprovals: mockListPendingApprovals,
    getOversightSettings: jest.fn().mockResolvedValue(null),
  },
}));

const mockGetByIdempotencyKey = jest.fn().mockResolvedValue(null);
const mockRecordIntent = jest.fn().mockResolvedValue('action-id-new');
const mockRecordOutcome = jest.fn().mockResolvedValue(undefined);
const mockRecordFailure = jest.fn().mockResolvedValue(undefined);
const mockFindInFlightConflicts = jest.fn().mockResolvedValue(null);
jest.mock('../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({
    getByIdempotencyKey: mockGetByIdempotencyKey,
    recordIntent: mockRecordIntent,
    recordOutcome: mockRecordOutcome,
    recordFailure: mockRecordFailure,
    findInFlightConflicts: mockFindInFlightConflicts,
  })),
}));
jest.mock('../action-ledger/service.js', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({
    getByIdempotencyKey: mockGetByIdempotencyKey,
    recordIntent: mockRecordIntent,
    recordOutcome: mockRecordOutcome,
    recordFailure: mockRecordFailure,
    findInFlightConflicts: mockFindInFlightConflicts,
  })),
}));

const mockGetAllowlists = jest.fn().mockResolvedValue([]);
const mockAllowlistsMatches = jest.fn().mockResolvedValue(false);
jest.mock('../admission/allowlists-service', () => ({
  allowlistsService: {
    getAllowlists: mockGetAllowlists,
    matches: mockAllowlistsMatches,
  },
  AllowlistsService: jest.fn().mockImplementation(() => ({
    getAllowlists: mockGetAllowlists,
    matches: mockAllowlistsMatches,
  })),
}));
jest.mock('../admission/allowlists-service.js', () => ({
  allowlistsService: {
    getAllowlists: mockGetAllowlists,
    matches: mockAllowlistsMatches,
  },
  AllowlistsService: jest.fn().mockImplementation(() => ({
    getAllowlists: mockGetAllowlists,
    matches: mockAllowlistsMatches,
  })),
}));

const mockRecordUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({
    recordUsage: mockRecordUsage,
  })),
}));
jest.mock('../usage-ledger/service.js', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({
    recordUsage: mockRecordUsage,
  })),
}));

const mockInsertAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../audit/service', () => ({
  insertAuditLog: (...args: unknown[]) => mockInsertAuditLog(...args),
  sanitizeArgs: (x: unknown) => x,
}));
jest.mock('../audit/service.js', () => ({
  insertAuditLog: (...args: unknown[]) => mockInsertAuditLog(...args),
  sanitizeArgs: (x: unknown) => x,
}));

// Mock the pool used for idempotency lookups in Authorize.
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a) },
}));
jest.mock('../infrastructure/database.js', () => ({
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a) },
}));

jest.mock('../infrastructure/logging', () => {
  const silent = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  silent.child.mockReturnValue(silent);
  return {
    logger: silent,
    log: silent,
    withTraceContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getTraceContext: () => null,
    setTraceContext: () => undefined,
  };
});
jest.mock('../infrastructure/logging.js', () => {
  const silent = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  silent.child.mockReturnValue(silent);
  return {
    logger: silent,
    log: silent,
    withTraceContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getTraceContext: () => null,
    setTraceContext: () => undefined,
  };
});

// withSpan → pass-through so we don't touch OTel.
jest.mock('@liftoffos/telemetry', () => ({
  withSpan: jest.fn(
    (_svc: string, _name: string, _attrs: unknown, fn: () => unknown) => fn(),
  ),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child() {
      return this;
    },
  }),
  withTraceContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getTraceContext: () => null,
  setTraceContext: () => undefined,
}));

import registerGovernanceService from './router.js';
import { signPreflightToken } from '../auth/preflight-token.js';

// ──────────────────────────────────────────────────────────────────────
// ConnectRouter stub — captures the service method map so tests can
// invoke handlers directly. The real @connectrpc/connect runtime calls
// handlers with (request, HandlerContext), and our stub replicates just
// enough of that.
// ──────────────────────────────────────────────────────────────────────

type AnyHandler = (req: unknown, ctx: unknown) => Promise<unknown>;

function buildStubRouter() {
  const handlers: Record<string, AnyHandler> = {};
  const router = {
    service: (_service: unknown, impl: Record<string, AnyHandler>) => {
      Object.assign(handlers, impl);
      return router;
    },
  };
  registerGovernanceService(router as never);
  return handlers;
}

const SIGNING_KEY = 'test-preflight-signing-key';

describe('GovernanceEngine RPC handlers', () => {
  let handlers: Record<string, AnyHandler>;
  let origKey: string | undefined;

  beforeAll(() => {
    origKey = process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;
    process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = SIGNING_KEY;
  });

  afterAll(() => {
    if (origKey === undefined)
      delete process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;
    else process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = origKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetByIdempotencyKey.mockResolvedValue(null);
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockCheckAdmission.mockResolvedValue({ allowed: true });
    mockGetKillSwitchState.mockResolvedValue({
      global: false,
      tenant: false,
      agentIds: [],
      connectorTypes: [],
    });
    mockResolveHitlLevel.mockResolvedValue(4);
    mockCreateApprovalRequest.mockResolvedValue({
      id: 'approval-new-1',
      status: 'pending',
    });
    mockFindInFlightConflicts.mockResolvedValue(null);
    mockGetAllowlists.mockResolvedValue([]);
    mockAllowlistsMatches.mockResolvedValue(false);
    handlers = buildStubRouter();
  });

  // ── Preflight ──────────────────────────────────────────────────────

  describe('preflight', () => {
    it('returns ADMITTED + signed token + derived version', async () => {
      const req: PreflightRequest = {
        $typeName: 'liftoff.governance.v1.PreflightRequest',
        tenantContext: {
          $typeName: 'liftoff.event.v1.TenantContext',
          tenantId: 'tenant-1',
          traceId: '',
          correlationId: '',
        },
        agentId: 'agent-1',
        connectorTypes: [],
        capabilityTier: 'standard',
        executionEnvironment: 'managed',
      } as unknown as PreflightRequest;

      const res: any = await handlers.preflight(req, {} as never);

      expect(res.admissionStatus).toBe(1); // ADMITTED
      expect(res.preflightToken).toBeTruthy();
      expect(res.preflightToken).toContain('.');
      expect(res.version).not.toBe(0n);
      expect(res.killSwitchState.global).toBe(false);
    });

    it('returns BLOCKED when admission denies', async () => {
      mockCheckAdmission.mockResolvedValueOnce({
        allowed: false,
        reason: 'Tenant is suspended',
        quotaType: 'operational_status',
      });

      const req = {
        tenantContext: { tenantId: 'tenant-1' },
        agentId: 'agent-1',
        capabilityTier: '',
        executionEnvironment: '',
      } as unknown as PreflightRequest;

      const res: any = await handlers.preflight(req, {} as never);
      expect(res.admissionStatus).toBe(3); // BLOCKED
    });

    it('returns empty allowlists by default', async () => {
      const req = {
        tenantContext: { tenantId: 'tenant-1' },
        agentId: 'agent-1',
        capabilityTier: 'standard',
        executionEnvironment: 'managed',
      } as unknown as PreflightRequest;

      const res: any = await handlers.preflight(req, {} as never);
      expect(res.allowlists).toEqual([]);
    });

    it('maps action_allowlists rows into proto ActionAllowlist entries', async () => {
      mockGetAllowlists.mockResolvedValueOnce([
        {
          id: 'al-1',
          tenantId: 'tenant-1',
          connectorType: 'slack',
          entityType: 'message',
          actionType: 'post_message',
          pattern: { channel: '#eng-*' },
          createdAt: new Date(),
        },
        {
          id: 'al-2',
          tenantId: 'tenant-1',
          connectorType: 'github',
          entityType: 'Issue',
          actionType: 'comment',
          pattern: {},
          createdAt: new Date(),
        },
      ]);

      const req = {
        tenantContext: { tenantId: 'tenant-1' },
        agentId: 'agent-1',
        capabilityTier: 'standard',
        executionEnvironment: 'managed',
      } as unknown as PreflightRequest;

      const res: any = await handlers.preflight(req, {} as never);
      expect(res.allowlists).toHaveLength(2);
      expect(res.allowlists[0]).toMatchObject({
        connector: 'slack',
        entityType: 'message',
        actionType: 'post_message',
      });
      expect(res.allowlists[0].scopePattern).toContain('#eng-*');
      expect(res.allowlists[1]).toMatchObject({
        connector: 'github',
        entityType: 'Issue',
        actionType: 'comment',
        scopePattern: '',
      });
    });

    it('rejects missing tenant_context.tenant_id', async () => {
      const req = {
        tenantContext: { tenantId: '' },
      } as unknown as PreflightRequest;
      await expect(handlers.preflight(req, {} as never)).rejects.toThrow(
        /tenantContext.tenantId is required/,
      );
    });
  });

  // ── Authorize ──────────────────────────────────────────────────────

  describe('authorize', () => {
    function validToken(overrides: Record<string, unknown> = {}): string {
      return signPreflightToken({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        capabilityTier: 'standard',
        executionEnvironment: 'managed',
        hitlLevel: 4,
        admissionStatus: 'ADMITTED',
        preflightVersion: 'v1',
        ...overrides,
      });
    }

    it('ALLOWED when token valid + no idempotency conflict + HITL level 4', async () => {
      const req: AuthorizeRequest = {
        preflightToken: validToken(),
        idempotencyKey: 'idem-1',
        connector: 'salesforce',
        entityType: 'Account',
        actionType: 'update',
        targetRef: 'ref-1',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
    });

    // Risk-aware gate: opening a change for review is reversible and low-risk;
    // merging/landing is the consequential act. They must not gate identically.
    describe('risk-aware gate (SE policy)', () => {
      const vcReq = (actionType: string, hitlLevel: number, idem: string): AuthorizeRequest =>
        ({
          preflightToken: validToken({ hitlLevel }),
          idempotencyKey: idem,
          connector: 'gitlab-abc',
          entityType: 'merge_request',
          actionType,
          targetRef: '',
          payload: new Uint8Array(),
        }) as unknown as AuthorizeRequest;

      it('ALLOWED: create_merge_request proceeds at balanced (level 3)', async () => {
        const res: any = await handlers.authorize(vcReq('create_merge_request', 3, 'risk-1'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      });

      it('ALLOWED: a review comment (add_comment) proceeds at balanced (level 3)', async () => {
        const res: any = await handlers.authorize(vcReq('add_comment', 3, 'risk-2'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      });

      it('HITL_REQUIRED: create_merge_request still gates at controlled (level 2)', async () => {
        const res: any = await handlers.authorize(vcReq('create_merge_request', 2, 'risk-3'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('HITL_REQUIRED: merge_pull_request gates even at autonomous (level 4)', async () => {
        const res: any = await handlers.authorize(vcReq('merge_pull_request', 4, 'risk-4'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('HITL_REQUIRED: GitLab accept_merge_request gates even at autonomous (level 4)', async () => {
        const res: any = await handlers.authorize(vcReq('accept_merge_request', 4, 'risk-4b'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('HITL_REQUIRED: a non-low-risk write (send) still gates at balanced (level 3)', async () => {
        const res: any = await handlers.authorize(vcReq('send', 3, 'risk-5'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      // Read exemption + connector-scoped low-risk writes — on the native
      // connector dispatch path the level 1-3 gate must not apply to pure
      // reads.
      const connReq = (
        connector: string,
        actionType: string,
        hitlLevel: number,
        idem: string,
      ): AuthorizeRequest =>
        ({
          preflightToken: validToken({ hitlLevel }),
          idempotencyKey: idem,
          connector,
          entityType: 'Message',
          actionType,
          targetRef: '',
          payload: new Uint8Array(),
        }) as unknown as AuthorizeRequest;

      it('ALLOWED: a read (list_channels) proceeds at balanced (level 3)', async () => {
        const res: any = await handlers.authorize(connReq('slack-d77db9a0', 'list_channels', 3, 'risk-6'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      });

      it('ALLOWED: a read proceeds at controlled (level 2)', async () => {
        const res: any = await handlers.authorize(connReq('slack-d77db9a0', 'list_channels', 2, 'risk-7'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      });

      it('HITL_REQUIRED: a read still gates at review-everything (level 1)', async () => {
        const res: any = await handlers.authorize(connReq('slack-d77db9a0', 'list_channels', 1, 'risk-8'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('ALLOWED: slack send_message (scoped internal-collaboration write) proceeds at balanced', async () => {
        const res: any = await handlers.authorize(connReq('slack-d77db9a0', 'send_message', 3, 'risk-9'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      });

      it('HITL_REQUIRED: slack send_message still gates at controlled (level 2)', async () => {
        const res: any = await handlers.authorize(connReq('slack-d77db9a0', 'send_message', 2, 'risk-10'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('HITL_REQUIRED: outlook send_message (EMAIL, scope miss) still gates at balanced', async () => {
        const res: any = await handlers.authorize(connReq('microsoft_outlook_mail-12ab34cd', 'send_message', 3, 'risk-11'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('ALLOWED: teams send_message (scoped) proceeds at balanced', async () => {
        const res: any = await handlers.authorize(connReq('microsoft_teams-12ab34cd', 'send_message', 3, 'risk-12'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      });
    });

    // A caller-supplied, provenance-aware read classification overrides the
    // action-NAME heuristic — but only when DECLARED, and never for the
    // consequential/allowlist checks. This is the fix for reviewed reads whose
    // name the heuristic does not recognise (pdl `enrich_company`, hunter
    // `email_finder`), which the name path gates though the connector declares
    // them reads.
    describe('action_read_class (provenance-aware classification)', () => {
      const clsReq = (
        actionType: string,
        hitlLevel: number,
        actionReadClass: ActionReadClass,
        idem: string,
      ): AuthorizeRequest =>
        ({
          preflightToken: validToken({ hitlLevel }),
          idempotencyKey: idem,
          connector: 'pdl',
          entityType: 'People',
          actionType,
          targetRef: '',
          payload: new Uint8Array(),
          actionReadClass,
        }) as unknown as AuthorizeRequest;

      it('ALLOWED: DECLARED_READ passes at balanced even though the name (enrich_company) is not a read verb', async () => {
        const res: any = await handlers.authorize(
          clsReq('enrich_company', 3, ActionReadClass.DECLARED_READ, 'cls-1'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      });

      it('HITL_REQUIRED: the same name (enrich_company) with NO classification falls back to the name heuristic and gates', async () => {
        const res: any = await handlers.authorize(
          clsReq('enrich_company', 3, ActionReadClass.UNSPECIFIED, 'cls-2'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('HITL_REQUIRED: DECLARED_NON_READ gates at balanced even when the name reads as a read (get_secret)', async () => {
        const res: any = await handlers.authorize(
          clsReq('get_secret', 3, ActionReadClass.DECLARED_NON_READ, 'cls-3'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('ALLOWED: an unclassified read-verb name (search_people) still passes via the name heuristic', async () => {
        const res: any = await handlers.authorize(
          clsReq('search_people', 3, ActionReadClass.UNSPECIFIED, 'cls-4'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      });

      it('HITL_REQUIRED: DECLARED_READ still gates at review-everything (level 1)', async () => {
        const res: any = await handlers.authorize(
          clsReq('enrich_company', 1, ActionReadClass.DECLARED_READ, 'cls-5'), {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });

      it('HITL_REQUIRED: a DECLARED_READ classification never overrides a consequential action (merge_pull_request)', async () => {
        const res: any = await handlers.authorize(
          ({
            preflightToken: validToken({ hitlLevel: 4 }),
            idempotencyKey: 'cls-6',
            connector: 'github-abc',
            entityType: 'pull_request',
            actionType: 'merge_pull_request',
            targetRef: '',
            payload: new Uint8Array(),
            actionReadClass: ActionReadClass.DECLARED_READ,
          }) as unknown as AuthorizeRequest, {} as never);
        expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      });
    });

    it('BLOCKED when preflight token is missing', async () => {
      const req = {
        preflightToken: '',
        idempotencyKey: 'idem-2',
        connector: 'x',
        entityType: 'y',
        actionType: 'z',
        targetRef: '',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.BLOCKED);
    });

    it('BLOCKED when preflight token is expired', async () => {
      const now = Date.now();
      const expired = signPreflightToken({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        capabilityTier: 'standard',
        executionEnvironment: 'managed',
        hitlLevel: 4,
        admissionStatus: 'ADMITTED',
        preflightVersion: 'v1',
        issuedAt: now - 60_000,
        expiresAt: now - 30_000,
      });
      const req = {
        preflightToken: expired,
        idempotencyKey: 'idem-exp',
        connector: 'c',
        entityType: 'e',
        actionType: 'a',
        targetRef: '',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.BLOCKED);
    });

    it('BLOCKED when token says admission BLOCKED', async () => {
      const req = {
        preflightToken: validToken({ admissionStatus: 'BLOCKED' }),
        idempotencyKey: 'idem-blocked',
        connector: 'c',
        entityType: 'e',
        actionType: 'a',
        targetRef: '',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.BLOCKED);
    });

    it('idempotent replay: returns ALLOWED when prior completed action exists', async () => {
      mockGetByIdempotencyKey.mockResolvedValueOnce({
        id: 'existing-action',
        status: 'completed',
      });

      const req = {
        preflightToken: validToken(),
        idempotencyKey: 'idem-replay',
        connector: 'c',
        entityType: 'e',
        actionType: 'a',
        targetRef: '',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      expect(mockGetByIdempotencyKey).toHaveBeenCalledWith('idem-replay');
    });

    it('idempotent replay: returns BLOCKED when prior action failed', async () => {
      mockGetByIdempotencyKey.mockResolvedValueOnce({
        id: 'failed-action',
        status: 'failed',
      });

      const req = {
        preflightToken: validToken(),
        idempotencyKey: 'idem-fail',
        connector: 'c',
        entityType: 'e',
        actionType: 'a',
        targetRef: '',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.BLOCKED);
    });

    it('HITL_REQUIRED with existing pending approval at hitlLevel 2', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'approval-pending-99', status: 'pending' }],
        rowCount: 1,
      });

      const req = {
        preflightToken: validToken({ hitlLevel: 2 }),
        idempotencyKey: 'idem-hitl',
        connector: 'c',
        entityType: 'e',
        actionType: 'a',
        targetRef: '',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      expect(res.approvalRequestId).toBe('approval-pending-99');
    });

    it('HITL_REQUIRED: creates new approval when none exists at hitlLevel 1', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const req = {
        preflightToken: validToken({ hitlLevel: 1 }),
        idempotencyKey: 'idem-fresh-hitl',
        connector: 'slack',
        entityType: 'message',
        actionType: 'send',
        targetRef: '#channel',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.HITL_REQUIRED);
      expect(res.approvalRequestId).toBe('approval-new-1');
      expect(mockCreateApprovalRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          hitlLevel: 1,
          idempotencyKey: 'idem-fresh-hitl',
        }),
      );
    });

    it('CONFLICT when an in-flight action targets the same (connector, entity, action, target_ref)', async () => {
      mockFindInFlightConflicts.mockResolvedValueOnce({
        id: 'action-in-flight-42',
        idempotencyKey: 'other-idem',
        status: 'pending',
        createdAt: new Date(),
      });

      const req = {
        preflightToken: validToken({ hitlLevel: 4 }),
        idempotencyKey: 'idem-conflict',
        connector: 'github',
        entityType: 'Issue',
        actionType: 'create',
        targetRef: 'repo/acme/1',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.CONFLICT);
      expect(res.conflict?.conflictingActionId).toBe('action-in-flight-42');
      expect(mockFindInFlightConflicts).toHaveBeenCalledWith(
        'tenant-1',
        'github',
        'Issue',
        'repo/acme/1',
        'create',
      );
    });

    it('no conflict → proceeds to ALLOWED path at hitlLevel 4', async () => {
      mockFindInFlightConflicts.mockResolvedValueOnce(null);

      const req = {
        preflightToken: validToken({ hitlLevel: 4 }),
        idempotencyKey: 'idem-noconflict',
        connector: 'github',
        entityType: 'Issue',
        actionType: 'create',
        targetRef: 'repo/acme/2',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      expect(mockFindInFlightConflicts).toHaveBeenCalled();
    });

    it('allowlist match short-circuits HITL at hitlLevel 1', async () => {
      mockAllowlistsMatches.mockResolvedValueOnce(true);

      const req = {
        preflightToken: validToken({ hitlLevel: 1 }),
        idempotencyKey: 'idem-allowed',
        connector: 'slack',
        entityType: 'message',
        actionType: 'post_message',
        targetRef: '#eng',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
      expect(mockAllowlistsMatches).toHaveBeenCalledWith(
        'tenant-1',
        'slack',
        'message',
        'post_message',
      );
      // Allowlist short-circuit means we never created an approval row.
      expect(mockCreateApprovalRequest).not.toHaveBeenCalled();
    });

    it('ALLOWED when prior approval is already APPROVED at hitlLevel 2', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'approval-ok', status: 'approved' }],
        rowCount: 1,
      });

      const req = {
        preflightToken: validToken({ hitlLevel: 2 }),
        idempotencyKey: 'idem-approved',
        connector: 'c',
        entityType: 'e',
        actionType: 'a',
        targetRef: '',
        payload: new Uint8Array(),
      } as unknown as AuthorizeRequest;

      const res: any = await handlers.authorize(req, {} as never);
      expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
    });
  });

  // ── Record ─────────────────────────────────────────────────────────

  describe('record', () => {
    function validToken(): string {
      return signPreflightToken({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        capabilityTier: 'standard',
        executionEnvironment: 'managed',
        hitlLevel: 4,
        admissionStatus: 'ADMITTED',
        preflightVersion: 'v1',
      });
    }

    it('returns accepted:true synchronously', async () => {
      const req = {
        preflightToken: validToken(),
        idempotencyKey: 'idem-rec-1',
        connector: 'salesforce',
        entityType: 'Account',
        actionType: 'update',
        targetRef: 'acc-1',
        traceId: 'trace-1',
        durationMs: 42n,
        status: ActionStatus.COMPLETED,
        error: '',
        costUsd: 0.01,
        externalResponse: new Uint8Array(),
      } as unknown as RecordRequest;

      const res: any = await handlers.record(req, {} as never);
      expect(res.accepted).toBe(true);
    });

    it('fires all three ledger writes on success', async () => {
      const req = {
        preflightToken: validToken(),
        idempotencyKey: 'idem-rec-ok',
        connector: 'salesforce',
        entityType: 'Account',
        actionType: 'update',
        targetRef: 'acc-1',
        traceId: 'trace-1',
        durationMs: 5n,
        status: ActionStatus.COMPLETED,
        error: '',
        costUsd: 0.02,
        externalResponse: new Uint8Array(),
      } as unknown as RecordRequest;

      await handlers.record(req, {} as never);
      // Give the fire-and-forget background work a microtask tick to land.
      // Flush the fire-and-forget microtask chain: recordIntent →
      // recordOutcome/recordFailure then Promise.allSettled bookkeeping.
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(mockRecordIntent).toHaveBeenCalledTimes(1);
      expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
      expect(mockRecordUsage).toHaveBeenCalledTimes(1);
      expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    });

    it('marks action failed and calls recordFailure when status=FAILED', async () => {
      const req = {
        preflightToken: validToken(),
        idempotencyKey: 'idem-rec-fail',
        connector: 'x',
        entityType: 'y',
        actionType: 'z',
        targetRef: '',
        traceId: '',
        durationMs: 1n,
        status: ActionStatus.FAILED,
        error: 'boom',
        costUsd: 0,
        externalResponse: new Uint8Array(),
      } as unknown as RecordRequest;

      await handlers.record(req, {} as never);
      // Flush the fire-and-forget microtask chain: recordIntent →
      // recordOutcome/recordFailure then Promise.allSettled bookkeeping.
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(mockRecordFailure).toHaveBeenCalledTimes(1);
      expect(mockRecordOutcome).not.toHaveBeenCalled();
      // Audit leg still fires with outcome=error.
      expect(mockInsertAuditLog).toHaveBeenCalledWith(
        null,
        'tenant-1',
        expect.objectContaining({ outcome: 'error' }),
      );
    });

    it('accepts + skips ledger writes when token invalid (WAL is source of truth)', async () => {
      const req = {
        preflightToken: 'bogus',
        idempotencyKey: 'idem-bad-tok',
        connector: 'x',
        entityType: 'y',
        actionType: 'z',
        targetRef: '',
        traceId: '',
        durationMs: 0n,
        status: ActionStatus.COMPLETED,
        error: '',
        costUsd: 0,
        externalResponse: new Uint8Array(),
      } as unknown as RecordRequest;

      const res: any = await handlers.record(req, {} as never);
      expect(res.accepted).toBe(true);
      // Flush the fire-and-forget microtask chain: recordIntent →
      // recordOutcome/recordFailure then Promise.allSettled bookkeeping.
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(mockRecordIntent).not.toHaveBeenCalled();
      expect(mockRecordUsage).not.toHaveBeenCalled();
      expect(mockInsertAuditLog).not.toHaveBeenCalled();
    });

    it('tolerates a single ledger leg failing via Promise.allSettled', async () => {
      mockRecordIntent.mockRejectedValueOnce(new Error('action ledger down'));

      const req = {
        preflightToken: validToken(),
        idempotencyKey: 'idem-partial',
        connector: 'c',
        entityType: 'e',
        actionType: 'a',
        targetRef: '',
        traceId: '',
        durationMs: 0n,
        status: ActionStatus.COMPLETED,
        error: '',
        costUsd: 0,
        externalResponse: new Uint8Array(),
      } as unknown as RecordRequest;

      const res: any = await handlers.record(req, {} as never);
      expect(res.accepted).toBe(true);
      // Flush the fire-and-forget microtask chain: recordIntent →
      // recordOutcome/recordFailure then Promise.allSettled bookkeeping.
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(mockRecordUsage).toHaveBeenCalledTimes(1);
      expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    });
  });
});
