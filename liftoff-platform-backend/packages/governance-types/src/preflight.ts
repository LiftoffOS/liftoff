// Preflight / authorize / record API shapes — new surface introduced by
// the governance-engine extraction (Phase 3). These are the wire types for
// the three hot-path RPCs every agent invocation makes:
//
//   POST /api/governance/preflight   → once per invocation
//   POST /api/governance/authorize   → once per tool call (synchronous)
//   POST /api/governance/record      → once per tool call (fire-and-forget)

export type AdmissionStatus = 'admitted' | 'throttled' | 'blocked';

/** Why admission was denied or throttled. */
export type AdmissionReason =
  | 'credits_exhausted'
  | 'rate_limit'
  | 'kill_switch_global'
  | 'kill_switch_tenant'
  | 'kill_switch_agent'
  | 'kill_switch_connector'
  | 'abuse_suspected';

export interface KillSwitchState {
  global: boolean;
  tenant?: boolean;
  agent?: string[]; // agent ids with kill switch on
  connector?: string[]; // connector types with kill switch on
}

/** Per-capability allowlist returned in preflight. */
export interface ActionAllowlist {
  connector: string;
  entityType: string;
  actionType: string;
  /** Optional scope pattern — e.g. `repo:acme/*`. */
  scopePattern?: string;
}

export interface PreflightRequest {
  tenantId: string;
  agentId: string;
  /** Connector types the agent has access to for this invocation. */
  connectorTypes: string[];
  /** Capability classification for this agent (R5). */
  capabilityTier?: 'standard' | 'sandbox' | 'enterprise';
  /** Execution environment (affects admission caps). */
  executionEnvironment?: 'sandbox' | 'managed' | 'bring-your-own';
}

export interface PreflightResponse {
  /** Overall admission decision. */
  admissionStatus: AdmissionStatus;
  admissionReason?: AdmissionReason;

  /** HITL escalation level the agent runs at for this invocation. */
  hitlLevel: number;

  /** Kill-switch state at invocation start. */
  killSwitchState: KillSwitchState;

  /** Pre-approved actions that skip authorize check. */
  allowlists: ActionAllowlist[];

  /**
   * Opaque token signed by the governance-engine identifying this
   * preflight. Must be echoed on every authorize / record call.
   */
  preflightToken: string;

  /** Version counter — bumped whenever kill switches / allowlists change. */
  version: number;
}

export type AuthorizeDecision = 'allowed' | 'hitl_required' | 'blocked' | 'conflict';

export interface AuthorizeRequest {
  preflightToken: string;
  idempotencyKey: string;
  connector: string;
  entityType: string;
  actionType: string;
  targetRef?: string;
  /** Optional action payload — used by conflict detection. */
  payload?: unknown;
}

export interface AuthorizeResponse {
  decision: AuthorizeDecision;

  /** When decision is `hitl_required`. */
  approvalRequestId?: string;

  /** When decision is `conflict`. */
  conflict?: {
    conflictingActionId: string;
    resolution: 'wait' | 'override' | 'cancel';
  };

  /** When decision is `blocked`. */
  reason?: AdmissionReason | 'kill_switch_triggered' | 'allowlist_miss';
}

export interface RecordRequest {
  preflightToken: string;
  idempotencyKey: string;
  connector: string;
  entityType: string;
  actionType: string;
  targetRef: string;
  traceId?: string;
  durationMs: number;
  /** Resulting ActionStatus. */
  status: 'completed' | 'failed';
  /** Populated for status=failed. */
  error?: string;
  /** Normalised cost in USD (0 when not metered). */
  costUsd?: number;
  /** External system response (kept out of ledger if too large). */
  externalResponse?: unknown;
}

export interface RecordResponse {
  /** Always 202 Accepted — caller does not block on ledger write. */
  accepted: true;
}
