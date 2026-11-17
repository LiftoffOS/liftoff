// Tool Gateway Service Implementation
// Per Section 10 & 11: Tool gateway, action allowlist, and connector conflict-policy registry

import {
  ExecuteInput,
  ExecuteResult,
  ConflictPolicy,
  ConflictDetection,
  FieldChange,
  MergeResolution,
  EscalationRequest,
  ExternalState,
  ToolExecutionError,
  SelfDispatchedRecord,
} from './types';
import { classifyError, isRetryable, isToolErrorCode, recoveryFor } from '@liftoffos/connector-types';
import { guardExternalToolCall, recordExternalToolResult } from './external-provenance';
import { parseVendorToolName } from '../action-ledger/record-external-tool-call';
import type { GuardExternalInput, ObserveExternalInput, DerivedDeclaration } from './dispatcher';
import { ConflictPolicyRegistry } from './conflict-policy-registry';
import { stateFetcherRegistry, ExternalStateFetcherRegistry } from './state-fetcher';
import { permissionValidator } from './permission-validator';

// Both predicates now live in dispatch-families.ts, so the family table and the
// routing in executeInner match on the same function rather than on two copies.
import {
  isAgentSlackToolName,
  isAgentTeamsToolName,
  dedicatedDispatchFamily,
  isOrdinaryConnectorDispatch,
} from './dispatch-families';
import { ActionLedgerService } from '../action-ledger/service';
import { actKeyFor, connectorTypeFromAlias, deriveTarget, directOperation, isWriteAction } from '../action-ledger/target-ref';
import { getToolSchema, getToolSchemas, getCustomMcpToolSchema, getCustomApiToolSchema, listCustomApiToolSchemasByAlias, CUSTOM_API_CONNECTOR_TYPE, catalogTypeFor, capabilityForToolName } from '../connectors/tool-schema-cache';
import { vendorDeclarationFor } from '../connectors/vendor-declarations';
import { refusalForTool, reportTriStateRefusal } from './capability-tri-state';
import { cardFoundFile, hostNoteForCardedFile, registerFoundFileWithPlatform } from './found-file-cards';
import { capabilityStatesFor, repoScopeFor } from './capability-states-lookup';
import { acceptedReturnsIds, ensureAcceptedShapesLoaded } from './learned-shapes-cache';
import { repoScopeRefusal } from './repo-scope';
import { observeReadShape } from './observed-shapes';
import { toolResultData, toolResultFailure } from './mcp-result';
import {
  checkFloorProvenance,
  checkWriteProvenance,
  holdMessage,
  provenanceGateMode,
  provenanceEnforcedFor,
  recordProvenance,
  reportInertDeclaration,
  reportProvenance,
  type ProvenanceDeclaration,
} from './record-provenance';
import {
  findCompletedDuplicate,
  findPriorVersionedAct,
  duplicateRefusal,
  duplicateReplay,
  duplicateKey,
  multiplexedOperation,
  inFlightInBatch,
  type DuplicateHit,
} from './duplicate-outward-action';
import type { DerivedTarget } from '../action-ledger/target-ref';
import { SANDBOX_CONNECTOR } from '../agent-execution/tool-dispatch-family';
import { dispatchTimeoutMs } from '../agent-execution/adapter/dispatch-timeout';

/**
 * The target ref governance-engine's authorize has always received.
 *
 * Kept deliberately narrow — see the call site. This value is not a record; it
 * decides whether the engine runs its in-flight CONFLICT check, so widening it
 * changes what gets blocked. Scalars only: the previous `String(x ?? '')` turned
 * an explicit null into the truthy string "null", arming the check against a
 * target that names nothing.
 */
export function legacyGovernanceTargetRef(input: ExecuteInput): string {
  const id = input.payload?.id ?? input.payload?.targetRef;
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return '';
}

/** Passed down into `executeInner` so it can say "I already recorded this one".
 *  Mutable on purpose: the wrapper needs the answer after the inner call has
 *  returned through any of its seventeen exits. See `backstopLedger`. */
interface LedgerReceipt {
  actionId: string | null;
}
import { AdmissionService } from '../admission/service';
import { AdmissionDeniedError, ADMISSION_DENIED_CODE, admissionDeniedRecovery } from '../admission/types';
import { formatToolErrorEnvelope } from './tool-error-envelope';
import { resolveInternalAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import { logger } from '../infrastructure/logging';
import { getPool } from '../infrastructure/database';
import { isSandboxTool } from '../execution-environments/function-registry';
import type { SandboxExecutorInterface, SandboxSession } from '../execution-environments/sandbox-executor';
// Phase 3 governance-engine integration — shadow-mode gated. See
// src/governance/README.md (module-level doc in governance-service-client.ts).
// Feature flag: GOVERNANCE_SERVICE_ENABLED (off|shadow|on), default off.
import { withGovernanceShadowAndFallback } from '../governance/shadow-mode';
import { getGovernanceServiceMode } from '../governance/governance-service-flag';
import { getGovernanceServiceClient } from '../governance/governance-service-client';
import { getPreflight } from '../governance/preflight-cache';
import { writeWalEntry } from '../governance/wal';
import { AuthorizeDecision, ActionStatus, AdmissionReason } from '../governance/governance-service-client';
import { resolveActionReadClass } from './action-read-class';
import { ActionReadClass } from '@liftoffos/proto-gen/dist/liftoff/governance/v1/governance_service_pb';
import type { AuthorizeRequest } from '../governance/governance-service-client';
import { runOutputGuardrails } from './output-guardrails';
import {
  stagedBatchRepository,
  stripProtocolArgs,
  logStrippedProtocolArgs,
  verifyApply,
  type StagedBatch,
} from './staged-batches';
import { drainHostDelivered } from './host-delivered';
import { contentIndexer } from './content-indexer';
import { scanPayloadForUnsafeUrls } from '../security/ssrf-guard';

/**
 * SSRF gate for untrusted-inbound invocations (inbound-webhook plan §6.4).
 * When the trigger is a public webhook, refuse any tool call whose payload
 * contains a URL pointing at a private / loopback / metadata endpoint.
 * Trusted invocations (cron, human, agent-to-agent) skip this gate so the
 * rest of the platform's tool surface is unaffected.
 *
 * Returns null on pass, or a synthesized ExecuteResult on block. Centralized
 * here so both `execute()` and the fast-path branch of `executeBatch()`
 * apply the same check — earlier versions only covered `execute()`, letting
 * batched tool calls slip past.
 */
export function checkSsrfGate(input: ExecuteInput): ExecuteResult | null {
  if (input.trustLevel !== 'untrusted_inbound') return null;
  const rejected = scanPayloadForUnsafeUrls(input.payload);
  if (rejected.length === 0) return null;
  logger.warn('tool-gateway: refusing untrusted_inbound tool call with unsafe URL', {
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    trace_id: input.traceId,
    connector: input.connector,
    action_type: input.actionType,
    rejected_count: rejected.length,
    first_reason: rejected[0]?.reason,
  });
  return {
    success: false,
    data: null,
    traceId: input.traceId,
    error: `Refused: tool input contains URL(s) targeting private/metadata endpoints (${rejected
      .map((r) => r.reason)
      .join(', ')})`,
  };
}

/** The identity a sandbox workspace is keyed by, in precedence order.
 *
 *  1. An explicit handle from the caller (`workspaceSessionId`) — provisioning,
 *     sidecar callbacks, and the parity rig pass their own composite handles
 *     (`sandbox:<sandboxId>:<tool>:<seq>`, see migration 286).
 *  2. The thread — scopes one workspace across the turns of a conversation.
 *  3. The invocation — the correct, narrower scope for runs with no thread
 *     (delegated children, wake polls), which get a per-run workspace.
 *
 *  Deliberately no trace-id fallback: a trace id is a diagnostic label, not an
 *  identity, and using it as a persistent workspace key is what produced the
 *  malformed `exec-…` handles that failed the sandbox_state lookup. A dispatch
 *  reaching here with none of the three has no run identity at all — a caller
 *  bug worth surfacing rather than papering over with a synthetic key.
 *
 *  The handle rides its OWN field and is deliberately never read out of
 *  `payload`. `payload` is the model's tool arguments, and `sessionId` is one
 *  of them: eleven sandbox tools take a session id naming a REPL or a PTY
 *  inside the workspace, which is a different thing from the workspace itself.
 *  Sharing one key between a platform identity and a tool argument means one
 *  overwrites the other. */
export function sandboxSessionIdFor(input: {
  workspaceSessionId?: string;
  threadId?: string;
  invocationId?: string;
  actionType?: string;
}): string {
  const explicit = input.workspaceSessionId;
  if (typeof explicit === 'string' && explicit) return explicit;
  if (input.threadId) return input.threadId;
  if (input.invocationId) return input.invocationId;
  throw new Error(
    `Sandbox dispatch for '${input.actionType ?? 'unknown tool'}' has no session identity `
    + '(no workspaceSessionId, threadId, or invocationId). The caller must thread a run identity through.',
  );
}

/** A workspace that outlives the run, for the runs that repeat.
 *
 *  A scheduled agent has no thread, so `sandboxSessionIdFor` falls through to
 *  the invocation and every tick gets a NEW workspace. Provisioning takes about
 *  a minute, so an agent on a five-minute cron pays that minute ~288 times a day
 *  and starts each run on an empty disk — it re-clones the repository it cloned
 *  five minutes ago, and a run that scheduled itself a continuation resumes with
 *  none of the work the previous one left behind.
 *
 *  Keying on the AGENT fixes both: one provision serves many ticks, and a
 *  self-scheduled follow-up lands in the workspace its predecessor was using.
 *  Nothing is provisioned speculatively — this is not a warm pool, it is the
 *  same lazy create with a key that stops changing — so it scales with active
 *  agents rather than with ticks.
 *
 *  Deliberately narrow, because a shared workspace is a weaker isolation
 *  boundary than a fresh one and only some runs benefit:
 *
 *    - A run WITH a thread keeps the thread's workspace. Unchanged.
 *    - A DELEGATED child (delegationDepth > 0) keeps its per-invocation
 *      workspace. Its isolation is the point: children are ephemeral, may run
 *      concurrently with siblings, and must not see each other's files.
 *    - Only a top-level run with no thread — cron, event, or a self-scheduled
 *      continuation of one — gets the durable key.
 *
 *  The reap is already handled: the sweep destroys a workspace whose heartbeat
 *  lapsed, and `hadDestroyedSandbox` tells the next run its workspace was reset
 *  rather than letting it read an empty directory as an empty repository.
 */
export function durableWorkspaceKeyFor(input: {
  agentId?: string;
  threadId?: string;
  delegationDepth?: number | null;
}): string | undefined {
  if (!input.agentId) return undefined;
  if (input.threadId) return undefined;
  if ((input.delegationDepth ?? 0) > 0) return undefined;
  return `agent:${input.agentId}`;
}

/**
 * Audit Log Hardening (System 1): thrown when pre-action snapshot capture
 * fails after all retries, blocking the write to preserve audit integrity.
 * Callers may re-submit with `skipSnapshotCapture: true` after human approval.
 */
export class SnapshotUnavailableError extends Error {
  readonly code = 'SNAPSHOT_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotUnavailableError';
  }
}

// Phase 2c: credential injection removed — connector-service owns
// credentials. The interface is kept as a vestigial shape so existing
// callers that construct a legacy ConnectorCredentialService-alike can
// still pass it in through `setCredentialService`; it's simply ignored.
interface CredentialService {
  getCredentials(connectorId: string, tenantId: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    instanceUrl?: string;
    expiresAt?: Date;
  }>;
}

// Governance-engine admission is keyed by the Platform-Backend INTERNAL
// agent id (its `agents` / `cached_entitlements` tables mirror internal_agents),
// but the tool-gateway runs on the runtime agent_id (audit / memory FKs). Every
// governed write must translate runtime -> internal before Preflight, else
// checkAdmission can't find the agent and Preflight returns admissionStatus=
// BLOCKED, which Authorize then respects (decision=BLOCKED). The mapping is
// minted once at provisioning (handleInternalAgentCreated) and never changes,
// so a positive resolution is cached process-wide to keep the Authorize hot
// path off the DB even when the preflight itself is cache-warm. An unmapped id
// (identity agents / not-yet-provisioned) is NOT cached — a mapping row may
// appear later — and falls back to the id we already hold.
const runtimeToInternalAgentIdCache = new Map<string, string>();
async function resolveGovernanceAgentId(
  tenantId: string,
  runtimeAgentId: string,
): Promise<string> {
  const cacheKey = `${tenantId}|${runtimeAgentId}`;
  const cached = runtimeToInternalAgentIdCache.get(cacheKey);
  if (cached) return cached;
  const internal = await resolveInternalAgentId(tenantId, runtimeAgentId);
  if (internal) {
    runtimeToInternalAgentIdCache.set(cacheKey, internal);
    return internal;
  }
  return runtimeAgentId;
}

/** Canonical UUID shape. Used to tell a resolved connector id from an alias
 *  like `google-mail-14a82d9e`, which is a NAME and must never reach a uuid
 *  column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long one connector-service RPC may take.
 *
 * The HTTP/2 transport pings a live session but sets no per-call deadline, so
 * an RPC on a session that died in a network reset waited forever. This is the
 * same ceiling the MCP bridge gives the tool call the RPC serves
 * (dispatchTimeoutMs: 180s, or a budget the call declares, plus margin), so the
 * bound never cuts a call its caller is still waiting for. Connect sends it as
 * the call's deadline, so connector-service can stop its side too; on expiry
 * the RPC rejects with DeadlineExceeded and lands in the thrown-error path
 * below like any other transport failure.
 */
function connectorCallDeadlineMs(payload: unknown): number {
  return dispatchTimeoutMs(payload);
}

export class ToolGatewayService {
  private registry = new ConflictPolicyRegistry();
  private actionLedger = new ActionLedgerService();
  private admissionService = new AdmissionService();
  private stateFetcher: ExternalStateFetcherRegistry = stateFetcherRegistry;
  private sandboxExecutor?: SandboxExecutorInterface;

  // Retained for backwards compatibility with callers that still pass a
  // legacy credential service. Phase 2c: tenant-runtime no longer resolves
  // credentials; connector-service does.
  setCredentialService(_service: CredentialService): void {
    // intentional no-op
  }

  // Allow injection of sandbox executor for execution environment tools
  setSandboxExecutor(executor: SandboxExecutorInterface): void {
    this.sandboxExecutor = executor;
  }

  /**
   * The sandbox, for a routine script that runs outside a model turn.
   *
   * Named for its one caller rather than exposed as a general getter: every
   * other sandbox call in this system goes through `execute()` so that
   * admission control, HITL and the action ledger all apply, and a bare
   * accessor is an invitation to skip them. A routine script is the one case
   * with no model turn to hang those on — it is operator-authored, scheduled
   * configuration, not something an agent decided to run — and it still goes
   * to the sandbox executor, which keeps the egress policy, the command audit,
   * the rate limits and the per-call credit accounting.
   *
   * Null when this process has no sandbox wired, which is the honest answer for
   * a connector-only deployment and is what makes the caller refuse the tick
   * rather than run the model against data it never gathered.
   */
  sandboxExecutorForRoutines(): SandboxExecutorInterface | null {
    return this.sandboxExecutor ?? null;
  }

  /**
   * The sandbox, for `code_session` to run a coding CLI in.
   *
   * Named for its caller for the same reason as the accessor above: a bare
   * getter is an invitation to skip `execute()`, and with it admission control,
   * HITL and the action ledger. This caller is legitimate because those have
   * ALREADY run — for the `code_session` call itself, which is one governed
   * tool call. The shell commands inside it are that call's implementation, not
   * new tool calls, and re-gating each one would put an approval prompt in
   * front of a human for work they already approved.
   *
   * What it does NOT skip is the sandbox executor's own layer: every command
   * still goes through `execute()`, so the audit row, the rate limit, the
   * per-call credit accounting and the command audit all still apply.
   *
   * Null when this process has no sandbox wired, which is the honest answer for
   * a connector-only deployment and is what makes `code_session` fall back to
   * the in-process workspace rather than fail.
   */
  sandboxExecutorForCodeSession(): SandboxExecutorInterface | null {
    return this.sandboxExecutor ?? null;
  }

  // Per Section 11: Tool gateway enforces:
  // - tenant identity
  // - agent identity
  // - instruction version
  // - connector allowlist
  // - action allowlist
  // - idempotency
  // - trace IDs
  // - reversibility metadata
  // - structured audit logs

  // Every tool call is audited here, once, around the whole of executeInner.
  //
  // The record used to live at the bottom of the execution body, which meant
  // it was reached only by calls that fell all the way through. executeInner
  // has seventeen exit points: the external-agent, agent-Slack, agent-Teams,
  // custom-MCP and external-agent branches all return within the first eighty
  // lines, the sandbox path returns from the middle, and an idempotent replay
  // returns before execution. Every one of those left no governance record,
  // so `governance_wal` could stay empty while docs/compliance/ropa.md
  // describes the ledger as recording security-relevant events.
  //
  // Auditing in a wrapper rather than at each of those seventeen sites is the
  // point: a future early return cannot silently opt out of the audit, which
  // is exactly how this was lost the first time.
  async execute(input: ExecuteInput & { _internalSkipHitl?: boolean }): Promise<ExecuteResult> {
    const auditStart = Date.now();
    const receipt: LedgerReceipt = { actionId: null };

    // The same outward act, twice in one run — refused here rather than in the
    // graph, because this is the lowest place it is a fact instead of an
    // intention. See duplicate-outward-action.ts for the key and its limits.
    //
    // Before executeInner, so nothing dispatches. Sandbox primitives are
    // exempt for the same reason backstopLedger exempts them: they are not in
    // the ledger this reads, so the answer would always be "no" and the lookup
    // would be a query per shell command that can never match.
    // Before dispatch, beside the duplicate guard and for the same reason: this
    // is the lowest place the call is a fact rather than an intention.
    // An `absent` capability's tools are refused BY NAME, before anything
    // dispatches. Ahead of the provenance guard because it is the stronger
    // statement: provenance asks whether this write may act on that record,
    // and this says the tool does not exist here at all.
    const refusal = await this.preDispatchGuards(input);
    if (refusal) return refusal;

    // A claimed staged apply dispatches the model's arguments minus the
    // protocol's, and settles its batch with what the vendor answered.
    const stagedPayload = this.stagedApplyPayload(input);
    if (stagedPayload) input = { ...input, payload: stagedPayload };

    try {
      const result = await this.executeInner(input, receipt).catch(async (err) => {
        await this.settleStagedApply(input, { success: false, error: (err as Error).message });
        throw err;
      });
      await this.settleStagedApply(input, { success: result.success, data: result.data, error: result.error });
      // What this call returned becomes provenance for the writes after it.
      await this.recordProvenanceForResult(input, result);
      // Reaching here means the call ran to completion; `result.success` may
      // still be false for a tool that returned an error, and that error is
      // carried into the record rather than flattened to ''.
      await this.recordToGovernance({
        input,
        status: ActionStatus.COMPLETED,
        durationMs: Date.now() - auditStart,
        error: result.error ?? '',
        result,
      });
      await this.backstopLedger(input, receipt, result, null);
      return result;
    } catch (error) {
      // Admission denials and guardrail blocks throw. They are security-
      // relevant refusals and belong in the ledger, so this records before
      // rethrowing rather than treating a throw as nothing to audit.
      await this.recordToGovernance({
        input,
        status: ActionStatus.FAILED,
        durationMs: Date.now() - auditStart,
        error: (error as Error).message,
        result: null,
      });
      await this.backstopLedger(input, receipt, null, error as Error);
      throw error;
    }
  }


  /**
   * The provenance declaration for the tool this call names, or undefined.
   *
   * Resolved from the schema cache by connector TYPE, because `input.connector`
   * carries the tenant's instance alias (`slack-d77db9a0`) while the catalog is
   * keyed on the type. Getting that wrong is not an error — it is a lookup that
   * silently returns nothing and a gate that silently never fires, which is the
   * shape `connectorTypeFromAlias` exists to prevent everywhere else.
   */
  private async provenanceDeclarationFor(
    input: ExecuteInput,
    /** What the caller derived from a vendor-hosted tool's own schema and sent
     *  with the request. Only a vendor-hosted tool has one; see below. */
    derived?: DerivedDeclaration,
  ): Promise<ProvenanceDeclaration | undefined> {
    if (input.connector === SANDBOX_CONNECTOR || isSandboxTool(input.actionType)) return undefined;
    // The accepted learned shapes, loaded once per tenant before the first
    // governed call consults them — bounded, so a database that is down does
    // not stall a write, and a cold instance's first call is not judged
    // against an empty set because it happened to be first.
    await ensureAcceptedShapesLoaded(input.tenantId);
    const connectorType = catalogTypeFor(input.connector);
    // The catalog first, then a customer's own server. The second map existed
    // and was written on every refresh; this is the first time anything on
    // the judging side has read it.
    const catalogSchema = getToolSchema(connectorType, input.actionType);
    const schema = catalogSchema
      ?? getCustomMcpToolSchema(input.tenantId, input.connector, input.actionType);
    if (!schema) {
      // A vendor-hosted server's tool: never in either cache, because it is
      // enumerated in the agent service for the model's tool list and not
      // here — and this service runs as several instances, so nothing one
      // request could leave in memory is guaranteed to be on the instance
      // that answers the next. A person's declaration, keyed by the connector
      // type and the vendor's own tool name, is what the judge reads when
      // there is one; else the `idArgs` the caller derived from the tool's
      // schema and sent with THIS request — and, either way, the `returnsIds`
      // a person accepted from what THIS server returned.
      //
      // The hand-written declaration when there is one; else the one the
      // caller derived from the tool's own schema under the reviewed rule
      // (derive-declarations.ts). Both hold. The derived one used to be
      // provisional — judged, never held — until the rule it is derived by
      // had been read against the whole catalog; a rule reviewed on the
      // estate vouches for the tools it is applied to, and a hold it gets
      // wrong costs the run one read, which the hold itself names.
      const declared = vendorDeclarationFor(connectorType, input.actionType);
      const derivedIdArgs = declared ? undefined : derived?.idArgs;
      const learnedForServer = acceptedReturnsIds(input.tenantId, connectorType, input.actionType, input.connector);
      if (!declared && !derivedIdArgs?.length && learnedForServer.length === 0) return undefined;
      const declaredIds = declared?.returnsIds ?? [];
      const known = new Set(declaredIds.map((r) => r.path));
      const returnsIds = [...declaredIds, ...learnedForServer.filter((r) => !known.has(r.path))];
      return {
        ...(declared ?? {}),
        idArgs: declared?.idArgs ?? derivedIdArgs,
        returnsIds: returnsIds.length > 0 ? returnsIds : undefined,
      };
    }
    // Declared paths first, then the ones a person accepted from what the
    // gateway observed. `returnsIds` cannot be derived from an input schema —
    // nothing about a tool's arguments says what its response holds — so for
    // any connector nobody hand-authored, the learned set is the only set.
    // A custom server's shapes live under its alias; a catalog connector's
    // under its type. Two custom servers of one type must not share a shape.
    const isCustomServer = /^custom-mcp-[0-9a-f]{8}$/.test(input.connector);
    const learned = acceptedReturnsIds(input.tenantId, connectorType, input.actionType, isCustomServer ? input.connector : '');
    const declared = schema.returnsIds ?? [];
    const seen = new Set(declared.map((r) => r.path));
    const merged = [...declared, ...learned.filter((r) => !seen.has(r.path))];
    // A customer's own server has no declaration home of its own: its
    // `idArgs` were derived at the refresh mapper, by the same reviewed rule
    // a vendor-hosted tool's are derived by at the request — and they hold
    // the same way. See the vendor branch above.
    return {
      idArgs: schema.idArgs,
      returnsIds: merged.length > 0 ? merged : undefined,
      entityType: schema.entityType,
    };
  }

  /**
   * Remember what a successful call returned, for the writes that follow it.
   *
   * Called from `execute` and from `executeBatch`'s fast path — the two places a
   * result materialises. A recorder wired into one of them would leave every
   * write that followed a BATCHED read looking unprovenanced, which is the
   * common shape for a poll-then-act agent and would have made the shadow
   * metric unreadable.
   */
  private async recordProvenanceForResult(input: ExecuteInput, result: ExecuteResult): Promise<void> {
    if (!result.success) return;
    // A file this read handed to the person becomes a card on the turn. Here
    // because this helper is the one place all three dispatch routes pass a
    // successful result through (the enumerating test holds it there), so a
    // found file is carded whichever route found it — never through the
    // provenance mode, which gates the bookkeeping below and not this.
    const carded = cardFoundFile({
      tenantId: input.tenantId,
      agentId: input.agentId,
      threadId: input.threadId,
      turnId: input.turnId,
      connector: input.connector,
      connectorId: input.bindingsByType?.[input.connector]?.connectorId,
      actionType: input.actionType,
      result,
      register: registerFoundFileWithPlatform,
    });
    // Tell the model what the surface did — only on the platform's word that
    // a card was appended, waited for within a bound; on a timeout or a
    // failure the result says nothing about a card, and the model has
    // nothing to repeat. Written onto the result here, the one place every
    // dispatch route passes a successful result through.
    if (carded) {
      const hostNote = await hostNoteForCardedFile(carded);
      if (hostNote) result.hostNote = hostNote;
    }
    if (provenanceGateMode() === 'off') return;
    try {
      // With the floor, which is what gives the ~144 undeclared connectors
      // provenance memory on day one.
      await recordProvenance({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        actionType: input.actionType,
        declaration: await this.provenanceDeclarationFor(input),
        payload: input.payload,
        result: result.data,
        isWrite: isWriteAction(input.actionType),
        floor: true,
      });
      // The precision layer's raw material. Paths only, never values — a shape
      // store holding values would be a second copy of customer data with none
      // of the retention or scoping the first copy has, built for a code
      // generator's convenience.
      if (!isWriteAction(input.actionType)) {
        // With the entity the read is declared to return, so the observed
        // path lands typed and nobody has to name it afterwards.
        observeReadShape(
          `${catalogTypeFor(input.connector)}.${input.actionType}`,
          result.data,
          input.tenantId,
          getToolSchema(catalogTypeFor(input.connector), input.actionType)?.entityType,
        );
      }
    } catch (err) {
      // Never fail a call that already succeeded because bookkeeping threw.
      logger.warn({ err: (err as Error).message }, 'provenance recording failed (non-fatal)');
    }
  }

  /**
   * Check a write against what this run has read.
   *
   * Returns a held RESULT in enforce mode and null everywhere else, so the
   * caller's shape is `const held = ...; if (held) return held;` on both
   * dispatch paths. Shadow mode reports and returns null: the observation is
   * the point, and it is also the false-positive alarm that has to be quiet
   * before enforce is a defensible flip.
   */
  /**
   * Refuse a tool whose capability this workspace does not have.
   *
   * In the SHARED helpers, so `execute` and `executeBatch`'s fast path both get
   * it — INV-TR-019 exactly. A refusal wired into one dispatch path is a
   * refusal that holds for whichever path a given turn happens to take.
   */
  /**
   * Refuse a call that reaches outside its binding's declared repositories.
   *
   * `githubFilter.repos` was consulted in exactly ONE place — the event trigger,
   * deciding whether an inbound event wakes the agent — and never on a dispatch
   * path. An operator narrowing a role to one repository was given a control
   * that appeared to work and did not, and the code-reviewer template told the
   * agent to respect a boundary nothing enforced.
   *
   * In the shared helpers so `execute` and `executeBatch`'s fast path both get
   * it, per INV-TR-019.
   */
  private async guardRepoScope(input: ExecuteInput): Promise<ExecuteResult | null> {
    const connectorId = input.bindingsByType?.[input.connector]?.connectorId ?? input.connector;
    const allowedRepos = await repoScopeFor(
      input.tenantId,
      input.agentId,
      input.instructionVersion,
      connectorId,
    );
    const refusal = repoScopeRefusal({ payload: input.payload, allowedRepos });
    if (!refusal) return null;

    logger.warn({
      event: 'repo_scope_refusal',
      metric: 'repo_scope.refused',
      connector: input.connector,
      actionType: input.actionType,
      outOfScope: refusal.outOfScope,
      allowed: refusal.allowed,
      tenantId: input.tenantId,
      agentId: input.agentId,
      invocationId: input.invocationId,
    }, 'refused a call naming a repository outside the binding\'s scope');

    return {
      success: false,
      data: null,
      traceId: input.traceId,
      error: refusal.message,
      errorCode: 'repo_out_of_scope',
      retryable: false,
    } as unknown as ExecuteResult;
  }

  private async guardCapabilityTriState(input: ExecuteInput): Promise<ExecuteResult | null> {
    // Resolved HERE, from the stored instruction, rather than read off the
    // input. ExecuteInput is built at a dozen call sites and a field each one
    // must remember is a field the next one forgets: a guard reading
    // `input.capabilityStates` that no call site sets can never fire, while its
    // unit test passes by calling the pure function directly.
    const states = await capabilityStatesFor(
      input.tenantId,
      input.agentId,
      input.instructionVersion,
    );
    if (Object.keys(states).length === 0) return null;

    const refusal = refusalForTool({
      toolName: input.actionType,
      capabilityForTool: (name) => capabilityForToolName(catalogTypeFor(input.connector), name),
      capabilityStates: states,
    });
    if (!refusal) return null;

    reportTriStateRefusal({
      refusal,
      toolName: input.actionType,
      tenantId: input.tenantId,
      agentId: input.agentId,
      invocationId: input.invocationId,
    });
    return {
      success: false,
      data: null,
      traceId: input.traceId,
      error: refusal.message,
      // Not retryable, and that is the point: an "unknown tool" reads as a
      // transient fault and gets retried, which is the behaviour this replaces.
      errorCode: 'capability_absent',
      retryable: false,
    } as unknown as ExecuteResult;
  }

  /**
   * Remember a call this service did not dispatch: the ledger row AND what it
   * returned.
   *
   * The Composio route dispatches from the MCP server and wrote an `audit_logs`
   * row and nothing else. `have_i_acted_on` reads `actions`, so an agent on a
   * Composio-served connector — which is most of them — had no memory of its own
   * actions: it posts, the same trigger is redelivered, it asks whether it has
   * already done this, and is told no. Every time. That is the defect the ledger
   * exists to prevent, happening under it.
   *
   * `backstopLedger` is reused rather than reimplemented because the row has to
   * be IDENTICAL to the native path's — same target derivation, same snapshot
   * status, same non-throwing contract. A parallel writer is how the Composio
   * branch drifted from the native one in the first place.
   *
   * SUCCESS ONLY, and that is the honest scope: `hasActedOn` counts completed
   * rows, so a failed attempt is not an action to remember. It is also the only
   * outcome this seam sees — a Composio failure throws past it.
   *
   * THE PROVENANCE RECORDER BELONGS HERE TOO: the guard chain judges Composio
   * writes, and a check without a recorder judges them against a store that
   * never saw the route's READS. It would flag `create_draft` for a Gmail
   * thread id the same run had read minutes earlier through the same route — a
   * false positive in shadow, and in enforce a refusal of very nearly every
   * Composio write.
   */
  async recordSelfDispatched(input: ExecuteInput, result: ExecuteResult): Promise<SelfDispatchedRecord> {
    await this.recordProvenanceForResult(input, result);
    await this.backstopLedger(input, { actionId: null }, result, null);
    // The recorder writes the note onto `result`; this route's caller holds a
    // different object in a different process, so the note goes back by value.
    return result.hostNote ? { hostNote: result.hostNote } : {};
  }

  /**
   * Judge a write the vendor SDK is about to dispatch, before it runs.
   *
   * The provenance store is IN-PROCESS and this service owns it. In a split
   * deployment (`TOOL_GATEWAY_SERVICE_URL` set, which is every environment
   * today) the engine runs in agent-service and the store lives here, so a
   * check made where the engine runs would judge against a map nothing writes.
   * One store, reached over the same RPC as everything else.
   *
   * Returns the hold to hand the model, or null to proceed.
   */
  async guardExternal(args: GuardExternalInput): Promise<string | null> {
    return guardExternalToolCall(args, await this.externalDeclarationFor(args));
  }

  /** The declaration for a vendor-hosted tool, resolved exactly as
   *  `execute()` resolves one for a gateway tool — same cache, same merge of
   *  declared and learned `returnsIds`. One lookup, two callers. */
  private async externalDeclarationFor(
    args: { tenantId: string; toolName: string; derived?: DerivedDeclaration },
  ): Promise<ProvenanceDeclaration | undefined> {
    const parsed = parseVendorToolName(args.toolName);
    if (!parsed) return undefined;
    return this.provenanceDeclarationFor({
      tenantId: args.tenantId,
      connector: parsed.connector,
      actionType: parsed.actionType,
    } as ExecuteInput, args.derived);
  }

  /**
   * Remember what a call the vendor SDK dispatched returned, for the writes
   * that follow. Records only — its verdict, if it was a write, was produced by
   * `guardExternal` before it ran.
   */
  async observeExternal(args: ObserveExternalInput): Promise<boolean> {
    const stored = await recordExternalToolResult(args, await this.externalDeclarationFor(args));
    // And what a successful vendor read RETURNED, for the learning path — the
    // only source of `returnsIds` for a tool nobody declared by hand. Keyed by
    // the server alias, so two servers of one type do not share a shape.
    try {
      const parsed = parseVendorToolName(args.toolName);
      if (parsed && !args.error && !toolResultFailure(args.result) && !isWriteAction(parsed.actionType)) {
        observeReadShape(
          `${parsed.connector}.${parsed.actionType}`,
          toolResultData(args.result),
          args.tenantId,
          vendorDeclarationFor(catalogTypeFor(parsed.connector), parsed.actionType)?.entityType,
        );
      }
    } catch {
      // Bookkeeping never fails a record that already landed.
    }
    return stored;
  }

  /**
   * Every check that must happen before a call dispatches, in one place.
   *
   * PUBLIC, and that is the point. `execute()` is not the only thing that
   * dispatches a connector tool: the Composio route dispatches from the MCP
   * server, and `executeBatch`'s fast path dispatches over RPC. Both reached
   * the vendor without any of this — not by disabling it, but by never entering
   * the function it lived inside.
   *
   * This file's own header says why that keeps happening: "auditing in a
   * wrapper rather than at each of those seventeen sites is the point: a future
   * early return cannot silently opt out." The wrapper stops an early return
   * INSIDE it. It cannot stop a caller that never enters — and three were added
   * that do not.
   *
   * Order is load-bearing and is the order `execute` had:
   *   1. capability tri-state — the tool does not exist here at all, which
   *      outranks every question about what it may touch.
   *   2. repository scope    — this repository is not this team's business.
   *   3. write provenance    — this write may not act on that record.
   *   4. duplicate outward   — this exact act already happened this run.
   *
   * Returns the refusal to hand back, or null to proceed.
   */
  async preDispatchGuards(
    input: ExecuteInput,
    opts: {
      /** The caller runs its own duplicate-outward check and this one must not
       *  double it. Only `executeBatch`'s fast path sets it, and it has to:
       *  two identical calls arriving in ONE batch are both absent from the
       *  ledger, because neither has dispatched. Its `seenInBatch` closes that,
       *  and the serial path cannot produce the ordering so never needed it. */
      duplicateHandledByCaller?: boolean;
    } = {},
  ): Promise<ExecuteResult | null> {
    const triStateRefusal = await this.guardCapabilityTriState(input);
    if (triStateRefusal) return triStateRefusal;

    const scopeRefusal = await this.guardRepoScope(input);
    if (scopeRefusal) return scopeRefusal;

    const heldForProvenance = await this.guardWriteProvenance(input);
    if (heldForProvenance) return heldForProvenance;

    if (!opts.duplicateHandledByCaller) {
      const duplicate = await this.findDuplicateOutwardAction(input);
      if (duplicate) {
        // Recorded, because a refusal is security-relevant in the same way an
        // admission denial is. NOT written to the action ledger: nothing
        // dispatched, and an intent row for an action that never happened would
        // corrupt the very question the ledger is being taught to answer.
        await this.recordDuplicateSuppressed(
          input, duplicate.target, duplicate.hit.actionId, duplicate.result,
        );
        return duplicate.result;
      }
    }

    // Last, after every refusal that costs nothing: a staged batch's apply
    // claims its batch here, and a claim is a write.
    const staged = await this.guardStagedApply(input);
    if (staged) return staged;

    return null;
  }

  /**
   * The stage/apply protocol's apply half (ADR-052 rule 5, staged-batches.ts).
   *
   * For a tool declared `writeRole: 'apply'`: find the batch the arguments
   * name within this binding, verify it — bound, live, approved by a person
   * against this digest — and CLAIM it before the vendor is called, so a retry
   * or a second delivery meets an applied batch and answers with the recorded
   * result instead of a second write. A refusal is an ExecuteResult failure
   * naming why; a replay is an ExecuteResult success carrying the recorded
   * result; a claim returns null and leaves the batch for `settleStagedApply`.
   *
   * The model's copy of the protocol's arguments is stripped before dispatch
   * and its presence logged: the batch, its digest and its grant are resolved
   * here, never taken from the call.
   */
  private async guardStagedApply(input: ExecuteInput): Promise<ExecuteResult | null> {
    const schema = getToolSchema(catalogTypeFor(input.connector), input.actionType);
    if (schema?.writeRole !== 'apply') return null;
    const { args, stripped } = stripProtocolArgs(input.payload as Record<string, unknown> | undefined);
    logStrippedProtocolArgs({ tenantId: input.tenantId, toolName: input.actionType, stripped });
    const refuse = (error: string): ExecuteResult => ({ success: false, data: null, traceId: input.traceId, error });
    let batch: StagedBatch | null;
    try {
      batch = await stagedBatchRepository().findForApply({
        tenantId: input.tenantId,
        agentId: input.agentId,
        connector: input.connector,
        applyTool: input.actionType,
        applyArgs: args,
      });
    } catch (err) {
      // Fail closed: an apply whose batch cannot be read is not run on the
      // chance that it was approved.
      logger.warn({ err: (err as Error).message, toolName: input.actionType }, 'staged apply: batch lookup failed; refusing');
      return refuse(`${input.actionType} commits a staged batch, and the batch could not be read; not applied`);
    }
    if (!batch) {
      return refuse(`${input.actionType} commits a staged batch, and nothing this run staged matches its arguments; stage first, then apply what was staged`);
    }
    const verdict = verifyApply(batch, {
      tenantId: input.tenantId, agentId: input.agentId, connector: input.connector, applyTool: input.actionType,
    });
    if (verdict.kind === 'refuse') {
      logger.info({ tenantId: input.tenantId, batchId: batch.id, reason: verdict.reason, toolName: input.actionType }, 'staged apply refused');
      return refuse(verdict.detail);
    }
    if (verdict.kind === 'replay') {
      logger.info({ tenantId: input.tenantId, batchId: batch.id, toolName: input.actionType }, 'staged apply already applied; answering with the recorded result');
      return { success: true, data: verdict.result, traceId: input.traceId };
    }
    const claimed = await stagedBatchRepository().claimApply(input.tenantId, batch.id, batch.digest);
    if (!claimed) {
      // Somebody else got there, or the batch moved between the read and the
      // claim. Read it back and answer as it now is.
      const now = await stagedBatchRepository().get(input.tenantId, batch.id);
      if (now?.status === 'applied' && now.applyResult !== null) return { success: true, data: now.applyResult, traceId: input.traceId };
      return refuse(`staged batch ${batch.id} could not be claimed for apply`);
    }
    logger.info({ tenantId: input.tenantId, batchId: batch.id, toolName: input.actionType, event: 'staged_batch_apply_claimed' }, 'staged batch claimed for apply under its approval');
    return null;
  }

  /** The arguments an apply dispatches with: the model's, minus the
   *  protocol's. Undefined for anything but an apply-role tool. Pure, so the
   *  caller that dispatches without this service (the Composio branch) reads
   *  the same answer from the same schema. */
  stagedApplyPayload(input: ExecuteInput): Record<string, unknown> | undefined {
    const schema = getToolSchema(catalogTypeFor(input.connector), input.actionType);
    if (schema?.writeRole !== 'apply') return undefined;
    return stripProtocolArgs(input.payload as Record<string, unknown> | undefined).args;
  }

  /** After the vendor answered: record the result on the claimed batch, or
   *  hand the claim back so the person's approval is not spent on a write
   *  that did not happen. Finds the batch by the call within its binding —
   *  claimed and unsettled — rather than through anything held in memory,
   *  because the claim and the settle may land on different instances.
   *  Idempotent: a call that claimed nothing settles nothing. */
  async settleStagedApply(input: ExecuteInput, outcome: { success: boolean; data?: unknown; error?: string }): Promise<void> {
    const schema = getToolSchema(catalogTypeFor(input.connector), input.actionType);
    if (schema?.writeRole !== 'apply') return;
    try {
      const batch = await stagedBatchRepository().findClaimedForSettle({
        tenantId: input.tenantId,
        agentId: input.agentId,
        connector: input.connector,
        applyTool: input.actionType,
        applyArgs: stripProtocolArgs(input.payload as Record<string, unknown> | undefined).args,
      });
      if (!batch) return;
      if (outcome.success) {
        await stagedBatchRepository().recordApplyResult(input.tenantId, batch.id, outcome.data ?? null);
        logger.info({ tenantId: input.tenantId, batchId: batch.id, toolName: input.actionType, event: 'staged_batch_applied' }, 'staged batch applied under its approval');
      } else {
        await stagedBatchRepository().releaseApply(input.tenantId, batch.id, outcome.error ?? 'apply failed');
        logger.warn({ tenantId: input.tenantId, batchId: batch.id, toolName: input.actionType, error: outcome.error }, 'staged apply failed at the vendor; claim released');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, toolName: input.actionType }, 'Non-fatal: staged apply settle failed');
    }
  }

  private async guardWriteProvenance(input: ExecuteInput): Promise<ExecuteResult | null> {
    const mode = provenanceGateMode();
    if (mode === 'off') return null;
    if (!isWriteAction(input.actionType)) return null;

    const declaration = await this.provenanceDeclarationFor(input);
    let verdict;
    try {
      verdict = await checkWriteProvenance({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        actionType: input.actionType,
        declaration,
        payload: input.payload,
      });
    } catch (err) {
      // A broken check is not grounds to refuse a write.
      logger.warn({ err: (err as Error).message }, 'provenance check failed (non-fatal)');
      return null;
    }
    // Reported for EVERY judged write, before any decision about it.
    //
    // This used to sit after `if (verdict.provenanced) return null`, which meant
    // the only event the gate could ever emit was the failure — and a metric
    // with one observable state cannot be read: would_block == 0 says either
    // "every write was provenanced" or "the gate never ran", which are opposite
    // conclusions. The pass and not-judged events exist to be that denominator,
    // and an early return above them made them unreachable while their unit
    // test — which calls reportProvenance directly — still passed.
    // The floor's view, reported separately and never merged into
    // `would_block`. Only when there is no declaration to be precise with: a
    // connector that HAS declarations is already judged properly, and running
    // both would double-count it.
    // A declaration that names arguments this tool does not take is invisible
    // in every other direction: the lookup finds nothing and the write reads as
    // undeclared, which is exactly what an uncovered tool looks like.
    reportInertDeclaration({
      connector: input.connector,
      actionType: input.actionType,
      declaration,
      payload: input.payload,
    });

    if (verdict.basis === 'no_declaration') {
      const floorUnseen = await checkFloorProvenance({
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        payload: input.payload,
        connector: input.connector,
        // The run writes files under its own invocation id, so without this
        // the floor flags every one of them: three of the three floor hits in
        // the dev shadow window were a run naming itself.
        runContext: [input.agentId, input.tenantId],
      });
      if (floorUnseen.length > 0) {
        logger.warn({
          event: 'provenance_floor_would_block',
          metric: 'provenance.floor_would_block',
          connector: input.connector,
          actionType: input.actionType,
          unseen: floorUnseen.slice(0, 10),
          tenantId: input.tenantId,
          agentId: input.agentId,
          invocationId: input.invocationId,
        }, 'heuristic floor: this write names an identifier the run has not read');
      }
    }

    reportProvenance({
      mode,
      verdict,
      connector: input.connector,
      actionType: input.actionType,
      tenantId: input.tenantId,
      agentId: input.agentId,
      invocationId: input.invocationId,
    });
    if (verdict.provenanced) return null;
    // Per connector, or wherever there is a declaration (`declared`):
    // PROVENANCE_ENFORCE_CONNECTORS decides. Everything else stays in shadow
    // however the global mode is set.
    if (!provenanceEnforcedFor(input.connector, declaration)) return null;

    return {
      success: false,
      data: null,
      traceId: input.traceId,
      error: holdMessage({
        connector: connectorTypeFromAlias(input.connector),
        actionType: input.actionType,
        unseen: verdict.unseen,
        readToRun: this.readThatWouldProvenance(input),
      }),
      // `invalid_arguments` because that is what it is: the call named an
      // identifier the run cannot account for. Not retryable — repeating the
      // same arguments produces the same hold; the model has to read first.
      errorCode: 'invalid_arguments',
      retryable: false,
    };
  }

  /** A read on the same connector that declares it returns this entity, so the
   *  hold can name the call to make rather than leaving the model to search. */
  private readThatWouldProvenance(input: ExecuteInput): string | undefined {
    const type = catalogTypeFor(input.connector);
    // A custom API connection's operations live in the per-instance map, keyed
    // by connector id; `custom_api_connector` holds nothing in the type map.
    // Resolved from the right one so a miss here means "this operation names
    // no entity type" rather than "the lookup was pointed at the wrong map".
    //
    // Its `entityType` is an operation TEMPLATE (`GET /v1/deals/{id}`) rather
    // than an entity name, and `returnsIds` is a declaration the generator does
    // not produce, so the search below finds nothing and the hold carries no
    // suggested read. That is the honest answer for this family, and it is now
    // the answer the code actually computes.
    const isCustomApi = type === CUSTOM_API_CONNECTOR_TYPE;
    const schema = isCustomApi
      ? getCustomApiToolSchema(input.tenantId, input.connector, input.actionType)
      : getToolSchema(type, input.actionType);
    const wanted = schema?.entityType;
    if (!wanted) return undefined;
    const pool = isCustomApi
      ? listCustomApiToolSchemasByAlias(input.tenantId, input.connector)
      : getToolSchemas(type);
    const candidate = pool.find(
      (f) => (f.returnsIds ?? []).some((r) => r.entityType === wanted),
    );
    return candidate?.name;
  }

  /**
   * The target this call acts on, or null when the guard has no business here.
   *
   * Outward acts only. `isWriteAction` is the same classification the ledger
   * uses to decide whether a missing target is worth reporting, so the two
   * cannot drift on what counts as changing something on the far side. A read
   * repeated in one run is wasteful, not wrong, and is none of this guard's
   * business.
   *
   * Split out from the lookup so the batch path can build the same key without
   * a database round trip — see `executeBatch`.
   */
  private guardableTarget(input: ExecuteInput): DerivedTarget | null {
    if (input.connector === SANDBOX_CONNECTOR || isSandboxTool(input.actionType)) return null;
    if (!isWriteAction(input.actionType)) return null;

    // NO TARGET IS STILL A GUARDABLE ACT, and this gate is the third place that
    // had to learn it. `actKeyFor` identifies a create by what it WRITES and
    // `findCompletedDuplicate` matches on that key — but both sit behind this,
    // and `if (!target.ref) return null` meant the guard never ran for a create
    // at all. The identity was computed, written onto the row, and never read.
    //
    // So one run can create the same watch list twice, seconds apart, with
    // BOTH rows carrying the identical
    // `google-docs:create_document_markdown|#<digest>` key. The key is right;
    // nothing asks it.
    //
    // The callers decide what to do with an empty ref: the serial path passes
    // the content key to the lookup, and the batch path passes it to
    // `duplicateKey` so two different creates in one batch stay different.
    return deriveTarget(input);
  }

  /**
   * The duplicate check, or null when the call should proceed.
   */
  private async findDuplicateOutwardAction(
    input: ExecuteInput,
  ): Promise<{ result: ExecuteResult; target: DerivedTarget; hit: DuplicateHit } | null> {
    const target = this.guardableTarget(input);
    if (!target) return null;

    // THIS RUN first, then EARLIER runs.
    //
    // Ordered, not merged: the run-scoped check covers every target, and the
    // cross-run one covers only a target carrying a revision. Asking the
    // narrower question first would let a same-run repeat of an unversioned
    // action through, which is the case the original guard exists for.
    const hit = (await findCompletedDuplicate(input, target, actKeyFor(directOperation(input.connector, input.actionType), target, input.payload)))
      ?? (await findPriorVersionedAct(input, target));
    if (!hit) return null;

    // Answered, not refused — see `duplicateReplay`. The first call's recorded
    // response is what the second gets, so a graph step whose postcondition is
    // already satisfied succeeds instead of taking its failure branch.
    return { result: duplicateReplay(input, target, hit), target, hit };
  }

  /**
   * What a SUPPRESSED duplicate leaves behind: a governance record and a log
   * line, and deliberately NO action-ledger row.
   *
   * Shared by both dispatch paths so the two cannot record it differently.
   * Nothing dispatched, and an intent row for an action that never happened
   * would corrupt the very question the ledger is being taught to answer.
   *
   * `FAILED` here means THIS DISPATCH DID NOT HAPPEN — not that the agent's
   * work failed. A replayed duplicate returns success to the caller and still
   * records here, because a call that was suppressed is exactly as
   * security-relevant as one that was refused, and the audit trail is the one
   * place the suppression is visible at all.
   */
  private async recordDuplicateSuppressed(
    input: ExecuteInput,
    target: DerivedTarget,
    firstActionId: string | null,
    outcome: ExecuteResult,
  ): Promise<void> {
    await this.recordToGovernance({
      input,
      status: ActionStatus.FAILED,
      durationMs: 0,
      error: outcome.error ?? outcome.notice ?? 'duplicate outward action suppressed',
      result: null,
    });
    logger.warn({
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      trace_id: input.traceId,
      action_type: input.actionType,
      target_ref: target.ref,
      target_version: target.version,
      first_action_id: firstActionId,
      answered: outcome.success,
    }, outcome.success
      ? 'duplicate outward action suppressed; replayed the first call\'s result'
      : 'duplicate outward action refused');
  }

  /**
   * Opportunistically index a read result for hybrid retrieval.
   *
   * SHARED WITH `executeBatch` — the fourth thing found living in
   * `executeInner` alone, and the one that starves a feature rather than a
   * control. Indexed only there, `connector_content` stays nearly empty even
   * with `CONNECTOR_CONTENT_INDEXING_ENABLED=true`, and two readers depend on
   * it: the data-landscape injection that tells the distiller what is actually
   * IN a bound system, and the MCP content search. Both then answer from an
   * empty index and report no error, which reads as "these systems are empty"
   * rather than "nothing was ever indexed".
   *
   * VOLUME IS BOUNDED, because this one WRITES where the guardrail only
   * transforms. The indexer caps itself at 3 concurrent, only touches read
   * actions, and is behind a kill switch, so the cost of turning it on scales
   * with read volume and is not a per-call surprise.
   *
   * Fire-and-forget on purpose: a retrieval index is not worth failing a tool
   * call for, which is why the catch swallows to a warn.
   */
  private indexToolResult(input: ExecuteInput, result: ExecuteResult): void {
    if (!result.success || result.data === null || result.data === undefined) return;
    contentIndexer.indexToolResult({
      tenantId: input.tenantId,
      agentId: input.agentId,
      connector: input.connector,
      actionType: input.actionType,
      idempotencyKey: input.idempotencyKey,
      data: result.data,
    }).catch((err) =>
      logger.warn(
        { err, tenantId: input.tenantId, connector: input.connector },
        'content-indexer: failed to index tool result',
      )
    );
  }

  /**
   * Phase 5 output guardrails: scan and transform a tool result before the
   * model reads it.
   *
   * SHARED WITH `executeBatch`, and that is the whole point. This loop lived
   * inside `executeInner`, which batched connector calls never reach — so the
   * only builtin guardrail, `secret-scrub`, never ran on a batched Slack
   * message, GitHub file or Gmail body. A GitHub PAT, a Slack token, an
   * `AKIA…` key or a `-----BEGIN … PRIVATE KEY-----` block sitting in such a
   * tool result reached the model verbatim.
   *
   * The third check lost to the same bypass, after `checkSsrfGate` and the
   * within-run duplicate guard. Anything added to `execute()`'s path belongs
   * here or in a helper both paths call, never in `executeInner` alone.
   *
   * Each guardrail returns transformed data or throws `GuardrailBlockError`,
   * which empties the payload rather than failing the call — a blocked output
   * is a result the model must not read, not an error the tool returned.
   */
  private async applyOutputGuardrails(
    input: Pick<ExecuteInput, 'connector' | 'actionType' | 'payload' | 'tenantId' | 'invocationId' | 'agentId'>,
    result: ExecuteResult,
  ): Promise<ExecuteResult> {
    if (!result.success || result.data === null || result.data === undefined) return result;

    const guarded = await runOutputGuardrails({
      actionType: input.actionType,
      payload: input.payload,
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      connector: input.connector,
      agentId: input.agentId,
    }, result.data);
    const out: ExecuteResult = guarded.outcome === 'blocked'
      ? { ...result, data: null, error: guarded.reason }
      : { ...result, data: guarded.data };
    // What the egress guardrail lifted, handed back to the CALLER rather than
    // kept here. This service runs in its own process in every environment
    // (`TOOL_GATEWAY_SERVICE_URL`), and the chat turn that delivers these to
    // the surface drains an in-process store in the agent service — so a value
    // recorded here was lifted from the model's copy and then reached nobody.
    // Beside the data, never inside it: the bridge re-records these in its own
    // process and strips them before anything is serialised for the model.
    const hostDelivered = drainHostDelivered(input.invocationId);
    return hostDelivered.length > 0 ? { ...out, hostDelivered } : out;
  }

  /**
   * Record the action ledger row for any dispatch the inner path did not.
   *
   * THE SAME DEFECT, IN THE SAME FUNCTION, A SECOND TIME. The comment above
   * `execute` describes how `governance_wal` came to miss records: the record
   * sat at the bottom of `executeInner`,
   * which has seventeen exit points, and the external-agent, agent-Slack,
   * agent-Teams, custom-MCP and sandbox branches all return within the first
   * eighty lines. Moving it to a wrapper fixed governance — and left the action
   * ledger, three hundred lines further down the same method, behind exactly
   * the same set of early returns.
   *
   * So `actions` got rows from the connector path alone: `agent_slack`,
   * `agent_teams`, `custom_mcp_server`, `external` and `external-agent` calls
   * went unrecorded. Moving agents off the connector's Slack write verbs and
   * onto the Liftoff app's `slack_*` tools moves the single largest action
   * class from the ledgered family to an unledgered one.
   *
   * A RECEIPT, NOT A PREDICATE. This could ask "which family is this?" and
   * record for the ones the connector path skips — and would then hold a second
   * copy of the routing rules, free to drift from the real ones, which is the
   * precise failure `tool-dispatch-family.ts` exists to prevent. Instead the
   * inner path stamps the receipt when it records, and this fills in whatever it
   * finds unstamped. A branch added tomorrow is covered without being told
   * about, which is the property that was missing both times.
   *
   * SANDBOX IS THE ONE EXEMPTION, and it is deliberate rather than incidental.
   * Sandbox primitives have their own audit table (`sandbox_command_audit`),
   * they fire at a completely different rate — a single run issues hundreds of
   * `read_file` / `shell_exec` calls — and their arguments name no external
   * entity: `{command: "gh pr review ..."}` cannot be resolved to a target by
   * anything short of parsing a shell line. Recording them would flood the table
   * with rows that can never answer the question it is being taught to answer.
   * The honest consequence, stated in docs/design/have-i-acted-on-this.md, is
   * that work an agent does inside its own shell stays invisible here.
   */
  private async backstopLedger(
    input: ExecuteInput,
    receipt: LedgerReceipt,
    result: ExecuteResult | null,
    error: Error | null,
  ): Promise<void> {
    if (receipt.actionId) return;
    if (input.connector === SANDBOX_CONNECTOR || isSandboxTool(input.actionType)) return;

    // Never let an audit write fail a tool call that already happened. The
    // ledger is a record OF the action, not a gate on it — throwing here would
    // turn a successful send into a reported failure and invite a retry that
    // sends twice.
    try {
      const target = this.deriveAndReportTarget(input);
      const actionId = await this.actionLedger.recordIntent({
        tenantId: input.tenantId,
        agentId: input.agentId,
        workflowId: input.payload?.workflowId || null,
        taskId: input.payload?.taskId || null,
        idempotencyKey: input.idempotencyKey,
        connector: input.connector,
        entityType: input.entityType,
        actionType: input.actionType,
        targetRef: target.ref,
        targetVersion: target.version,
        actKey: actKeyFor(directOperation(input.connector, input.actionType), target, input.payload),
        invocationId: input.invocationId,
        traceId: input.traceId,
        instructionVersion: input.instructionVersion,
        payload: input.payload,
        // These families capture no pre-action snapshot — there is no remote
        // record to read back — so the status says that rather than claiming a
        // capture that never happened.
        snapshotStatus: 'skipped_no_snapshot_path',
      });
      if (error) await this.actionLedger.recordFailure(actionId, error);
      else if (result) await this.actionLedger.recordOutcome(actionId, result, { connector: input.connector, actionType: input.actionType, entityType: input.entityType });
    } catch (err) {
      logger.warn({
        err: (err as Error).message,
        tenant_id: input.tenantId,
        connector: input.connector,
        action_type: input.actionType,
      }, 'action-ledger: backstop record failed');
    }
  }

  private async executeInner(
    input: ExecuteInput & { _internalSkipHitl?: boolean },
    receipt: LedgerReceipt = { actionId: null },
  ): Promise<ExecuteResult> {
    // Validate tenant and agent identity
    this.validateIdentity(input);

    // SSRF gate for untrusted-inbound invocations (inbound-webhook plan §6.4).
    const ssrfBlock = checkSsrfGate(input);
    if (ssrfBlock) return ssrfBlock;

    // WHICH HANDLER OWNS THIS CALL, decided once, from the table every other
    // reader consults. The branches below used to carry their own conditions,
    // and `executeBatch` carried a hand-written list of the same fact — which
    // is how `custom_mcp_server` came to be routed here and batchable at the
    // same time. See dispatch-families.ts.
    const family = dedicatedDispatchFamily(input);

    // Per implementation plan Phase 4.1: Route external agent tools
    // When called from MCP server: actionType is the raw MCP tool name (e.g. 'get_simple_price')
    // When called from custom loop: actionType may be prefixed 'external__alias__toolName'
    if (family === 'external-mcp-tool') {
      // If actionType contains '__' prefix, extract the tool name; otherwise use as-is
      const parts = input.actionType.split('__');
      const mcpToolName = parts.length >= 3 ? parts.slice(2).join('__') : input.actionType;

      const { externalAgentHandler } = await import('./external-agent-handler');
      return externalAgentHandler.execute({
        tenantId: input.tenantId,
        agentId: input.agentId,
        instructionVersion: input.instructionVersion,
        traceId: input.traceId,
        idempotencyKey: input.idempotencyKey,
        externalAgentId: input.entityType,  // External agent ID
        toolName: mcpToolName,
        toolInput: input.payload,
        skipHitl: input._internalSkipHitl,  // Phase 3.5D: pass HITL skip flag
        invocationId: input.invocationId,
      });
    }

    // Route per-agent Slack tool calls. The agent's Slack identity is the
    // per-agent app installed from the More pane on /dashboard/agents/chat;
    // bot tokens live in Secret Manager and are resolved by platform-backend's
    // /api/internal/agent-slack/installs RPC. The handler is dispatched on
    // the actionType prefix so the agent does not need to bind a "Slack"
    // connector row — install presence alone is sufficient.
    if (family === 'agent-slack') {
      const { agentSlackHandler } = await import('./agent-slack-handler');
      return agentSlackHandler.execute({
        tenantId: input.tenantId,
        agentId: input.agentId,
        toolName: input.actionType,
        toolInput: (input.payload ?? {}) as Record<string, unknown>,
        traceId: input.traceId,
      });
    }

    // Per-agent Microsoft Teams tools (teams_send_message, teams_send_dm, …).
    // One multi-tenant Liftoff bot serves every agent; PB's bot adapter does the
    // Graph work via /api/internal/agent-teams/*. Dispatched on the actionType
    // prefix, same as Slack — no per-agent "Teams" connector row is required.
    if (family === 'agent-teams') {
      const { agentTeamsHandler } = await import('./agent-teams-handler');
      return agentTeamsHandler.execute({
        tenantId: input.tenantId,
        agentId: input.agentId,
        toolName: input.actionType,
        toolInput: (input.payload ?? {}) as Record<string, unknown>,
        traceId: input.traceId,
      });
    }

    // Route custom MCP server tool calls. Custom MCP servers are first-class
    // connectors row entries (connector.type === 'custom_mcp_server'), so the
    // upstream allowlist/HITL gates already validated this call. The handler
    // resolves the endpoint URL from platform-backend, looks up credentials in
    // Secret Manager, and dispatches via the standard MCP streamable-http
    // transport — same shape as external-agent MCP calls.
    if (family === 'custom-mcp-server') {
      const { customMcpServerHandler } = await import('./custom-mcp-server-handler');
      return customMcpServerHandler.execute({
        tenantId: input.tenantId,
        customMcpServerId: input.entityType,
        toolName: input.actionType,
        toolInput: input.payload ?? {},
        traceId: input.traceId,
      });
    }

    // Route to external agent handler if connector is 'external-agent'
    if (family === 'external-agent') {
      const { externalAgentHandler } = await import('./external-agent-handler');
      return externalAgentHandler.execute({
        tenantId: input.tenantId,
        agentId: input.agentId,
        instructionVersion: input.instructionVersion,
        traceId: input.traceId,
        idempotencyKey: input.idempotencyKey,
        externalAgentId: input.entityType,  // External agent ID passed as entityType
        toolName: input.actionType,          // MCP tool name passed as actionType
        toolInput: input.payload,
        skipHitl: input._internalSkipHitl,  // Phase 3.5D: pass HITL skip flag
        invocationId: input.invocationId,
      });
    }

    // Route execution environment sandbox tools
    // Sandbox tools go through admission control (per-tool-call credit deduction)
    // but skip connector-specific conflict detection and action ledger — sandbox has
    // its own audit table (sandbox_command_audit) and usage ledger (sandbox_usage_log).
    if (family === 'sandbox') {
      if (!this.sandboxExecutor) {
        throw new Error('Sandbox executor not configured');
      }

      // Per-tool-call admission control (tenant status / kill switches).
      // Thrown as AdmissionDeniedError, not a bare Error: a denial is a policy
      // outcome, and every surface downstream (model envelope, HTTP status,
      // audit row) reads the reason off the type instead of re-deriving it
      // from a message string.
      const admission = await this.admissionService.checkAdmission({
        tenantId: input.tenantId,
        agentId: input.agentId,
        checkType: 'action',
        requiredCredits: input.estimatedCredits,
      });
      if (!admission.allowed) {
        throw new AdmissionDeniedError({
          reason: admission.reason ?? 'Admission denied',
          quotaType: admission.quotaType,
          message: `Sandbox admission denied: ${admission.reason}`,
        });
      }

      // Sandbox identity comes from real run identity only. The trace id was
      // previously the fallback for both halves, which is what sent
      // `exec-<workflowId>-<taskId>-<hash>` into sandbox_state.session_id and
      // failed the lookup outright. Callers that legitimately have no
      // invocation (provisioning, sidecar callbacks, the parity rig) pass
      // their own handle in `workspaceSessionId`, so the fallback was only ever
      // reached by runs that HAD an identity and simply weren't handed it.
      const session: SandboxSession = {
        tenantId: input.tenantId,
        agentId: input.agentId,
        // The invocation handle keeps its trace-id fallback ON PURPOSE: the
        // sandbox tables store it as text (migration 286) and
        // asInvocationUuid() NULLs any non-uuid before it reaches
        // audit_logs.invocation_id, which is uuid with an FK to invocations.
        // Substituting a thread id here would be a well-formed uuid that is
        // NOT an invocations row — an FK violation the trace id cannot cause.
        invocationId: (input.payload?.invocationId as string) || input.invocationId || input.traceId,
        sessionId: sandboxSessionIdFor(input),
        instructionVersion: input.instructionVersion,
      };

      // §4.5 sandbox idempotency: claim-before / replay the WHOLE run so a
      // redelivery / crash-retry replays the prior result instead of re-executing
      // the script. Run-level granularity (in-script side effects are not
      // individually deduped). Posture at_most_once (we don't know what the code
      // did). No triggerKey (chat / non-redelivered) → passthrough.
      const { claimSideEffect, resolveSideEffect, failSideEffect } = await import('../agent-execution/sideeffect-idempotency');
      const runSandbox = () => this.sandboxExecutor.execute(session, {
        toolName: input.actionType,
        input: input.payload || {},
        id: input.idempotencyKey,
      });
      let result: Awaited<ReturnType<typeof this.sandboxExecutor.execute>>;
      if (input.triggerKey) {
        const claim = await claimSideEffect({
          tenantId: input.tenantId,
          triggerKey: input.triggerKey,
          toolName: `sandbox.${input.actionType}`,
          args: input.payload || {},
          policy: 'at_most_once',
        });
        if (claim.outcome === 'replay') {
          result = claim.result as Awaited<ReturnType<typeof this.sandboxExecutor.execute>>;
        } else if (claim.outcome === 'blocked') {
          return {
            success: false,
            data: { error: 'BLOCKED_PRIOR_ATTEMPT: a previous sandbox run for this trigger was interrupted; not re-run to avoid duplicate side effects.' },
            traceId: input.traceId,
            error: 'sandbox_blocked_prior_attempt',
          };
        } else {
          try {
            result = await runSandbox();
            await resolveSideEffect({ tenantId: input.tenantId, stepKey: claim.stepKey, result });
          } catch (e) {
            await failSideEffect({ tenantId: input.tenantId, stepKey: claim.stepKey, error: (e as Error).message });
            throw e;
          }
        }
      } else {
        result = await runSandbox();
      }

      // `error` carries the executor's message. Dropping it left a failed
      // sandbox call reaching the model as `{"success":false,"data":{}}`, which
      // the envelope could only classify as `internal_error, retryable:false` —
      // so a recoverable condition (a session that no longer exists, a missing
      // interpreter) arrived as an opaque wall the model could not act on.
      return {
        success: result.success,
        data: result.data,
        traceId: input.traceId,
        ...(result.error ? { error: result.error } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
        ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }

    // GAP-002 FIX: Check idempotency key before executing action
    // This prevents duplicate action execution
    const existingAction = await this.actionLedger.getByIdempotencyKey(input.idempotencyKey);
    if (existingAction) {
      if (existingAction.status === 'completed') {
        logger.info('Returning cached result for idempotent action', {
          idempotency_key: input.idempotencyKey,
          action_id: existingAction.id,
          trace_id: input.traceId,
        });
        return {
          success: true,
          data: existingAction.externalResponse,
          traceId: input.traceId,
        };
      } else if (existingAction.status === 'pending' || existingAction.status === 'executing' || existingAction.status === 'failed') {
        logger.info('Previous action failed, allowing retry', {
          idempotency_key: input.idempotencyKey,
          action_id: existingAction.id,
        });
        // Allow retry of failed actions
      }
    }

    // Per Section 15 + Phase 3 governance-engine integration:
    // Legacy path (in-process): AdmissionService + permission allowlist.
    // RPC path (governance-engine): Preflight (invocation-cached) +
    //   Authorize per tool call. The shadow-mode helper runs both under
    //   GOVERNANCE_SERVICE_ENABLED=shadow and compares; under =on it serves
    //   only the RPC path and fails-closed on RPC error.
    //
    // We intentionally keep the legacy in-process code intact — Phase 3
    // introduces the shadow path, NOT the cutover. Removal happens post-
    // cutover once shadow telemetry is clean.
    await withGovernanceShadowAndFallback<void>({
      operation: 'authorize',
      legacy: async () => {
        const admission = await this.admissionService.checkAdmission({
          tenantId: input.tenantId,
          agentId: input.agentId,
          checkType: 'action',
          requiredCredits: input.estimatedCredits,
        });
        if (!admission.allowed) {
          logger.warn({
            tenant_id: input.tenantId,
            agent_id: input.agentId,
            connector: input.connector,
            reason: admission.reason,
            quota_type: admission.quotaType,
          }, 'Action admission denied');
          throw new AdmissionDeniedError({
            reason: admission.reason ?? 'Admission denied',
            quotaType: admission.quotaType,
            message: `Action admission denied: ${admission.reason}`,
          });
        }
        // Per Section 10: Validate connector and action against allowlist
        await this.validateAllowlist(input);
      },
      rpc: async () => {
        // Preflight/admission is keyed by the INTERNAL agent id; the gateway
        // holds the runtime id. Translate first (see resolveGovernanceAgentId)
        // or admission fails-closed as BLOCKED for every provisioned agent.
        const governanceAgentId = await resolveGovernanceAgentId(input.tenantId, input.agentId);
        // Pull the cached preflight — invocation-scoped, 30s TTL, push-
        // invalidated by the kill-switch subscriber.
        const preflight = await getPreflight(
          input.tenantId,
          governanceAgentId,
          [input.connector],
          'standard',
          'sandbox',
        );
        const client = getGovernanceServiceClient();

        // Forward this action's DECLARED read classification so the engine trusts
        // a reviewed read instead of re-guessing from the action name (its name
        // heuristic gates reviewed reads whose verb it does not recognise — pdl
        // `enrich_company`, hunter `email_finder`). Resolved here, inside execute(),
        // so every dispatch path (connector handler, slack/teams, agent-execution,
        // batch, resumed) is covered at one point. Only a declared classification
        // is sent; an inferred/unknown one stays UNSPECIFIED (see resolveActionReadClass).
        // The tenant rides along (1b): a custom-MCP alias carries only an
        // eight-character id prefix that can collide across tenants, so the
        // custom cache is read under the tenant.
        const actionReadClass = resolveActionReadClass(input.tenantId, input.connector, input.actionType);
        // The class the engine is told, per governed call. The engine trusts a
        // DECLARED class over its name heuristic and logs neither, so this is
        // the one record of which rule decided a read: a 1b effect class that
        // reached the engine reads here as DECLARED_READ, and nowhere else.
        logger.info({
          event: 'action_read_class',
          tenant_id: input.tenantId,
          invocation_id: input.invocationId,
          connector: input.connector,
          action_type: input.actionType,
          action_read_class: ActionReadClass[actionReadClass],
        });

        const authorizeArgs = {
          preflightToken: preflight.preflightToken,
          idempotencyKey: input.idempotencyKey,
          connector: input.connector,
          entityType: input.entityType,
          actionType: input.actionType,
          actionReadClass,
          // NOT the derived target, deliberately. This field is not a record
          // here — it is an INPUT TO A DECISION, and populating it turns on a
          // gate that is effectively dormant.
          //
          // governance-engine's authorize does, guarded on a truthy targetRef:
          //
          //   if (req.connector && req.entityType && req.actionType && req.targetRef)
          //     → findInFlightConflicts(...) → decision = CONFLICT
          //
          // blocking a second write against the same
          // (tenant, connector, entity_type, target_ref, action_type) while one
          // is pending. With `GOVERNANCE_SERVICE_ENABLED` `on`, that branch is
          // live — and it is unreachable for almost every call only because the
          // old expression yielded '' for nearly all actions.
          //
          // Its semantics are wrong for the targets this now derives. A CREATE
          // has no prior identity, so `send_message` keys on its CONTAINER: two
          // different messages to #code-reviewer share the ref
          // `slack:C01ABCD2EFG` and would read as concurrent writes to one
          // entity. They are not. A stranded `pending` row would then block that
          // channel for five minutes and the caller sees
          // `authorize denied: decision=CONFLICT`.
          //
          // Turning a dormant safety gate on is a decision worth making on
          // purpose, with the create/update distinction taught to the engine
          // first. It should not ride along inside a data-quality fix. The audit
          // record (recordToGovernance) and the action ledger both carry the
          // real target; only the decision input stays as it was.
          //
          // One thing DOES change: `String(payload?.id ?? …)` produced the
          // string "null" when `id` was present and explicitly null, and "null"
          // is truthy — so those calls armed the gate against a target that
          // names nothing, and every one of them collided with every other.
          targetRef: legacyGovernanceTargetRef(input),
          payload: new Uint8Array(),
        };
        // thread_id added in proto-gen 0.5.4 — assign after construction to
        // avoid excess-property-check failure against the installed 0.3.x type.
        Object.assign(authorizeArgs, { threadId: input.threadId ?? '' });
        const resp = await client.authorize(authorizeArgs as unknown as AuthorizeRequest);
        if (resp.decision !== AuthorizeDecision.ALLOWED) {
          const reasonName = AdmissionReason[(resp as { blockedReason?: number }).blockedReason ?? 0] ?? 'UNSPECIFIED';
          throw new Error(
            `Governance authorize denied: decision=${AuthorizeDecision[resp.decision]} reason=${reasonName}`,
          );
        }
      },
      // Both paths return void on success; no semantic comparison to do.
      compare: () => true,
    });

    // Get conflict policy
    const policy = await this.getConflictPolicy(
      input.connector,
      input.entityType,
      input.actionType
    );

    // === Section 7 Step 3: Capture pre-action snapshot ===
    // This happens BEFORE recording intent and BEFORE execution
    // The snapshot is used for both undo capability and conflict detection
    const snapshotResult = await this.capturePreActionSnapshot(input, policy);
    const preActionSnapshot = snapshotResult?.snapshot;

    // Per Section 7: For every external write-capable action:
    // 1. persist action intent
    // 2. persist idempotency key
    // 3. persist target reference and pre-action snapshot reference
    // 4. execute via tool gateway
    // 5. persist external response
    // 6. persist outcome
    // 7. commit workflow transition
    // 8. only then emit downstream completion events

    // === Section 7 Steps 1-3: Record intent WITH snapshot BEFORE conflict detection ===
    // Per Section 11: Record action in ledger with full audit trail
    // Including trace_id, undo_support_mode, and conflict_resolution_mode
    // NOTE: We record the ORIGINAL intended payload here, not the potentially merged one
    const target = this.deriveAndReportTarget(input);
    const actionId = await this.actionLedger.recordIntent({
      tenantId: input.tenantId,
      agentId: input.agentId,
      workflowId: input.payload?.workflowId || null,
      taskId: input.payload?.taskId || null,
      idempotencyKey: input.idempotencyKey,
      connector: input.connector,
      entityType: input.entityType,
      actionType: input.actionType,
      targetRef: target.ref,
      targetVersion: target.version,
      actKey: actKeyFor(directOperation(input.connector, input.actionType), target, input.payload),
      invocationId: input.invocationId,
      snapshot: preActionSnapshot,  // Use captured snapshot instead of input.snapshot
      // Per Section 11: Audit fields for structured logging
      traceId: input.traceId,
      instructionVersion: input.instructionVersion,
      undoSupportMode: policy.undoSupportMode,
      conflictResolutionMode: policy.conflictResolutionMode,
      payload: input.payload,  // Record original intended payload
      snapshotStatus: snapshotResult?.status ?? 'captured',
    });
    // Tell the wrapper this dispatch is already in the ledger, so its backstop
    // stands down. Without this the connector path would be recorded twice.
    receipt.actionId = actionId;

    // Per Section 11: Write path contract (conflict detection)
    // 1. Validate snapshot freshness threshold
    // 2. Fetch latest external state if required
    // 3. Compare version token or relevant fields
    // 4. Write only if policy passes
    // 5. Otherwise retry or escalate

    let resolvedPayload = input.payload;

    if (input.actionType === 'update' || input.actionType === 'delete') {
      // Pass the pre-captured snapshot to avoid double-fetching
      const writeResult = await this.executeWritePath(input, policy, preActionSnapshot);
      if (writeResult.mergedPayload) {
        resolvedPayload = writeResult.mergedPayload;
      }
    }

    logger.info({
      message: 'Action persisted to audit ledger',
      action_id: actionId,
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      connector: input.connector,
      action_type: input.actionType,
      entity_type: input.entityType,
      trace_id: input.traceId,
      undo_support_mode: policy.undoSupportMode,
      conflict_resolution_mode: policy.conflictResolutionMode,
    });

    // Execution timing for the audit record is stamped by the execute()
    // wrapper, which spans this whole method including the early returns.
    // Hoisted so the catch can inspect a classified {success:false} result and
    // rethrow it as a ToolExecutionError carrying the structured contract.
    let result: ExecuteResult | undefined;
    try {
      // Execute the actual connector call with potentially merged payload.
      // The ledger actionId rides along so a paid (x402) call's cost row can
      // join back to the actions row that caused it.
      result = await this.executeConnectorCall({
        ...input,
        payload: resolvedPayload,
      }, actionId);

      // Phase 5: output guardrails — scan/transform tool output before handing
      // to the LLM. Shared with the batched fast path; see the method.
      result = await this.applyOutputGuardrails(input, result);

      // Opportunistically index read-action results for hybrid retrieval.
      // Fire-and-forget: failures must never block the tool call response.
      this.indexToolResult(input, result);

      // Record outcome (legacy action ledger — kept during shadow).
      await this.actionLedger.recordOutcome(actionId, result, {
        connector: input.connector, actionType: input.actionType, entityType: input.entityType,
      });

      // Audit Log Hardening (System 1): capture post-action snapshot for CREATE
      // operations. This snapshot becomes the "before" baseline for any future
      // agent update on the same record, enabling conflict detection from day one.
      const isCreate =
        input.actionType.startsWith('create') ||
        input.actionType.startsWith('insert') ||
        input.actionType.startsWith('append') ||
        input.actionType.startsWith('post') ||
        input.actionType.startsWith('send') ||
        input.actionType.startsWith('write');

      let postSnapshot: unknown = null;
      if (isCreate && result.success) {
        postSnapshot = result.data ?? null;
        if (postSnapshot && this.isIdOnlyResponse(postSnapshot)) {
          // Vendor returned ID-only; fetch full record for the snapshot
          try {
            const fullState = await this.fetchExternalState({
              ...input,
              payload: { ...input.payload, id: (postSnapshot as { id: string }).id },
            });
            postSnapshot = fullState.data;
          } catch (err) {
            logger.warn({ err: (err as Error).message, actionId }, 'Failed to fetch full record for post-action snapshot — using ID-only response');
          }
        }
        if (postSnapshot) {
          await this.actionLedger.recordPostActionSnapshot(actionId, postSnapshot).catch(err =>
            logger.warn({ err: (err as Error).message, actionId }, 'Failed to record post-action snapshot')
          );
        }
      }

      // Governance record is written by the execute() wrapper, which sees
      // every exit from this method rather than only this one.
      return {
        ...result,
        preActionSnapshot: preActionSnapshot ?? null,
        postActionSnapshot: (isCreate && postSnapshot) ? postSnapshot as Record<string, unknown> : null,
        externalResponse: result.data ?? null,
        snapshotStatus: snapshotResult?.status ?? 'captured',
      };
    } catch (error) {
      await this.actionLedger.recordFailure(actionId, error);
      // Governance record on the throw path is written by execute()'s catch.

      // Already-typed contract → propagate unchanged.
      if (error instanceof ToolExecutionError) throw error;
      // A classified connector failure that a later step (audit/governance
      // write) turned into a throw: surface the contract to downstream catch
      // sites instead of an opaque Error. Raw infra throws stay as-is →
      // classified as internal_error by consumers.
      if (result && !result.success && result.errorCode) {
        const message = result.error ?? (error as Error).message;
        throw new ToolExecutionError(message, {
          code: result.errorCode,
          retryable: result.retryable ?? isRetryable(result.errorCode),
          retryAfterMs: result.retryAfterMs,
          recovery: result.recovery ?? recoveryFor(result.errorCode, { connectorType: input.connector }),
          message,
        });
      }
      throw error;
    }
  }

  /**
   * Phase 3: WAL + governance-engine Record. Writes the audit entry to the
   * local `governance_wal` table synchronously (survives engine outages),
   * then calls Record via the shadow-mode helper. Record is fire-and-forget
   * on the engine side (returns 202 Accepted).
   */
  /**
   * Derive the ledger target, and say so when a WRITE could not produce one.
   *
   * A read with no target is unremarkable — `github search {query}` names no
   * entity and never will. A write with no target is a missing rule, and it is
   * invisible unless something says it out loud: the column is NOT NULL, so the
   * gap stores as `''` and looks exactly like a read that had nothing to name.
   * That indistinguishability is how 97.5% of the table came to be unkeyed
   * without anyone noticing for the fourteen months the column has existed.
   *
   * Logged, not thrown. Refusing the dispatch would be truer, and would break
   * every connector whose rule is not yet written — which is most of them, since
   * there are far more Composio toolkits than hand-written rules. The log is
   * greppable by connector and action, so the next rule to write is the one that
   * appears most.
   */
  private deriveAndReportTarget(input: ExecuteInput): DerivedTarget {
    const target = deriveTarget(input);
    if (!target.ref && isWriteAction(input.actionType)) {
      logger.warn({
        tenant_id: input.tenantId,
        connector: input.connector,
        action_type: input.actionType,
        entity_type: input.entityType,
        payload_keys: Object.keys((input.payload ?? {}) as Record<string, unknown>).sort(),
      }, 'action-ledger: write action produced no target_ref — no rule matched its payload');
    }
    return target;
  }

  private async recordToGovernance(args: {
    input: ExecuteInput;
    status: number;
    durationMs: number;
    error: string;
    result: ExecuteResult | null;
  }): Promise<void> {
    if (getGovernanceServiceMode() === 'off') return;

    const { input } = args;
    const targetRef = deriveTarget(input).ref;
    const recordPayload = {
      preflightToken: '', // populated server-side against cached preflight
      idempotencyKey: input.idempotencyKey,
      connector: input.connector,
      entityType: input.entityType,
      actionType: input.actionType,
      targetRef,
      traceId: input.traceId,
      durationMs: BigInt(args.durationMs),
      status: args.status,
      error: args.error,
      costUsd: 0,
      externalResponse: new Uint8Array(),
      threadId: input.threadId ?? '',
    };

    try {
      await writeWalEntry({
        tenantId: input.tenantId,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        actionPayload: recordPayload,
        result: args.result ? { success: args.result.success } : null,
        costUsd: 0,
        vendorLatencyMs: args.durationMs,
      });
    } catch (err) {
      // WAL write failure is logged but does not break the caller — audit
      // loss is bad, but the user-facing tool call has already succeeded.
      logger.warn(
        { err: (err as Error).message, idempotencyKey: input.idempotencyKey },
        'governance_wal write failed',
      );
    }

    // Record via shadow-mode. Legacy path is no-op (action ledger already
    // wrote). Under 'on', the drainer catches any RPC failures.
    try {
      await withGovernanceShadowAndFallback<void>({
        operation: 'record',
        legacy: async () => undefined,
        rpc: async () => {
          const client = getGovernanceServiceClient();
          await client.record(recordPayload);
        },
        compare: () => true,
      });
    } catch (err) {
      // In 'on' mode an RPC failure re-throws — but we swallow here because
      // Record is fire-and-forget per proto docs and the WAL drainer will
      // replay. (Only the authorize path is hard-fail on 'on'.)
      logger.warn(
        { err: (err as Error).message, idempotencyKey: input.idempotencyKey },
        'governance-engine Record RPC failed (wal drainer will replay)',
      );
    }
  }

  // Per Section 11: Conflict-policy registry
  async getConflictPolicy(
    connector: string,
    entityType: string,
    actionType: string
  ): Promise<ConflictPolicy> {
    return this.registry.get(connector, entityType, actionType);
  }

  private validateIdentity(input: ExecuteInput): void {
    if (!input.tenantId) throw new Error('Tenant ID required');
    if (!input.agentId) throw new Error('Agent ID required');
    if (!input.instructionVersion) throw new Error('Instruction version required');
  }

  // Per Section 10: Tool gateway enforces action allowlist
  private async validateAllowlist(input: ExecuteInput): Promise<void> {
    const result = await permissionValidator.validate({
      tenantId: input.tenantId,
      agentId: input.agentId,
      instructionVersion: input.instructionVersion,
      connector: input.connector,
      actionType: input.actionType,
      entityType: input.entityType,
      payload: input.payload,
    });

    if (!result.allowed) {
      logger.warn('Action not allowed by permission policy', {
        tenantId: input.tenantId,
        agentId: input.agentId,
        connector: input.connector,
        actionType: input.actionType,
        entityType: input.entityType,
        reason: result.reason,
        deniedFields: result.deniedFields,
      });

      throw new Error(`Permission denied: ${result.reason}`);
    }

    // Log allowed action with applied policy
    logger.info('Action permitted by allowlist', {
      tenantId: input.tenantId,
      connector: input.connector,
      actionType: input.actionType,
      entityType: input.entityType,
      policyId: result.appliedEntry?.id,
      allowedFields: result.allowedFields,
    });
  }

  /**
   * Per Section 7 Step 3: Capture pre-action snapshot before execution
   * This is separate from conflict detection - it's for undo/restore capability
   */
  private async capturePreActionSnapshot(
    input: ExecuteInput,
    _policy: ConflictPolicy
  ): Promise<{ snapshot: any; versionToken?: string; status?: string } | null> {
    // Audit Log Hardening: if the HITL approval flow set skipSnapshotCapture,
    // skip silently and return an explicit 'unavailable_approved' status so the
    // caller can persist it to snapshot_status.
    if (input.skipSnapshotCapture) {
      logger.info('Snapshot capture skipped — human-approved override', {
        connector: input.connector,
        entityType: input.entityType,
      });
      return { snapshot: null, status: 'unavailable_approved' as const };
    }

    // SHORT-TERM PATCH (NOT the durable design — see "Durable mutability metadata"
    // in the implementation plan follow-ups). Skip snapshot capture for any action
    // whose name looks read-only by convention. Capturing a snapshot for a read is
    // wasteful because reads can't conflict with anything, and it costs a
    // credential refresh + an API call we don't need.
    //
    // Why this is a short-term patch and not the clean final design: this is a
    // NAME-PREFIX heuristic. It encodes mutability via the action's English name
    // rather than via metadata that explicitly declares it. If anyone ever ships
    // a connector action named `read_only_dry_run` that DOES mutate state (a
    // sync verb starting with `get_`, an idempotent UPSERT named `getOrCreate`,
    // etc.), the heuristic will skip the snapshot for a write and break undo /
    // conflict detection silently. The durable fix is to encode `mutates_state:
    // bool` in the connector function registry or the conflict policy registry,
    // then check that flag here instead of grepping the action name. We are NOT
    // doing the durable fix in this commit because it touches every connector
    // function definition and the registry shape. The next time this snapshot
    // logic is touched, this heuristic should be replaced — not extended with
    // more prefixes.
    // Use prefix matching for compound action names too. Connector functions
    // can be named `create_values`, `write_row`, `read_spreadsheet`, etc.
    // Snapshot capture is only useful for mutating actions on EXISTING
    // entities (update/delete style); for creates and reads it's wasted
    // work that costs an extra credential refresh + an API call.
    const isCreateVerb =
      input.actionType.startsWith('create') ||
      input.actionType.startsWith('write') ||
      input.actionType.startsWith('insert') ||
      input.actionType.startsWith('append') ||
      input.actionType.startsWith('post') ||
      input.actionType.startsWith('send');

    const isReadVerb =
      input.actionType.startsWith('read') ||
      input.actionType.startsWith('list') ||
      input.actionType.startsWith('get') ||
      input.actionType.startsWith('fetch') ||
      input.actionType.startsWith('search') ||
      input.actionType.startsWith('find') ||
      input.actionType.startsWith('query');

    if (isCreateVerb || isReadVerb) {
      logger.debug('Skipping snapshot capture for non-mutating action', {
        connector: input.connector,
        entityType: input.entityType,
        actionType: input.actionType,
      });
      return { snapshot: null, status: isCreateVerb ? 'skipped_create' : 'skipped_read_op' };
    }

    // If caller provided a snapshot, trust it
    if (input.snapshot) {
      logger.debug('Using caller-provided snapshot', {
        connector: input.connector,
        entityType: input.entityType,
      });
      return { snapshot: input.snapshot };
    }

    // For UPDATE/DELETE, always capture current state for undo capability
    const entityId = input.payload?.id || input.payload?.targetRef || input.payload?.entityId;
    if (!entityId) {
      logger.warn('No entity ID for snapshot capture - proceeding without snapshot', {
        connector: input.connector,
        entityType: input.entityType,
        actionType: input.actionType,
      });
      return { snapshot: null, status: 'skipped_no_entity_id' };
    }

    logger.info('Capturing pre-action snapshot', {
      connector: input.connector,
      entityType: input.entityType,
      entityId,
      traceId: input.traceId,
    });

    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [0, 100, 2000]; // delay before attempt 0, 1, 2 respectively

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, BACKOFF_MS[attempt]));
      }
      try {
        const externalState = await this.fetchExternalState(input);
        if (attempt === 0) {
          logger.info('Pre-action snapshot captured successfully', {
            connector: input.connector,
            entityType: input.entityType,
            entityId,
            hasVersionToken: !!externalState.versionToken,
            traceId: input.traceId,
          });
        } else {
          logger.info('Pre-action snapshot captured on retry', {
            attempt,
            connector: input.connector,
            entityType: input.entityType,
            entityId,
            traceId: input.traceId,
          });
        }
        return { snapshot: externalState.data, versionToken: externalState.versionToken, status: 'captured' as const };
      } catch (err) {
        if (attempt < MAX_ATTEMPTS - 1) continue;
        // All attempts exhausted — block the write to preserve audit integrity
        logger.error('Pre-action snapshot capture failed after all retries — blocking write', {
          connector: input.connector,
          entityType: input.entityType,
          entityId,
          error: (err as Error).message,
          traceId: input.traceId,
        });
        throw new SnapshotUnavailableError(
          `Cannot capture pre-action state for ${input.connector}/${input.entityType}/${entityId} ` +
          `after ${MAX_ATTEMPTS} attempts: ${(err as Error).message}. ` +
          `Write blocked to preserve audit integrity. ` +
          `To proceed without audit trail, re-submit with skipSnapshotCapture: true after human approval.`
        );
      }
    }
  }

  private async executeWritePath(
    input: ExecuteInput,
    policy: ConflictPolicy,
    capturedSnapshot?: any  // Pre-captured snapshot from capturePreActionSnapshot()
  ): Promise<{ mergedPayload?: any }> {
    // Per Section 11: Write path contract
    if (!policy.freshReadBeforeWriteRequired) {
      return {};
    }

    // Fetch latest external state for conflict detection
    // Note: This may be redundant if capturedSnapshot was just fetched,
    // but ensures we have the absolute latest state for conflict comparison
    let externalState: ExternalState;
    try {
      externalState = await this.fetchExternalState(input);
    } catch (error) {
      logger.warn('Could not fetch external state for conflict detection, proceeding without', {
        connector: input.connector, error: (error as Error).message,
      });
      // Proceed without conflict detection
      return {};
    }

    // Check freshness threshold
    if (policy.freshnessTTL && this.isStale(externalState, policy.freshnessTTL)) {
      throw new Error('Snapshot is stale - external state changed outside freshness window');
    }

    // Detect conflicts using the pre-captured snapshot as baseline
    // If no snapshot was captured, use the just-fetched external state as baseline
    // (this means we can't detect conflicts, but the action can still proceed)
    const conflictDetection = this.detectConflicts(
      capturedSnapshot || externalState.data,  // Use captured snapshot as baseline
      input.payload,
      externalState.data,
      policy
    );

    if (!conflictDetection.hasConflict) {
      logger.info('No conflict detected', {
        connector: input.connector,
        entityType: input.entityType,
        traceId: input.traceId,
      });
      return {};
    }

    // Handle conflict based on policy
    const resolution = await this.handleConflict(input, policy, externalState.data, conflictDetection);

    return { mergedPayload: resolution.mergedPayload };
  }

  // Detect conflicts between local changes and remote state
  private detectConflicts(
    snapshot: any,
    localPayload: any,
    remoteState: any,
    policy: ConflictPolicy
  ): ConflictDetection {
    if (!snapshot) {
      // No snapshot to compare - can't detect conflicts
      return {
        hasConflict: false,
        conflictingFields: [],
        localChanges: [],
        remoteChanges: [],
      };
    }

    const localChanges: FieldChange[] = [];
    const remoteChanges: FieldChange[] = [];
    const conflictingFields: string[] = [];

    // Compare fields in the comparison set
    const fieldsToCheck = policy.fieldComparisonSet.length > 0
      ? policy.fieldComparisonSet
      : Object.keys({ ...localPayload, ...remoteState });

    for (const field of fieldsToCheck) {
      const snapshotValue = snapshot[field];
      const localValue = localPayload[field];
      const remoteValue = remoteState[field];

      // Check if local wants to change this field
      const localChanged = localValue !== undefined && !this.valuesEqual(snapshotValue, localValue);
      // Check if remote changed since snapshot
      const remoteChanged = !this.valuesEqual(snapshotValue, remoteValue);

      if (localChanged) {
        localChanges.push({ field, oldValue: snapshotValue, newValue: localValue });
      }

      if (remoteChanged) {
        remoteChanges.push({ field, oldValue: snapshotValue, newValue: remoteValue });
      }

      // Conflict occurs when both local and remote changed the same field differently
      if (localChanged && remoteChanged && !this.valuesEqual(localValue, remoteValue)) {
        conflictingFields.push(field);
      }
    }

    // Also check version token if present
    if (policy.versionTokenField) {
      const snapshotVersion = snapshot[policy.versionTokenField];
      const remoteVersion = remoteState[policy.versionTokenField];
      if (snapshotVersion !== remoteVersion) {
        // Version mismatch indicates remote changed
        if (conflictingFields.length === 0 && remoteChanges.length === 0) {
          // Version changed but no field conflicts detected - record as generic change
          remoteChanges.push({
            field: policy.versionTokenField,
            oldValue: snapshotVersion,
            newValue: remoteVersion,
          });
        }
      }
    }

    return {
      hasConflict: conflictingFields.length > 0,
      conflictingFields,
      localChanges,
      remoteChanges,
    };
  }

  private valuesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  }

  private async handleConflict(
    input: ExecuteInput,
    policy: ConflictPolicy,
    currentState: any,
    detection: ConflictDetection
  ): Promise<MergeResolution> {
    logger.info('Handling conflict', {
      connector: input.connector,
      entityType: input.entityType,
      conflictingFields: detection.conflictingFields,
      resolutionMode: policy.conflictResolutionMode,
      traceId: input.traceId,
    });

    // Per Section 11: Supported resolution modes
    switch (policy.conflictResolutionMode) {
      case 'compare-and-set':
        // Strict conflict - fail if any conflict
        throw new Error(
          `Conflict detected: version mismatch on fields [${detection.conflictingFields.join(', ')}]`
        );

      case 'fresh-read-before-write':
        // Retry with fresh state - caller should refetch and retry
        throw new Error('Conflict detected: please refetch and retry');

      case 'last-write-wins':
        // Allow local changes to proceed, ignoring remote changes
        return {
          strategy: 'local-wins',
          mergedPayload: input.payload,
          conflictsResolved: detection.conflictingFields,
          conflictsEscalated: [],
        };

      case 'escalate-on-conflict':
        // Create escalation request
        await this.escalateConflict(input, detection);
        throw new Error('Conflict escalated to human review');

      case 'merge':
        // Attempt automatic merge
        return this.performMerge(input, currentState, detection, policy);

      default:
        throw new Error(`Unknown conflict resolution mode: ${policy.conflictResolutionMode}`);
    }
  }

  // Perform field-level merge
  private performMerge(
    input: ExecuteInput,
    currentState: any,
    detection: ConflictDetection,
    policy: ConflictPolicy
  ): MergeResolution {
    const mergedPayload = { ...currentState };
    const conflictsResolved: string[] = [];
    const conflictsEscalated: string[] = [];

    // Apply local changes for non-conflicting fields
    for (const change of detection.localChanges) {
      if (!detection.conflictingFields.includes(change.field)) {
        mergedPayload[change.field] = change.newValue;
        conflictsResolved.push(change.field);
      }
    }

    // Handle conflicting fields
    for (const field of detection.conflictingFields) {
      const localChange = detection.localChanges.find((c) => c.field === field);
      const remoteChange = detection.remoteChanges.find((c) => c.field === field);

      if (!localChange || !remoteChange) continue;

      // Strategy: Try to merge based on field type and values
      const merged = this.attemptFieldMerge(field, localChange, remoteChange);

      if (merged.success) {
        mergedPayload[field] = merged.value;
        conflictsResolved.push(field);
        logger.info('Auto-merged field', { field, strategy: merged.strategy });
      } else {
        // Cannot auto-merge - escalate if policy requires
        if (policy.escalateOnConflict) {
          conflictsEscalated.push(field);
        } else {
          // Default: local wins for unresolvable conflicts
          mergedPayload[field] = localChange.newValue;
          conflictsResolved.push(field);
        }
      }
    }

    // If any conflicts were escalated, throw
    if (conflictsEscalated.length > 0) {
      throw new Error(
        `Cannot auto-merge fields [${conflictsEscalated.join(', ')}] - requires human review`
      );
    }

    return {
      strategy: 'auto-merge',
      mergedPayload,
      conflictsResolved,
      conflictsEscalated,
    };
  }

  // Attempt to merge a single field
  private attemptFieldMerge(
    field: string,
    localChange: FieldChange,
    remoteChange: FieldChange
  ): { success: boolean; value?: any; strategy?: string } {
    // Strategy 1: If both changed to the same value, no conflict
    if (this.valuesEqual(localChange.newValue, remoteChange.newValue)) {
      return { success: true, value: localChange.newValue, strategy: 'same-value' };
    }

    // Strategy 2: Numeric fields - check if changes are additive
    if (typeof localChange.newValue === 'number' && typeof remoteChange.newValue === 'number') {
      const originalValue = localChange.oldValue as number;
      const localDelta = localChange.newValue - originalValue;
      const remoteDelta = remoteChange.newValue - originalValue;

      // Both increased or both decreased - use larger absolute change
      if ((localDelta >= 0 && remoteDelta >= 0) || (localDelta <= 0 && remoteDelta <= 0)) {
        const mergedValue = originalValue + localDelta + remoteDelta;
        return { success: true, value: mergedValue, strategy: 'numeric-combine' };
      }
    }

    // Strategy 3: Array fields - union of additions
    if (Array.isArray(localChange.newValue) && Array.isArray(remoteChange.newValue)) {
      const originalSet = new Set(localChange.oldValue || []);
      const localAdditions = (localChange.newValue as any[]).filter((v) => !originalSet.has(v));
      const remoteAdditions = (remoteChange.newValue as any[]).filter((v) => !originalSet.has(v));

      // Combine unique additions
      const merged = [
        ...new Set([...localChange.oldValue, ...localAdditions, ...remoteAdditions]),
      ];
      return { success: true, value: merged, strategy: 'array-union' };
    }

    // Strategy 4: String concatenation for append-style fields
    if (
      typeof localChange.newValue === 'string' &&
      typeof remoteChange.newValue === 'string' &&
      typeof localChange.oldValue === 'string'
    ) {
      const original = localChange.oldValue;
      // Check if both are appending
      if (
        localChange.newValue.startsWith(original) &&
        remoteChange.newValue.startsWith(original)
      ) {
        const localAppend = localChange.newValue.slice(original.length);
        const remoteAppend = remoteChange.newValue.slice(original.length);
        const merged = original + localAppend + remoteAppend;
        return { success: true, value: merged, strategy: 'string-append' };
      }
    }

    // Cannot auto-merge
    return { success: false };
  }

  private async escalateConflict(
    input: ExecuteInput,
    detection: ConflictDetection
  ): Promise<void> {
    const escalation: EscalationRequest = {
      tenantId: input.tenantId,
      agentId: input.agentId,
      connector: input.connector,
      entityType: input.entityType,
      // `'unknown'` used to be the fallback here, which reads as a value and
      // sorts alongside real ones on the escalation queue. An empty string is
      // the honest shape for "the payload named nothing".
      targetRef: deriveTarget(input).ref,
      conflict: detection,
      reason: `Conflict on fields: ${detection.conflictingFields.join(', ')}`,
      priority: detection.conflictingFields.length > 3 ? 'high' : 'medium',
    };

    logger.info('Escalating conflict to human review', {
      connector: input.connector,
      entityType: input.entityType,
      conflictingFields: detection.conflictingFields,
      traceId: input.traceId,
    });

    // Store escalation for human review
    // This would integrate with the escalation system
    await this.storeEscalation(escalation);
  }

  // GAP-006 FIX: Persist escalation requests to database for human-in-loop approval
  private async storeEscalation(escalation: EscalationRequest): Promise<string> {
    const pool = getPool();
    const id = `esc_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    await pool.query(
      `INSERT INTO escalation_requests (
        id, tenant_id, agent_id, workflow_id, task_id, connector, entity_type,
        target_ref, conflict_data, reason, priority, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NOW(), NOW())`,
      [
        id,
        escalation.tenantId,
        escalation.agentId,
        escalation.workflowId || null,
        escalation.taskId || null,
        escalation.connector,
        escalation.entityType,
        escalation.targetRef,
        JSON.stringify(escalation.conflict),
        escalation.reason,
        escalation.priority,
      ]
    );

    logger.info('Escalation persisted to database', {
      escalation_id: id,
      tenantId: escalation.tenantId,
      connector: escalation.connector,
      entityType: escalation.entityType,
      priority: escalation.priority,
    });

    return id;
  }

  // Get pending escalations for tenant (for human review UI)
  async getPendingEscalations(tenantId: string): Promise<EscalationRequest[]> {
    const pool = getPool();

    const result = await pool.query(
      `SELECT * FROM escalation_requests
       WHERE tenant_id = $1 AND status = 'pending'
       ORDER BY priority DESC, created_at ASC`,
      [tenantId]
    );

    return result.rows.map((row: any) => ({
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      workflowId: row.workflow_id,
      taskId: row.task_id,
      connector: row.connector,
      entityType: row.entity_type,
      targetRef: row.target_ref,
      conflict: JSON.parse(row.conflict_data),
      reason: row.reason,
      priority: row.priority,
    }));
  }

  // Approve escalation request
  async approveEscalation(escalationId: string, resolution: any): Promise<void> {
    const pool = getPool();

    await pool.query(
      `UPDATE escalation_requests
       SET status = 'approved', resolution = $2, resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [escalationId, JSON.stringify(resolution)]
    );

    logger.info('Escalation approved', { escalation_id: escalationId });
  }

  // Reject escalation request
  async rejectEscalation(escalationId: string, reason: string): Promise<void> {
    const pool = getPool();

    await pool.query(
      `UPDATE escalation_requests
       SET status = 'rejected', rejection_reason = $2, resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [escalationId, reason]
    );

    logger.info('Escalation rejected', { escalation_id: escalationId, reason });
  }

  /**
   * Audit Log Hardening (System 1): check if the connector response is ID-only
   * (e.g., { id: "xyz" }). If so, fetch the full record for the post-action snapshot.
   */
  private isIdOnlyResponse(data: unknown): data is { id: string } {
    if (!data || typeof data !== 'object') return false;
    const keys = Object.keys(data as object);
    return keys.length <= 2 && keys.some(k => k === 'id' || k === 'Id' || k.endsWith('_id'));
  }

  private async fetchExternalState(input: ExecuteInput): Promise<ExternalState> {
    logger.info('Fetching external state', {
      connector: input.connector,
      entityType: input.entityType,
      traceId: input.traceId,
    });

    // Get entity ID from payload
    const entityId = input.payload.id || input.payload.targetRef || input.payload.entityId;
    if (!entityId) {
      throw new Error('Entity ID required for external state fetch');
    }

    // Phase 2c: the per-connector state fetchers now call ConnectorService.Execute
    // internally, so tenant-runtime no longer needs to resolve credentials or
    // even look up the connector UUID — the connector-service identifies the
    // right connector by (tenantId, connectorType) from its own manifest. The
    // credentialProvider below is a vestigial no-op kept for signature compat;
    // the new RpcStateFetcher ignores it.
    const credentialProvider = async () => ({ accessToken: '' });

    return this.stateFetcher.fetchState(
      input.connector,
      credentialProvider,
      input.entityType,
      entityId,
    );
  }

  private isStale(state: ExternalState, ttlSeconds: number): boolean {
    const now = Date.now();
    const fetchedAt = state.fetchedAt.getTime();
    const ageMs = now - fetchedAt;
    const ttlMs = ttlSeconds * 1000;

    return ageMs > ttlMs;
  }

  /**
   * Phase 1a-ii perf fix #2 — Batch dispatch for parallel tool-use turns.
   *
   * When the LLM returns an array of independent connector tool-use blocks in
   * the same turn, callers can hand them here as a single batch. This runs
   * per-operation governance (admission, allowlist, idempotency check,
   * action-ledger recordIntent) in parallel via Promise.all, then flushes a
   * single ConnectorService.ExecuteBatch RPC for all survivors — one wire
   * hop instead of N.
   *
   * Per-operation semantics are preserved: each result carries its own
   * success/error, failures don't cancel siblings, and the action ledger
   * records outcomes per-call.
   *
   * Safety guardrails (to avoid disturbing conflict-detection semantics):
   * - Any input whose actionType is 'update' or 'delete' falls through to
   *   the serial `execute()` path so snapshot capture + conflict detection
   *   run exactly as before.
   * - Inputs with the `external` / `external-agent` / `execution_environment`
   *   connector are not eligible for the batch fast-path (they don't hit
   *   connector-service) and should be pre-filtered by callers; if they slip
   *   through we fall back to serial per-item execution.
   * - A batch of size 1 still issues one ExecuteBatch RPC — that's
   *   intentional and simpler than branching on length.
   */
  async executeBatch(inputs: ExecuteInput[]): Promise<ExecuteResult[]> {
    if (inputs.length === 0) return [];

    // Wall clock for the batch, used as the audited duration for each slot.
    // Per-slot timing is not separable here — the connector-service RPC runs
    // the whole batch in one call — so this is honestly the batch's duration,
    // not a fabricated per-item figure.
    const batchStart = Date.now();

    // Identify which inputs are safe for the RPC fast-path. Anything that
    // needs the conflict-detection / snapshot-capture write path goes
    // through the serial `execute()` implementation instead.
    // ELIGIBILITY IS DERIVED, NOT LISTED. This was a literal connector set that
    // had to be kept in step with `executeInner`'s routing by hand, and was not:
    // `custom_mcp_server` is routed to its own handler there and appeared in no
    // exclusion list here, so a batched call carrying it went to
    // connector-service as an ordinary operation. Asking the family table means
    // a family added tomorrow is excluded by existing.
    const fastPathEligible = (i: ExecuteInput): boolean => {
      if (!isOrdinaryConnectorDispatch(i)) return false;
      if (i.actionType === 'update' || i.actionType === 'delete') return false;
      return true;
    };

    // Partition. Preserve original indices so we can stitch results back in
    // caller order.
    type Indexed = { input: ExecuteInput; idx: number };
    const batchable: Indexed[] = [];
    const fallback: Indexed[] = [];
    inputs.forEach((input, idx) => {
      (fastPathEligible(input) ? batchable : fallback).push({ input, idx });
    });

    const out: ExecuteResult[] = new Array(inputs.length);

    // THE FAST PATH SKIPS `execute()`, SO IT SKIPS WHAT LIVES THERE. Each piece
    // was added here after being found missing — the recorder, the ledger row,
    // the governance row, the SSRF gate, the duplicate-outward guard — and this
    // file already names that as the shape to look for. Three checks had still
    // not been: the capability tri-state, repository scope, and write
    // provenance. The exclusion above keeps out only the two action types
    // literally named 'update' and 'delete', so `create_draft`, `send_message`
    // and `create_pull_request_review` are all eligible.
    //
    // The duplicate check is the caller's here, deliberately — see the note on
    // `seenInBatch` below, which the serial path cannot produce and this one
    // needs.
    //
    // Guarded here rather than by widening the exclusion, because the property
    // wanted is "every dispatch is guarded", not "writes avoid the fast path".
    // Iterated backwards so removing a held item cannot skip its neighbour.
    for (let i = batchable.length - 1; i >= 0; i -= 1) {
      const { input, idx } = batchable[i];
      const refusal = await this.preDispatchGuards(input, { duplicateHandledByCaller: true });
      if (refusal) {
        out[idx] = refusal;
        batchable.splice(i, 1);
      }
    }

    // Non-fast-path items run through the serial `execute()` pipeline which
    // preserves snapshot/conflict/write-path semantics. Run them in parallel
    // since each is independent at the governance layer.
    await Promise.all(
      fallback.map(async ({ input, idx }) => {
        try {
          out[idx] = await this.execute(input);
        } catch (error) {
          out[idx] = {
            success: false,
            data: null,
            traceId: input.traceId,
            error: (error as Error).message,
          };
        }
      }),
    );

    if (batchable.length === 0) return out;

    // THE SAME OUTWARD ACT, TWICE IN ONE RUN — ON THIS PATH TOO.
    //
    // A guard in `execute()` alone never runs on a real batched dispatch,
    // because `executeToolCalls` sends every batchable connector call here
    // instead — so one run can post to the same inline comment target five
    // times: the defect the guard was written for, happening under it.
    //
    // The same defect this file already records for `checkSsrfGate`, which was
    // also `execute()`-only until batched calls were found slipping past it.
    // Two checks have now been lost the same way, so this is the shape to look
    // for whenever something is added to `execute()`.
    //
    // WITHIN THE BATCH AS WELL AS BEFORE IT. Two identical calls arriving in
    // ONE batch are both absent from the ledger when either is looked up —
    // `findCompletedDuplicate` asks for a COMPLETED row and neither has
    // dispatched. The serial path cannot produce that ordering and so never
    // needed the check; here it is the ordinary case for a model that emits
    // parallel tool calls. `seenInBatch` closes it, keyed identically.
    const seenInBatch = new Set<string>();

    // Per-operation governance in parallel — admission, allowlist,
    // idempotency, action-ledger recordIntent. Any rejection becomes a
    // failure slot in the final result array; siblings continue.
    //
    // SURVIVORS KEEP CALLER ORDER. These callbacks resume in whatever order
    // their awaits settle, so pushing as each finishes made the RPC's operation
    // order depend on how fast an admission check or a ledger insert happened
    // to return. Results were still stitched back by `idx` and so were never
    // wrong, but the wire order was nondeterministic — and adding one more
    // await in front of the push was enough to change it. A slot per input,
    // compacted afterwards, makes the order the caller's.
    type Prepared = { idx: number; input: ExecuteInput; actionId: string };
    const preparedSlots: Array<Prepared | null> = new Array(batchable.length).fill(null);
    await Promise.all(
      batchable.map(async ({ input, idx }, slot) => {
        try {
          this.validateIdentity(input);

          // SSRF gate must fire on the batched-fast-path too. Without this
          // check, an untrusted_inbound invocation could batch a tool call
          // with a private-IP URL and skip the gate that lives in execute().
          const ssrfBlock = checkSsrfGate(input);
          if (ssrfBlock) {
            out[idx] = ssrfBlock;
            return;
          }

          // Before `recordIntent`, so a refused call leaves no ledger row —
          // the same ordering `execute()` keeps, and for the same reason.
          //
          // The claim is taken SYNCHRONOUSLY, before the first `await` in this
          // callback. `Promise.all` starts every callback before any of them
          // resumes, so a check-then-await-then-claim would let two identical
          // calls both pass the check and both dispatch — the race this set
          // exists to stop. Claiming first also makes the winner deterministic:
          // the earliest call in the batch, in caller order.
          const guardTarget = this.guardableTarget(input);
          if (guardTarget) {
            const key = duplicateKey(
              input.actionType, guardTarget, multiplexedOperation(input.payload),
              // Without this, every create of one action type in the batch
              // shares a key and the second is suppressed as a duplicate of a
              // different document.
              actKeyFor(directOperation(input.connector, input.actionType), guardTarget, input.payload),
            );
            const alreadyClaimed = seenInBatch.has(key);
            seenInBatch.add(key);

            // Both lookups here too. `executeBatch` re-implements this check
            // rather than sharing the serial path's, so a guard added to one and
            // not the other runs for some calls and not others — the shape that
            // let a governance gate added to `execute()` miss every batched
            // call. Same order as the serial path, same reason.
            const hit = alreadyClaimed
              ? null
              : ((await findCompletedDuplicate(input, guardTarget))
                 ?? (await findPriorVersionedAct(input, guardTarget)));
            if (alreadyClaimed || hit) {
              // A ledger hit can be ANSWERED with what the first call returned.
              // An in-batch twin cannot — it has not dispatched, so there is no
              // response to replay and a refusal is the honest answer.
              const outcome = hit
                ? duplicateReplay(input, guardTarget, hit)
                : duplicateRefusal(input, guardTarget, inFlightInBatch());
              await this.recordDuplicateSuppressed(input, guardTarget, hit?.actionId ?? null, outcome);
              out[idx] = outcome;
              return;
            }
          }

          // Idempotency short-circuit (matches serial path).
          const existingAction = await this.actionLedger.getByIdempotencyKey(input.idempotencyKey);
          if (existingAction && existingAction.status === 'completed') {
            out[idx] = {
              success: true,
              data: existingAction.externalResponse,
              traceId: input.traceId,
            };
            return;
          }

          const admission = await this.admissionService.checkAdmission({
            tenantId: input.tenantId,
            agentId: input.agentId,
            checkType: 'action',
            requiredCredits: input.estimatedCredits,
          });
          if (!admission.allowed) {
            // Batch items return a result rather than throwing, so the code
            // travels in the envelope the same way the thrown path carries it
            // on the error object. Without it a batch denial reaches the model
            // as an unclassified string and lands on the internal_error
            // heuristic — the same defect, one layer over.
            out[idx] = {
              success: false,
              data: null,
              traceId: input.traceId,
              error: formatToolErrorEnvelope({
                message: `Action admission denied: ${admission.reason}`,
                code: ADMISSION_DENIED_CODE,
                retryable: false,
                recovery: admissionDeniedRecovery(admission.reason ?? 'Admission denied'),
              }),
            };
            return;
          }

          await this.validateAllowlist(input);

          const policy = await this.getConflictPolicy(input.connector, input.entityType, input.actionType);
          const batchTarget = this.deriveAndReportTarget(input);

          // THE SNAPSHOT, which this path did not take. `recordIntent` was
          // called with `snapshot: undefined`, so every batched WRITE had
          // nothing for undo or conflict detection to restore from — while the
          // partition meant to send such writes down the serial path tests
          // whether the action is NAMED update or delete rather than whether it
          // mutates. `create_*`, `send_message`, `pull_request_review_write` and
          // `add_comment_to_pending_review` are all writes and none is named
          // either word.
          //
          // Captured here rather than by widening the partition, so a batch of
          // reads keeps its single wire hop. `capturePreActionSnapshot` skips
          // read-shaped actions itself, so this costs nothing on the common
          // case and gives a batched write exactly what a serial one gets.
          const batchSnapshot = await this.capturePreActionSnapshot(input, policy);

          const actionId = await this.actionLedger.recordIntent({
            tenantId: input.tenantId,
            agentId: input.agentId,
            workflowId: input.payload?.workflowId || null,
            taskId: input.payload?.taskId || null,
            idempotencyKey: input.idempotencyKey,
            connector: input.connector,
            entityType: input.entityType,
            actionType: input.actionType,
            targetRef: batchTarget.ref,
            targetVersion: batchTarget.version,
            actKey: actKeyFor(directOperation(input.connector, input.actionType), batchTarget, input.payload),
            invocationId: input.invocationId,
            snapshot: batchSnapshot?.snapshot,
            snapshotStatus: batchSnapshot?.status ?? 'captured',
            traceId: input.traceId,
            instructionVersion: input.instructionVersion,
            undoSupportMode: policy.undoSupportMode,
            conflictResolutionMode: policy.conflictResolutionMode,
            payload: input.payload,
          });

          preparedSlots[slot] = { idx, input, actionId };
        } catch (error) {
          out[idx] = {
            success: false,
            data: null,
            traceId: input.traceId,
            error: (error as Error).message,
          };
        }
      }),
    );

    const prepared: Prepared[] = preparedSlots.filter((p): p is Prepared => p !== null);
    if (prepared.length === 0) return out;

    // Single wire hop: coalesce all survivors into one ExecuteBatch RPC.
    // Every operation shares the same tenantContext (callers enforce this).
    const { getConnectorServiceClient } = await import('../connectors/connector-service-client');
    const client = getConnectorServiceClient();
    const tenantId = prepared[0].input.tenantId;

    let responses: Array<{
      success: boolean;
      result?: unknown;
      error?: string;
      errorCode?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      recovery?: string;
      costUsd?: number;
      fundingSource?: string;
    }> = [];
    try {
      const resp = await client.executeBatch({
        tenantContext: { tenantId },
        operations: prepared.map((p) => {
          // A claimed staged apply sends the model's arguments minus the
          // protocol's, here as on the serial path.
          const stagedPayload = this.stagedApplyPayload(p.input);
          const { connectorId, payload } = this.resolveBinding(stagedPayload ? { ...p.input, payload: stagedPayload } : p.input);
          return {
            tenantContext: { tenantId: p.input.tenantId },
            connectorId,
            functionName: p.input.actionType,
            input: (payload ?? {}) as never,
            idempotencyKey: p.input.idempotencyKey,
            traceId: p.input.traceId,
          };
        }) as never,
      }, { timeoutMs: Math.max(...prepared.map((p) => connectorCallDeadlineMs(p.input.payload))) });
      responses = resp.results.map((r) => ({
        success: r.success,
        result: r.result ?? null,
        error: r.error || undefined,
        // Structured error contract per batch slot (§5.3).
        errorCode: r.errorCode || undefined,
        retryable: r.retryable,
        retryAfterMs: r.retryAfterMs ? Number(r.retryAfterMs) : undefined,
        recovery: r.recovery || undefined,
        costUsd: r.costUsd,
        fundingSource: r.fundingSource,
      }));
    } catch (error) {
      // Entire batch RPC failed — fail every slot.
      const message = (error as Error).message;
      responses = prepared.map(() => ({ success: false, error: message }));
    }

    // Map responses back onto caller-order indices + record outcomes.
    await Promise.all(
      prepared.map(async ({ idx, input, actionId }, i) => {
        const r = responses[i] ?? { success: false, error: 'missing batch response slot' };
        let result: ExecuteResult;
        if (r.success) {
          // Same wallet-spend ledgering as the single-call path: a batch slot
          // the x402 wallet paid for must not become invisible spend just
          // because it rode the coalesced RPC (INV-PB-013).
          const { recordX402ConnectorUsage } = await import('./x402-usage');
          recordX402ConnectorUsage(input, r.costUsd ?? 0, actionId, r.fundingSource);
          result = { success: true, data: r.result ?? null, traceId: input.traceId };
          // Before `out[idx]`, the ledger outcome and the audit, so what is
          // handed to the model and what is recorded are the same scrubbed
          // value rather than two different ones.
          result = await this.applyOutputGuardrails(input, result);
          // AFTER the guardrails, so what lands in the retrieval index is the
          // scrubbed text. Indexing first would persist a credential the
          // guardrail exists to remove, in a table built to be searched.
          this.indexToolResult(input, result);
        } else {
          const errorMessage = r.error || 'connector-service returned an unsuccessful response';
          // Prefer the wire code; classify from the message for slots that
          // carry none (empty error_code / whole-batch RPC failure).
          const code = isToolErrorCode(r.errorCode) ? r.errorCode : classifyError({ message: errorMessage });
          result = {
            success: false,
            data: null,
            traceId: input.traceId,
            error: errorMessage,
            errorCode: code,
            retryable: r.retryable ?? isRetryable(code),
            retryAfterMs: r.retryAfterMs,
            recovery: r.recovery ?? recoveryFor(code, { connectorType: input.connector }),
          };
        }
        out[idx] = result;
        await this.settleStagedApply(input, { success: result.success, data: result.data, error: result.error });
        // Same recorder as the serial path. The fast path does not call
        // execute(), so a recorder wired only there would miss every batched
        // read — and poll-then-act, the shape this matters most for, batches.
        await this.recordProvenanceForResult(input, result);
        try {
          if (r.success) {
            await this.actionLedger.recordOutcome(actionId, result, { connector: input.connector, actionType: input.actionType, entityType: input.entityType });
          } else {
            await this.actionLedger.recordFailure(actionId, new Error(result.error || 'batch failure'));
          }
        } catch (err) {
          logger.warn({ err, actionId }, 'Non-fatal: action-ledger outcome write failed');
        }

        // Governance record for the batched fast path. This path does not go
        // through execute(), so the wrapper there never sees it — it was the
        // other half of why `governance_wal` was empty. The ten rows the
        // legacy ledger held for prod's last seven days were all batched
        // Google Sheets calls, and not one of them produced an audit row.
        //
        // Deliberately after the ledger write and outside its try: a failed
        // ledger write must not skip the audit, and a failed audit must not
        // skip the ledger.
        await this.recordToGovernance({
          input,
          status: r.success ? ActionStatus.COMPLETED : ActionStatus.FAILED,
          durationMs: Date.now() - batchStart,
          error: result.error ?? '',
          result,
        });
      }),
    );

    return out;
  }

  /**
   * Resolve `input.connector` against `input.bindingsByType` to produce the
   * concrete `connectorId` (UUID) for dispatch, and inject per-binding config
   * into the payload when applicable.
   *
   * - If `input.bindingsByType[input.connector]` exists, use that binding's
   *   UUID and inject Gmail-specific args (q, from) when relevant.
   * - If no map is provided, fall back to treating `input.connector` as an
   *   already-resolved UUID (legacy / non-agent-execution callers).
   * - If a map IS provided but the alias is not in it, throw — the agent is
   *   calling a connector it is not bound to.
   */
  private resolveBinding(input: ExecuteInput): {
    connectorId: string;
    payload: any;
  } {
    if (!input.bindingsByType) {
      // No map supplied: the caller is responsible for having resolved the
      // connector already. Legitimate for legacy and non-agent-execution
      // callers, which pass a connector TYPE or a UUID directly.
      //
      // A guard rejecting non-UUIDs here was tried and removed: it also refused
      // those callers, which are correct. The failure this was reaching for —
      // an agent-execution run dispatching the ALIAS because its map went
      // missing across a HITL pause — is fixed at the source, in the resume
      // rebuild that now carries bindingsByType. When a map IS supplied and the
      // alias is absent from it, the throw below already says so precisely.
      return { connectorId: input.connector, payload: input.payload };
    }

    const binding = input.bindingsByType[input.connector];
    if (!binding) {
      throw new Error(
        `Agent has no binding for connector "${input.connector}"`,
      );
    }

    let payload = input.payload;

    if (input.connector === 'google_mail' && binding.config) {
      const cfg = binding.config as { gmailQuery?: string; sendAs?: string };
      // Clone before mutating to avoid leaking injection back to the caller.
      payload = { ...(payload ?? {}) };
      if (input.actionType === 'list_messages' && cfg.gmailQuery) {
        const userQ = (payload as any).query;
        (payload as any).query = userQ
          ? `(${userQ}) (${cfg.gmailQuery})`
          : cfg.gmailQuery;
      }
      if (
        ['send_email', 'reply_email', 'forward_email'].includes(input.actionType) &&
        cfg.sendAs &&
        !(payload as any).from
      ) {
        (payload as any).from = cfg.sendAs;
      }
    }

    if (input.connector === 'microsoft_outlook_mail' && binding.config) {
      const cfg = binding.config as { outlookFilter?: string; sendAs?: string };
      payload = { ...(payload ?? {}) };

      // Inbound: AND user-supplied $filter with binding's outlookFilter
      if (input.actionType === 'list_messages' && cfg.outlookFilter) {
        const userFilter = (payload as any).filter as string | undefined;
        (payload as any).filter = userFilter
          ? `(${userFilter}) and (${cfg.outlookFilter})`
          : cfg.outlookFilter;
      }

      // Outbound: inject `from` for all send-side actions. Mirror Gmail's pattern
      // of only injecting when the agent didn't supply one explicitly.
      const outboundActions = new Set([
        'send_email', 'reply_email', 'forward_email', 'create_draft', 'create_reply_draft',
      ]);
      if (outboundActions.has(input.actionType) && cfg.sendAs && !(payload as any).from) {
        (payload as any).from = cfg.sendAs;
      }
    }

    return { connectorId: binding.connectorId, payload };
  }

  // Phase 2b: connector dispatch is the RPC path only. The legacy in-process
  // client path (MCP passthrough + connector clients + HTTP fallback) has been
  // removed. Every connector call is translated into a proto ExecuteRequest
  // and forwarded to the connector-service.
  private async executeConnectorCall(input: ExecuteInput, ledgerActionId?: string): Promise<ExecuteResult> {
    const { getConnectorServiceClient } = await import('../connectors/connector-service-client');
    const client = getConnectorServiceClient();

    const { connectorId, payload } = this.resolveBinding(input);

    try {
      const resp = await client.execute({
        tenantContext: { tenantId: input.tenantId },
        connectorId,
        functionName: input.actionType,
        // Proto Struct only accepts JSON-native values; the wider legacy type
        // accepts `any`, but here we constrain to JsonObject at the wire layer.
        input: (payload ?? {}) as never,
        idempotencyKey: input.idempotencyKey,
        traceId: input.traceId,
      }, { timeoutMs: connectorCallDeadlineMs(payload) });
      if (resp.success) {
        // An x402 vendor call the platform wallet paid for: ledger the
        // settled amount so the charge reaches cost attribution. The wire's
        // fundingSource decides; no-op for calls funded any other way (see
        // x402-usage.ts for the empty-report fallback).
        const { recordX402ConnectorUsage } = await import('./x402-usage');
        recordX402ConnectorUsage(input, resp.costUsd ?? 0, ledgerActionId, resp.fundingSource);
        return {
          success: true,
          data: resp.result ?? null,
          traceId: input.traceId,
        };
      }
      // Structured error contract carried across the RPC wire. When the wire
      // carries a valid code, trust its retryable/recovery; when it doesn't
      // (older connector-service build → empty error_code), derive BOTH from the
      // internal_error fallback so the returned contract is always
      // self-consistent — matching the executeBatch mapping below.
      // Inline guard narrows resp.errorCode → ToolErrorCode; wireClassified
      // drives the retryable choice (which reads resp.retryable, not the code).
      const code = isToolErrorCode(resp.errorCode) ? resp.errorCode : 'internal_error';
      const wireClassified = isToolErrorCode(resp.errorCode);
      return {
        success: false,
        data: null,
        traceId: input.traceId,
        error: resp.error || 'connector-service returned an unsuccessful response',
        errorCode: code,
        retryable: wireClassified ? resp.retryable : isRetryable(code),
        retryAfterMs: resp.retryAfterMs ? Number(resp.retryAfterMs) : undefined,
        recovery: resp.recovery || recoveryFor(code, { connectorType: input.connector }),
      };
    } catch (err) {
      // Thrown-ConnectError path (vs the in-band success:false response handled
      // above): connector-service threw a ConnectError (OAuth refresh /
      // Internal / NotFound / …). Prefer the taxonomy stamped on the
      // ConnectError metadata by oauthRefreshToConnectError; otherwise infer
      // from the gRPC code + message.
      const ce = err as { code?: number; message?: string; metadata?: { get(k: string): string | undefined } };
      const metaCode = ce.metadata?.get('x-tool-error-code');
      const code = isToolErrorCode(metaCode)
        ? metaCode
        : classifyError({ message: ce.message, connectCode: ce.code });
      return {
        success: false,
        data: null,
        traceId: input.traceId,
        error: ce.message ?? 'connector call failed',
        errorCode: code,
        retryable: isRetryable(code),
        recovery: recoveryFor(code, { connectorType: input.connector }),
      };
    }
  }

  /**
   * Execute a tool call on an external AI agent via MCP
   * Per implementation plan: A2A communication through Tool Gateway
   */
  async executeExternalAgent(input: {
    tenantId: string;
    agentId: string;
    instructionVersion: number;
    traceId: string;
    idempotencyKey: string;
    externalAgentId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): Promise<{
    success: boolean;
    data: unknown;
    traceId: string;
    error?: string;
    gatePending?: boolean;
    approvalId?: string;
  }> {
    const { externalAgentHandler } = await import('./external-agent-handler');
    return externalAgentHandler.execute(input);
  }
}
