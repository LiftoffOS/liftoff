// Connect-RPC server implementation for GovernanceEngine.
//
// Handlers are registered against the proto-defined service descriptor
// from @liftoffos/proto-gen. Every request is typed, every response is
// a proto message built via create() so the $typeName + defaults are
// populated by protobuf-es.
//
// Surface (see liftoff/governance/v1/governance_service.proto):
//   Preflight     — invocation-start policy fetch (admission, HITL level,
//                   kill-switch snapshot, allowlists, preflight token)
//   Authorize     — per-tool-call authorization (HITL gating, conflict
//                   detection, idempotency). p99 < 5ms target.
//   Record        — fire-and-forget post-execution ledger write
//   ListApprovals — HITL dashboard pending-approvals query
//
// Auth: handled by verifyServiceAuth middleware mounted on the Express
// app before expressConnectMiddleware.

import { trace } from '@opentelemetry/api';
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { withSpan } from '@liftoffos/telemetry';
import { GovernanceService } from '@liftoffos/proto-gen';
import {
  PreflightResponseSchema,
  AuthorizeResponseSchema,
  RecordResponseSchema,
  ListApprovalsResponseSchema,
  AuthorizeDecision,
  ActionReadClass,
  ConflictSchema,
  Conflict_Resolution,
  type PreflightRequest,
  type PreflightResponse,
  type AuthorizeRequest,
  type AuthorizeResponse,
  type RecordRequest,
  type RecordResponse,
  type ListApprovalsRequest,
  type ListApprovalsResponse,
} from '@liftoffos/proto-gen/liftoff/governance/v1/governance_service_pb.js';
import {
  KillSwitchStateSchema,
  HitlApprovalRequestSchema,
  ActionAllowlistSchema,
  AdmissionStatus,
  AdmissionReason,
  HitlLevel,
  ApprovalStatus,
  ApprovalDecision,
  ActionStatus,
} from '@liftoffos/proto-gen/liftoff/governance/v1/types_pb.js';

import { AdmissionService } from '../admission/service.js';
import { allowlistsService } from '../admission/allowlists-service.js';
import { hitlEnforcementService } from '../hitl-enforcement/service.js';
import {
  toolActionMatchesNameSet,
  MERGE_TO_MAIN_TOOL_NAMES,
  LOW_RISK_REVERSIBLE_WRITES,
  LOW_RISK_REVERSIBLE_WRITES_SCOPED,
  isReadOnlyActionName,
  scopedActionMatchesNameSet,
  SUPER_DESTRUCTIVE_OPERATIONS,
} from '../hitl-enforcement/risk-classes.js';
import { ActionLedgerService } from '../action-ledger/service.js';
import { UsageLedgerService } from '../usage-ledger/service.js';
import { insertAuditLog } from '../audit/service.js';
import {
  signPreflightToken,
  verifyPreflightToken,
  deriveVersionTag,
  type PreflightClaims,
} from '../auth/preflight-token.js';
import { logger } from '../infrastructure/logging.js';

const SERVICE_NAME = 'liftoff-governance-engine';

// Shared service instances — created once at module load.
const admissionService = new AdmissionService();
const actionLedgerService = new ActionLedgerService();
const usageLedgerService = new UsageLedgerService();

function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(SERVICE_NAME, name, undefined, async () => fn());
}

function requireTenantId(
  req: { tenantContext?: { tenantId: string } },
  method: string,
): string {
  const tid = req.tenantContext?.tenantId;
  if (!tid || typeof tid !== 'string' || tid.length === 0) {
    throw new ConnectError(
      `${method}: tenantContext.tenantId is required`,
      Code.InvalidArgument,
    );
  }
  return tid;
}

// Map the numeric HITL level the service returns into the proto enum.
function hitlLevelToProto(n: number): HitlLevel {
  switch (n) {
    case 1:
      return HitlLevel.HITL_LEVEL_1;
    case 2:
      return HitlLevel.HITL_LEVEL_2;
    case 3:
      return HitlLevel.HITL_LEVEL_3;
    case 4:
      return HitlLevel.HITL_LEVEL_4;
    case 5:
      return HitlLevel.HITL_LEVEL_5;
    default:
      return HitlLevel.HITL_LEVEL_UNSPECIFIED;
  }
}

// Map the service's AdmissionResult.quotaType string into the proto
// AdmissionReason enum. Strings must match the values produced by
// AdmissionService (see src/admission/service.ts).
function reasonToProto(quotaType: string | undefined): AdmissionReason {
  switch (quotaType) {
    case 'credits':
      return AdmissionReason.CREDITS_EXHAUSTED;
    case 'operational_status':
    case 'agent_execution':
    case 'agent_lifecycle':
      return AdmissionReason.KILL_SWITCH_TENANT;
    case 'global_freeze':
      return AdmissionReason.KILL_SWITCH_GLOBAL;
    case 'connector_kill_switch':
      return AdmissionReason.KILL_SWITCH_CONNECTOR;
    case 'workflow_kill_switch':
      return AdmissionReason.KILL_SWITCH_TRIGGERED;
    default:
      return AdmissionReason.UNSPECIFIED;
  }
}

function approvalStatusToProto(s: string): ApprovalStatus {
  switch (s) {
    case 'pending':
      return ApprovalStatus.PENDING;
    case 'approved':
      return ApprovalStatus.APPROVED;
    case 'rejected':
      return ApprovalStatus.REJECTED;
    case 'expired':
      return ApprovalStatus.EXPIRED;
    default:
      return ApprovalStatus.UNSPECIFIED;
  }
}

function approvalDecisionToProto(
  d: 'approved' | 'rejected' | null | undefined,
): ApprovalDecision {
  if (d === 'approved') return ApprovalDecision.APPROVED;
  if (d === 'rejected') return ApprovalDecision.REJECTED;
  return ApprovalDecision.UNSPECIFIED;
}

function admissionStatusEnumToString(
  s: AdmissionStatus,
): PreflightClaims['admissionStatus'] {
  switch (s) {
    case AdmissionStatus.ADMITTED:
      return 'ADMITTED';
    case AdmissionStatus.THROTTLED:
      return 'THROTTLED';
    case AdmissionStatus.BLOCKED:
      return 'BLOCKED';
    default:
      return 'UNSPECIFIED';
  }
}

// Build a blocked AuthorizeResponse with a given reason.
function blocked(reason: AdmissionReason): AuthorizeResponse {
  return create(AuthorizeResponseSchema, {
    decision: AuthorizeDecision.BLOCKED,
    approvalRequestId: '',
    blockedReason: reason,
  });
}

export default function registerGovernanceService(router: ConnectRouter): ConnectRouter {
  return router.service(GovernanceService, {
    // ── Preflight ─────────────────────────────────────────────────────
    // Invocation-start policy fetch. Combines:
    //   - admission (operational status / agent lifecycle / kill switches / credits)
    //   - HITL level resolution from the tenant's oversight settings
    //   - kill-switch snapshot for the tenant
    //   - signed preflight token bound to this invocation (30s TTL)
    //
    // Allowlists remain an empty list — there is no allowlists module
    // ported yet (see TODO comment below).
    async preflight(
      req: PreflightRequest,
      _ctx: HandlerContext,
    ): Promise<PreflightResponse> {
      const tenantId = requireTenantId(req, 'Preflight');
      return traced('Preflight', async () => {
        const [admission, hitlLevel, killSwitch, allowlistRows] =
          await Promise.all([
            admissionService.checkAdmission({
              tenantId,
              agentId: req.agentId || undefined,
              checkType: 'workflow',
            }),
            hitlEnforcementService.resolveHitlLevel(tenantId),
            admissionService.getKillSwitchState(tenantId),
            allowlistsService.getAllowlists(tenantId).catch((err) => {
              logger.warn(
                { err: (err as Error).message, tenantId },
                'Preflight: allowlists lookup failed — returning empty list',
              );
              return [] as Awaited<
                ReturnType<typeof allowlistsService.getAllowlists>
              >;
            }),
          ]);

        // Fetch oversight settings for OTel span attributes (non-blocking on failure)
        const oversight = await hitlEnforcementService.getOversightSettings(tenantId).catch(
          () => null,
        );

        // Attach governance attributes to the active OTel span for Cloud Trace → BigQuery analysis
        const span = trace.getActiveSpan();
        if (span) {
          span.setAttributes({
            'governance.hitl_level': hitlLevel,
            'governance.autonomy': oversight?.autonomy ?? 'unknown',
            'governance.escalation': oversight?.escalation ?? 'unknown',
            'governance.tenant_id': tenantId,
          });
        }

        const admissionStatusEnum = admission.allowed
          ? AdmissionStatus.ADMITTED
          : AdmissionStatus.BLOCKED;

        // Build the claim set first so we can fingerprint it for the
        // version tag + sign it into the preflight token.
        const claimsCore: Omit<
          PreflightClaims,
          'issuedAt' | 'expiresAt'
        > = {
          tenantId,
          agentId: req.agentId || '',
          invocationId: undefined,
          capabilityTier: req.capabilityTier || '',
          executionEnvironment: req.executionEnvironment || '',
          hitlLevel,
          admissionStatus: admissionStatusEnumToString(admissionStatusEnum),
          preflightVersion: '', // filled below
        };
        // Derive a short monotonic-ish version string from the content.
        // Clients compare this to detect kill-switch/HITL-level changes
        // mid-cache-TTL — if the bytes change, refresh preflight.
        const versionTag = deriveVersionTag(
          JSON.stringify({
            claimsCore,
            killSwitch,
            admissionReason: admission.quotaType ?? '',
          }),
        );
        const claims: Omit<PreflightClaims, 'issuedAt' | 'expiresAt'> = {
          ...claimsCore,
          preflightVersion: versionTag,
        };

        let preflightToken = '';
        try {
          preflightToken = signPreflightToken(claims);
        } catch (err) {
          // Fail-closed: if we can't sign a token, clients can still
          // see admission/HITL state but every subsequent Authorize
          // will reject "preflight-token-invalid". Log loudly.
          logger.error(
            { err: (err as Error).message, tenantId },
            'Preflight token signing failed — returning unsigned response',
          );
        }

        // int64 on PreflightResponse.version — we encode 15 hex chars of
        // the fingerprint as a 60-bit integer so it always fits in a
        // signed i64 without overflowing. `0n` means "failed to
        // compute" — callers should always prefer the string version on
        // the preflight token payload.
        let versionBig = 0n;
        try {
          versionBig = BigInt('0x' + versionTag.slice(0, 15));
        } catch {
          versionBig = 0n;
        }

        return create(PreflightResponseSchema, {
          admissionStatus: admissionStatusEnum,
          admissionReason: admission.allowed
            ? AdmissionReason.UNSPECIFIED
            : reasonToProto(admission.quotaType),
          hitlLevel: hitlLevelToProto(hitlLevel),
          killSwitchState: create(KillSwitchStateSchema, {
            global: killSwitch.global,
            tenant: killSwitch.tenant,
            agentIds: killSwitch.agentIds,
            connectorTypes: killSwitch.connectorTypes,
          }),
          // Allowlists: tenant-scoped rows from action_allowlists.
          // ActionAllowlist proto carries (connector, entity_type,
          // action_type, scope_pattern). We stringify the JSONB `pattern`
          // column into scope_pattern for now — if it's a plain scope
          // string we pass it through, otherwise JSON.stringify so the
          // client can reparse. TODO(phase-3b): add structured pattern
          // fields on the proto once scope patterns stabilise.
          allowlists: allowlistRows.map((r) =>
            create(ActionAllowlistSchema, {
              connector: r.connectorType,
              entityType: r.entityType,
              actionType: r.actionType,
              scopePattern:
                typeof r.pattern === 'string'
                  ? r.pattern
                  : r.pattern && Object.keys(r.pattern).length > 0
                    ? JSON.stringify(r.pattern)
                    : '',
            }),
          ),
          preflightToken,
          version: versionBig,
        });
      });
    },

    // ── Authorize ─────────────────────────────────────────────────────
    // Per-tool-call authorization. Fails closed if the preflight token
    // is invalid or expired.
    //
    // Decision ladder (first match wins):
    //   1. Invalid/expired preflight_token     → BLOCKED (fail-closed)
    //   2. Idempotent replay (action exists)   → AUTHORIZED/BLOCKED per prior outcome
    //   3. Token says admission BLOCKED        → BLOCKED
    //   4. HITL gate required for this call    → HITL_REQUIRED w/ approval id
    //   5. Conflict on (tenant, entity, action) in-flight → CONFLICT
    //   6. Otherwise                           → ALLOWED
    async authorize(
      req: AuthorizeRequest,
      _ctx: HandlerContext,
    ): Promise<AuthorizeResponse> {
      return traced('Authorize', async () => {
        // 1. Verify preflight token — this is what binds the call to
        //    an invocation and carries tenant/HITL context (since the
        //    current proto has no tenantContext on AuthorizeRequest).
        const verified = verifyPreflightToken(req.preflightToken || '');
        if (!verified.valid) {
          logger.warn(
            {
              reason: verified.reason,
              connector: req.connector,
              action_type: req.actionType,
              idempotency_key: req.idempotencyKey,
            },
            'Authorize: preflight token rejected — failing closed',
          );
          return blocked(AdmissionReason.UNSPECIFIED);
        }
        const claims = verified.claims;

        // 2. Idempotent replay. If we've already recorded an action for
        //    this idempotency_key, return the prior outcome without
        //    re-running admission / HITL checks.
        if (req.idempotencyKey) {
          const existing = await actionLedgerService.getByIdempotencyKey(
            req.idempotencyKey,
          );
          if (existing) {
            if (existing.status === 'failed') {
              // Treat prior failures as BLOCKED so callers don't retry
              // through the hot path — they must refetch preflight.
              return blocked(AdmissionReason.UNSPECIFIED);
            }
            return create(AuthorizeResponseSchema, {
              decision: AuthorizeDecision.ALLOWED,
              approvalRequestId: '',
            });
          }
        }

        // 3. Admission snapshot from the token. If Preflight said BLOCKED,
        //    Authorize respects that — tenant-runtime is expected to refetch
        //    preflight on kill-switch push-invalidation, so a stale token
        //    is either still valid or already expired (handled above).
        if (claims.admissionStatus === 'BLOCKED') {
          return blocked(AdmissionReason.KILL_SWITCH_TENANT);
        }

        // 4. Conflict detection — an in-flight (pending/executing) action
        //    on the same tenant+connector+entity+action blocks a second
        //    concurrent write. We query the action ledger for any row in
        //    pending/executing/in_flight/queued state created in the last
        //    five minutes targeting the same tuple. If one exists, block
        //    this authorize with decision=CONFLICT so the caller can wait
        //    or override.
        if (req.connector && req.entityType && req.actionType && req.targetRef) {
          try {
            const conflict = await actionLedgerService.findInFlightConflicts(
              claims.tenantId,
              req.connector,
              req.entityType,
              req.targetRef,
              req.actionType,
            );
            if (conflict) {
              logger.info(
                {
                  tenant_id: claims.tenantId,
                  connector: req.connector,
                  entity_type: req.entityType,
                  action_type: req.actionType,
                  target_ref: req.targetRef,
                  conflicting_action_id: conflict.id,
                  conflict_status: conflict.status,
                },
                'Authorize: in-flight conflict detected — returning CONFLICT',
              );
              return create(AuthorizeResponseSchema, {
                decision: AuthorizeDecision.CONFLICT,
                approvalRequestId: '',
                conflict: create(ConflictSchema, {
                  conflictingActionId: conflict.id,
                  resolution: Conflict_Resolution.WAIT,
                }),
              });
            }
          } catch (err) {
            // Conflict detection is a safety hint; if the query fails we
            // log and fall through rather than fail the hot path.
            logger.warn(
              {
                err: (err as Error).message,
                tenant_id: claims.tenantId,
              },
              'Authorize: conflict detection query failed — continuing',
            );
          }
        }

        // 5. Allowlist short-circuit — if the (connector, entity_type,
        //    action_type) matches a tenant allowlist entry, skip HITL and
        //    return ALLOWED. This is how tenants whitelist known-safe
        //    automations even at HITL levels 1-3.
        let allowlistMatch = false;
        if (req.connector && req.entityType && req.actionType) {
          try {
            allowlistMatch = await allowlistsService.matches(
              claims.tenantId,
              req.connector,
              req.entityType,
              req.actionType,
            );
          } catch (err) {
            logger.warn(
              {
                err: (err as Error).message,
                tenant_id: claims.tenantId,
              },
              'Authorize: allowlist lookup failed — falling through to HITL',
            );
          }
        }

        // 6. Risk-aware HITL gate. Per-action risk is inferred from the action
        //    NAME (this RPC has no tool definitions):
        //     - CONSEQUENTIAL (merge/land + super-destructive) → require a human
        //       at EVERY autonomy level. This closes the prior gap where levels
        //       4-5 skipped the gate here entirely, letting a merge-to-main
        //       through on the per-action path.
        //     - Reversible, low-risk collaboration writes (open a PR/MR, post a
        //       review comment) → proceed once autonomy is 'balanced' (level
        //       >= 3): opening a change for review is trivially reversible and is
        //       not the consequential act. They still gate at the most
        //       restrictive levels 1-2.
        //     - Every other write → the original levels-1-3 gate.
        //    A tenant allowlist entry still short-circuits all of the above.
        const action = req.actionType || '';
        const isConsequential =
          toolActionMatchesNameSet(SUPER_DESTRUCTIVE_OPERATIONS, action) ||
          toolActionMatchesNameSet(MERGE_TO_MAIN_TOOL_NAMES, action);
        const isReversibleLowRisk =
          toolActionMatchesNameSet(LOW_RISK_REVERSIBLE_WRITES, action) ||
          scopedActionMatchesNameSet(
            LOW_RISK_REVERSIBLE_WRITES_SCOPED,
            req.connector || '',
            action,
          );
        // Reads gate only at level 1 (parity with the batch checkHitlGate,
        // where level 1 gates everything and levels 2-3 pass reads). Without
        // a read-ness check the level 1-3 gate applies to EVERY action, so at
        // balanced autonomy the native connector path HITL-gates pure reads
        // (e.g. slack list_channels).
        //
        // Read-ness is the caller's DECLARED classification when it supplied
        // one, and the action-NAME heuristic otherwise. This RPC has no tool
        // definitions of its own, so historically it could only guess from the
        // name — and the name heuristic misses reviewed reads whose verb it does
        // not recognise (PDL `enrich_company`, Hunter `email_finder`), gating
        // them though the connector declares them reads. `action_read_class` is
        // resolved by the caller from the connector catalog (categories +
        // provenance, write signals winning) and is trusted ONLY when DECLARED:
        // an inferred or absent classification leaves the name heuristic in
        // force, because the caller's inference defaults an unknown verb to read
        // and must never loosen this fail-closed gate. A DECLARED_NON_READ gates
        // as a write even when its name reads as a read. This changes only the
        // read exemption; the consequential, allowlist and conflict checks are
        // untouched.
        const isReadOnly =
          req.actionReadClass === ActionReadClass.DECLARED_READ
            ? true
            : req.actionReadClass === ActionReadClass.DECLARED_NON_READ
              ? false
              : isReadOnlyActionName(action);
        const gatedByLevel =
          claims.hitlLevel >= 1 &&
          claims.hitlLevel <= 3 &&
          !(isReadOnly && claims.hitlLevel >= 2) &&
          !(isReversibleLowRisk && claims.hitlLevel >= 3);
        if (!allowlistMatch && (isConsequential || gatedByLevel)) {
          const approvalId = await findOrCreateApprovalForAuthorize(
            claims,
            req,
          );
          if (approvalId) {
            return create(AuthorizeResponseSchema, {
              decision: AuthorizeDecision.HITL_REQUIRED,
              approvalRequestId: approvalId,
            });
          }
          // No pending/approved record — fall through to allow.
        }

        return create(AuthorizeResponseSchema, {
          decision: AuthorizeDecision.ALLOWED,
          approvalRequestId: '',
        });
      });
    },

    // ── Record ────────────────────────────────────────────────────────
    // Fire-and-forget post-execution recording. Writes in parallel to:
    //   - action-ledger       (action row with status + external_response)
    //   - usage-ledger        (credits consumed, cost_usd)
    //   - audit               (audit trail)
    //
    // Returns 202-equivalent ({accepted: true}) immediately. A single
    // backend failure does NOT fail the call — the local WAL in
    // tenant-runtime is the durable source and a reconciler will catch
    // drift. All three writes run via Promise.allSettled so one bad
    // dependency doesn't take the others down.
    async record(
      req: RecordRequest,
      _ctx: HandlerContext,
    ): Promise<RecordResponse> {
      return traced('Record', async () => {
        const verified = verifyPreflightToken(req.preflightToken || '');
        if (!verified.valid) {
          // Unlike Authorize, we do NOT fail closed on Record — losing
          // audit rows is worse than accepting ones whose token expired.
          // tenant-runtime's local WAL is the durable source of truth.
          logger.warn(
            {
              reason: verified.reason,
              idempotency_key: req.idempotencyKey,
              action_type: req.actionType,
            },
            'Record: preflight token invalid — accepting anyway (WAL is source of truth)',
          );
        }
        const claims = verified.valid ? verified.claims : null;

        // Fire-and-forget background writes. We intentionally do NOT
        // await this promise — return 202 immediately.
        void backgroundRecord(req, claims);

        return create(RecordResponseSchema, { accepted: true });
      });
    },

    // ── ListApprovals ─────────────────────────────────────────────────
    async listApprovals(
      req: ListApprovalsRequest,
      _ctx: HandlerContext,
    ): Promise<ListApprovalsResponse> {
      const tenantId = requireTenantId(req, 'ListApprovals');
      return traced('ListApprovals', async () => {
        const pageSize = req.pagination?.pageSize ?? 20;
        const cursor = req.pagination?.pageToken || undefined;

        const { approvals, nextCursor } =
          await hitlEnforcementService.listPendingApprovals(tenantId, {
            cursor,
            limit: pageSize,
          });

        return create(ListApprovalsResponseSchema, {
          approvals: approvals.map((a) =>
            create(HitlApprovalRequestSchema, {
              id: a.id,
              tenantId: a.tenantId,
              workflowId: a.workflowId ?? '',
              taskId: a.taskId ?? '',
              agentId: a.agentId,
              hitlLevel: hitlLevelToProto(a.hitlLevel),
              toolCallsHash: a.toolCallsHash,
              reason: a.reason ?? '',
              status: approvalStatusToProto(a.status),
              decidedBy: a.decidedBy ?? '',
              decidedByRole: a.decidedByRole ?? '',
              decision: approvalDecisionToProto(a.decision ?? undefined),
              rejectionReason: a.rejectionReason ?? '',
            }),
          ),
          nextPageToken: nextCursor ?? '',
        });
      });
    },
  });
}

// ── helpers ─────────────────────────────────────────────────────────

// For a HITL-gated Authorize call, look up any existing pending approval
// by the idempotency_key. If one exists and is:
//   - pending  → return its id so tenant-runtime can keep polling
//   - approved → return `null` (no gate needed, caller may proceed)
//   - rejected/expired → return its id so the caller surfaces the block
// If none exists yet, create a new pending approval and return its id.
async function findOrCreateApprovalForAuthorize(
  claims: PreflightClaims,
  req: AuthorizeRequest,
): Promise<string | null> {
  // We keep the lookup scoped to idempotency_key for now — cross-key
  // lookups (tenant+entity+action) require an index that isn't in this
  // repo's migrations yet.
  if (req.idempotencyKey) {
    // hitl-enforcement has no findByIdempotencyKey helper — use a
    // lightweight direct query via the repo's pool. To keep this module
    // mockable in tests, we delegate to the service which proxies pool.
    const existing = await lookupApprovalByIdempotency(req.idempotencyKey);
    if (existing) {
      if (existing.status === 'approved') return null;
      return existing.id;
    }
  }

  // Create a fresh pending approval row bound to this tool call.
  const approval = await hitlEnforcementService.createApprovalRequest({
    tenantId: claims.tenantId,
    workflowId: '', // not in AuthorizeRequest proto — TODO
    taskId: '',
    agentId: claims.agentId,
    hitlLevel: claims.hitlLevel,
    pendingToolCalls: [
      {
        id: req.idempotencyKey || '',
        name: `${req.connector || ''}.${req.actionType || ''}`,
        input: {
          connector: req.connector,
          entityType: req.entityType,
          actionType: req.actionType,
          targetRef: req.targetRef,
        },
      },
    ],
    reason: 'authorize_gate',
    idempotencyKey: req.idempotencyKey || undefined,
  });
  return approval.id;
}

// Minimal idempotency-key → approval lookup. Kept as a module-level
// function so tests can spy on hitlEnforcementService.getApprovalRequest
// without reaching into the pool.
async function lookupApprovalByIdempotency(
  idempotencyKey: string,
): Promise<{ id: string; status: string } | null> {
  try {
    // hitlEnforcementService.createApprovalRequest uses UPSERT on
    // idempotency_key so we can fetch via the same key by doing a
    // no-op upsert-probe. Simpler: use the pool directly.
    const { pool } = await import('../infrastructure/database.js');
    const r = await pool.query(
      `SELECT id, status FROM hitl_approval_requests WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey],
    );
    if (r.rows.length === 0) return null;
    return { id: r.rows[0].id as string, status: r.rows[0].status as string };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, idempotencyKey },
      'Authorize: approval idempotency lookup failed',
    );
    return null;
  }
}

// RecordRequest.thread_id was added in @liftoffos/proto-gen 0.5.4.
// Use an intersection type until CI installs that version.
type RecordRequestPlus = RecordRequest & { readonly threadId?: string };

// Background fanout for Record — intentionally not awaited by the
// caller. Uses Promise.allSettled so a single failing leg doesn't kill
// the others.
async function backgroundRecord(
  req: RecordRequest,
  claims: PreflightClaims | null,
): Promise<void> {
  if (!claims) {
    // Without claims we can't attribute the write to a tenant/agent —
    // log once and bail rather than writing orphan rows.
    logger.warn(
      {
        idempotency_key: req.idempotencyKey,
        action_type: req.actionType,
      },
      'Record background: no claims available, skipping ledger writes',
    );
    return;
  }

  const actionStatus: 'completed' | 'failed' =
    req.status === ActionStatus.FAILED ? 'failed' : 'completed';

  const results = await Promise.allSettled([
    // Action ledger — record the intent row; the caller's post-action
    // state is what we're persisting here (status reflects outcome).
    (async () => {
      const actionId = await actionLedgerService.recordIntent({
        tenantId: claims.tenantId,
        agentId: claims.agentId,
        workflowId: '', // TODO: proto gap — RecordRequest has no workflow_id
        taskId: '',
        idempotencyKey: req.idempotencyKey,
        connector: req.connector,
        entityType: req.entityType,
        actionType: req.actionType,
        targetRef: req.targetRef,
        traceId: req.traceId || undefined,
        costUsd: req.costUsd ?? 0,
        threadId: (req as RecordRequestPlus).threadId || undefined,
        invocationId: claims.invocationId || undefined,
      });
      // Immediately mark outcome since this is post-execution.
      if (actionStatus === 'failed') {
        await actionLedgerService.recordFailure(actionId, {
          message: req.error || 'unknown',
        });
      } else {
        await actionLedgerService.recordOutcome(actionId, {
          success: true,
          // `external_response` is proto `bytes` — store the raw buffer;
          // the ledger's updateAction JSON-stringifies it for storage.
          data: req.externalResponse
            ? { response: Buffer.from(req.externalResponse).toString('base64') }
            : null,
        });
      }
      return actionId;
    })(),

    // Usage ledger — record cost. We convert cost_usd into credits via
    // the tenant's cost model lookup path. If cost_usd is 0 we still
    // emit a zero-credit event so reconciliation sees the call.
    usageLedgerService.recordUsage({
      tenantId: claims.tenantId,
      agentId: claims.agentId,
      workflowId: null,
      actionId: req.idempotencyKey, // best-available correlator
      eventType: req.actionType || 'tool_call',
      credits: 0, // cost_usd → credits conversion is a pricing concern;
                  // governance-engine records the raw USD in metadata
                  // and the aggregation service does the conversion.
      metadata: {
        costUsd: req.costUsd ?? 0,
        durationMs: Number(req.durationMs ?? 0),
        connector: req.connector,
        entityType: req.entityType,
        actionType: req.actionType,
        outcome: actionStatus,
      },
    }),

    // Audit trail — always record, even on failure.
    insertAuditLog(null, claims.tenantId, {
      internalAgentId: claims.agentId || undefined,
      action: `${req.connector || ''}.${req.actionType || ''}`,
      inputArgs: {
        entityType: req.entityType,
        targetRef: req.targetRef,
        idempotencyKey: req.idempotencyKey,
      },
      outputSummary: req.error || undefined,
      outcome: actionStatus === 'failed' ? 'error' : 'success',
      errorCode: req.error || undefined,
      triggeredBy: 'agent',
      durationMs: Number(req.durationMs ?? 0) || undefined,
    }),
  ]);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      const leg = ['action-ledger', 'usage-ledger', 'audit'][i];
      logger.warn(
        {
          leg,
          err: r.reason instanceof Error ? r.reason.message : String(r.reason),
          idempotency_key: req.idempotencyKey,
          tenant_id: claims.tenantId,
        },
        'Record background: ledger write failed (non-fatal)',
      );
    }
  }
}

// Re-export instances so tests / future handlers can reuse them.
export {
  admissionService,
  actionLedgerService,
  usageLedgerService,
  hitlEnforcementService,
};
