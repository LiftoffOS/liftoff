// Typed item accumulation for agent runs.
// Each entry represents one discrete event in a run's history, typed so
// downstream consumers (handoff context, audit, approval resume) can filter
// and render without parsing opaque strings.

import type { ExecutionEngineId } from '../adapter/types';

// 1.1 replaces the Anthropic-only providerState ({type:'claude-agent-sdk'}) with
// the engine-aware structure. Legacy 1.0 rows were upgraded in place by a one-time
// data migration (agent_run_states has no TTL, so a perpetual read-time translator
// would be forever-maintenance). The read path therefore supports 1.1 ONLY and
// fail-closes on any other version instead of silently coercing it.
// 1.2 gives every item an identity (`id`) and a link to the item it followed
// (`parentId`), turning the flat array into a tree substrate. Upgraded in place
// by a one-time data migration, for the same reason 1.0→1.1 was: agent_run_states
// has no TTL, so a read-time translator would be forever-maintenance.
export const AGENT_RUN_STATE_SCHEMA_VERSION = '1.2';
export const SUPPORTED_SCHEMA_VERSIONS = new Set(['1.2']);

/** Fields every item carries, whatever its type.
 *
 *  `parentId` is WRITTEN but not yet READ. That is deliberate and recorded
 *  rather than accidental: a tree read path only pays for itself once something
 *  needs it — rerun-from-step-N, HITL what-if branching, or chat message-edit —
 *  and none of those exist. Capturing the linkage now costs one field per item
 *  and means the history is already shaped correctly when the first of them is
 *  built; deriving it retroactively from a flat array is not possible.
 *
 *  Registered in the reachability baseline as intentional debt with a named
 *  consumer, so it cannot quietly become a column nobody remembers writing. */
export interface AgentRunItemBase {
  /** Stable identity for this item, unique within the run. */
  id: string;
  /** The item this one followed. Null for the first item in a run. Linear
   *  today: every item's parent is its predecessor. A branch is what makes it
   *  a tree, and nothing branches yet. */
  parentId: string | null;
  turn: number;
  timestamp: string;
}

export type AgentRunItem =
  | (AgentRunItemBase & { type: 'message_output'; role: 'assistant' | 'user'; content: string })
  | (AgentRunItemBase & { type: 'tool_call';   toolName: string; callId: string; input: unknown })
  | (AgentRunItemBase & { type: 'tool_result'; callId: string; output: unknown; error?: string })
  | (AgentRunItemBase & { type: 'hitl_approval'; callId: string; toolName: string; decision: 'approved' | 'rejected'; decidedBy: string })
  | (AgentRunItemBase & { type: 'handoff'; fromAgentId: string; toAgentId: string; context?: string });

/** What a caller supplies to `appendItem`: everything except the two fields the
 *  append itself owns. `id` is minted and `parentId` is resolved inside the same
 *  statement that appends, because only that statement can see what the last
 *  item was without a read-modify-write race. */
export type AgentRunItemInput =
  | Omit<Extract<AgentRunItem, { type: 'message_output' }>, 'id' | 'parentId'>
  | Omit<Extract<AgentRunItem, { type: 'tool_call' }>, 'id' | 'parentId'>
  | Omit<Extract<AgentRunItem, { type: 'tool_result' }>, 'id' | 'parentId'>
  | Omit<Extract<AgentRunItem, { type: 'hitl_approval' }>, 'id' | 'parentId'>
  | Omit<Extract<AgentRunItem, { type: 'handoff' }>, 'id' | 'parentId'>;

export interface PendingApproval {
  callId: string;
  toolName: string;
  input: unknown;
  idempotencyKey: string;
}

export interface AgentRunStateInterruption {
  reason: 'hitl_approval';
  pendingApprovals: PendingApproval[];
  interruptedAtTurn: number;
  approvalRequestId: string;
}

/** Engine-aware provider state (schema 1.1+). Records the concrete
 * engine plus whatever durable upstream identifiers that engine exposes. Upstream
 * ids are OPTIONAL: an engine that surfaces no session/thread id (e.g. a stateless
 * wire adapter) simply omits them — they are never required or invented. */
export interface AgentRunStateProviderState {
  engineId: ExecutionEngineId;
  /** SDK session id where the engine exposes one (Claude Agent SDK session_id,
   * OpenCode sessionID). */
  upstreamSessionId?: string;
  /** Upstream thread id where the engine exposes one (Codex thread_id). */
  upstreamThreadId?: string;
}

export interface AgentRunState {
  $schemaVersion: string;
  invocationId: string;
  agentId: string;
  tenantId: string;
  currentTurn: number;
  maxTurns?: number;   // captured at create() so status endpoints can render N/M
  status: 'running' | 'interrupted' | 'complete' | 'failed';
  items: AgentRunItem[];
  // NOTE: always_approve policy is NOT stored here — it lives in governance-engine's
  // hitl_approval_policies table and is queried by checkHitlGate() before gating.
  providerState: AgentRunStateProviderState;
  interruption?: AgentRunStateInterruption;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  createdAt: string;
  updatedAt: string;
}
