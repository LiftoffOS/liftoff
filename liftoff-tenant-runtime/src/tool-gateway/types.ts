// Tool Gateway Types
// Per Section 11: Tool gateway and conflict-policy registry

import type { ToolErrorCode, ToolErrorContract } from '@liftoffos/connector-types';

export interface ExecuteInput {
  // Per Section 11: Required identity fields
  tenantId: string;
  agentId: string;
  instructionVersion: number;
  traceId: string;
  idempotencyKey: string;
  /** Stable trigger identity (plan §4.1/§4.5). When set, the sandbox dispatch
   *  path claim-before/replays the run so a redelivery does not re-execute the
   *  script. Undefined for chat / non-redelivered runs. */
  triggerKey?: string;

  // Action details
  connector: string;
  entityType: string;
  actionType: string;
  payload: any;

  // For write path
  snapshot?: any;

  /** The revision this RUN is acting on, when the payload cannot name one.
   *
   *  "Have I reviewed PR #81" is the wrong question; "have I reviewed PR #81 at
   *  head sha c6d160f7" is the right one, and `target_version` is where the
   *  ledger keeps the answer. The review flow could not supply it: GitHub's
   *  `pull_request_review_write` takes `{method, owner, repo, pullNumber, body,
   *  event}` and has no argument for a commit, so every review row
   *  carried `target_version = NULL` and the ledger could say WHICH pull request
   *  it had reviewed but not WHICH revision.
   *
   *  So the revision rides beside the payload rather than inside it. It never
   *  reaches the vendor — putting an argument a tool does not declare into a
   *  tool call is either a rejection or a silent drop, and a silent drop would
   *  have looked exactly like this working.
   *
   *  Set ONLY for calls to the connector that fired the run, because that is
   *  the only connector the triggering revision describes. A head sha is not a
   *  property of the Slack message the same run happens to post. */
  targetVersionHint?: string | null;

  // Per Section 15: For admission control credit check
  estimatedCredits?: number;

  // Thread ID for interactive chat attribution — populated for chat-turn
  // tool calls, absent (undefined) for autonomous/workflow runs.
  threadId?: string;

  /** The chat turn this call runs in — the id platform-backend minted for
   *  the turn — populated beside `threadId` for chat-turn tool calls and
   *  absent for autonomous runs. A found file this call registers as a card
   *  is stamped with it (`produced_in_turn_id`), so the turn's reply can be
   *  checked against the cards the turn actually produced. */
  turnId?: string;

  // Owning invocation (invocations.id), forwarded to a HITL approval created for
  // an external-agent call. Undefined for session-less / inbound-origin dispatch.
  invocationId?: string;
  /** Per-capability live | unwired | absent for this agent. An `absent`
   *  capability's tools are refused by name rather than merely hidden — see
   *  capability-tri-state.ts for why hiding alone is not enough. */
  capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;

  /** Explicit sandbox workspace handle, for callers that own their own scope
   *  (provisioning, sidecar callbacks, the grader rig). Highest precedence in
   *  sandboxSessionIdFor. Its own field rather than a payload key because
   *  `payload` is the model's tool arguments, and `sessionId` is already one of
   *  them on the session-bearing sandbox tools. */
  workspaceSessionId?: string;

  // Set by HITL approval flow after human override; skips snapshot capture
  // when the human has explicitly approved proceeding without an audit trail.
  skipSnapshotCapture?: boolean;

  /**
   * Trust level of the invocation that produced this tool call. Defaults to
   * 'trusted' when omitted. When 'untrusted_inbound', the gateway scans the
   * payload for URLs and refuses any that point at private / loopback /
   * metadata-server endpoints (see src/security/ssrf-guard.ts). Per
   * inbound-webhook plan §6.4 layer 3.
   */
  trustLevel?: 'trusted' | 'untrusted_inbound';

  /**
   * Map of connector type alias → { connectorId, config } for the calling
   * agent's bindings. Carried on the ExecuteInput so the tool-gateway can
   * (a) resolve a type alias ("google_mail") to the bound connector UUID,
   * and (b) inject per-binding config into tool-call args before dispatch
   * (e.g. Gmail's `q` for list_messages, `from` for send/reply/forward).
   *
   * Optional for backward compatibility with callers that supply `connector`
   * as a UUID already and have no per-binding config to inject.
   */
  bindingsByType?: Record<string, { connectorId: string; config?: Record<string, unknown> }>;
}

// Internal-only: used by MCP server code path where HITL is already enforced in SDK hooks.
// NEVER exposed to HTTP handlers or public API. (REVIEW FIX SE-002)
export interface InternalExecuteInput extends ExecuteInput {
  _internalSkipHitl?: boolean;  // Underscore prefix signals internal-only
}

export interface ExecuteResult {
  success: boolean;
  data: any;
  traceId: string;
  error?: string;
  // ── Structured tool-error contract (populated only when success = false).
  // Carried end-to-end from connector-service's ExecuteResponse across the RPC
  // wire so the model + workflow recovery never re-derive it from prose. ──
  errorCode?: ToolErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  recovery?: string;
  /** Non-failure information the model must see. Carried separately from
   *  `error` so a successful call can still say something important. */
  notice?: string;
  /** One host-authored line about what the SURFACE did with this result —
   *  today, that a found file became a card on the conversation. Set only
   *  when the platform answered `cardAppended: true` for the registration,
   *  within the gateway's wait bound; never on a file id alone, a timeout or
   *  a failure. The model repeats it instead of inferring an attachment from
   *  the tool's success. Rendered OUTSIDE the untrusted frame. */
  hostNote?: string;
  /** Values the egress guardrail lifted OUT of `data` for the person, on the
   *  internal hop from the gateway process to the bridge that called it. The
   *  bridge re-records them in its own process for the surface and strips
   *  them before the result is serialised for the model — they are never
   *  part of what a model reads. */
  hostDelivered?: Array<{ toolName: string; fields: Record<string, unknown> }>;
  // Audit snapshot fields — populated by tool-gateway for callers to forward to audit logs
  preActionSnapshot?: Record<string, unknown> | null;
  postActionSnapshot?: Record<string, unknown> | null;
  externalResponse?: Record<string, unknown> | null;
  snapshotStatus?: string;
}

/** What the gateway answers a caller that dispatched a call ITSELF and asked
 *  for it to be recorded: the host note the recorder attached, if the found
 *  file became a card. Returned rather than written onto the caller's result,
 *  because in a split deployment the recorder runs in another process. */
export interface SelfDispatchedRecord {
  hostNote?: string;
}

/**
 * Typed connector-call failure carrying the structured tool-error contract.
 * Thrown by the tool-gateway when a classified `{success:false}` connector
 * result surfaces as an exception, so downstream catch sites (workflow
 * recovery, anomaly mapping) read `error.contract` instead of regex-grepping
 * the message. Raw infra throws stay plain Errors → classified as
 * internal_error by consumers.
 */
export class ToolExecutionError extends Error {
  constructor(msg: string, readonly contract: ToolErrorContract) {
    super(msg);
    this.name = 'ToolExecutionError';
  }
}

// Per Section 11: Conflict-policy registry
// Each policy record defines:
export interface ConflictPolicy {
  connector: string;
  entityType: string;
  actionType: string;

  // Per Section 11: Policy fields
  freshnessTTL: number | null;
  freshReadBeforeWriteRequired: boolean;
  versionTokenField: string | null;
  fieldComparisonSet: string[];
  conflictResolutionMode: ConflictResolutionMode;
  escalateOnConflict: boolean;
  undoSupportMode: UndoSupportMode;
}

// Per Section 11: Supported resolution modes
export type ConflictResolutionMode =
  | 'compare-and-set'
  | 'fresh-read-before-write'
  | 'last-write-wins'
  | 'escalate-on-conflict'
  | 'merge';

export type UndoSupportMode =
  | 'full'
  | 'partial'
  | 'none';

// Per Section 11: Merge conflict resolution types
export interface ConflictDetection {
  hasConflict: boolean;
  conflictingFields: string[];
  localChanges: FieldChange[];
  remoteChanges: FieldChange[];
  resolution?: MergeResolution;
}

export interface FieldChange {
  field: string;
  oldValue: any;
  newValue: any;
}

export interface MergeResolution {
  strategy: 'auto-merge' | 'local-wins' | 'remote-wins' | 'field-level' | 'escalate';
  mergedPayload?: any;
  conflictsResolved: string[];
  conflictsEscalated: string[];
}

export interface EscalationRequest {
  tenantId: string;
  agentId: string;
  workflowId?: string;
  taskId?: string;
  connector: string;
  entityType: string;
  targetRef: string;
  conflict: ConflictDetection;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface ExternalState {
  data: any;
  fetchedAt: Date;
  versionToken?: string;
  etag?: string;
}
