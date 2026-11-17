// Tenant Runtime Client
// Per implementation plan: Control plane proxies HITL approval calls to tenant runtime

import crypto from 'crypto';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { log } from '../infrastructure/logging';
import type { MediaRef } from '../chat-attachments';
import type { PendingToolCall, LateFeedbackDecision } from '../hitl-late-feedback/types';
import { lateFeedbackRepository } from '../hitl-late-feedback/repository';
import type { InvocationStats, AgentCostEntry, UsageDashboard, ConnectorHealthEntry } from '../insights/types';
import type { AgentStatusResponse } from '../agent-status/types';
import { tenantRuntimeBreaker } from './tenant-runtime-circuit-breaker';
import { resolveRuntimeBaseUrl, buildRuntimeHeaders } from './tenant-runtime-url';
import { getTenantRuntimeServiceClient } from './tenant-runtime-service-client';
import type { JsonObject } from '@bufbuild/protobuf';
import { ApprovalDecision } from '@liftoffos/proto-gen/dist/liftoff/governance/v1/types_pb';

// ── SDK Chat Turn SSE Event Types ─────────────────────────────────────

/** `delegatedTo` off a terminal frame: the runtime agent ids of the teammates
 *  the turn handed work to. Only the strings — a malformed entry names nobody,
 *  and attribution the runtime could not state is absent, not a failed turn.
 *  One reader for the three frames that carry it (complete, hitl_required,
 *  awaiting_input), so they cannot parse it three ways. */
function delegatedToField(data: { delegatedTo?: unknown }): { delegatedTo?: string[] } {
  return Array.isArray(data.delegatedTo)
    ? { delegatedTo: data.delegatedTo.filter((id: unknown): id is string => typeof id === 'string') }
    : {};
}

export type ChatTurnStreamEvent =
  | { type: 'thinking' }
  | { type: 'text_delta'; text: string }
  // End of one assistant message. Carries no text — the content already
  // arrived as deltas — and exists so the consumer can place a paragraph
  // break at a real boundary instead of inferring one from tool calls.
  | { type: 'text_break' }
  // Default (frontend) mode carries only the tool name; trace mode also
  // carries callId + args. Both shapes are union-safe at the consumer.
  | { type: 'tool_call'; tool: string; callId?: string; args?: unknown }
  // Where a long run has got to. The ONLY thing a workflow-shaped run emits
  // while it works: its step loop dispatches tools itself rather than through
  // the adapter, so it produces no tool_call and no text between the question
  // and the answer.
  | { type: 'workflow_step'; stepId: string; index: number; total: number }
  // `delegatedTo` on the two pauses that persist speech, for the same reason
  // it is on `complete`: the partial a turn wrote before it stopped is
  // attributed exactly like a reply that finished.
  | { type: 'hitl_required'; approvalId: string; reason: string; action?: string | null; why?: string | null; detail?: string | null; delegatedTo?: string[] }
  // A team this team is handing work to, at the moment the hand-over begins.
  // Transient: nothing is persisted for it, the consumer resolves the display
  // name and shows a live status line while the delegated run works.
  | { type: 'delegation_started'; agentId: string }
  // A team this team delegated work to stopped for a human approval. Not a
  // failure and not terminal for the PARENT's turn — the parent model received
  // the structured pause as its tool result and keeps narrating. This frame
  // exists so the surfacing layers can post a status row and point the person
  // at the review queue rather than leaving the fact buried in prose.
  | { type: 'delegation_paused'; agentId: string; approvalId: string | null; reason: string }
  // Values a tool returned that were lifted OUT of the model's copy because they
  // are for the person: a signed download link, a one-time token. The runtime
  // replaces them with a placeholder before the model reads the result, so this
  // frame is the only way they reach anyone. Not trace-gated, unlike
  // tool_call_finished — there is no result to leak by forwarding a field that
  // never entered model context in the first place.
  | { type: 'host_delivered'; tool: string; fields: Array<{ path: string; value: unknown }> }
  | { type: 'awaiting_input'; question: string; sessionId: string; delegatedTo?: string[] }
  // The run parked and will come back on its own: it either ran out of wall
  // clock at a step boundary and is continuing in a fresh invocation
  // ('continuation'), or it parked itself on a condition ('wake'). Terminal for
  // THIS turn and not a failure -- nothing is asked of the reader, and the
  // result arrives later through settlement.
  | { type: 'run_parked'; reason: 'continuation' | 'wake'; detail: string }
  // `stopped` is set when the person ended the turn. It carries the fact that
  // the turn was stopped rather than encoding it in outputText, which used to
  // arrive as the literal string "(stopped)" and land in the transcript as
  // something the agent had said.
  // `escalated` is set when the run ended by handing the work to a person. It
  // travels as a fact for the same reason `stopped` does. The runtime appends
  // its own handoff sentence to `outputText`, but that field is only read when
  // the turn streamed nothing, so on any turn that spoke the sentence never
  // reached the thread. Optional because older runtime revisions omit it.
  // `delegatedTo` lists the runtime agent ids of the teammates the turn handed
  // work to through delegate_to_agent, unique and in first-call order — the
  // persisted attribution of the reply, resolved to names by the consumer.
  // Optional for the same reason `escalated` is.
  // `didNotFinish` is the other half of `escalated`: the run ended on a record
  // nobody in the workspace receives, so no handoff happened and the reply is
  // still composed from whatever a broken graph left behind. Optional for the
  // same reason the two above it are.
  | { type: 'complete'; outputText: string; inputTokens: number; outputTokens: number; sessionId: string; stopped?: boolean; escalated?: boolean; didNotFinish?: boolean; delegatedTo?: string[] }
  // `message` is user-facing copy classified by the runtime, never a raw
  // engine string. `failureClass` rides along so the client can branch on the
  // cause without pattern-matching English. Optional because older runtime
  // revisions omit it during a rollout.
  // `retryable` is the runtime's own verdict on whether re-sending this turn
  // could plausibly succeed, so the retry decision and the failure taxonomy stay
  // in one place (the runtime) rather than being re-derived from failureClass
  // here. Optional for the same rollout reason as failureClass.
  | { type: 'error'; code: string; message: string; failureClass?: string; retryable?: boolean }
  // ── Trace-mode-only events (opt-in via traceMode: true on the chat-turn
  //    body). Real chat never sees these because real chat never sets
  //    traceMode. Used by the PB-side agent-test-harness endpoint to
  //    reach parity with the TR-direct runner: full args/result/usage
  //    detail + the agent's exposed tool catalog. ────────────────────
  | { type: 'catalog'; exposedToolNames: string[] }
  | { type: 'tool_call_finished'; callId: string; result: unknown; error?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number }
  // ── Non-stream acknowledgments. TR answers the chat-turn POST with plain
  //    JSON (never SSE) when the message did not start a turn: it was folded
  //    into an in-flight run as an interrupt, consumed as the answer to a
  //    pending clarification, or converted into a stop of the active run.
  | { type: 'interrupt_delivered' }
  | { type: 'clarification_accepted' }
  | { type: 'stop_acknowledged' };

// Helper function for async sleep
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a chat-turn SSE stream may run before this side aborts it. One
 *  constant, and the TIMEOUT error message is derived from it, because the
 *  two drifted: the timer grew to match TR's 14-minute engine ceiling while
 *  the message still said "5 minutes", and a timeout diagnosis starts from
 *  the message. See the ladder comment at the runChatTurnStream call site. */
const CHAT_TURN_STREAM_TIMEOUT_MS = 870 * 1000;

// Wraps fetch with a hard AbortController timeout. Default 10 s is enough for
// all synchronous TR reads; streaming calls manage their own signal and must
// NOT use this helper (they pass signal directly to fetch).
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

// Map PB caller trigger sources onto TR's ExecuteTaskInput.triggeredBy union
// ('human'|'agent'|'cron'|'event') with granular attribution in
// triggeredByLabel (plan v6.1 Phase 0.4). TR's conformTriggeredBy is
// audit-only (returns strings like 'human:x') and must NOT feed execution
// input.
//
//   mcp liftoff_delegate_task ('claude_code') → human / claude_code:mcp-delegate
//   A2A SendMessage ('a2a')                   → agent / a2a:<callerId-prefix>
//   workflow-engine step ('workflow')          → agent / workflow-engine:step
//   platform-tools passthrough                 → caller's value if already in
//                                                the union, else event / platform-tool:<raw>
const EXECUTION_TRIGGERED_BY_UNION = new Set(['human', 'agent', 'cron', 'event']);

export function mapTriggeredByForExecution(
  raw: string,
  requestedById?: string,
): { triggeredBy: 'human' | 'agent' | 'cron' | 'event'; triggeredByLabel: string } {
  switch (raw) {
    case 'claude_code':
      return { triggeredBy: 'human', triggeredByLabel: 'claude_code:mcp-delegate' };
    case 'a2a':
      return { triggeredBy: 'agent', triggeredByLabel: `a2a:${(requestedById ?? 'unknown').slice(0, 8)}` };
    case 'workflow':
      return { triggeredBy: 'agent', triggeredByLabel: 'workflow-engine:step' };
    default:
      if (EXECUTION_TRIGGERED_BY_UNION.has(raw)) {
        return {
          triggeredBy: raw as 'human' | 'agent' | 'cron' | 'event',
          triggeredByLabel: `platform-tool:${raw}`,
        };
      }
      return { triggeredBy: 'event', triggeredByLabel: `platform-tool:${raw}` };
  }
}

// Custom error for HITL operations with status code
export class HitlError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HitlError';
  }
}

// Maps a ConnectError (or any error) thrown by client.resolveApproval into
// a typed HitlError so the calling code can branch on race vs unrecoverable.
// The shapes recognised come from hitl-enforcement/service.ts's approveRequest
// and rejectRequest — both throw plain Error with one of these prefixes.
function mapResolveApprovalError(err: unknown, approvalId: string): HitlError | null {
  const msg = err instanceof Error ? err.message : String(err);
  // ConnectError wraps the server message; substring matching is robust to
  // future code prefixing.
  if (/Approval request not found/i.test(msg)) {
    return new HitlError(msg, 404, 'NOT_FOUND', { approvalId });
  }
  if (/TAMPER_DETECTED/i.test(msg)) {
    return new HitlError(msg, 409, 'TAMPER_DETECTED', { approvalId });
  }
  if (/has expired/i.test(msg)) {
    return new HitlError(msg, 410, 'EXPIRED', { approvalId });
  }
  if (/request status is/i.test(msg)) {
    return new HitlError(msg, 409, 'ALREADY_DECIDED', { approvalId });
  }
  return null;
}

// Tenant runtime API response types
export interface HitlApproval {
  id: string;
  tenantId: string;
  workflowId: string;
  taskId: string;
  agentId: string;
  hitlLevel: number;
  pendingToolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  toolCallsHash: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedBy: string | null;
  decidedByRole: string | null;
  decision: 'approved' | 'rejected' | null;
  rejectionReason: string | null;
  decidedAt: string | null;
  expiresAt: string;
  /** Chat thread this gate paused (tenant-runtime migration 327), so a decision
   *  can be posted back into the conversation. Null for workflow, scheduled and
   *  sandbox gates, and for rows written before that migration. */
  threadId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Free-form provenance attached at creation by tenant-runtime — e.g.
   *  `{ origin: 'external_content', screenVerdict?: ... }` for an external-content
   *  write gate. Passed straight through to the /review surface. */
  context?: Record<string, unknown> | null;
  /** Generic HITL card summary generated at the gate in TR (hitl-card-content.ts)
   *  and stored on TR's hitl_approval_requests row. Carried verbatim to the web
   *  review page. Null on older rows / when the generic-card flag is off. */
  actionSummary?: string | null;
  whySummary?: string | null;
  detail?: string | null;
}

/** The agent's display name, resolved by the runtime for every queue item.
 *
 *  Not a convenience. `agentId` on a queue item is a RUNTIME `agents.id`, a
 *  different id space from the `internal_agents.id` this service and the web
 *  app address teams by, and the two are disjoint by construction, so nothing
 *  downstream of the runtime can turn that id into a name.
 *
 *  Optional because a runtime that predates the field sends none; null when the
 *  runtime row is gone. Either way the surface has to render something that is
 *  not an id. */
interface AgentNamed {
  agentName?: string | null;
}

// PR0: unified queue items. The /api/hitl-enforcement/approvals endpoint
// returns a discriminated union of approval items and clarification items.
export interface ApprovalItem extends HitlApproval, AgentNamed {
  kind: 'approval';
  /** Set only on the `window=passed` view: true when this approval already
   *  carries late feedback, so the surface renders it as answered instead of
   *  offering the form again. */
  lateFeedbackSubmitted?: boolean;
}

export interface ClarificationItem extends AgentNamed {
  kind: 'clarification';
  id: string;
  tenantId: string;
  agentId: string;
  threadId: string;
  question: string;
  source: 'recovery_llm' | 'anchor_intervention';
  vendorRequestId: string | null;
  createdAt: string;
  expiresAt: string;
}

/** One page of a review history feed. */
export interface ReviewHistoryPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** An approval as the runtime's history feed serves it, every status. Its own
 *  shape rather than HitlApproval: the runtime's queue mapper does
 *  `new Date(expires_at)` on a nullable column, so here every timestamp is
 *  `string | null`. */
export interface ReviewHistoryApproval extends AgentNamed {
  id: string;
  status: string;
  decision: 'approved' | 'rejected' | null;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  hitlLevel: number | null;
  reason: string | null;
  pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  editedToolInputs: Record<string, Record<string, unknown>> | null;
  actionSummary: string | null;
  whySummary: string | null;
  detail: string | null;
}

/** A clarification as the history feed serves it, with the outcome columns
 *  the runtime's migration 419 added. */
export interface ReviewHistoryClarification extends AgentNamed {
  id: string;
  question: string;
  status: string;
  firesAt: string | null;
  firedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  resolutionKind: 'answered' | 'declined' | 'expired' | 'self_answered' | null;
  resolvedBy: string | null;
  resolvedByLabel: string | null;
  resolvedAt: string | null;
}

/** The review queue holds parked runs: an approval waiting on a decision, or a
 *  clarification waiting on an answer. Both resume the run they belong to.
 *
 *  Escalations are deliberately absent. An escalated run has already ended, so
 *  an answer had nothing to restart and "resolve" only flipped a row. The
 *  runtime now parks a blocker a person can clear as a clarification, and keeps
 *  one only we can clear as an operator record. */
export type QueueItem = ApprovalItem | ClarificationItem;

/** What caused a memory write, in control-plane terms. */
export type MemoryTriggerType =
  | 'mcp_share'
  | 'agent_action'
  | 'workflow_step'
  | 'skill_reflection';

/** Control-plane trigger to the runtime's provenance `nodeType` vocabulary.
 *  The runtime's enum is the one that reaches the database, so the mapping
 *  lives here rather than sending a value the runtime would reject. */
const MEMORY_TRIGGER_NODE_TYPE: Record<MemoryTriggerType, string> = {
  mcp_share: 'system_event',
  agent_action: 'agent_action',
  workflow_step: 'agent_action',
  // A refined skill instruction is an amendment to what an agent was told.
  skill_reflection: 'instruction_amendment',
};

/** The runtime's `RetrievedMemory`, as it comes back over HTTP. */
export interface MemoryRecord {
  id: string;
  content: string;
  layer: 'global' | 'role' | 'individual';
  scopeKey: string;
  similarity: number;
  tags: string[];
  createdAt: string;
  /** Runtime agents.id — the runtime's own space, not internal_agents.id. */
  agentId?: string;
  agentName?: string;
}

/** Which view of the queue: what still needs a person, or the approvals whose
 *  decision window closed. */
export type QueueWindow = 'actionable' | 'passed';

export interface ListApprovalsResponse {
  items: QueueItem[];
  nextCursor: string | null;
}

/** Bucketed count of the tenant's review queue, computed by the runtime from the
 *  same SQL predicate its listing uses. The buckets partition `total`:
 *  approvalsStandard + approvalsCritical + approvalsOther + clarifications.
 *  `approvalsOther` exists because hitl_level is the tenant's autonomy level
 *  1 to 5, so Standard (1) and Critical (2) do not cover it. */
export interface PendingItemsCount {
  total: number;
  approvalsStandard: number;
  approvalsCritical: number;
  approvalsOther: number;
  clarifications: number;
}

/** An escalation only the platform can clear, as the runtime reports it.
 *
 *  Operator-side by definition: `kind = 'system_internal'`. Customer-facing
 *  records park their run and appear in the review queue instead, so nothing
 *  here is ever something a tenant could act on. */
export interface OperatorEscalationRecord {
  id: string;
  tenantId: string;
  agentId: string | null;
  reason: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  occurrenceCount: number;
}

/** The runtime's pending-count body. `count` repeats `total` for callers that
 *  predate the breakdown. */
export interface ApprovalCountResponse extends Partial<PendingItemsCount> {
  count: number;
}

// Phase 2: Tool Catalog response types — imported from canonical shared-types
// to prevent drift (D-2.9 fix). The shared-types-drift CI fence flags any
// local duplicate of these types.
export type {
  ToolCatalogResponse,
  TenantManifestsResponse,
  ManifestSummary,
} from '@liftoffos/shared-types';
import type {
  ToolCatalogResponse,
  TenantManifestsResponse,
} from '@liftoffos/shared-types';


/**
 * Tenant Runtime Client
 * Proxies HITL approval operations to the tenant runtime service.
 */
export class TenantRuntimeClient {
  // Per-process cache of the last successfully fetched external agent task counts.
  // Used as circuit-breaker fallback so per-task costs don't zero out when
  // Tenant Runtime is temporarily unavailable.
  private readonly lastKnownExternalTaskCounts =
    new Map<string, Record<string, { taskCount: number }>>();

  /**
   * Get the count of review-queue items awaiting a person, for a tenant.
   *
   * This asks the tenant runtime, which owns the definition of "actionable" in
   * one SQL predicate shared with the queue listing. It used to ask over the
   * RPC and re-derive expiry here, in a second copy of a rule the runtime
   * already applies, and it measured the queue by fetching a page of 100 and
   * taking its length. Both are gone; the runtime's predicate is the only
   * definition, and the listing sees exactly what this counts.
   *
   * Returns null, never 0, when the runtime cannot be reached. This number's
   * whole job is to be believed, and a confident zero is the failure being
   * fixed; callers render the absence instead.
   */
  async getPendingApprovalCount(
    tenantId: string,
    options?: { agentId?: string },
  ): Promise<PendingItemsCount | null> {
    return tenantRuntimeBreaker.executeOrFallback<PendingItemsCount | null>(
      { tenantId, method: 'getPendingApprovalCount' },
      async () => {
        // Resolved inside the breaker: this does a DB lookup, and a failure
        // outside the callback would escape the fallback entirely.
        const params = new URLSearchParams();
        if (options?.agentId) params.set('agentId', options.agentId);
        const query = params.toString();
        const url =
          `${await resolveRuntimeBaseUrl(tenantId)}/api/hitl-enforcement/pending-count` +
          (query ? `?${query}` : '');

        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime pending count`);
        }

        const body = await response.json() as ApprovalCountResponse;

        // A runtime that predates the breakdown sends `count` alone. Reading the
        // buckets defensively keeps a rolled-back runtime from turning into
        // NaNs on the dashboard.
        return {
          total: body.total ?? body.count ?? 0,
          approvalsStandard: body.approvalsStandard ?? 0,
          approvalsCritical: body.approvalsCritical ?? 0,
          approvalsOther: body.approvalsOther ?? 0,
          clarifications: body.clarifications ?? 0,
        };
      },
      null,
    );
  }

  /**
   * B4: operator-only `system_internal` escalation records for one tenant.
   *
   * The operator dashboard's service reads the control-plane database and has
   * never called the runtime, which is why these records were visible to
   * nobody: they left the customer queue by design, and no internal surface
   * replaced it. This is the one read path that changes that.
   *
   * Behind the breaker like every other runtime call, and falling back to an
   * empty list rather than throwing: an operator dashboard panel must not take
   * the page down because one tenant's runtime is cold.
   */
  async listOperatorEscalationRecords(
    tenantId: string,
    options?: { status?: 'pending' | 'resolved'; limit?: number },
  ): Promise<OperatorEscalationRecord[]> {
    return tenantRuntimeBreaker.executeOrFallback<OperatorEscalationRecord[]>(
      { tenantId, method: 'listOperatorEscalationRecords' },
      async () => {
        const params = new URLSearchParams();
        if (options?.status) params.set('status', options.status);
        if (options?.limit) params.set('limit', String(options.limit));
        const query = params.toString();
        // Resolved inside the breaker: it does a DB lookup, and a failure
        // outside the callback would escape the fallback entirely.
        const url =
          `${await resolveRuntimeBaseUrl(tenantId)}/api/hitl-enforcement/operator-records` +
          (query ? `?${query}` : '');

        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime operator records`);
        }

        const body = await response.json() as { records?: OperatorEscalationRecord[] };
        return body.records ?? [];
      },
      [],
    );
  }

  /**
   * List pending HITL approvals + clarifications for a tenant.
   * Returns a discriminated `items` array (kind='approval' | 'clarification').
   */
  async listPendingApprovals(
    tenantId: string,
    options?: { cursor?: string; limit?: number; agentId?: string; window?: QueueWindow }
  ): Promise<ListApprovalsResponse> {
    return tenantRuntimeBreaker.executeOrFallback<ListApprovalsResponse>(
      { tenantId, method: 'listPendingApprovals' },
      async () => {
        const params = new URLSearchParams();
        if (options?.cursor) params.set('cursor', options.cursor);
        if (options?.limit) params.set('limit', String(options.limit));
        if (options?.agentId) params.set('agentId', options.agentId);
        if (options?.window) params.set('window', options.window);

        // Resolved inside the breaker: it does a DB lookup, and a failure
        // outside the callback would escape the fallback entirely.
        const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/hitl-enforcement/approvals?${params}`;

        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime approvals list`);
        }

        return await response.json() as ListApprovalsResponse;
      },
      { items: [], nextCursor: null },
    );
  }

  /**
   * The approval blocking one chat thread, or null.
   *
   * The in-chat banner used to find this by listing the tenant's queue and
   * scanning the first hundred items. For a tenant with a long queue the real
   * approval sat past that page and the person whose turn was blocked saw
   * nothing, so this asks the runtime for the thread directly.
   *
   * Falls back to null when the runtime is unreachable: no banner is the same
   * thing the reader saw before, and it is better than a wrong one.
   */
  async getApprovalForThread(
    tenantId: string,
    threadId: string,
    agentId?: string,
  ): Promise<HitlApproval | null> {
    return tenantRuntimeBreaker.executeOrFallback<HitlApproval | null>(
      { tenantId, method: 'getApprovalForThread' },
      async () => {
        const params = new URLSearchParams();
        if (agentId) params.set('agentId', agentId);
        const query = params.toString();
        const url =
          `${await resolveRuntimeBaseUrl(tenantId)}/api/hitl-enforcement/approvals/for-thread/${threadId}` +
          (query ? `?${query}` : '');

        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime thread approval`);
        }

        const body = await response.json() as { approval: HitlApproval | null };
        return body.approval ?? null;
      },
      null,
    );
  }

  /**
   * Submit operator's text response to a pending clarification. Routes the
   * answer through the tenant-runtime's TenantRuntimeService RPC; backend
   * dispatches by clarification source (recovery_llm vs anchor_intervention).
   */
  async respondToClarification(
    tenantId: string,
    clarificationId: string,
    response: string,
    resolvedBy: string,
  ): Promise<void> {
    const client = await getTenantRuntimeServiceClient(tenantId);
    await client.respondToClarification({
      tenantContext: { tenantId },
      clarificationId,
      response,
      resolvedBy,
    });
  }

  /**
   * Decline a clarification: the run resumes now with no answer available.
   *
   * REST rather than a Connect method, unlike its sibling above. The runtime
   * needs no new contract to be told this — the resume text differs and
   * nothing else — and routing it through the service would have meant a proto
   * change generated and published before either side could ship.
   *
   * Deliberately not wrapped in the circuit breaker. The breaker exists so a
   * read can fall back to something harmless; a write has no harmless fallback,
   * and reporting a decline as delivered when the runtime never heard it would
   * leave the run parked with the queue insisting it was handled.
   */
  async declineClarification(
    tenantId: string,
    clarificationId: string,
    resolvedBy: string,
    reason?: string,
  ): Promise<void> {
    const url =
      `${await resolveRuntimeBaseUrl(tenantId)}/api/hitl-enforcement/clarifications/${clarificationId}/decline`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: await buildRuntimeHeaders(tenantId),
      body: JSON.stringify({ resolvedBy, ...(reason ? { reason } : {}) }),
    }, 10_000);

    if (response.status === 404) {
      // Somebody else settled it, or its window closed, between the page
      // rendering and this call. Surfaced as-is so the route can say so.
      throw Object.assign(new Error('clarification not found'), { status: 404 });
    }
    if (response.status === 409) {
      // An Anchor intervention, which has no decline. The page hides the
      // affordance; a stale tab can still get here.
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw Object.assign(
        new Error(body.error ?? 'this clarification cannot be declined'),
        { status: 409 },
      );
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime decline clarification`);
    }
  }

  /**
   * One page of the runtime's approval history, every status, oldest first,
   * bounded by `asOf` (the workspace export's inclusion boundary).
   *
   * Deliberately not wrapped in the circuit breaker and never falling back to
   * an empty page: an export that quietly wrote "no approvals" because the
   * runtime was down would be a false record. It throws, and the route turns
   * the throw into a 503 naming the source.
   */
  async listReviewHistoryApprovals(
    tenantId: string,
    options: { asOf: Date; cursor?: string; limit?: number },
  ): Promise<ReviewHistoryPage<ReviewHistoryApproval>> {
    return this.fetchReviewHistory<ReviewHistoryApproval>(tenantId, 'approvals', options);
  }

  /** The clarification half of the same feed. */
  async listReviewHistoryClarifications(
    tenantId: string,
    options: { asOf: Date; cursor?: string; limit?: number },
  ): Promise<ReviewHistoryPage<ReviewHistoryClarification>> {
    return this.fetchReviewHistory<ReviewHistoryClarification>(tenantId, 'clarifications', options);
  }

  private async fetchReviewHistory<T extends { id: string }>(
    tenantId: string,
    kind: 'approvals' | 'clarifications',
    options: { asOf: Date; cursor?: string; limit?: number },
  ): Promise<ReviewHistoryPage<T>> {
    const params = new URLSearchParams({ asOf: options.asOf.toISOString() });
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/hitl-enforcement/review-history/${kind}?${params}`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: await buildRuntimeHeaders(tenantId),
    }, 10_000);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime review history (${kind})`);
    }
    const body = await response.json() as { items?: unknown; nextCursor?: unknown };
    // The body shape is validated, not trusted: a runtime that predates the
    // feed answers something else at this path, and an export built on that
    // would be wrong rather than failed.
    if (!body || !Array.isArray(body.items)
      || (body.nextCursor !== null && typeof body.nextCursor !== 'string')
      || body.items.some((item) => !item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string')) {
      throw new Error(`Malformed review history page from tenant runtime (${kind})`);
    }
    return { items: body.items as T[], nextCursor: body.nextCursor as string | null };
  }

  /**
   * Ask TR to stop the run currently active on a chat thread. TR inserts an
   * abort signal for the active invocation; `deliveredAs` is 'abort' when a
   * signal was delivered and 'noop' when nothing was running (a benign race
   * with completion — the user's intent is satisfied either way).
   */
  async signalStopChatTurn(
    tenantId: string,
    p: { agentId: string; threadId: string; senderAccountId?: string; userDisplayName?: string },
  ): Promise<{ acknowledged: boolean; deliveredAs: 'abort' | 'noop' }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/interactive-chat/${p.agentId}/stop`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: await buildRuntimeHeaders(tenantId),
      body: JSON.stringify({
        tenantId,
        threadId: p.threadId,
        ...(p.senderAccountId ? { senderAccountId: p.senderAccountId } : {}),
        ...(p.userDisplayName ? { userDisplayName: p.userDisplayName } : {}),
      }),
    }, 10_000);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime stop`);
    }
    return await response.json() as { acknowledged: boolean; deliveredAs: 'abort' | 'noop' };
  }

  /**
   * Get a specific HITL approval
   */
  async getApproval(tenantId: string, approvalId: string): Promise<HitlApproval | null> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/hitl-enforcement/approvals/${approvalId}`;

    return tenantRuntimeBreaker.executeOrFallback<HitlApproval | null>(
      { tenantId, method: 'getApproval' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        // 404 is a legitimate "not found" — return null inside the inner
        // function so the breaker counts this as a SUCCESS (not a failure)
        // and the circuit stays closed. Only 5xx / network errors trip the
        // breaker.
        if (response.status === 404) return null;

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime get approval`);
        }

        return await response.json() as HitlApproval;
      },
      null,
    );
  }

  /**
   * Approve a HITL request
   */
  async approveRequest(
    tenantId: string,
    approvalId: string,
    decidedBy: string,
    decidedByRole: string,
    alwaysApply: boolean = false,
    approvalNote?: string,
    editedToolInputs?: Record<string, Record<string, unknown>>,
  ): Promise<HitlApproval | null> {
    const client = await getTenantRuntimeServiceClient(tenantId);
    try {
      await client.resolveApproval({
        tenantContext: { tenantId },
        approvalId,
        decidedBy,
        decidedByRole,
        decision: ApprovalDecision.APPROVED,
        alwaysApply,
        // Proto field 10. The arguments the reviewer rewrote before saying yes,
        // keyed by pending tool call id. The decision is still APPROVED: what a
        // reviewer who fixes a price and sends did was approve, and only WHICH
        // arguments get dispatched changes.
        // Cast, not conversion: these values were parsed out of a JSON request
        // body, so they already satisfy the Struct field's JsonObject shape.
        // TypeScript cannot see that through `unknown` on the zod result.
        editedToolInputs: (editedToolInputs ?? {}) as Record<string, JsonObject>,
        // Proto field 9. The counterpart to rejectionReason, which the reject
        // half below has always sent: until this existed, half of every gate
        // decision reached the agent's memory with no reasoning attached.
        approvalNote: approvalNote ?? '',
      });
    } catch (err) {
      const mapped = mapResolveApprovalError(err, approvalId);
      if (mapped) throw mapped;
      throw err;
    }
    return this.getApproval(tenantId, approvalId);
  }

  /**
   * Reject a HITL request
   */
  async rejectRequest(
    tenantId: string,
    approvalId: string,
    decidedBy: string,
    decidedByRole: string,
    rejectionReason?: string,
    alwaysApply: boolean = false,
  ): Promise<HitlApproval | null> {
    const client = await getTenantRuntimeServiceClient(tenantId);
    try {
      await client.resolveApproval({
        tenantContext: { tenantId },
        approvalId,
        decidedBy,
        decidedByRole,
        rejectionReason: rejectionReason ?? '',
        decision: ApprovalDecision.REJECTED,
        alwaysApply,
      });
    } catch (err) {
      const mapped = mapResolveApprovalError(err, approvalId);
      if (mapped) throw mapped;
      throw err;
    }
    return this.getApproval(tenantId, approvalId);
  }

  /**
   * Send late feedback to tenant runtime for agent learning
   * Includes retry mechanism with exponential backoff: 1s, 2s, 4s, 8s, 16s
   */
  async sendLateFeedback(
    tenantId: string,
    feedbackId: string,
    feedback: {
      approvalId: string;
      decision: LateFeedbackDecision;
      decidedBy: string;
      decidedByRole: string;
      rejectionReason?: string;
      toolCallsHash: string;
      pendingToolCalls: PendingToolCall[];
    }
  ): Promise<{ success: boolean }> {
    const maxRetries = 5;

    // The breaker wraps the entire 5-retry loop so a flapping endpoint
    // doesn't cost us 30+ seconds of backoff on every late-feedback send.
    // When the circuit is open, the inner function never runs and we
    // return { success: false } immediately — the late_feedback row stays
    // in `pending` state and the background sync job will retry it later.
    return tenantRuntimeBreaker.executeOrFallback<{ success: boolean }>(
      { tenantId, method: 'sendLateFeedback' },
      async () => {
        const client = await getTenantRuntimeServiceClient(tenantId);
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            await client.sendLateFeedback({
              tenantContext: { tenantId },
              feedbackId,
              decision: feedback.decision === 'would_approve'
                ? ApprovalDecision.APPROVED
                : ApprovalDecision.REJECTED,
              decidedBy: feedback.decidedBy,
              decidedByRole: feedback.decidedByRole,
              rejectionReason: feedback.rejectionReason ?? '',
              toolCallsHash: feedback.toolCallsHash,
              pendingToolCalls: feedback.pendingToolCalls.map(ptc => ({
                id: ptc.id,
                name: ptc.name,
                inputJson: new TextEncoder().encode(JSON.stringify(ptc.input)),
              })),
            });

            await lateFeedbackRepository.markSynced(feedbackId);

            log.info({
              event: 'hitl_late_feedback_synced',
              feedbackId,
              tenantId,
              attempt: attempt + 1,
            });

            return { success: true };
          } catch (error) {
            lastError = error as Error;

            await lateFeedbackRepository.recordSyncAttempt(feedbackId, lastError.message);

            log.warn({
              event: 'hitl_late_feedback_sync_attempt_failed',
              feedbackId,
              tenantId,
              attempt: attempt + 1,
              error: lastError.message,
            });

            // Exponential backoff: 1s, 2s, 4s, 8s, 16s
            if (attempt < maxRetries - 1) {
              await sleep(Math.pow(2, attempt) * 1000);
            }
          }
        }

        // All retries exhausted — log and throw so the breaker counts the
        // failure. The breaker returns { success: false } as the fallback.
        log.warn({
          event: 'hitl_late_feedback_sync_exhausted',
          feedbackId,
          tenantId,
          error: lastError?.message,
        });

        throw lastError ?? new Error('Late feedback sync exhausted');
      },
      { success: false },
    );
  }

  /**
   * Get per-agent cost aggregation for the trailing 30 days.
   * Used by the /teams "30-Day Cost" column. Trailing window is preferred
   * over month-to-date so the number is stable across month boundaries.
   */
  async getAgentMonthlyCosts(tenantId: string): Promise<Record<string, { totalCostUsd: number; invocationCount: number }>> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    return tenantRuntimeBreaker.executeOrFallback<Record<string, { totalCostUsd: number; invocationCount: number }>>(
      { tenantId, method: 'getAgentMonthlyCosts' },
      async () => {
        const client = await getTenantRuntimeServiceClient(tenantId);
        const res = await client.getAgentCosts({
          tenantContext: { tenantId },
          since: { seconds: BigInt(Math.floor(since.getTime() / 1000)), nanos: 0 },
        });
        const result: Record<string, { totalCostUsd: number; invocationCount: number }> = {};
        for (const entry of res.entries) {
          result[entry.agentId] = {
            totalCostUsd: entry.totalCostUsd,
            invocationCount: Number(entry.invocationCount),
          };
        }
        return result;
      },
      {},
    );
  }

  /**
   * Get in-time HITL decision counts (approvals + rejections) per account from
   * hitl_approval_requests for the given window. Captures decisions made before
   * the approval expired — late feedback (post-expiry) does NOT update
   * hitl_approval_requests and is sourced separately from hitl_late_feedback.
   */
  async getHitlDecisionCounts(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<Record<string, { decisionCount: number }>> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/invocations/hitl-decision-counts?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

    return tenantRuntimeBreaker.executeOrFallback<Record<string, { decisionCount: number }>>(
      { tenantId, method: 'getHitlDecisionCounts' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime hitl-decision-counts`);
        }

        return await response.json() as Record<string, { decisionCount: number }>;
      },
      {},
    );
  }

  /**
   * Get task counts for external agents from audit_logs for the given window.
   * Used by /insights (range-aware) and /teams (trailing 30 days, computed at
   * the call site).
   */
  async getExternalAgentTaskCounts(
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<Record<string, { taskCount: number }>> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/invocations/external-agent-tasks?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

    return tenantRuntimeBreaker.executeOrFallback<Record<string, { taskCount: number }>>(
      { tenantId, method: 'getExternalAgentTaskCounts' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime external-agent-tasks`);
        }

        const data = await response.json() as Record<string, { taskCount: number }>;
        // Cache the result so we can serve it when the circuit is open.
        this.lastKnownExternalTaskCounts.set(tenantId, data);
        return data;
      },
      // Fall back to the last successfully fetched counts so per-task external
      // agent costs don't zero out during a transient Tenant Runtime outage.
      this.lastKnownExternalTaskCounts.get(tenantId) ?? {},
    );
  }

  /**
   * Get invocation stats for a tenant within a time range.
   */
  async getInvocationStats(
    tenantId: string,
    start: string,
    end: string,
    agentId?: string,
  ): Promise<InvocationStats | null> {
    void end;
    void agentId;
    return tenantRuntimeBreaker.executeOrFallback<InvocationStats | null>(
      { tenantId, method: 'getInvocationStats' },
      async () => {
        const client = await getTenantRuntimeServiceClient(tenantId);
        const since = new Date(start);
        const res = await client.getInvocationStats({
          tenantContext: { tenantId },
          since: { seconds: BigInt(Math.floor(since.getTime() / 1000)), nanos: 0 },
        });
        return {
          totalCostUsd: res.totalCostUsd,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          invocationCount: Number(res.totalInvocations),
          // The gRPC shape carries no token counts at all, so it cannot say
          // which of its invocations were uncosted. Zero here means "this source
          // does not report it", not "there were none" — a caller that needs the
          // split reads the cost_attribution_events aggregation instead.
          uncostedInvocationCount: 0,
          uncostedInputTokens: 0,
          uncostedOutputTokens: 0,
        };
      },
      null,
    );
  }

  /**
   * Get per-agent cost aggregation for a specific time range.
   * Proxies to GET /api/invocations/agent-costs with start/end params.
   */
  async getInvocationStatsForRange(
    tenantId: string,
    start: string,
    end: string,
  ): Promise<Record<string, AgentCostEntry>> {
    const params = new URLSearchParams({ start, end });
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/invocations/agent-costs?${params}`;

    return tenantRuntimeBreaker.executeOrFallback<Record<string, AgentCostEntry>>(
      { tenantId, method: 'getInvocationStatsForRange' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime agent-costs`);
        }

        return await response.json() as Record<string, AgentCostEntry>;
      },
      {},
    );
  }

  /**
   * Get burn state (credit usage) for a tenant.
   */
  async getBurnState(tenantId: string): Promise<UsageDashboard | null> {
    return tenantRuntimeBreaker.executeOrFallback<UsageDashboard | null>(
      { tenantId, method: 'getBurnState' },
      async () => {
        const client = await getTenantRuntimeServiceClient(tenantId);
        const res = await client.getUsageDashboard({
          tenantContext: { tenantId },
        });
        return {
          totalCreditsUsed: res.totalCostUsd,
          remainingCredits: res.remainingCreditsUsd,
          creditsPerHour: 0,
        };
      },
      null,
    );
  }

  /**
   * Get per-action cost entries for a tenant.
   */
  async getActionCosts(
    tenantId: string,
    opts: {
      agentId?: string;
      since?: Date;
      until?: Date;
      pageCursor?: string;
      pageSize?: number;
    } = {},
  ): Promise<{
    entries: Array<{
      actionId: string;
      agentId: string;
      workflowId: string;
      connector: string;
      actionType: string;
      llmCostUsd: number;
      connectorCostUsd: number;
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
      occurredAt: string;
    }>;
    nextPageCursor: string;
  }> {
    return tenantRuntimeBreaker.executeOrFallback(
      { tenantId, method: 'getActionCosts' },
      async () => {
        const client = await getTenantRuntimeServiceClient(tenantId);
        const res = await client.getActionCosts({
          tenantContext: { tenantId },
          agentId: opts.agentId ?? '',
          since: opts.since
            ? { seconds: BigInt(Math.floor(opts.since.getTime() / 1000)), nanos: 0 }
            : undefined,
          until: opts.until
            ? { seconds: BigInt(Math.floor(opts.until.getTime() / 1000)), nanos: 0 }
            : undefined,
          pageCursor: opts.pageCursor ?? '',
          pageSize: opts.pageSize ?? 50,
        });
        return {
          entries: res.entries.map(e => ({
            actionId: e.actionId,
            agentId: e.agentId,
            workflowId: e.workflowId,
            connector: e.connector,
            actionType: e.actionType,
            llmCostUsd: e.llmCostUsd,
            connectorCostUsd: e.connectorCostUsd,
            inputTokens: Number(e.inputTokens),
            outputTokens: Number(e.outputTokens),
            durationMs: Number(e.durationMs),
            occurredAt: e.occurredAt
              ? new Date(Number(e.occurredAt.seconds) * 1000).toISOString()
              : new Date().toISOString(),
          })),
          nextPageCursor: res.nextPageCursor,
        };
      },
      { entries: [], nextPageCursor: '' },
    );
  }

  /**
   * Get connector health data aggregated from actions table.
   * Proxies to GET /api/action-ledger/health
   */
  async getActionsByConnector(
    tenantId: string,
    start: string,
    end: string,
  ): Promise<ConnectorHealthEntry[]> {
    const params = new URLSearchParams({ start, end });
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/action-ledger/health?${params}`;

    return tenantRuntimeBreaker.executeOrFallback<ConnectorHealthEntry[]>(
      { tenantId, method: 'getActionsByConnector' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime action-ledger/health`);
        }

        return await response.json() as ConnectorHealthEntry[];
      },
      [],
    );
  }

  // ── Memory proxy ─────────────────────────────────────────────────────
  //
  // Memories live in the tenant runtime. Two control-plane features reach
  // them from here: skill-feedback recording a refined skill, and the MCP
  // `liftoff_share_context` / `liftoff_read_context` tools.
  //
  // Both methods fail-soft via the circuit breaker: a tenant runtime outage
  // returns an empty result (retrieve) or a null id (save) rather than
  // failing the caller. That softness is why the request shape below has to
  // match the runtime exactly — a rejected write looks identical to a
  // degraded one from here, and reports success either way.

  /**
   * Save a memory to the tenant runtime's memory store.
   *
   * `scopeKey` is optional: the runtime scopes an individual-layer memory to
   * its agent, and everything else to a shared key.
   */
  async saveMemory(
    tenantId: string,
    input: {
      layer: 'global' | 'role' | 'individual';
      scopeKey?: string;
      content: string;
      tags?: string[];
      /** Control-plane internal_agents.id. The runtime translates it into its
       *  own agent id space before the write; the two are disjoint, so sending
       *  an untranslated id would fail the memories.agent_id foreign key. */
      internalAgentId?: string;
      triggerType: MemoryTriggerType;
      /** Identifies the thing that caused this write, for the provenance
       *  chain. Stable per cause so a replay does not fork the lineage. */
      triggerRefId: string;
      /** MCP API key that shared the context, when the trigger is mcp_share. */
      writtenByKeyId?: string;
    },
  ): Promise<{ id: string | null }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/memory`;

    const body = {
      layer: input.layer,
      ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
      content: input.content,
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.internalAgentId ? { internalAgentId: input.internalAgentId } : {}),
      source: {
        nodeType: MEMORY_TRIGGER_NODE_TYPE[input.triggerType],
        refId: input.triggerRefId,
        ...(input.writtenByKeyId
          ? { metadata: { writtenByKeyId: input.writtenByKeyId } }
          : {}),
      },
    };

    return tenantRuntimeBreaker.executeOrFallback<{ id: string | null }>(
      { tenantId, method: 'saveMemory' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            ...(await buildRuntimeHeaders(tenantId)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime memory save`);
        }

        const data = await response.json() as { id: string };
        return { id: data.id };
      },
      { id: null },
    );
  }

  /**
   * Retrieve memories from the tenant runtime's memory store.
   *
   * The returned fields are the runtime's `RetrievedMemory`, not a superset:
   * anything not listed here is not something the runtime sends.
   */
  async retrieveMemories(
    tenantId: string,
    input: {
      query: string;
      layers?: Array<'global' | 'role' | 'individual'>;
      topK?: number;
      /** Control-plane internal_agents.id; translated by the runtime. An agent
       *  with no mapping yet simply matches nothing. */
      internalAgentId?: string;
    },
  ): Promise<MemoryRecord[]> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/memory/retrieve`;

    return tenantRuntimeBreaker.executeOrFallback<MemoryRecord[]>(
      { tenantId, method: 'retrieveMemories' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            ...(await buildRuntimeHeaders(tenantId)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime memory retrieve`);
        }

        const data = await response.json() as { memories: MemoryRecord[] };
        return data.memories ?? [];
      },
      [],
    );
  }

  // =========================================================================
  // Phase 2: Tool Catalog
  // =========================================================================

  /**
   * Fetch the per-tenant tool catalog for a specific connector manifest.
   * Returns tools with the exact aliased names the executor will see at
   * runtime, so distill can emit tool names that resolve at execution time.
   *
   * Fallback: returns empty array on failure so distill can degrade
   * gracefully to agent-type classification (no workflow graph).
   */
  async getToolCatalog(
    tenantId: string,
    manifestId: string,
  ): Promise<ToolCatalogResponse> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/v1/tool-catalog/tenant/${tenantId}/manifest/${manifestId}/tools`;

    return tenantRuntimeBreaker.executeOrFallback<ToolCatalogResponse>(
      { tenantId, method: 'getToolCatalog' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime tool-catalog`);
        }

        return await response.json() as ToolCatalogResponse;
      },
      { schemaVersion: 1, connectorType: '', alias: '', tools: [] },
    );
  }

  /**
   * List all connected manifests for a tenant (summary view).
   * Used by distill to enumerate which integrations have tools to offer.
   *
   * Fallback: returns empty manifests array on failure.
   */
  async getTenantManifests(
    tenantId: string,
  ): Promise<TenantManifestsResponse> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/v1/tool-catalog/tenant/${tenantId}/manifests`;

    return tenantRuntimeBreaker.executeOrFallback<TenantManifestsResponse>(
      { tenantId, method: 'getTenantManifests' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: await buildRuntimeHeaders(tenantId),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime manifests`);
        }

        return await response.json() as TenantManifestsResponse;
      },
      { schemaVersion: 1, manifests: [] },
    );
  }

  /**
   * Retrieve memories relevant to an interactive chat query.
   *
   * The chat service calls this to inject contextual memories into the
   * system prompt before each LLM turn.
   *
   * Fallback: returns empty array — the chat proceeds without memory context.
   */
  async retrieveAgentMemories(
    tenantId: string,
    agentId: string,
    query: string,
    topK?: number,
  ): Promise<Array<{ id: string; content: string; tags: string[]; similarity?: number }>> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/interactive-chat/${agentId}/memory-retrieve`;

    return tenantRuntimeBreaker.executeOrFallback<Array<{ id: string; content: string; tags: string[]; similarity?: number }>>(
      { tenantId, method: 'retrieveAgentMemories' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: await buildRuntimeHeaders(tenantId),
          body: JSON.stringify({ query, topK: topK ?? 10 }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
          log.warn(
            { tenantId, agentId, status: response.status, error: errorBody },
            'retrieveAgentMemories: non-OK response from tenant runtime',
          );
          throw new Error(`HTTP ${response.status} from tenant runtime memories/retrieve`);
        }

        const data = await response.json() as { memories: Array<{ id: string; content: string; tags: string[]; similarity?: number }> };
        log.info(
          { event: 'interactive_chat_retrieve_memories', tenantId, agentId, resultCount: data.memories?.length ?? 0 },
          'retrieveAgentMemories: fetched',
        );
        return data.memories ?? [];
      },
      [],
    );
  }

  /**
   * Save a memory from an interactive chat session.
   *
   * The chat service calls this when the LLM or a post-processing step
   * determines a memory-worthy fact was surfaced during the conversation.
   *
   * Fallback: returns { memoryId: '', deduplicated: false } so the chat
   * service can continue without blocking on persistence.
   */
  async saveAgentMemory(
    tenantId: string,
    agentId: string,
    layer: string,
    content: string,
    tags: string[],
  ): Promise<{ memoryId: string; deduplicated: boolean }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/interactive-chat/${agentId}/memory-save`;

    return tenantRuntimeBreaker.executeOrFallback<{ memoryId: string; deduplicated: boolean }>(
      { tenantId, method: 'saveAgentMemory' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: await buildRuntimeHeaders(tenantId),
          body: JSON.stringify({ layer, content, tags }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
          log.warn(
            { tenantId, agentId, status: response.status, error: errorBody },
            'saveAgentMemory: non-OK response from tenant runtime',
          );
          throw new Error(`HTTP ${response.status} from tenant runtime memories/save`);
        }

        const data = await response.json() as { memoryId: string; deduplicated: boolean };
        log.info(
          { event: 'interactive_chat_save_memory', tenantId, agentId, memoryId: data.memoryId, deduplicated: data.deduplicated },
          'saveAgentMemory: saved',
        );
        return data;
      },
      { memoryId: '', deduplicated: false },
    );
  }

  /**
   * List all runtime memories for an agent (user-facing CRUD API).
   *
   * Supports pagination via cursor and optional keyword search.
   * Throws on failure — callers should return a 502 rather than an empty list,
   * so the frontend can show an error rather than silently empty state.
   */
  async listAgentMemories(
    tenantId: string,
    agentId: string,
    opts: { limit?: number; cursor?: string; search?: string } = {},
  ): Promise<{
    memories: Array<{ id: string; content: string; source: string; createdAt: string; usefulnessScore?: number; lastUsedAt?: string; contradicts?: string[] }>;
    nextCursor: string | null;
    total: number;
  }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.search) params.set('search', opts.search);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/interactive-chat/${agentId}/memories${qs}`;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: await buildRuntimeHeaders(tenantId),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
      log.warn(
        { tenantId, agentId, status: response.status, error: errorBody },
        'listAgentMemories: non-OK response from tenant runtime',
      );
      throw new Error(`HTTP ${response.status} from tenant runtime memories/list`);
    }

    const data = await response.json() as {
      memories: Array<{ id: string; content: string; source: string; createdAt: string; usefulnessScore?: number; lastUsedAt?: string; contradicts?: string[] }>;
      nextCursor: string | null;
      total: number;
    };
    log.info(
      { event: 'list_agent_memories', tenantId, agentId, count: data.memories?.length ?? 0 },
      'listAgentMemories: fetched',
    );
    return data;
  }

  /**
   * Delete a single runtime memory for an agent (user-facing CRUD API).
   *
   * Throws on failure — a missing memory is treated as a 404 from the TR.
   */
  async deleteAgentMemory(
    tenantId: string,
    agentId: string,
    memoryId: string,
  ): Promise<void> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/interactive-chat/${agentId}/memories/${memoryId}`;

    const response = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: await buildRuntimeHeaders(tenantId),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
      log.warn(
        { tenantId, agentId, memoryId, status: response.status, error: errorBody },
        'deleteAgentMemory: non-OK response from tenant runtime',
      );
      throw new Error(`HTTP ${response.status} from tenant runtime memories/delete`);
    }

    log.info(
      { event: 'delete_agent_memory', tenantId, agentId, memoryId },
      'deleteAgentMemory: deleted',
    );
  }

  /**
   * Update the content of a single runtime memory (user-facing CRUD API).
   *
   * Throws on failure — a missing memory is treated as a 404 from the TR.
   */
  async updateAgentMemory(
    tenantId: string,
    agentId: string,
    memoryId: string,
    content: string,
  ): Promise<{ id: string; content: string; updatedAt: string }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/interactive-chat/${agentId}/memories/${memoryId}`;

    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: await buildRuntimeHeaders(tenantId),
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
      log.warn(
        { tenantId, agentId, memoryId, status: response.status, error: errorBody },
        'updateAgentMemory: non-OK response from tenant runtime',
      );
      throw new Error(`HTTP ${response.status} from tenant runtime memories/update`);
    }

    const data = await response.json() as { id: string; content: string; updatedAt: string };
    log.info(
      { event: 'update_agent_memory', tenantId, agentId, memoryId },
      'updateAgentMemory: updated',
    );
    return data;
  }

  /**
   * List memories by layer across the tenant (user-facing CRUD API).
   * Supports global, role, and individual layers with optional scopeKey filter.
   * Throws on failure.
   */
  async listMemoriesByLayer(
    tenantId: string,
    opts: { layer?: 'global' | 'role' | 'individual'; scopeKey?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ memories: Array<{ id: string; content: string; source: string; layer: string; scopeKey: string; createdAt: string; usefulnessScore?: number; tags: string[] }>; nextCursor: string | null; total: number }> {
    const params = new URLSearchParams();
    if (opts.layer) params.set('layer', opts.layer);
    if (opts.scopeKey) params.set('scopeKey', opts.scopeKey);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/memory${qs}`;

    const response = await fetchWithTimeout(url, { method: 'GET', headers: await buildRuntimeHeaders(tenantId) });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
      log.warn({ tenantId, status: response.status, error: errorBody }, 'listMemoriesByLayer: non-OK response');
      throw new Error(`HTTP ${response.status} from tenant runtime memory list`);
    }
    const data = await response.json() as { memories: Array<{ id: string; content: string; source: string; layer: string; scopeKey: string; createdAt: string; usefulnessScore?: number; tags: string[] }>; nextCursor: string | null; total: number };
    return data;
  }

  /**
   * Get a single memory by ID (user-facing CRUD API).
   * Returns null if not found.
   */
  async getMemoryById(
    tenantId: string,
    memoryId: string,
  ): Promise<{ id: string; content: string; layer: string; scopeKey: string; createdAt: string; tags: string[] } | null> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/memory/${memoryId}`;
    const response = await fetchWithTimeout(url, { method: 'GET', headers: await buildRuntimeHeaders(tenantId) });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime memory get`);
    }
    return response.json() as Promise<{ id: string; content: string; layer: string; scopeKey: string; createdAt: string; tags: string[] }>;
  }

  /**
   * Delete a memory by ID regardless of layer (user-facing CRUD API).
   * Throws on failure; treats 404 as not found.
   */
  async deleteMemoryById(
    tenantId: string,
    memoryId: string,
  ): Promise<void> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/memory/${memoryId}`;
    const response = await fetchWithTimeout(url, { method: 'DELETE', headers: await buildRuntimeHeaders(tenantId) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime memory delete`);
    }
    log.info({ event: 'delete_memory', tenantId, memoryId }, 'deleteMemoryById: deleted');
  }

  /**
   * Update the content of a memory by ID regardless of layer (user-facing CRUD API).
   * Throws on failure; treats 404 as not found.
   */
  async updateMemoryById(
    tenantId: string,
    memoryId: string,
    content: string,
  ): Promise<{ id: string; content: string; updatedAt: string }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/memory/${memoryId}`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: await buildRuntimeHeaders(tenantId),
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime memory update`);
    }
    return response.json() as Promise<{ id: string; content: string; updatedAt: string }>;
  }

  async getMemoryProvenance(
    tenantId: string,
    memoryId: string,
    depth = 10,
  ): Promise<{
    memoryId: string;
    maxDepth: number;
    upstream: Array<{
      nodeType: string;
      refId: string;
      connectorId?: string;
      agentId?: string;
      confidence?: number;
      edgeType: string;
      depth: number;
      metadata: Record<string, unknown>;
    }>;
    downstream: Array<{
      nodeType: string;
      refId: string;
      edgeType: string;
      depth: number;
    }>;
  }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/memory/${memoryId}/provenance?depth=${depth}`;
    const response = await fetchWithTimeout(url, { method: 'GET', headers: await buildRuntimeHeaders(tenantId) });
    if (response.status === 404) {
      throw new Error(`HTTP 404 from tenant runtime memory provenance`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime memory provenance`);
    }
    return response.json() as Promise<{
      memoryId: string;
      maxDepth: number;
      upstream: Array<{ nodeType: string; refId: string; connectorId?: string; agentId?: string; confidence?: number; edgeType: string; depth: number; metadata: Record<string, unknown> }>;
      downstream: Array<{ nodeType: string; refId: string; edgeType: string; depth: number }>;
    }>;
  }

  async getAgentSkills(
    tenantId: string,
    agentId: string,
  ): Promise<{ skills: Array<{ id: string; name: string; description: string; instruction: string; tags: string[] }> }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/agents/${agentId}/skills?tenantId=${tenantId}`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: await buildRuntimeHeaders(tenantId),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime skills`);
    }
    return response.json() as Promise<{ skills: Array<{ id: string; name: string; description: string; instruction: string; tags: string[] }> }>;
  }

  // ADR-030: "Run again" — proxy a failed-run re-run to the tenant runtime.
  // PB forwards the internal agent id directly; TR resolves the runtime agent
  // from the invocation row. Returns TR's status + parsed body verbatim (does
  // NOT throw on 4xx) so the router can relay the outcome (202 / 404 / 422).
  async rerunFailedRun(
    tenantId: string,
    internalAgentId: string,
    invocationId: string,
    /** accounts.id of the member who clicked "Run again". TR records it as the
     *  new run's triggeredByUserId; the lineage back to the failed run is
     *  carried separately by rerun_of_invocation_id. Omitted when the caller
     *  could not be resolved to an account. */
    triggeredByUserId?: string,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/internal/agents/${internalAgentId}/invocations/${invocationId}/rerun`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: await buildRuntimeHeaders(tenantId),
      body: JSON.stringify(triggeredByUserId ? { triggeredByUserId } : {}),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  async getAgentsMissingSkills(tenantId: string): Promise<{
    agents: Array<{
      internal_agent_id: string;
      agent_id: string;
      tenant_id: string;
      system_prompt: string;
      user_instructions: string;
      instructions_md: string | null;
    }>;
  }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/agents/missing-skills?tenantId=${tenantId}`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: await buildRuntimeHeaders(tenantId),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from tenant runtime missing-skills`);
    }
    return response.json() as Promise<{ agents: Array<{ internal_agent_id: string; agent_id: string; tenant_id: string; system_prompt: string; user_instructions: string; instructions_md: string | null }> }>;
  }

  /**
   * Submit user feedback on a chat message.
   *
   * The chat service calls this when a user clicks thumbs-up/down or
   * provides written feedback on an assistant message. The tenant runtime
   * stores the feedback as a memory and may queue it for learning loops.
   *
   * Fallback: returns { memoryId: '', queued: false } — feedback is
   * best-effort; a transient failure should not disrupt the chat UX.
   */
  async submitChatFeedback(
    tenantId: string,
    agentId: string,
    feedback: { threadId: string; messageId: string; feedbackType: string; content: string; userId: string },
  ): Promise<{ memoryId: string; queued: boolean }> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/interactive-chat/${agentId}/feedback`;

    return tenantRuntimeBreaker.executeOrFallback<{ memoryId: string; queued: boolean }>(
      { tenantId, method: 'submitChatFeedback' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: await buildRuntimeHeaders(tenantId),
          body: JSON.stringify(feedback),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
          log.warn(
            { tenantId, agentId, threadId: feedback.threadId, status: response.status, error: errorBody },
            'submitChatFeedback: non-OK response from tenant runtime',
          );
          throw new Error(`HTTP ${response.status} from tenant runtime feedback`);
        }

        const data = await response.json() as { memoryId: string; queued: boolean };
        log.info(
          { event: 'interactive_chat_feedback', tenantId, agentId, threadId: feedback.threadId, messageId: feedback.messageId, feedbackType: feedback.feedbackType, queued: data.queued },
          'submitChatFeedback: submitted',
        );
        return data;
      },
      { memoryId: '', queued: false },
    );
  }

  // ── SDK Chat Turn SSE Streaming ────────────────────────────────────

  /**
   * Stream a full chat turn from the Tenant Runtime's SDK engine.
   *
   * POST to /api/interactive-chat/:agentId/chat-turn with Accept: text/event-stream.
   * Parses the SSE stream using eventsource-parser and yields typed events.
   *
   * 5-minute timeout via AbortController. Circuit breaker wrapped so a
   * flapping tenant runtime fast-fails instead of blocking the chat service.
   */
  async *runChatTurnStream(
    tenantId: string,
    params: {
      agentId: string;
      threadId: string;
      invocationId: string;
      userMessage?: string;
      channelHint: 'web' | 'slack' | 'teams';
      userId: string;
      userDisplayName: string;
      userRole: string;
      tenantName?: string;
      resumeSessionId?: string;
      // R5 TE-R5-011: explicit resume contract
      resume?: true;
      approvalId?: string;
      // R5 Fix 12: propagate turnId for audit correlation
      turnId?: string;
      /** Strict accounts.id of the message sender (recall attribution).
       *  Omitted for unresolved Slack/Teams guests. TR maps this to
       *  messageSenderAccountId; without it the recall_conversations
       *  gate fails closed. */
      senderAccountId?: string;
      /** The Liftoff operator's accounts.id when a support delegation session
       *  is sending this turn. TR carries it through execution onto the run's
       *  audit rows, which is the only way to mark a RUN: the delegated request
       *  has ended by the time the run finishes and writes them. Omitted on
       *  every ordinary turn. */
      impersonatedBy?: string;
      autonomy?: 'autonomous' | 'balanced' | 'controlled';
      // Pricing from PB's pricing.ts — single source of truth, eliminates duplicate table in TR
      modelPriceInputPerMillion?: number;
      modelPriceOutputPerMillion?: number;
      /** Opt-in flag set ONLY by the PB-side agent-test harness. When
       *  true, TR's chat-turn-handler emits richer SSE events
       *  (catalog / tool_call args / tool_call_finished / usage) so the
       *  harness has full parity with the TR-direct runner. Real chat
       *  never sets this and never receives the richer events. See
       *  tenant-runtime chat-event-relay.ts. */
      traceMode?: boolean;
      /** Rolling summary of everything older than the recent-turns window,
       *  formatted by `formatSummaryForPrompt`. PB owns the summary (it is
       *  regenerated after each turn from `agent_chat_threads.rolling_summary`)
       *  and TR owns prompt assembly, so it has to travel on the wire.
       *  Absent on short threads — the summarizer does not run below its
       *  message threshold, and a missing summary must never block a turn. */
      conversationSummary?: string;
      /** Images this turn carries, as REFERENCES.
       *
       *  Never bytes. A 20 MB base64 payload on a chat-turn request would put
       *  the whole upload on a path sized for a sentence, and it would ride it
       *  again on every retry. The runtime fetches each object from the control
       *  plane's service-auth content route instead.
       *
       *  Only ever populated with media the agent's model can actually SEE:
       *  this process owns the capability registry, so the vision decision is
       *  made here and what the model cannot see is described in words inside
       *  `userMessage` instead. */
      media?: MediaRef[];
      /** The person handed the browser back, ending this hold; verified by the
       *  caller against the runtime's record. With an empty `userMessage` the
       *  runtime supplies the model-facing text of the turn. */
      browserHandback?: { holdId: string };
      /** The display name of the person holding the wheel, for the Browser
       *  section the runtime renders into the turn. */
      browserDriverName?: string;
    },
  ): AsyncGenerator<ChatTurnStreamEvent> {
    const baseUrl = await resolveRuntimeBaseUrl(tenantId);
    const url = `${baseUrl}/api/interactive-chat/${params.agentId}/chat-turn`;

    // Deliberately LONGER than the runtime's own 14-minute hard timeout so TR
    // wins the race and ends the turn itself — TR's timeout persists whatever
    // the engine produced and settles it, whereas aborting from here just drops
    // the stream. Ladder: TR 840s < this 870s < SSE cap 880s < PB Cloud Run 900s.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TURN_STREAM_TIMEOUT_MS);

    try {
      const headers = await buildRuntimeHeaders(tenantId);
      headers['Accept'] = 'text/event-stream';

      // R5: build body per resume vs new-message contract
      const body: Record<string, unknown> = {
        tenantId,
        agentId: params.agentId,
        threadId: params.threadId,
        invocationId: params.invocationId,
        channelHint: params.channelHint,
        userId: params.userId,
        userDisplayName: params.userDisplayName,
        userRole: params.userRole,
      };
      if (params.tenantName !== undefined) body.tenantName = params.tenantName;
      if (params.resumeSessionId !== undefined) body.resumeSessionId = params.resumeSessionId;
      if (params.turnId !== undefined) body.turnId = params.turnId;
      if (params.senderAccountId !== undefined) body.senderAccountId = params.senderAccountId;
      // Omitted rather than sent as null, like senderAccountId above: TR
      // validates it as an optional uuid and a null would be rejected.
      if (params.impersonatedBy) body.impersonatedBy = params.impersonatedBy;
      if (params.autonomy !== undefined) body.autonomy = params.autonomy;
      if (params.modelPriceInputPerMillion !== undefined) body.modelPriceInputPerMillion = params.modelPriceInputPerMillion;
      if (params.modelPriceOutputPerMillion !== undefined) body.modelPriceOutputPerMillion = params.modelPriceOutputPerMillion;
      if (params.traceMode === true) body.traceMode = true;
      if (params.conversationSummary) body.conversationSummary = params.conversationSummary;
      if (params.media && params.media.length > 0) body.media = params.media;
      if (params.browserHandback) body.browserHandback = params.browserHandback;
      if (params.browserDriverName) body.browserDriverName = params.browserDriverName;
      if (params.resume === true) {
        if (!params.approvalId) {
          throw new Error('resume requires approvalId');
        }
        body.resume = true;
        body.approvalId = params.approvalId;
        if (params.userMessage !== undefined) body.userMessage = params.userMessage;
      } else {
        // A browser event is a turn of its own: the runtime supplies the
        // model-facing text when the person sent no words with it.
        const browserEvent = params.browserHandback !== undefined;
        if (!params.userMessage && !browserEvent) {
          throw new Error('userMessage required when resume is not set');
        }
        body.userMessage = params.userMessage ?? '';
      }

      const response: Response = await tenantRuntimeBreaker.executeOrFallback<Response>(
        { tenantId, method: 'runChatTurnStream' },
        async () => {
          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!resp.ok) {
            const errorBody = await resp.text().catch(() => 'Unknown error');
            throw new Error(`HTTP ${resp.status} from tenant runtime chat-turn: ${errorBody}`);
          }

          return resp;
        },
        // Fallback: if the circuit is open, return a synthetic error response
        null as unknown as Response,
      );

      if (!response || !response.body) {
        yield { type: 'error', code: 'CONNECTION_FAILED', message: 'Failed to connect to tenant runtime' };
        return;
      }

      // TR answers with plain JSON (not SSE) when the message was folded into an
      // in-flight run (interrupt), answered a pending clarification, or stopped a
      // run — before any SSE headers are written on its side. Detect by
      // content-type; feeding JSON to the SSE parser yields zero events and the
      // caller misreads it as a dead stream.
      // Divert ONLY when the response positively identifies itself as
      // non-SSE; an absent content-type falls through to stream parsing.
      const contentType = response.headers?.get('content-type') ?? '';
      if (contentType && !contentType.startsWith('text/event-stream')) {
        type ChatTurnAck = { resumed?: boolean; acknowledged?: boolean; deliveredAs?: string };
        let ack: ChatTurnAck | null = null;
        try {
          ack = await response.json() as ChatTurnAck;
        } catch {
          ack = null;
        }
        if (ack?.resumed) {
          yield { type: 'clarification_accepted' };
        } else if (ack?.acknowledged && ack.deliveredAs === 'interrupt') {
          yield { type: 'interrupt_delivered' };
        } else if (ack?.acknowledged && (ack.deliveredAs === 'abort' || ack.deliveredAs === 'noop')) {
          // 'noop' = stop pressed but nothing was running (race with completion);
          // the user's intent is satisfied either way.
          yield { type: 'stop_acknowledged' };
        } else {
          yield { type: 'error', code: 'UNEXPECTED_RESPONSE',
                  message: 'Tenant runtime returned a non-stream response of unknown shape' };
        }
        return;
      }

      // Parse SSE events from the response body stream
      const events: ChatTurnStreamEvent[] = [];
      let resolveEvent: (() => void) | null = null;

      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          try {
            const data = JSON.parse(event.data);
            const eventType = event.event || data.type;

            switch (eventType) {
              case 'thinking':
                events.push({ type: 'thinking' });
                break;
              case 'text_delta':
                events.push({ type: 'text_delta', text: data.text });
                break;
              case 'text_break':
                events.push({ type: 'text_break' });
                break;
              case 'tool_call':
                // Default mode: { tool } only. Trace mode also carries
                // callId + args. Pass through both shapes — the
                // ChatTurnStreamEvent union accepts both.
                events.push({
                  type: 'tool_call',
                  tool: data.tool,
                  ...(data.callId !== undefined ? { callId: data.callId } : {}),
                  ...(data.args !== undefined ? { args: data.args } : {}),
                });
                break;
              // ── Trace-mode-only events. Only emitted by TR when the
              //    chat-turn body had traceMode: true. Real chat never
              //    receives them because real chat never sets the flag.
              case 'catalog':
                events.push({ type: 'catalog', exposedToolNames: data.exposedToolNames ?? [] });
                break;
              case 'tool_call_finished':
                events.push({
                  type: 'tool_call_finished',
                  callId: data.callId,
                  result: data.result,
                  ...(data.error ? { error: data.error } : {}),
                });
                break;
              case 'usage':
                events.push({
                  type: 'usage',
                  inputTokens: data.inputTokens ?? 0,
                  outputTokens: data.outputTokens ?? 0,
                  ...(data.cachedTokens !== undefined ? { cachedTokens: data.cachedTokens } : {}),
                });
                break;
              case 'hitl_required':
                events.push({
                  type: 'hitl_required', approvalId: data.approvalId, reason: data.reason,
                  action: data.action ?? null, why: data.why ?? null, detail: data.detail ?? null,
                  ...delegatedToField(data),
                });
                break;
              case 'delegation_started':
                if (typeof data.agentId === 'string') {
                  events.push({ type: 'delegation_started', agentId: data.agentId });
                }
                break;
              case 'host_delivered': {
                const fields = Array.isArray(data.fields)
                  ? (data.fields as Array<Record<string, unknown>>)
                      .filter((f) => f && typeof f.path === 'string')
                      .map((f) => ({ path: f.path as string, value: f.value }))
                  : [];
                if (fields.length > 0) {
                  events.push({
                    type: 'host_delivered',
                    tool: typeof data.tool === 'string' ? data.tool : '',
                    fields,
                  });
                }
                break;
              }
              case 'delegation_paused':
                events.push({
                  type: 'delegation_paused',
                  agentId: data.agentId,
                  approvalId: typeof data.approvalId === 'string' ? data.approvalId : null,
                  reason: typeof data.reason === 'string'
                    ? data.reason
                    : 'The team stopped for an approval before it could continue.',
                });
                break;
              case 'workflow_step':
                if (typeof data.index === 'number' && typeof data.total === 'number') {
                  events.push({
                    type: 'workflow_step',
                    stepId: typeof data.stepId === 'string' ? data.stepId : '',
                    index: data.index,
                    total: data.total,
                  });
                }
                break;
              case 'run_parked':
                events.push({
                  type: 'run_parked',
                  reason: data.reason === 'wake' ? 'wake' : 'continuation',
                  detail: typeof data.detail === 'string' && data.detail.length > 0
                    ? data.detail
                    : 'This run is continuing in the background and will post here when it is done.',
                });
                break;
              case 'awaiting_input':
                // ask_user clarification pause. Unmapped it falls through to
                // `default` ("unknown SSE event type") and is dropped, so the
                // frontend's inline-prompt affordance never fires. Map it so the
                // generator yields it end to end (symmetric with hitl_required).
                events.push({
                  type: 'awaiting_input', question: data.question, sessionId: data.sessionId,
                  ...delegatedToField(data),
                });
                break;
              case 'complete':
                events.push({
                  type: 'complete',
                  outputText: data.outputText,
                  inputTokens: data.inputTokens,
                  outputTokens: data.outputTokens,
                  sessionId: data.sessionId,
                  ...(data.stopped === true ? { stopped: true } : {}),
                  ...(data.escalated === true ? { escalated: true } : {}),
                  ...(data.didNotFinish === true ? { didNotFinish: true } : {}),
                  ...delegatedToField(data),
                });
                break;
              case 'error':
                events.push({
                  type: 'error',
                  code: data.code,
                  message: data.message,
                  ...(typeof data.failureClass === 'string'
                    ? { failureClass: data.failureClass }
                    : {}),
                  ...(typeof data.retryable === 'boolean'
                    ? { retryable: data.retryable }
                    : {}),
                });
                break;
              default:
                log.warn({ tenantId, eventType }, 'runChatTurnStream: unknown SSE event type');
            }
          } catch (parseErr) {
            log.warn(
              { tenantId, data: event.data, error: (parseErr as Error).message },
              'runChatTurnStream: failed to parse SSE event data',
            );
          }

          // Wake up the consumer if it's waiting
          if (resolveEvent) {
            resolveEvent();
            resolveEvent = null;
          }
        },
        onComment() {
          // Heartbeat comments — ignore
        },
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let readerDone = false;

      // Read chunks and feed to parser, yielding events as they arrive
      while (!readerDone) {
        const { done, value } = await reader.read();
        if (done) {
          readerDone = true;
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);

        // Yield any events that were parsed from this chunk
        while (events.length > 0) {
          yield events.shift()!;
        }
      }

      // Yield any remaining events after stream ends
      while (events.length > 0) {
        yield events.shift()!;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        yield {
          type: 'error',
          code: 'TIMEOUT',
          message: `Chat turn stream timed out after ${Math.round(CHAT_TURN_STREAM_TIMEOUT_MS / 60000)} minutes`,
        };
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Dispatch an agent task asynchronously (plan v6.1 Phase 0.4).
   *
   * Calls TR's `POST /api/tasks/enqueue-standalone` — a fast 202 that
   * self-enqueues a Cloud Task targeting TR's execute-standalone handler.
   * The old direct call to /api/tasks/execute was broken end-to-end: field
   * names didn't match TR's contract (context/inputData, escalationLevel/
   * escalation, triggerRef/triggerKey), workflowId/taskId were missing (TR
   * 400), and the circuit-breaker `{}` fallback swallowed every failure so
   * callers reported success while nothing ran.
   *
   * Contract: returns `{ taskId }` ONLY on a successful enqueue; THROWS on
   * any failure (deliberately no breaker fallback — silent success was the
   * bug). The client-generated taskId is TR's payload.taskId and the value
   * workflow-engine stores in workflow_step_executions.task_id, so one uuid
   * threads through enqueue, execution, cancellation, and callbacks.
   */
  async enqueueAgentTask(
    tenantId: string,
    agentId: string,
    params: {
      objective: string;
      context: Record<string, unknown>;
      triggeredBy: string;
      triggeredByUserId?: string;
      triggerRef: string;
      hitlLevel?: number;
      escalationLevel?: 'exceptions' | 'important' | 'sensitive';
      requestedByType?: 'mcp_key' | 'a2a_token' | 'internal';
      requestedById?: string;
    },
  ): Promise<{ taskId: string }> {
    const taskId = crypto.randomUUID();
    const { triggeredBy, triggeredByLabel } = mapTriggeredByForExecution(
      params.triggeredBy,
      params.requestedById,
    );

    // Breaker retained for state tracking + fast-fail when TR is down, but
    // with a SENTINEL fallback converted back into a throw — the old `{}`
    // fallback's silent success was the production bug this replaces.
    const BREAKER_OPEN = Symbol('enqueue-breaker-open');
    const result = await tenantRuntimeBreaker.executeOrFallback<{ taskId: string } | typeof BREAKER_OPEN>(
      { tenantId, method: 'enqueueAgentTask' },
      async () => {
        const baseUrl = await resolveRuntimeBaseUrl(tenantId);
        const res = await fetchWithTimeout(`${baseUrl}/api/tasks/enqueue-standalone`, {
          method: 'POST',
          headers: { ...(await buildRuntimeHeaders(tenantId)), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId,
            agentId,
            taskId,
            objective: params.objective,
            inputData: params.context,
            triggeredBy,
            triggeredByLabel,
            triggerKey: params.triggerRef,
            hitlLevel: params.hitlLevel,
            escalation: params.escalationLevel,
            requestedByType: params.requestedByType,
            requestedById: params.requestedById,
          }),
        });
        if (res.status !== 202) {
          throw new Error(`enqueueAgentTask failed: ${res.status}`);
        }
        return { taskId };
      },
      BREAKER_OPEN,
    );
    if (result === BREAKER_OPEN) {
      throw new Error('enqueueAgentTask failed: tenant runtime unavailable (circuit open or call failed)');
    }
    return result;
  }

  /** Self-wake operator surface: list a tenant's live wakes via TR's internal endpoint. */
  async listWakes(tenantId: string, agentId?: string | null): Promise<{ wakes: unknown[] }> {
    const baseUrl = await resolveRuntimeBaseUrl(tenantId);
    const q = agentId ? `?tenantId=${encodeURIComponent(tenantId)}&agentId=${encodeURIComponent(agentId)}`
                      : `?tenantId=${encodeURIComponent(tenantId)}`;
    const res = await fetchWithTimeout(`${baseUrl}/api/internal/wakes${q}`, {
      headers: { ...(await buildRuntimeHeaders(tenantId)), 'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '' },
    });
    if (!res.ok) throw new Error(`listWakes failed: ${res.status}`);
    return (await res.json()) as { wakes: unknown[] };
  }

  /** Operator cancel of a wake via TR's internal endpoint. */
  async cancelWake(tenantId: string, wakeId: string): Promise<{ cancelled: boolean }> {
    const baseUrl = await resolveRuntimeBaseUrl(tenantId);
    const res = await fetchWithTimeout(`${baseUrl}/api/internal/wakes/${encodeURIComponent(wakeId)}/cancel`, {
      method: 'POST',
      headers: {
        ...(await buildRuntimeHeaders(tenantId)),
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
      },
      body: JSON.stringify({ tenantId }),
    });
    if (!res.ok) throw new Error(`cancelWake failed: ${res.status}`);
    return (await res.json()) as { cancelled: boolean };
  }

  async cancelAgentTask(tenantId: string, agentId: string, taskId: string): Promise<void> {
    await tenantRuntimeBreaker.executeOrFallback<void>(
      { tenantId, method: 'cancelAgentTask' },
      async () => {
        const baseUrl = await resolveRuntimeBaseUrl(tenantId);
        const res = await fetchWithTimeout(`${baseUrl}/api/tasks/cancel`, {
          method: 'POST',
          headers: { ...(await buildRuntimeHeaders(tenantId)), 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantId, agentId, taskId, triggerRef: `a2a:${taskId}` }),
        });
        if (!res.ok) throw new Error(`cancelAgentTask failed: ${res.status}`);
      },
      undefined,
    );
  }

  /**
   * Delete all connector content for a given connector type from tenant runtime.
   * Called on connector.deleted event — best-effort, non-throwing.
   */
  async deleteConnectorContent(tenantId: string, connectorType: string): Promise<void> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/internal/connector-content`;
    const response = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: { ...(await buildRuntimeHeaders(tenantId)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId, connectorType }),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status, tenantId, connectorType },
        'deleteConnectorContent: non-OK response (best-effort)',
      );
    }
  }

  /**
   * Search indexed connector content (Slack messages, Confluence pages, etc.)
   * using semantic search in tenant runtime. Returns empty array on failure.
   */
  async searchConnectorContent(
    tenantId: string,
    params: {
      query: string;
      connectorType?: string;
      limit?: number;
      agentId?: string;
    },
  ): Promise<{
    results: Array<{ id: string; content: string; connector_type: string; entity_type: string; tags: string[] }>;
    coverage: { indexedItems: number; oldestIndexedAt: string | null; newestIndexedAt: string | null } | null;
  }> {
    const url = new URL(`${await resolveRuntimeBaseUrl(tenantId)}/api/internal/connector-content/search`);
    url.searchParams.set('tenantId', tenantId);
    url.searchParams.set('query', params.query);
    if (params.connectorType) url.searchParams.set('connectorType', params.connectorType);
    if (params.limit) url.searchParams.set('limit', String(params.limit));
    if (params.agentId) url.searchParams.set('agentId', params.agentId);
    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: await buildRuntimeHeaders(tenantId),
    });
    if (!response.ok) {
      log.warn({ status: response.status, tenantId }, 'searchConnectorContent: non-OK response');
      return { results: [], coverage: null };
    }
    const json = await response.json() as {
      results?: Array<{ id: string; content: string; connector_type: string; entity_type: string; tags: string[] }>;
      coverage?: { indexedItems: number; oldestIndexedAt: string | null; newestIndexedAt: string | null };
    };
    return { results: json.results ?? [], coverage: json.coverage ?? null };
  }

  /**
   * What this workspace's data looks like: entity counts per connector, how
   * much content is already indexed, how far back the record goes.
   *
   * Returns null on any failure. Distillation runs on top of this and must
   * never fail because the runtime was slow or unreachable — an agent
   * distilled without its data landscape gets generic instructions, which is
   * the status quo, not a regression.
   */
  async getDataLandscape(
    tenantId: string,
    opts?: { knowledgeItems?: number },
  ): Promise<{
    connectors: Array<{
      connectorType: string;
      entityCounts: Record<string, number>;
      hydratedCount: number;
      stubCount: number;
      oldestObservedAt: string | null;
      newestObservedAt: string | null;
    }>;
    indexedContext: { items: number; oldest: string | null; newest: string | null };
    knowledgeItems: number | null;
    truncated: boolean;
  } | null> {
    try {
      const url = new URL(`${await resolveRuntimeBaseUrl(tenantId)}/api/internal/data-landscape`);
      url.searchParams.set('tenantId', tenantId);
      if (opts?.knowledgeItems !== undefined) {
        url.searchParams.set('knowledgeItems', String(opts.knowledgeItems));
      }
      const response = await fetchWithTimeout(url.toString(), {
        method: 'GET',
        headers: await buildRuntimeHeaders(tenantId),
      });
      if (!response.ok) {
        log.warn({ status: response.status, tenantId }, 'getDataLandscape: non-OK response');
        return null;
      }
      return await response.json() as Awaited<ReturnType<TenantRuntimeClient['getDataLandscape']>>;
    } catch (err) {
      log.warn({ err: (err as Error).message, tenantId }, 'getDataLandscape failed');
      return null;
    }
  }

  /**
   * Trigger connector content expiry for a single tenant (maintenance job).
   * Best-effort — logs and returns on failure.
   */
  async expireConnectorContentForTenant(tenantId: string): Promise<void> {
    const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/internal/connector-content/maintenance/expire-connector-content`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...(await buildRuntimeHeaders(tenantId)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status, tenantId },
        'expireConnectorContentForTenant: non-OK response (best-effort)',
      );
    }
  }

  /**
   * Fetch live agent status from tenant-runtime.
   *
   * Returns `AgentStatusResponse` for `format='json'`, a pre-rendered text
   * blob for `format='text'`, or `null` when the invocation doesn't exist
   * (or doesn't belong to the supplied tenant per the defense-in-depth
   * `X-Liftoff-Expected-Tenant` header).
   */
  async getAgentStatus(args: {
    tenantId: string;
    invocationId: string;
    format: 'json' | 'text';
  }): Promise<AgentStatusResponse | string | null> {
    const url =
      `${await resolveRuntimeBaseUrl(args.tenantId)}/api/invocations/${args.invocationId}` +
      `/status?format=${args.format}`;

    return tenantRuntimeBreaker.executeOrFallback<AgentStatusResponse | string | null>(
      { tenantId: args.tenantId, method: 'getAgentStatus' },
      async () => {
        const response = await fetchWithTimeout(url, {
          method: 'GET',
          headers: {
            ...(await buildRuntimeHeaders(args.tenantId)),
            'X-Liftoff-Expected-Tenant': args.tenantId,
          },
        });
        if (response.status === 404) return null;
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from tenant runtime agent-status`);
        }
        return args.format === 'text'
          ? await response.text()
          : (await response.json()) as AgentStatusResponse;
      },
      null,
    );
  }
}

export const tenantRuntimeClient = new TenantRuntimeClient();
