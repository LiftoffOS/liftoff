// HITL Enforcement Service — the tenant-runtime side of the human-in-the-loop approval gate.

import crypto from 'crypto';
import { uuidOrNull } from '../agent-execution/run-identity';
import type { PoolClient } from 'pg';
import { pool, withTenantScope } from '../infrastructure/database';
import { enqueueActionTrustOutbox, type TrustDecisionsPayload } from './action-trust-outbox';
import { log } from '../infrastructure/logging';
import {
  ToolCallRequest,
  ModelTool,
  HitlApprovalRequest,
  ApprovalStatus,
  OversightSettings,
  GateResult,
  CreateApprovalInput,
  ResolveApprovalInput,
  hardInvariantEffectOf,
  semanticsOf,
  type ApprovalGateView,
  type GateReason,
} from './types';
import {
  parseApprovedEdits,
  applyApprovedEdits,
  editedCallIds,
  type ApprovedEdits,
} from './approved-edits';
import {
  evaluateApprovalObligations,
  REASON_PRECEDENCE,
  type ObligationConfig,
  type StandingPolicy,
} from './approval-obligations';
import { stagedBatchRepository } from '../tool-gateway/staged-batches';
import { postSkillFeedback } from '../platform-callback/client';
import { isInProcessBookkeepingTool, isOwnWorkspaceChatTool, isSelfWakeTool, resolveGateTool, bareToolActionName } from './tool-name-resolution';
import { fetchOversightSettings } from '../clients/platform-backend-client';
import { getGovernanceApprovalPolicy, createGovernanceApprovalPolicy, getAgentActionTrust } from '../governance/governance-service-client';
import { insertAuditLog } from '../audit';
import { recordHumanCorrection } from '../agent-execution/evidence-totals';
import { classifyVendorToolEffect, effectPassesUngated, toolIsReadOnly } from '../tool-gateway/tool-effect';
import { isInternalCollaborationTool, isOutboundTool } from '../tool-gateway/oversight-decision';
import { canonicalJson } from '../agent-execution/sideeffect-idempotency';
import { isInPlaceReply, type TriggerTarget } from './in-place-reply';
import { inDeclaredScope, type DeclaredStep } from './declared-scope';
import { allow as contractCheckedAllow, type HitlContract } from './contract-check';
import { surfacingPolicyOf } from './surfacing';

// [SE-001] Rate limit for autonomous operations (Level 5 and Level 4 auto-elevated)
const AUTONOMOUS_HOURLY_LIMIT = 1000;

/**
 * Name-based gate sets (SUPER_DESTRUCTIVE_OPERATIONS, MERGE_TO_MAIN_TOOL_NAMES)
 * hold BARE action names (e.g. `merge_pull_request`). At runtime every tool
 * call name is prefixed by the dispatch surface:
 *   - sandbox / connector catalog:  `<alias>__<tool>`        (github-ab12__merge_pull_request)
 *   - Claude Agent SDK (LLM path):  `mcp__<server>__<tool>`  (mcp__github-ab12__merge_pull_request,
 *                                    in-process: mcp__liftoff-tools-<tenant>__<alias>__<tool>)
 * A raw `set.has(prefixedName)` therefore never matches, silently disabling
 * these gates (tests that pass bare names would not notice). The merge-to-main gate exists specifically to govern vendor-MCP
 * GitHub tools — which can't be category-gated — so the prefix mismatch defeats
 * its entire purpose. Normalize to the bare action (segment after the last
 * `__`) and check both forms so prefixed AND bare names match.
 */
export function toolActionMatchesNameSet(set: ReadonlySet<string>, toolName: string): boolean {
  if (set.has(toolName)) return true;
  const sep = toolName.lastIndexOf('__');
  return sep >= 0 && set.has(toolName.slice(sep + 2));
}

// `bareToolActionName` lives in tool-name-resolution.ts beside the other name
// normalisers; re-exported here because this is where its callers import it.
export { bareToolActionName };

/** Gate reasons too high-risk to let an operator turn into a blanket standing
 *  ("always allow" / "always reject") decision — each occurrence must get a fresh
 *  human decision. Enforced authoritatively where the standing policy is created
 *  (below), and mirrored by the card/web UIs which hide the always-apply affordance. */
const STANDING_APPROVAL_SUPPRESSED_REASONS: ReadonlySet<string> = new Set([
  'super_destructive_gate', 'merge_to_main', 'sensitive_work',
]);
/** True when a gate reason may be turned into a standing auto-decision via alwaysApply. */
export function standingApprovalAllowed(reason: string): boolean {
  return !STANDING_APPROVAL_SUPPRESSED_REASONS.has(reason);
}

// ── Unified /review queue types ────────────────────────────────────────
//
// Both pending HITL approvals AND pending clarification questions live in
// the same dashboard queue. PR0 introduces this discriminated union so the
// frontend can render both card variants from one list.

/** The agent's display name, on every queue item.
 *
 *  Resolved here because only this service can. `agentId` on both kinds is a
 *  RUNTIME `agents.id` (INV-TR-010), while every consumer downstream addresses
 *  a team by its control-plane `internal_agents.id`. The two spaces are
 *  disjoint by construction, so a consumer looking this id up in what it holds
 *  matches nothing and gets no error saying so: the name has to travel with the
 *  item or it cannot be shown at all.
 *
 *  Null when the runtime row is gone. `hitl_approval_requests.agent_id`
 *  cascades from `agents`, but `agent_scheduled_invocations.agent_id` carries
 *  no FK, so a clarification can outlive its team. `agents` keeps DELETED rows,
 *  so an ordinary deletion still resolves its name. */
type AgentNamed = {
  agentName: string | null;
};

export interface ApprovalItem extends HitlApprovalRequest, AgentNamed {
  kind: 'approval';
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
  createdAt: Date;
  expiresAt: Date;
}

/** One approval as the review HISTORY feed serves it: every status, for the
 *  workspace export. A dedicated shape rather than HitlApprovalRequest because
 *  `mapApprovalRequest` does `new Date(row.expires_at)` unconditionally while
 *  the column is nullable (the queue predicate itself tests
 *  `expires_at IS NULL`), so this carries `expiresAt: string | null` and the
 *  other timestamps likewise. Selects exactly what the export's status table
 *  reads: the transition timestamps first, then the terminal status. */
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
  pendingToolCalls: ToolCallRequest[];
  editedToolInputs: ApprovedEdits | null;
  actionSummary: string | null;
  whySummary: string | null;
  detail: string | null;
}

/** One clarification as the history feed serves it, with the four resolution
 *  columns migration 419 added. */
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

export interface ReviewHistoryOptions {
  /** Inclusion boundary: rows created at or before this instant. */
  asOf: Date;
  cursor?: string;
  limit?: number;
}

/** Page size ceiling for the history feeds. */
export const REVIEW_HISTORY_MAX_LIMIT = 200;

/** The /review queue holds parked runs: an approval waiting on a decision, or a
 *  clarification waiting on an answer. Both resume the run they belong to.
 *
 *  Escalations are deliberately not here. An escalated run has already ended,
 *  so there is nothing for an answer to restart, and "resolve" only flipped a
 *  row. A blocker a person can clear now parks the run as a clarification at
 *  the point the agent decides to escalate; a blocker only we can clear is a
 *  `system_internal` record. `resolveEscalation` below stays for the operator
 *  surface, which still clears rows. */
export type PendingQueueItem = ApprovalItem | ClarificationItem;

/** The stored clarification, as the answer and decline paths both need it.
 *
 *  `question` is read out of the resume payload rather than a column, which is
 *  where the queue listing reads it from too, so the text a person saw is the
 *  text the learning loop records. Null on rows written before the pause
 *  carried its own context. */
interface ClarificationRow {
  id: string;
  clarification_source: string;
  vendor_request_id: string | null;
  scheduled_by_invocation_id: string;
  tenant_id: string;
  agent_id: string;
  thread_id: string;
  question: string | null;
}

/** Bucketed count of everything the /review queue would render for a tenant.
 *
 *  The approval buckets partition the approvals exhaustively — `hitl_level` is
 *  the tenant's effective autonomy level (1 to 5, default 3), not a two-way
 *  split, so anything outside Standard (1) and Critical (2) lands in
 *  `approvalsOther` rather than falling out of the arithmetic. The invariant
 *  every surface relies on: total = approvalsStandard + approvalsCritical +
 *  approvalsOther + clarifications. */
export interface PendingItemsCount {
  total: number;
  approvalsStandard: number;
  approvalsCritical: number;
  approvalsOther: number;
  clarifications: number;
}

/** One operator record: an escalation only we can clear.
 *
 *  These left every customer surface when the queue narrowed to parked runs, on
 *  the reasoning that a customer cannot act on a broken connector or an
 *  unreachable provider. That was right, and it left them visible to nobody at
 *  all: not the customer, and not the internal dashboard, whose service reads
 *  the control plane and never calls the runtime. A record nobody can see is
 *  indistinguishable from one that does not exist, and the retention sweep
 *  would eventually delete it unread. This is the read path that fixes that. */
export interface OperatorEscalationRecord {
  id: string;
  tenantId: string;
  agentId: string | null;
  reason: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  occurrenceCount: number;
  /** Why it landed here, when the writer said (migration 429): the ask
   *  check's `{ ask_check: { person_can_act: p } }`. Null otherwise. */
  context: Record<string, unknown> | null;
}

/** The one definition of "actionable" for the /review queue.
 *
 *  Both the listing and the count embed these exact clauses, so a kind that is
 *  counted but not listed (or the reverse) cannot happen. Before this existed,
 *  five places re-derived the rule and disagreed: a tenant with 141 pending
 *  escalations read "0 items awaiting decision" beside a full queue.
 *
 *  The queue holds parked runs: a person supplies one input and the run carries
 *  on. Escalations are deliberately absent, and that absence is the point. An
 *  escalated run has already ended — there is no pause row, no resume payload,
 *  nothing an answer could restart — so it was never a queue item, only a
 *  notice wearing one's clothes. A blocker a person CAN clear now parks the run
 *  as a clarification instead, and arrives here as one; a blocker only we can
 *  clear is a `system_internal` record. Either way nothing reaches this queue
 *  that a person cannot act on.
 *
 *  Parameter contract, identical in both queries: $1 = tenant id, $2 = optional
 *  agent id filter (NULL means every agent).
 *
 *  - approvals: a NULL `expires_at` is a gate with no deadline and stays live,
 *    which is what the write path does too (approve/reject only refuses once
 *    `expires_at` is in the past).
 *  - clarifications: status only, deliberately no expiry guard.
 *    `respondToClarification` transitions on `status='pending'` alone, so an
 *    expiry filter here would hide a question the write path still accepts.
 *    `review_listed` (migration 430) is the one row the write path itself
 *    keeps off the page: a plain question parked under the Escalation
 *    setting "Only exceptions" waits in its chat thread, and is answered by
 *    a reply there, by a direct link, or by expiry, on `status` alone. It
 *    is listed again the moment a later tick announces it.
 */
const ACTIONABLE_QUEUE_PREDICATES = {
  approvals: `tenant_id = $1
              AND status = 'pending'
              AND (expires_at IS NULL OR expires_at > NOW())
              AND ($2::uuid IS NULL OR agent_id = $2::uuid)`,
  clarifications: `tenant_id = $1
              AND status = 'pending'
              AND objective = 'clarification-expiry'
              AND review_listed
              AND ($2::uuid IS NULL OR agent_id = $2::uuid)`,
} as const;

/** How far back the "decision window passed" view looks.
 *
 *  A display bound, not an eligibility rule: late feedback stays acceptable on
 *  an older approval reached by a direct link. Without it the view would grow
 *  without limit over a table that is never pruned. */
export const PASSED_WINDOW_LOOKBACK = '30 days';

/** Approvals whose decision window has closed, for the queue's "Passed" view.
 *
 *  `status IN ('pending','expired')` covers both sides of the sweeper: the
 *  runtime flips a lapsed approval to 'expired' within ~30 minutes, and until
 *  it does the row is still 'pending' with a past `expires_at`. An approval
 *  that was actually decided is not "passed" — it was answered — so approved
 *  and rejected rows stay out.
 *
 *  Same parameter contract as ACTIONABLE_QUEUE_PREDICATES: $1 tenant, $2 agent. */
const PASSED_APPROVALS_PREDICATE = `tenant_id = $1
              AND status IN ('pending', 'expired')
              AND expires_at IS NOT NULL
              AND expires_at <= NOW()
              AND expires_at > NOW() - INTERVAL '${PASSED_WINDOW_LOOKBACK}'
              AND ($2::uuid IS NULL OR agent_id = $2::uuid)`;

/** Which view of the queue a caller wants: what still needs a person, or what
 *  slipped past its decision window. */
export type QueueWindow = 'actionable' | 'passed';

/** Opaque keyset cursor: base64 of `<sort_at text>|<kind>|<id>`.
 *
 *  The timestamp travels as Postgres text rather than a JS Date because a Date
 *  truncates `timestamptz` to milliseconds, and a truncated boundary silently
 *  drops every row inside the same millisecond. `kind` and `id` break ties:
 *  `created_at` is not unique, least of all across three independent tables. */
export function encodeQueueCursor(sortAt: string, kind: string, id: string): string {
  return Buffer.from(`${sortAt}|${kind}|${id}`, 'utf8').toString('base64');
}

export function decodeQueueCursor(
  cursor?: string | null,
): { sortAt: string; kind: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const firstSep = raw.indexOf('|');
    const secondSep = raw.indexOf('|', firstSep + 1);
    if (firstSep < 1 || secondSep < 0) return null;
    const sortAt = raw.slice(0, firstSep);
    const kind = raw.slice(firstSep + 1, secondSep);
    const id = raw.slice(secondSep + 1);
    if (!sortAt || !kind || !id) return null;
    return { sortAt, kind, id };
  } catch {
    // A malformed cursor reads as no cursor: the caller gets page one rather
    // than an error, which is the safe way to fail an opaque token.
    return null;
  }
}

// Shared exhaustive router for clarification resolution. Used by both
// hitl-enforcement.respondToClarification (queue surface) and the chat
// turn handler (in-thread reply surface) so the two paths can't drift.
export async function resolveClarification(
  row: {
    id: string;
    clarification_source: string;
    vendor_request_id: string | null;
    scheduled_by_invocation_id: string;
    tenant_id: string;
    agent_id: string;
    thread_id: string;
  },
  responseText: string,
): Promise<void> {
  const source = row.clarification_source as 'recovery_llm' | 'anchor_intervention';
  switch (source) {
    case 'recovery_llm': {
      const { enqueueResumeForRecoveryClarification } = await import(
        '../interactive-chat/clarification-resume-helpers'
      );
      await enqueueResumeForRecoveryClarification({
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        threadId: row.thread_id,
        scheduledRowId: row.id,
        scheduledByInvocationId: row.scheduled_by_invocation_id,
        userAnswer: responseText,
      });
      return;
    }
    case 'anchor_intervention': {
      if (!row.vendor_request_id) {
        throw new Error('anchor_intervention row missing vendor_request_id');
      }
      const { forwardAnchorInterventionResponse } = await import(
        '../integrations/web-fetch/anchor-intervention-bridge'
      );
      await forwardAnchorInterventionResponse(row.vendor_request_id, responseText);
      const { agentScheduledInvocationsRepo } = await import(
        '../scheduling/agent-scheduled-invocations-repo'
      );
      await agentScheduledInvocationsRepo.markClarificationFired(row.id);
      return;
    }
    default: {
      const _exhaustive: never = source;
      throw new Error(`unhandled clarification_source: ${_exhaustive as string}`);
    }
  }
}

export class HitlEnforcementService {
  // [SE-001] Get count of recent autonomous operations for rate limiting
  // Counts both Level 5 and Level 4 auto-elevated operations.
  //
  // Reads from `hitl_rate_limit_events` (migration 100) — moved out of
  // audit_logs so rate-limit bookkeeping doesn't pollute the user-facing
  // /activity feed. RLS is enabled on the new table, so this query MUST
  // run inside withTenantScope().
  async getRecentOperationCount(tenantId: string, window: string): Promise<number> {
    // Parse window (e.g., '1h' -> 1 hour) and calculate cutoff timestamp
    const match = window.match(/^(\d+)([hms])$/);
    if (!match) {
      return 0;
    }

    const [, value, unit] = match;
    const multipliers: Record<string, number> = { h: 3600000, m: 60000, s: 1000 };
    const windowMs = parseInt(value, 10) * multipliers[unit];
    const cutoffTime = new Date(Date.now() - windowMs);

    const count = await withTenantScope(tenantId, async (client) => {
      const result = await client.query(
        `SELECT COUNT(*) as count FROM hitl_rate_limit_events
         WHERE tenant_id = $1
           AND created_at > $2`,
        [tenantId, cutoffTime]
      );
      return parseInt(result.rows[0]?.count || '0', 10);
    });

    return count;
  }

  // Record a rate-limit bookkeeping event for getRecentOperationCount().
  // Replaces the legacy practice of writing `hitl_level_5_operation` /
  // `hitl_level_4_auto_elevated` rows into audit_logs. Wrapped in
  // withTenantScope so RLS on hitl_rate_limit_events passes.
  private async recordRateLimitEvent(params: {
    tenantId: string;
    agentId?: string;
    hitlLevel: 4 | 5;
    toolName: string;
    autoElevated: boolean;
  }): Promise<void> {
    try {
      await withTenantScope(params.tenantId, async (client) => {
        await client.query(
          `INSERT INTO hitl_rate_limit_events
             (tenant_id, agent_id, hitl_level, tool_name, auto_elevated)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            params.tenantId,
            params.agentId ?? null,
            params.hitlLevel,
            params.toolName,
            params.autoElevated,
          ]
        );
      });
    } catch (err) {
      // Bookkeeping failure must never abort tool execution. Log and move on.
      log.warn(
        {
          tenantId: params.tenantId,
          toolName: params.toolName,
          hitlLevel: params.hitlLevel,
          err: (err as Error).message,
        },
        'Non-fatal: failed to record HITL rate-limit event'
      );
    }
  }

  // Check if a tool is low-risk (safe for auto-elevation to Level 5 behavior)
  // Low-risk = explicitly classified with no sensitive categories and not destructive
  private isLowRiskTool(tool: ModelTool | undefined): boolean {
    if (!tool) return false; // Unknown tool - treat as higher risk
    if (tool.categories === undefined) return false; // Not classified - treat as higher risk
    if (tool.categories.length > 0) return false; // Has sensitive categories
    if (tool.description?.includes('⚠️ DESTRUCTIVE')) return false; // Destructive marker
    return true;
  }

  // Check the HITL gate — returns GateResult.
  // Parameter order: (toolCalls, oversight, hitlLevel, tools, tenantId)
  // [SE-001, SE-002] Made async to support Level 5 rate limiting and audit logging
  async checkHitlGate(
    toolCalls: ToolCallRequest[],
    oversight: OversightSettings | undefined,
    hitlLevel: number,
    tools: ModelTool[],
    tenantId: string,
    agentId?: string,
    opts?: {
      dryRun?: boolean;
      trustLevel?: 'trusted' | 'untrusted_inbound';
      // Operator kill-switch resolution (negative polarity). Passed by the caller,
      // which resolves the per-tenant `external_content_write_gate_disabled` flag
      // fail-closed (missing row / read error → false → gate ON). When true, the
      // external_content_write invariant is skipped for this tenant.
      externalContentGateDisabled?: boolean;
      /** The entity this run was woken by. Lets a non-destructive write BACK to
       *  that same entity pass — replying on the pull request that triggered the
       *  run adds no blast radius, because the entity written to is the one
       *  already carrying the untrusted content. Absent → nothing is in place
       *  and the invariant behaves exactly as before. */
      triggerTarget?: TriggerTarget;
      /** The approved graph step dispatching this call, when one is.
       *
       *  Present ONLY on the workflow path. The conversational / adapter path
       *  passes nothing, because the model chose the tool itself and there is no
       *  declared step to point at — which is the definition of a deviation, so
       *  the exemption is withheld by the architecture rather than by a rule.
       *
       *  Absent → every decision below behaves exactly as it did before. */
      declaredStep?: DeclaredStep;
      /** What the batch is judged against by the contract check
       *  (contract-check.ts): the declared step on the workflow path, the
       *  instructions and role otherwise. The gate holds no instruction text
       *  of its own, so a caller that passes nothing gets today's decision,
       *  unchecked, and that is logged once per invocation. */
      contract?: HitlContract;
      /** The owning invocation, for the contract check's usage record. */
      invocationId?: string;
      /** The last tool names this run dispatched, most recent last. */
      recentToolNames?: string[];
    },
  ): Promise<GateResult> {
    // dryRun: compute and return the gate DECISION without any write side
    // effects (rate-limit bookkeeping, policy auto-approve audit). Used by the
    // sandbox-dispatch shadow mode so it can observe what WOULD gate without
    // mutating shared state (e.g. the autonomous rate-limit counter, which the
    // LLM path also consumes). Existing callers omit it → unchanged behavior.
    const dryRun = opts?.dryRun === true;

    // 0. Empty tool calls - nothing to gate
    if (toolCalls.length === 0) {
      return { shouldGate: false };
    }

    // Every allow after the hard invariants goes through here, and this is the
    // only place the contract check runs (contract-check.ts). A gate decision
    // is returned as it is; an allow may become `contract_deviation`, never
    // the reverse.
    const allow = (result: GateResult): Promise<GateResult> => contractCheckedAllow(result, {
      toolCalls,
      tools,
      tenantId,
      ...(agentId ? { agentId } : {}),
      ...(opts?.invocationId ? { invocationId: opts.invocationId } : {}),
      ...(opts?.contract ? { contract: opts.contract } : {}),
      ...(opts?.triggerTarget ? { triggerTarget: opts.triggerTarget } : {}),
      ...(opts?.recentToolNames ? { recentToolNames: opts.recentToolNames } : {}),
    });

    // 1. Super-destructive always gates [FIX: SE-002] — policy bypass not allowed
    //
    // Widened from the name set to the EFFECT model, which is derived from it:
    // every member of SUPER_DESTRUCTIVE_OPERATIONS maps to an effect, asserted
    // by a test in @liftoffos/governance-types, so this cannot silently narrow.
    // What it adds is the effects that name matching cannot see on a host whose
    // tool names nobody enumerated.
    //
    // Merge is deliberately NOT included here: it keeps its own branch below so
    // it stays clearable by a standing per-agent approval policy, which
    // super-destructive is not.
    const superDestructive = toolCalls.filter(t => {
      const effect = hardInvariantEffectOf(t.name);
      return effect !== undefined && effect !== 'merge_to_protected_branch';
    });
    if (superDestructive.length > 0) {
      return { shouldGate: true, reason: 'super_destructive_gate' };
    }

    // 1a. Name-based merge-to-main gate — covers GitHub MCP tools whose
    //     categories are dynamically discovered from the vendor MCP
    //     server (api.githubcopilot.com/mcp/) and don't carry our
    //     static category labels. Without this, the only enforcement
    //     would be the standard category-driven sensitive-work path
    //     below — which can't reach vendor-MCP tools because they
    //     aren't enumerated in buildToolsSchema, so the tools.find()
    //     lookup returns undefined and no category match fires.
    //
    //     Fires BEFORE the autonomy-based level-4/5 shortcuts so a
    //     fully-autonomous agent can't bypass it via the smart-autonomous
    //     low-risk auto-elevation path. Standing-approval policy can
    //     still bypass it (the policy lookup runs inline here, same
    //     fail-open semantics as section 6 below) — e.g. an ops team
    //     that has explicitly approved a code-bot agent to auto-merge
    //     within scope. Mirrors the simulator side at
    //     liftoff-governance-engine/src/hitl-enforcement/service.ts:314-324
    //     so the operator dashboard's gate preview matches runtime.
    // NO LONGER CONDITIONAL ON THE TOGGLE.
    //
    // This branch used to open `if (oversight?.sensitiveWork?.mergeToMain)`, so
    // a workspace could switch off the one control governing merges to a
    // default branch. A hard invariant a tenant can turn off is not one, and
    // this control has already been off by accident: the category shipped
    // `false`, so every tenant created before it — and every one after who
    // never opened the page — had it silently disabled, "an operator reasonably
    // believing merges were governed because that is what the page is for."
    //
    // It matters more now, not less. Declared scope exempts approved work from
    // the category path below, so the toggle would have been the only thing
    // between a reviewer and merging the pull request that woke it — the case
    // in-place-reply.ts records as killing its own first draft, because
    // `merge_pull_request` classifies as ['dataChanges'] and not as destructive.
    //
    // The standing-approval policy check below still clears it per agent, so an
    // ops team that has deliberately approved an auto-merge bot keeps that
    // escape hatch. Absolute does not mean unbypassable; it means the bypass is
    // a deliberate, per-agent act rather than a workspace checkbox.
    //
    // Recognised by EFFECT rather than by name, so the three code-collaboration
    // hosts that have no entry in MERGE_TO_MAIN_TOOL_NAMES are covered too.
    // GitLab is wired end to end in resolve-trigger-bound-tool.ts and had no
    // merge coverage at all; `accept_merge_request` now resolves the same way
    // `merge_pull_request` does, without either being enumerated here.
    {
      const mergeCall = toolCalls.find(
        t => hardInvariantEffectOf(t.name) === 'merge_to_protected_branch',
      );
      if (mergeCall) {
        if (tenantId && agentId) {
          try {
            const policy = await getGovernanceApprovalPolicy(tenantId, agentId, 'merge_to_main');
            if (policy?.decision === 'approved') {
              if (!dryRun) {
                insertAuditLog(null, tenantId, {
                  internalAgentId: agentId,
                  action: 'hitl_auto_approved_by_policy',
                  inputArgs: { gateReason: 'merge_to_main', toolCalls: toolCalls.map(t => t.name) },
                  outcome: 'success',
                  triggeredBy: `agent:${agentId}`,
                }).catch(() => {});
              }
              return allow({ shouldGate: false });
            }
            // rejected → fall through to the gate-fire return below.
          } catch {
            // Fail-open per section 6's convention.
          }
        }
        return { shouldGate: true, reason: 'merge_to_main' };
      }
    }

    // 1b. External-content write gate — a platform INVARIANT in the
    //     super_destructive mold. When the run's content trust is
    //     untrusted_inbound (external-authored input reached the agent) and any
    //     pending call is not a pure read (effect !== 'read' — write, spawn, and a
    //     missing/unclassified effect all gate, fail closed), gate. Placed BEFORE
    //     the level-4/5 autonomy shortcuts so earned autonomy cannot bypass it.
    //     Cleared ONLY by a standing policy whose action_classes cover EVERY pending
    //     call — a legacy reason-wide policy (action_classes NULL) does not clear it.
    //     Mirrored in the governance-engine simulator so the dashboard preview matches.
    if (opts?.trustLevel === 'untrusted_inbound' && !opts?.externalContentGateDisabled) {
      const hasEffectfulCall = toolCalls.some(call => {
        // resolveCatalogTool, not a raw name match: the model calls MCP tools as
        // `mcp__<serverId>__<name>` and the catalog stores `<name>`, so a plain
        // comparison misses every connector tool. Here a miss reads as
        // `effect === undefined`, which was silently treating unknown connector
        // calls as non-effectful on the untrusted-inbound path.
        // The agent writing in its own notebook. Neither tool leaves the
        // process, so there is nothing to approve — and an approval card for one
        // is unanswerable. Checked by NAME, before any catalog lookup, so a
        // stale or incomplete catalog cannot turn it into an "unknown" that
        // fails closed (a run stalling on an approval to record a step's own
        // result).
        if (isInProcessBookkeepingTool(call.name)) return false;
        // The agent waiting on itself. A wake reaches nothing and carries the
        // trust forward; the resumed half is gated on what it then does. Held,
        // it could not even be approved (the approved dispatch runs no wake
        // tool), and a run woken by inbound content that wanted to sleep an
        // hour asked forever.
        if (isSelfWakeTool(call.name)) return false;
        // The agent telling its own people what it did. Same reasoning as the
        // line above and the same failure it prevents: a Code Reviewer posted
        // to a public pull request ungated and then needed approval to say so.
        // Covers notifications_send too: every recipient form it takes is a
        // workspace identity, so email is a transport choice and not a
        // destination outside the workspace.
        if (isOwnWorkspaceChatTool(call.name)) return false;

        const tool = resolveGateTool(call, tools);
        // A read never gates, for any tool on any connector.
        //
        // This asked `effectPassesUngated(tool?.effect)`, and `effect` is
        // populated for platform tools but left undefined on every CONNECTOR
        // tool — the connector catalog states the same fact in `categories`
        // instead. So the check read undefined, failed closed, and raised an
        // approval for a pure read — e.g. "Approval needed — Retrieve email
        // thread <id> from Google Mail" on `get_thread`, whose catalog entry is
        // `effect: undefined, categories: ['read']`.
        //
        // Asking a person to authorise a retrieval teaches them to click
        // through approvals without reading them, which costs more safety than
        // gating a read could ever buy. toolIsReadOnly consults both signals
        // and lets a write marker in either one win.
        if (toolIsReadOnly(tool as { effect?: 'read' | 'write' | 'spawn'; categories?: string[] } | undefined)) {
          return false;
        }

        // A RESOLVED entry carrying NEITHER signal is a catalog that lost the
        // classification, not a tool nobody classified.
        //
        // For example, an agent can pause on `github-<id>__pull_request_read`
        // — a read — with reason external_content_write, and no
        // `hitl_gate_unresolved_tool` logged, so the name DID resolve.
        // vendor-mcp-enumerate.ts sets
        // `effect: declared ?? classifyVendorToolEffect(name)`, which returns
        // 'read' for that name, and classifyVendorMcpTool assigns it no
        // non-read category. The entry that reaches this gate can have neither.
        //
        // So the same fact lives in two places and only one of them arrives —
        // and the gate fails closed on a read, which is the outcome
        // toolIsReadOnly exists to prevent. Deriving from the name HERE, with
        // the same helper the enumerator uses, means the two cannot disagree
        // however the entry got here.
        //
        // Fail-closed is preserved: classifyVendorToolEffect sends any
        // unrecognised verb to 'write', so only a name that positively reads as
        // a read passes.
        const unclassified = !!tool
          && (tool as { effect?: unknown }).effect === undefined
          && (((tool as { categories?: string[] }).categories?.length ?? 0) === 0);
        if (unclassified && classifyVendorToolEffect(bareToolActionName(call.name)) === 'read') {
          log.warn(
            {
              event: 'hitl_gate_unclassified_tool_read',
              metric: 'hitl.gate.unclassified_tool_read',
              tool_name: call.name,
              tenant_id: tenantId,
              agent_id: agentId,
            },
            'HITL gate resolved a tool carrying no effect and no categories and derived '
            + 'read from its name — the catalog that reached the gate lost a classification '
            + 'the enumerator sets, which is a catalog defect rather than an unknown tool',
          );
          return false;
        }

        // An outbound call is the Communication policy's to govern, not this
        // invariant's.
        //
        // `/dashboard/oversight` -> Communication already routes outbound three
        // ways, and one of those ways IS the review queue:
        //   Draft first                  -> only the draft form is registered
        //   Review for sensitive cases   -> approval in /dashboard/review, on a
        //                                   sensitive match only
        //   Send automatically when safe -> sends
        //
        // Gating outbound here as well overrode that choice, and this invariant
        // runs BEFORE autonomy is consulted, so a workspace set to send
        // automatically still queued every message and raising autonomy could
        // not help. The result was one review-queue entry per outbound message:
        // an outbox. A queue full of routine sends buries the escalations and
        // clarifications that need a person, and teaches people to approve
        // without reading, which is the same cost the read fix above exists to
        // avoid.
        //
        // Everything NOT outbound still gates below, and that is the injection
        // protection that matters: editing a file, merging, changing records are
        // covered by no communication policy and have no other control.
        //
        // isOutboundTool is imported rather than reimplemented so the exemption
        // can never be broader than what Communication actually governs. A call
        // that is exempted here but unrecognised there would be neither gated
        // nor governed.
        if (isOutboundTool(tool as { categories?: string[] } | undefined)) return false;

        // A post into the workspace's OWN Slack or Teams is not an external
        // write. `internalCollaboration` is the category those catalogs tag
        // every message with, and no policy read it — so the tools sat in a gap:
        // not outbound, so oversightDecisionFor returns `allow` and Communication
        // never governs them; not read, so this invariant counted them as
        // unknown effectful writes and gated. Oversight said yes, this said no.
        //
        // Without this, an agent that routes to escalation and posts it to the
        // support channel pauses for approval. An escalation exists to tell a
        // person that something needs a person, so requiring an approval to
        // deliver that notification is circular — and it stops the run before
        // the customer acknowledgement that follows it.
        //
        // Imported rather than reimplemented, for the same reason as
        // isOutboundTool above: an exemption defined here could drift wider than
        // the categorisation it claims to follow. Exclusion-scoped, so a tool
        // tagged both internal and outbound (or destructive, or admin) is not
        // exempt.
        if (isInternalCollaborationTool(tool as { categories?: string[] } | undefined)) return false;

        // An UNRESOLVED tool still gates — and now says so.
        //
        // Failing closed on a tool nobody classified is correct and stays. But a
        // call the catalog cannot resolve is not that: it is the catalog and the
        // caller disagreeing, which tool-name-resolution.ts calls a defect its
        // callers "must surface loudly rather than treat as no policy applies".
        // Until now the only thing it surfaced was an approval card, so a naming
        // mismatch and a genuinely unknown tool were indistinguishable — to an
        // operator reading logs, and to the person being asked to approve.
        //
        // That person cannot act on it either way: the request names an action
        // no oversight control governs, so there is nothing on the settings page
        // that would have prevented it and nothing to change after approving.
        // Read-only tools can reach people this way, because of a lookup miss
        // rather than a policy.
        //
        // Behaviour is unchanged. This only makes the cause findable in one
        // query instead of requiring a live incident to notice.
        if (!tool) {
          const detail = {
            event: 'hitl_gate_unresolved_tool',
            metric: 'hitl.gate.unresolved_tool',
            tool_name: call.name,
            tenant_id: tenantId,
            agent_id: agentId,
            catalog_size: tools?.length ?? 0,
          };
          log.error(
            detail,
            'HITL gate could not resolve this tool in the catalog and is gating it as an '
            + 'effectful write — the approval names an action no oversight control governs, so '
            + 'this is a catalog/caller naming mismatch rather than a policy decision',
          );
        }

        return true;
      });
      // In-place reply: a non-destructive, non-outbound write to the very
      // entity that woke this run. See in-place-reply.ts for why this is the
      // one safe exception and why every uncertainty resolves to "gate".
      //
      // Applied only when EVERY pending call qualifies: a batch containing one
      // call that reaches beyond the trigger gates as a whole, because approving
      // the batch would approve that one too.
      const allInPlace = toolCalls.length > 0 && toolCalls.every((call) => {
        const tool = resolveGateTool(call, tools);
        return isInPlaceReply(
          {
            name: call.name,
            input: call.input as Record<string, unknown> | undefined,
            categories: (tool as { categories?: string[] } | undefined)?.categories,
            effect: tool?.effect,
          },
          opts?.triggerTarget,
        );
      });

      // A declared step whose ARGUMENTS the graph fixed is not steerable.
      //
      // The invariant exists because untrusted content can steer an agent. On
      // the workflow path the graph already fixes which tool runs; when it fixes
      // the arguments too, there is nothing left for injected text to move, and
      // the call was settled by a human before the untrusted content existed.
      //
      // Without this the exemption never fires where it is needed. Reactive
      // runs are untrusted_inbound by definition, so they gate HERE — and a
      // declared-scope clearance wired only to `sensitive_work`, a reason these
      // runs never reach, leaves a card asking a person to authorise looking up
      // the id of the Slack channel the agent's own approved workflow names, on
      // a step of that workflow.
      //
      // Every pending call must qualify, like `allInPlace`: approving a batch
      // approves the one call in it that does not.
      const allDeclaredAndAuthored = opts?.declaredStep?.argumentsAuthored === true
        && toolCalls.length > 0
        && toolCalls.every((call) => inDeclaredScope(
          { name: call.name, input: call.input as Record<string, unknown> | undefined },
          opts.declaredStep,
          opts.triggerTarget,
        ));

      if (hasEffectfulCall && !allInPlace && !allDeclaredAndAuthored) {
        if (tenantId && agentId) {
          try {
            const policy = await getGovernanceApprovalPolicy(tenantId, agentId, 'external_content_write');
            if (policy?.decision === 'approved' && Array.isArray(policy.actionClasses)) {
              const covered = new Set(policy.actionClasses);
              const allCovered = toolCalls.every(tc => covered.has(bareToolActionName(tc.name)));
              if (allCovered) {
                if (!dryRun) {
                  insertAuditLog(null, tenantId, {
                    internalAgentId: agentId,
                    action: 'hitl_auto_approved_by_policy',
                    inputArgs: { gateReason: 'external_content_write', toolCalls: toolCalls.map(t => t.name) },
                    outcome: 'success',
                    triggeredBy: `agent:${agentId}`,
                  }).catch(() => {});
                }
                return allow({ shouldGate: false });
              }
            }
            // rejected / reason-wide / partial coverage → fall through and gate.
          } catch {
            // Fail CLOSED for this invariant — a policy-lookup failure still gates
            // (the return below fires).
          }
        }
        return { shouldGate: true, reason: 'external_content_write' };
      }
    }

    // 2. Level 4: Smart autonomous - auto-elevate low-risk tools to Level 5 behavior
    // When user selects "More autonomous", low-risk tools proceed without gate
    if (hitlLevel === 4) {
      const allToolsLowRisk = toolCalls.every(call => {
        // See resolveCatalogTool. A miss here passed `undefined` to isLowRiskTool,
        // which reads `tool.description` for the DESTRUCTIVE marker — so every
        // unresolved connector tool was classified low-risk and took the level-4
        // no-gate shortcut regardless of what it actually did.
        const tool = resolveGateTool(call, tools);
        return this.isLowRiskTool(tool);
      });

      if (allToolsLowRisk) {
        // Apply Level 5 behavior for low-risk tools: rate limit + audit + no gate
        const recentOps = await this.getRecentOperationCount(tenantId, '1h');
        if (recentOps > AUTONOMOUS_HOURLY_LIMIT) {
          return {
            shouldGate: true,
            reason: 'rate_limit_exceeded',
            message: `Autonomous rate limit exceeded (${recentOps}/${AUTONOMOUS_HOURLY_LIMIT} ops/hour)`
          };
        }

        // Record rate-limit bookkeeping (NOT audit_logs — see migration 100).
        if (!dryRun) {
          for (const call of toolCalls) {
            await this.recordRateLimitEvent({
              tenantId,
              agentId,
              hitlLevel: 4,
              toolName: call.name,
              autoElevated: true,
            });
          }
        }

        return allow({ shouldGate: false });
      }
      // Fall through to sensitive work check for tools with categories
    }

    // 3. Level 5: Fully autonomous - only super-destructive gates [SE-001, SE-002]
    if (hitlLevel === 5) {
      // Rate limiting check
      const recentOps = await this.getRecentOperationCount(tenantId, '1h');
      if (recentOps > AUTONOMOUS_HOURLY_LIMIT) {
        return {
          shouldGate: true,
          reason: 'rate_limit_exceeded',
          message: `Autonomous rate limit exceeded (${recentOps}/${AUTONOMOUS_HOURLY_LIMIT} ops/hour)`
        };
      }

      // Record rate-limit bookkeeping (NOT audit_logs — see migration 100).
      if (!dryRun) {
        for (const call of toolCalls) {
          await this.recordRateLimitEvent({
            tenantId,
            agentId,
            hitlLevel: 5,
            toolName: call.name,
            autoElevated: false,
          });
        }
      }

      return allow({ shouldGate: false });
    }

    // 4. Compute gate reason — one unified pass so the policy check (below) can
    // intercept before the gate fires. Policy bypass applies to level_1_gate,
    // destructive_gate, and sensitive_work. super_destructive_gate is already
    // handled above and is never bypassable.
    let gateReason: GateResult['reason'] | undefined;
    let gateMatchedCategory: string | undefined;
    // Representative tool that triggered the gate — used ONLY as the trust
    // ledger's actionClass key in the shadow evaluation below. Never affects
    // the gate decision.
    let gateTriggerToolName: string | undefined;

    if (hitlLevel === 1) {
      gateReason = 'level_1_gate';
      gateTriggerToolName = toolCalls[0]?.name;
    } else if (hitlLevel === 2) {
      // resolveCatalogTool, not a raw name match against catalog names. The
      // catalog registers `<alias>__<fn>` (tools-builder.ts, mcp-server.ts) while
      // the SDK calls `mcp__liftoff-tool-gateway__<alias>__<fn>`, so the old
      // `destructiveNames.has(call.name)` matched nothing for ANY connector or
      // vendor-MCP tool and the level-2 destructive gate cleared them silently.
      // Nothing downstream caught it: `destructive` is not a SensitivityCategory,
      // so the sensitive-work pass below cannot match on it either.
      // This is the same prefix defect already fixed at the three other lookups
      // in this function; section 4 was the branch left behind. It stayed green
      // because both destructive tests pass the catalog's own name form —
      // exactly what toolActionMatchesNameSet's docstring warns about.
      const destructiveCall = toolCalls.find(call =>
        resolveGateTool(call, tools)?.description?.includes('⚠️ DESTRUCTIVE')
      );
      if (destructiveCall) {
        gateReason = 'destructive_gate';
        gateTriggerToolName = destructiveCall.name;
      }
    }

    // 5. Escalation + Sensitive Work check (also applies to Level 4 non-low-risk tools)
    //
    // Under the surfacing policy (surfacing.ts, in force once the workspace
    // has saved its Escalation setting under the page's stated meaning) only
    // "Sensitive or high-impact work" gates the opted-in categories; the page
    // says so, and "Important decisions" governs asks and escalations instead.
    // Otherwise the two settings read as they always have.
    const surfacing = surfacingPolicyOf(oversight);
    const sensitiveWorkGates = surfacing
      ? surfacing.sensitiveWorkGates
      : !!oversight && (oversight.escalation === 'sensitive' || oversight.escalation === 'important');
    if (!gateReason && oversight && sensitiveWorkGates) {
      const enabledCategories = Object.entries(oversight.sensitiveWork)
        .filter(([, enabled]) => enabled)
        .map(([category]) => category);

      for (const call of toolCalls) {
        // THE defect this work exists to fix. The model calls
        // `mcp__liftoff-tool-gateway__slack-d77db9a0__send_message`; the catalog
        // holds `slack-d77db9a0__send_message`. A raw name match returned
        // undefined, so `tool?.categories` was undefined and no enabled category
        // could ever match — sensitive-work oversight was inert for EVERY
        // connector tool, not just Slack.
        const tool = resolveGateTool(call, tools);
        const matchedCategory = tool?.categories?.find(cat =>
          enabledCategories.includes(cat)
        );
        if (matchedCategory) {
          gateReason = 'sensitive_work';
          gateMatchedCategory = matchedCategory;
          gateTriggerToolName = call.name;
          break;
        }
      }
    }

    // No gate reason computed — allow.
    if (!gateReason) return allow({ shouldGate: false });

    // ── Declared scope: the work a human already approved ────────────────
    //
    // "Sensitive work" had no exception for the work the operator approved, so
    // a conservative policy became a total block rather than a filter. A
    // tenant configured `escalation: important` with all six categories on —
    // a reasonable choice, executed faithfully — sees a code-host comment
    // classify as `dataChanges`, so a reviewer agent has to ask permission to
    // write each of its own review comments. Fixing the external-content
    // invariant alone only moves the gate: the same call then raises
    // `sensitive_work` with a different reason string and an
    // identical-looking card.
    //
    // A step in the approved graph, dispatching the tool it declares, against
    // the entity that triggered the run, was authorised when a human approved
    // the agent. See declared-scope.ts for why reading the graph is not a
    // fourth carve-out.
    //
    // SCOPED TO `sensitive_work` ON PURPOSE. The other two reasons that reach
    // here mean something a graph does not override:
    //   level_1_gate     — the operator asked for EVERY action to be gated.
    //                      Exempting declared work would override an explicit
    //                      instruction with an inference.
    //   destructive_gate — the tool carries the ⚠️ DESTRUCTIVE marker. Being
    //                      declared does not make a destructive act reversible.
    // The two invariants that gate before this point (super_destructive_gate,
    // merge_to_main) never reach here at all, so no declaration can touch them.
    //
    // Applied only when EVERY pending call qualifies, for the same reason
    // `allInPlace` is: approving a batch approves the one call in it that
    // reached beyond the trigger.
    if (gateReason === 'sensitive_work' && opts?.declaredStep) {
      const allDeclared = toolCalls.length > 0 && toolCalls.every((call) => inDeclaredScope(
        {
          name: call.name,
          input: call.input as Record<string, unknown> | undefined,
        },
        opts.declaredStep,
        opts.triggerTarget,
      ));
      if (allDeclared) {
        log.info({
          event: 'hitl_gate_declared_scope',
          metric: 'hitl.gate.declared_scope_cleared',
          step_id: opts.declaredStep.stepId,
          tool_name: toolCalls[0]?.name,
          matched_category: gateMatchedCategory,
          tenant_id: tenantId,
          agent_id: agentId,
        }, 'in declared scope — a human approved this step of this workflow, so it runs without asking again');
        return allow({ shouldGate: false });
      }
    }

    // 6. Standing approval policy check (fail-open — if governance-engine is
    // unreachable getGovernanceApprovalPolicy() returns null and gate fires normally).
    if (tenantId && agentId) {
      try {
        const policy = await getGovernanceApprovalPolicy(tenantId, agentId, gateReason);
        if (policy?.decision === 'approved') {
          if (!dryRun) {
            insertAuditLog(null, tenantId, {
              internalAgentId: agentId,
              action: 'hitl_auto_approved_by_policy',
              inputArgs: { gateReason, toolCalls: toolCalls.map(t => t.name) },
              outcome: 'success',
              triggeredBy: `agent:${agentId}`,
            }).catch(() => {});
          }
          return allow({ shouldGate: false });
        }
        if (policy?.decision === 'rejected') {
          return { shouldGate: true, reason: gateReason, ...(gateMatchedCategory ? { matchedCategory: gateMatchedCategory } : {}) };
        }
      } catch {
        // fail-open
      }
    }

    // 7. SHADOW MODE (observability only — NEVER changes the decision).
    // The gate has decided to fire for a NON-contract-sensitive reason
    // (level_1_gate / destructive_gate / sensitive_work; super_destructive and
    // merge_to_main already returned above and never reach here). Fire-and-forget
    // a trust-ledger lookup to LOG how often the ledger WOULD have cleared this
    // gate, so we can calibrate thresholds before any future enforcement. It is
    // NOT awaited into the decision path and can never throw or mutate `result`.
    if (!dryRun) {
      void this.emitTrustShadowIfWouldClear({
        tenantId,
        agentId,
        gateReason,
        toolName: gateTriggerToolName,
      });
    }

    return { shouldGate: true, reason: gateReason, ...(gateMatchedCategory ? { matchedCategory: gateMatchedCategory } : {}) };
  }

  /**
   * SHADOW-MODE trust evaluation. Consults the governance trust ledger for the
   * (tenant, agent, action) and, when the ledger says `tier === 'auto'`, emits a
   * single structured log line (which backs the `hitl_trust_shadow_would_clear`
   * log-based metric) recording that the gate WOULD have been cleared. This is
   * pure observability — it has NO effect on the GateResult and is invoked only
   * via `void` (fire-and-forget). Every failure mode is swallowed so it can
   * neither throw nor destabilize the gate.
   *
   * Gated behind `HITL_TRUST_SHADOW_ENABLED=true` (default off) so it stays inert
   * until governance's endpoint is live and can be enabled per-env with no deploy
   * risk. Never runs in dryRun (caller already suppresses it), and only when both
   * tenantId and agentId are present (same guard as the approval-policy lookup).
   */
  private async emitTrustShadowIfWouldClear(params: {
    tenantId: string;
    agentId?: string;
    gateReason: GateResult['reason'];
    toolName?: string;
  }): Promise<void> {
    try {
      if (process.env.HITL_TRUST_SHADOW_ENABLED !== 'true') return;
      const { tenantId, agentId, gateReason, toolName } = params;
      if (!tenantId || !agentId || !toolName || !gateReason) return;

      const actionClass = bareToolActionName(toolName);
      const trust = await getAgentActionTrust(tenantId, agentId, actionClass);
      if (!trust || trust.tier !== 'auto') return;

      log.info(
        {
          event: 'hitl_trust_shadow_would_clear',
          tenantId,
          agentId,
          actionClass,
          gateReason,
          runs: trust.runs,
          passRate: trust.passRate,
        },
        'HITL trust shadow: trust ledger WOULD have cleared this gate (shadow mode — decision unchanged)',
      );
    } catch {
      // Shadow observability must NEVER affect the gate. Swallow everything.
    }
  }

  // Hash tool calls for tamper detection [FIX: SE-008]
  /**
   * Tamper hash over the gated calls.
   *
   * KEY-ORDER-INDEPENDENT, and it has to be: `pending_tool_calls` is a `jsonb`
   * column, and jsonb does not store keys in the order they were written — it
   * normalizes them (shortest key first, then bytewise). So the object that
   * comes back out is not the object that went in, and a plain
   * `JSON.stringify` produced a different string on read than on write.
   *
   * The hash therefore could never match for any tool call whose input had two
   * or more keys not already in jsonb's order, and approving one threw
   * TAMPER_DETECTED — an unhandled throw, so the RPC 500'd with no message.
   * For example, a Slack escalation with `{channel, text}` hashes differently
   * on read than on write, while re-running the write order reproduces the
   * stored hash exactly, which is the whole proof. It fails identically from
   * Slack and from /dashboard/review because both call the same handler, and
   * no retry can help.
   *
   * Sorting recursively makes the hash a function of the VALUE, which is what
   * tamper detection is actually about; key order was never part of the claim.
   */
  hashToolCalls(toolCalls: ToolCallRequest[]): string {
    // A call with no `name` is the WRONG SHAPE, and refusing beats hashing it.
    //
    // Two interfaces in this codebase are called `ToolCallRequest`: governance's
    // `{id, name, input}`, which this hashes, and agent-execution's
    // `{id, connector, entityType, actionType, payload}`. Hand this the second
    // and every field it reads is undefined, so the digest is the same constant
    // for any input — tamper detection that returns "unchanged" for a changed
    // tool, a changed argument and an added call alike. Silent, and it reports
    // success.
    for (const t of toolCalls) {
      if (typeof t?.name !== 'string') {
        throw new Error(
          'hashToolCalls: a tool call has no `name` — this is the agent-execution '
          + 'ToolCallRequest shape, not the governance one, and hashing it would '
          + 'produce the same digest for every input',
        );
      }
    }
    const normalized = canonicalJson(toolCalls.map(t => ({
      id: t.id,
      name: t.name,
      input: t.input,
    })));
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  // Create approval request
  async createApprovalRequest(input: CreateApprovalInput): Promise<HitlApprovalRequest> {
    const toolCallsHash = this.hashToolCalls(input.pendingToolCalls);

    const result = await pool.query(
      `INSERT INTO hitl_approval_requests
        (tenant_id, workflow_id, task_id, agent_id, hitl_level, pending_tool_calls,
         tool_calls_hash, reason, idempotency_key, injected_skill_ids, source, context,
         invocation_id, action_summary, why_summary, detail, thread_id, gate_view)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [
        input.tenantId,
        // workflow_id and task_id are uuid columns: a real id or NULL, never an
        // empty string, which the column rejects. A caller whose context was
        // rebuilt without the ids can hand this a blank, and NULL is the only
        // correct translation of "absent" — the columns are nullable for exactly
        // this case.
        uuidOrNull(input.workflowId),
        uuidOrNull(input.taskId),
        input.agentId,
        input.hitlLevel,
        JSON.stringify(input.pendingToolCalls),
        toolCallsHash,
        input.reason,
        input.idempotencyKey || null,
        input.injectedSkillIds ?? [],
        input.source ?? 'agent',
        input.context ? JSON.stringify(input.context) : null,
        // Immutable per-invocation label. NULL where no invocation context exists — a NULL row is
        // simply not usable as a per-invocation training label (correct, not approximated).
        input.invocationId ?? null,
        input.actionSummary ?? null,
        input.whySummary ?? null,
        input.detail ?? null,
        // The conversation this gate paused, so the decision can be posted back
        // into it. NULL for workflow, scheduled and sandbox gates, which have no
        // thread — those decisions simply post nowhere.
        input.threadId ?? null,
        // How the gate classified these calls, so the grant can be recomputed
        // at approval and at consumption (migration 409).
        input.gateView ? JSON.stringify(input.gateView) : null,
      ]
    );

    log.info({
      approvalId: result.rows[0].id,
      tenantId: input.tenantId,
      reason: input.reason,
    }, 'HITL approval request created');

    return this.mapApprovalRequest(result.rows[0]);
  }

  /** Cheap existence check by idempotency key. The gate sites use it to guard the
   *  one-time approval-card summary generation so a re-fired gate never spends a
   *  second small-model call (createApprovalRequest's ON CONFLICT already preserves
   *  the first-stored summary — this just avoids the wasted generation). */
  async approvalExistsForIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM hitl_approval_requests WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return result.rows.length > 0;
  }

  // Get approval request by ID
  async getApprovalRequest(approvalId: string): Promise<HitlApprovalRequest | null> {
    const result = await pool.query(
      `SELECT * FROM hitl_approval_requests WHERE id = $1`,
      [approvalId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapApprovalRequest(result.rows[0]);
  }

  /** Look up the `agent_scheduled_invocations` row that holds the
   *  hitl_approval pause matching this approvalId. Joined by the
   *  approvalId stamped onto `workflow_resume_payload->'hitlContext'`
   *  by `createHitlPause`. Used by the approval router (`hitl-enforcement/
   *  router.ts`) on approve / reject to enqueue the resume Cloud Task.
   *
   *  Returns null only when no pause row exists for this approval — e.g. an
   *  external-agent synchronous flow that never armed a createHitlPause row.
   *  NOTE: interactive-chat AND MCP-initiated chat DO create a scheduled pause —
   *  the unified executeTask engine calls createHitlPause on the conversational
   *  path too (service.ts) — so those approvals ARE found here and drive a real
   *  background resume. For an MCP-origin run that resume additionally closes the
   *  durable mcp_chat_runs row (Option 1) via the PB settle-by-approval callback. */
  async findHitlPauseForApproval(
    approvalId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    tenantId: string;
    agentId: string;
    threadId: string | null;
    scheduledByInvocationId: string | null;
  } | null> {
    const result = await pool.query(
      `SELECT id, tenant_id, agent_id, thread_id, scheduled_by_invocation_id
       FROM agent_scheduled_invocations
       WHERE tenant_id = $1
         AND status = 'pending'
         AND objective = 'hitl-expiry'
         AND workflow_resume_payload->'hitlContext'->>'approvalId' = $2
       LIMIT 1`,
      [tenantId, approvalId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as {
      id: string;
      tenant_id: string;
      agent_id: string;
      thread_id: string | null;
      scheduled_by_invocation_id: string | null;
    };
    return {
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      threadId: row.thread_id,
      scheduledByInvocationId: row.scheduled_by_invocation_id,
    };
  }

  // Unified count of every kind the /review queue renders — backs the badge, the
  // oversight page's "items awaiting decision", the dashboard tile's stat and
  // the queue's own tab labels. It cannot drift from listPendingItemsForTenant
  // below because both embed ACTIONABLE_QUEUE_PREDICATES verbatim.
  //
  // One aggregate over the same union the listing pages through, so the buckets
  // are a partition of `total` by construction rather than by arithmetic that
  // has to be kept in agreement.
  /** B4: the operator surface for `system_internal` records.
   *
   *  Scoped to system_internal on purpose. `kind = 'escalation'` rows are
   *  customer-facing and belong in the review queue, and handing them to an
   *  operator listing would recreate the dumping ground this whole change
   *  removed. Newest first, because an operator triaging these wants what broke
   *  most recently, and bounded so one tenant's backlog cannot return the table.
   *
   *  Read-only. Resolving one still goes through resolveEscalation. */
  async listOperatorRecords(args: {
    tenantId: string;
    status?: 'pending' | 'resolved';
    limit?: number;
  }): Promise<OperatorEscalationRecord[]> {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const { rows } = await pool.query(
      `SELECT id, tenant_id, agent_id, reason, status, created_at, resolved_at, occurrence_count, context
         FROM workflow_escalations
        WHERE tenant_id = $1
          AND kind = 'system_internal'
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [args.tenantId, args.status ?? null, limit],
    );
    return rows.map((r) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      agentId: (r.agent_id ?? null) as string | null,
      reason: r.reason as string,
      status: r.status as string,
      createdAt: (r.created_at as Date).toISOString(),
      resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
      occurrenceCount: (r.occurrence_count ?? 1) as number,
      context: (r.context ?? null) as Record<string, unknown> | null,
    }));
  }

  async getPendingItemsCount(
    tenantId: string,
    options?: { agentId?: string | null },
  ): Promise<PendingItemsCount> {
    const result = await pool.query(
      `WITH actionable AS (
         SELECT 'approval'::text AS kind, hitl_level
           FROM hitl_approval_requests
          WHERE ${ACTIONABLE_QUEUE_PREDICATES.approvals}

         UNION ALL

         SELECT 'clarification'::text AS kind, NULL::int AS hitl_level
           FROM agent_scheduled_invocations
          WHERE ${ACTIONABLE_QUEUE_PREDICATES.clarifications}
       )
       SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE kind = 'approval' AND hitl_level = 1) AS approvals_standard,
              COUNT(*) FILTER (WHERE kind = 'approval' AND hitl_level = 2) AS approvals_critical,
              COUNT(*) FILTER (
                WHERE kind = 'approval' AND (hitl_level IS NULL OR hitl_level NOT IN (1, 2))
              ) AS approvals_other,
              COUNT(*) FILTER (WHERE kind = 'clarification') AS clarifications
         FROM actionable`,
      [tenantId, options?.agentId ?? null]
    );

    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    const int = (value: unknown): number => parseInt(value as string, 10) || 0;

    return {
      total: int(row.total),
      approvalsStandard: int(row.approvals_standard),
      approvalsCritical: int(row.approvals_critical),
      approvalsOther: int(row.approvals_other),
      clarifications: int(row.clarifications),
    };
  }

  // Unified listing of every kind the /review queue renders: pending HITL
  // approvals, pending recovery-LLM / Anchor clarification questions, and
  // pending escalations. The discriminated `kind` field tells the three row
  // shapes apart.
  //
  // Actionability comes from ACTIONABLE_QUEUE_PREDICATES, the same clauses
  // getPendingItemsCount above embeds, so the page and its counts agree.
  //
  // Pagination is a real composite keyset over (sort_at, kind, id). The cursor
  // used to be accepted and then ignored while a nextCursor was still handed
  // back, so "Load more" refetched page one forever and appended duplicates.
  // The approvals arm also projects the full column set: it used to omit
  // eleven columns mapApprovalRequest reads, which is why every listed approval
  // shipped `status: undefined` and an Invalid Date `updatedAt`.
  //
  // `window: 'passed'` serves the queue's "Decision window passed" view: the
  // same approval rows, selected by PASSED_APPROVALS_PREDICATE instead. Only
  // approvals have a decision window, so that view is approvals alone.
  async listPendingItemsForTenant(
    tenantId: string,
    options?: { cursor?: string; limit?: number; agentId?: string | null; window?: QueueWindow }
  ): Promise<{ items: PendingQueueItem[]; nextCursor: string | null }> {
    const limit = Math.min(options?.limit || 20, 100);
    const cursor = decodeQueueCursor(options?.cursor);
    const window: QueueWindow = options?.window ?? 'actionable';

    const approvalsPredicate = window === 'passed'
      ? PASSED_APPROVALS_PREDICATE
      : ACTIONABLE_QUEUE_PREDICATES.approvals;

    // workflow_escalations.created_at is nullable, so the sort key coalesces to
    // epoch: that gives the NULLS LAST ordering those rows deserve while
    // keeping the keyset comparison total. A NULL inside a row-wise comparison
    // yields NULL, which would strand such a row on page one forever.
    const query = `
      WITH base AS (
        SELECT 'approval' AS kind,
               COALESCE(created_at, 'epoch'::timestamptz) AS sort_at,
               id::text AS id,
               tenant_id::text AS tenant_id,
               agent_id::text AS agent_id,
               workflow_id::text AS workflow_id, task_id::text AS task_id,
               hitl_level, reason, pending_tool_calls,
               tool_calls_hash,
               status,
               decided_by, decided_by_role, decision, rejection_reason, decided_at,
               idempotency_key, injected_skill_ids, source, context,
               action_summary, why_summary, detail,
               -- What the approver rewrote before saying yes (migration 376).
               -- Carried on the LIST as well as the single-row read, because
               -- the passed queue is where a person looks to see what the
               -- review actually did; without it the audit can show that a
               -- call was approved but not that it was changed first.
               edited_tool_inputs,
               NULL::text AS question,
               NULL::text AS clarification_source,
               NULL::text AS vendor_request_id,
               -- Real column since migration 327. Was a NULL literal, which is why
               -- nothing could post a decision back into the thread that stalled.
               thread_id::text AS thread_id,
               created_at, updated_at, expires_at
        FROM hitl_approval_requests
        WHERE ${approvalsPredicate}
        ${window === 'passed' ? '' : `
        UNION ALL

        SELECT 'clarification' AS kind,
               COALESCE(created_at, 'epoch'::timestamptz) AS sort_at,
               id::text AS id,
               tenant_id::text AS tenant_id,
               agent_id::text AS agent_id,
               NULL::text AS workflow_id, NULL::text AS task_id,
               NULL::int AS hitl_level, NULL::text AS reason, '[]'::jsonb AS pending_tool_calls,
               NULL::text AS tool_calls_hash,
               NULL::text AS status,
               NULL::text AS decided_by, NULL::text AS decided_by_role,
               NULL::text AS decision, NULL::text AS rejection_reason,
               NULL::timestamptz AS decided_at,
               NULL::text AS idempotency_key, NULL::text[] AS injected_skill_ids,
               NULL::text AS source, NULL::jsonb AS context,
               NULL::text AS action_summary, NULL::text AS why_summary, NULL::text AS detail,
               NULL::jsonb AS edited_tool_inputs,
               (workflow_resume_payload->'pauseContext'->>'originalQuestion') AS question,
               clarification_source,
               vendor_request_id,
               thread_id::text AS thread_id,
               created_at, NULL::timestamptz AS updated_at, fires_at AS expires_at
        FROM agent_scheduled_invocations
        WHERE ${ACTIONABLE_QUEUE_PREDICATES.clarifications}
        `}
      )
      SELECT base.*,
             sort_at::text AS sort_cursor,
             -- The agent's display name, which no consumer of this queue can
             -- resolve for itself: agent_id is a runtime agents.id and every
             -- surface downstream knows teams by their control-plane id
             -- (INV-TR-010). agents.name mirrors internal_agents.role, so this
             -- is the exact string the Teams page shows.
             --
             -- A correlated subquery rather than a LEFT JOIN on purpose: agents
             -- carries its own id and tenant_id, so joining it makes the
             -- unqualified sort_at/kind/id below ambiguous, and qualifying them
             -- is a bigger edit to the keyset than this is worth. One
             -- primary-key lookup per row, over at most one page of them.
             (SELECT a.name FROM agents a WHERE a.id = base.agent_id::uuid) AS agent_name
      FROM base
      WHERE $3::timestamptz IS NULL
         OR (sort_at, kind, id) < ($3::timestamptz, $4::text, $5::text)
      ORDER BY sort_at DESC, kind DESC, id DESC
      LIMIT $6`;

    const result = await pool.query(query, [
      tenantId,
      options?.agentId ?? null,
      cursor?.sortAt ?? null,
      cursor?.kind ?? null,
      cursor?.id ?? null,
      limit + 1,
    ]);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items: PendingQueueItem[] = rows.map(row => {
      const agentName = (row.agent_name as string | null) ?? null;
      if (row.kind === 'approval') {
        return { kind: 'approval', agentName, ...this.mapApprovalRequest(row) };
      }
      return {
        kind: 'clarification',
        id: row.id as string,
        tenantId: row.tenant_id as string,
        agentId: row.agent_id as string,
        agentName,
        threadId: row.thread_id as string,
        question: (row.question as string) ?? '',
        source: row.clarification_source as 'recovery_llm' | 'anchor_intervention',
        vendorRequestId: (row.vendor_request_id as string | null) ?? null,
        createdAt: new Date(row.created_at as string),
        expiresAt: new Date(row.expires_at as string),
      };
    });

    // Built from the last row's raw Postgres text, not from the mapped Date, so
    // the boundary keeps its microseconds and the next page resumes exactly
    // where this one stopped.
    const lastRow = rows[rows.length - 1] as Record<string, unknown> | undefined;

    return {
      items,
      nextCursor: hasMore && lastRow
        ? encodeQueueCursor(
            lastRow.sort_cursor as string,
            lastRow.kind as string,
            lastRow.id as string,
          )
        : null,
    };
  }

  /** Every approval of a tenant created at or before `asOf`, oldest first, for
   *  the workspace export.
   *
   *  One ordered pass over (created_at, id) with a composite keyset, so two
   *  rows that share a boundary timestamp lose nothing; the queue's cursor
   *  codec is reused because it already carries the Postgres text timestamp
   *  with its microseconds intact. `created_at` is nullable on this table, so
   *  the sort key coalesces to epoch the way the queue's does: a NULL inside a
   *  row-wise comparison yields NULL, which would strand such a row on page one
   *  forever. Reads every status: the export projects the terminal state
   *  itself, against its own `asOf`. */
  async listReviewHistoryApprovals(
    tenantId: string,
    options: ReviewHistoryOptions,
  ): Promise<{ items: ReviewHistoryApproval[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? REVIEW_HISTORY_MAX_LIMIT, 1), REVIEW_HISTORY_MAX_LIMIT);
    const cursor = decodeQueueCursor(options.cursor);
    const result = await pool.query(
      `SELECT r.id::text AS id,
              r.status, r.decision, r.decided_by, r.decided_at, r.rejection_reason,
              r.expires_at, r.updated_at, r.created_at,
              r.hitl_level, r.reason, r.pending_tool_calls, r.edited_tool_inputs,
              r.action_summary, r.why_summary, r.detail,
              COALESCE(r.created_at, 'epoch'::timestamptz)::text AS sort_cursor,
              (SELECT a.name FROM agents a WHERE a.id = r.agent_id) AS agent_name
         FROM hitl_approval_requests r
        WHERE r.tenant_id = $1
          AND COALESCE(r.created_at, 'epoch'::timestamptz) <= $2::timestamptz
          AND ($3::timestamptz IS NULL
               OR (COALESCE(r.created_at, 'epoch'::timestamptz), r.id) > ($3::timestamptz, $4::uuid))
        ORDER BY COALESCE(r.created_at, 'epoch'::timestamptz) ASC, r.id ASC
        LIMIT $5`,
      [tenantId, options.asOf, cursor?.sortAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit) as Array<Record<string, unknown>>;
    const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
    const items: ReviewHistoryApproval[] = rows.map((row) => ({
      id: row.id as string,
      agentName: (row.agent_name as string | null) ?? null,
      status: row.status as string,
      decision: (row.decision as 'approved' | 'rejected' | null) ?? null,
      decidedBy: (row.decided_by as string | null) ?? null,
      decidedAt: iso(row.decided_at),
      rejectionReason: (row.rejection_reason as string | null) ?? null,
      expiresAt: iso(row.expires_at),
      updatedAt: iso(row.updated_at),
      createdAt: iso(row.created_at),
      hitlLevel: typeof row.hitl_level === 'number' ? row.hitl_level : null,
      reason: (row.reason as string | null) ?? null,
      pendingToolCalls: this.parseToolCalls(row.pending_tool_calls),
      editedToolInputs: parseApprovedEdits(row.edited_tool_inputs) ?? null,
      actionSummary: (row.action_summary as string | null) ?? null,
      whySummary: (row.why_summary as string | null) ?? null,
      detail: (row.detail as string | null) ?? null,
    }));
    const lastRow = rows[rows.length - 1];
    return {
      items,
      nextCursor: hasMore && lastRow
        ? encodeQueueCursor(lastRow.sort_cursor as string, 'approval', lastRow.id as string)
        : null,
    };
  }

  /** Every clarification of a tenant created at or before `asOf`, oldest
   *  first, with the resolution columns migration 419 added. Same keyset and
   *  the same cursor codec as the approvals feed. */
  async listReviewHistoryClarifications(
    tenantId: string,
    options: ReviewHistoryOptions,
  ): Promise<{ items: ReviewHistoryClarification[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? REVIEW_HISTORY_MAX_LIMIT, 1), REVIEW_HISTORY_MAX_LIMIT);
    const cursor = decodeQueueCursor(options.cursor);
    const result = await pool.query(
      `SELECT c.id::text AS id,
              (c.workflow_resume_payload->'pauseContext'->>'originalQuestion') AS question,
              c.status, c.fires_at, c.fired_at, c.cancelled_at, c.updated_at, c.created_at,
              c.resolution_kind, c.resolved_by, c.resolved_by_label, c.resolved_at,
              c.created_at::text AS sort_cursor,
              (SELECT a.name FROM agents a WHERE a.id = c.agent_id) AS agent_name
         FROM agent_scheduled_invocations c
        WHERE c.tenant_id = $1
          AND c.objective = 'clarification-expiry'
          AND c.created_at <= $2::timestamptz
          AND ($3::timestamptz IS NULL OR (c.created_at, c.id) > ($3::timestamptz, $4::uuid))
        ORDER BY c.created_at ASC, c.id ASC
        LIMIT $5`,
      [tenantId, options.asOf, cursor?.sortAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit) as Array<Record<string, unknown>>;
    const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
    const items: ReviewHistoryClarification[] = rows.map((row) => ({
      id: row.id as string,
      agentName: (row.agent_name as string | null) ?? null,
      question: (row.question as string | null) ?? '',
      status: row.status as string,
      firesAt: iso(row.fires_at),
      firedAt: iso(row.fired_at),
      cancelledAt: iso(row.cancelled_at),
      updatedAt: iso(row.updated_at),
      createdAt: iso(row.created_at),
      resolutionKind: (row.resolution_kind as 'answered' | 'declined' | 'expired' | 'self_answered' | null) ?? null,
      resolvedBy: (row.resolved_by as string | null) ?? null,
      resolvedByLabel: (row.resolved_by_label as string | null) ?? null,
      resolvedAt: iso(row.resolved_at),
    }));
    const lastRow = rows[rows.length - 1];
    return {
      items,
      nextCursor: hasMore && lastRow
        ? encodeQueueCursor(lastRow.sort_cursor as string, 'clarification', lastRow.id as string)
        : null,
    };
  }

  /** The actionable approval blocking one chat thread, if there is one.
   *
   *  The in-chat banner used to find this by listing the tenant's queue and
   *  scanning the first hundred items for a matching thread. For the tenant
   *  that prompted this work — 141 pending escalations — a real approval sat
   *  outside that page and the person whose turn was blocked saw nothing at
   *  all. A thread is an index lookup, not a haystack.
   *
   *  Actionability is ACTIONABLE_QUEUE_PREDICATES.approvals, so the banner and
   *  the queue agree about what is still open. */
  async findActionableApprovalForThread(
    tenantId: string,
    threadId: string,
    agentId?: string,
  ): Promise<HitlApprovalRequest | null> {
    const result = await pool.query(
      `SELECT *
         FROM hitl_approval_requests
        WHERE ${ACTIONABLE_QUEUE_PREDICATES.approvals}
          AND thread_id = $3::uuid
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, agentId ?? null, threadId],
    );

    if (result.rows.length === 0) return null;
    return this.mapApprovalRequest(result.rows[0]);
  }

  /** Mark a pending escalation resolved from the review queue.
   *
   *  This transition is what makes the whole loop work: the dedup in
   *  escalation-helper collapses repeats into the one open `pending` row, so
   *  flipping it to `resolved` is also the reset — if the same blocker fires
   *  again afterwards, no pending row matches, a fresh escalation is created,
   *  and the fresh one notifies. State-transition semantics with no extra
   *  machinery. Guarded on kind='escalation' so an operator id can never close
   *  a system_internal row through the customer surface. */
  async resolveEscalation(args: {
    tenantId: string;
    escalationId: string;
    resolvedBy: string;
  }): Promise<boolean> {
    const result = await pool.query(
      `UPDATE workflow_escalations
          SET status = 'resolved',
              resolved_at = NOW(),
              resolution = jsonb_build_object('resolvedBy', $3::text, 'via', 'review_queue')
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending' AND kind = 'escalation'
        RETURNING id, agent_id`,
      [args.escalationId, args.tenantId, args.resolvedBy],
    );
    const resolved = (result.rowCount ?? 0) > 0;
    // B0: a person just corrected this agent, and that fact has to outlive the
    // row. Retention deletes resolved escalations at 30 days; counting them
    // live afterwards would report an agent as never corrected. Stamped here,
    // at the moment of the correction, so the number cannot move later.
    // RETURNING guarantees this runs once per real transition and never on a
    // no-op update.
    if (resolved && result.rows[0]?.agent_id) {
      await recordHumanCorrection(args.tenantId, result.rows[0].agent_id as string);
    }
    return resolved;
  }

  // Operator answer to a pending clarification, surfaced through /review.
  // Mirrors the chat-turn-handler atomic transition to close the cross-surface race.
  async respondToClarification(args: {
    tenantId: string;
    clarificationId: string;
    response: string;
    resolvedBy: string;
  }): Promise<void> {
    // 1. Atomic transition pending → resume_inflight. The outcome and the
    //    actor (migration 419) ride the same statement, so a recorded answer
    //    can never exist without the transition that delivered it.
    const transition = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'resume_inflight', updated_at = NOW(),
           resolution_kind = 'answered', resolved_by = $3, resolved_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
         AND objective = 'clarification-expiry'
       RETURNING id`,
      [args.clarificationId, args.tenantId, args.resolvedBy],
    );
    if (!transition.rowCount) {
      throw new Error('clarification already resolved or not found');
    }
    // 2. Re-fetch the row for routing data.
    const row = await this.loadClarificationRow(args.clarificationId);
    // 3. Route via shared helper.
    await resolveClarification(row, args.response);
    // 4. Reflect operator's answer in the chat thread.
    await pool.query(
      `INSERT INTO messages (id, tenant_id, thread_id, role, content, input_tokens, output_tokens, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'user', $3, 0, 0, NOW())`,
      [row.tenant_id, row.thread_id, args.response],
    );
    // 5. Audit trail.
    try {
      await insertAuditLog(null, row.tenant_id, {
        userId: args.resolvedBy,
        threadId: row.thread_id,
        internalAgentId: row.agent_id,
        action: 'clarification_resolved',
        inputArgs: {
          clarificationId: row.id,
          clarificationSource: row.clarification_source,
          vendorRequestId: row.vendor_request_id,
        },
        outcome: 'success',
        triggeredBy: 'human',
      });
    } catch (err) {
      log.warn({ err, clarificationId: row.id }, 'Non-fatal: audit log insert failed for clarification resolution');
    }
    // 6. Learn from it. A rejected approval already becomes memory; being
    //    answered taught the agent nothing, so the same question came back on
    //    the next run and the queue refilled with asks a person had settled.
    this.captureClarificationLearning(row, 'answered', args.response);
  }

  /** The clarification row, with the question it asked.
   *
   *  The question lives in the resume payload rather than a column, which is
   *  also where the queue listing reads it from — so both surfaces name the ask
   *  the same way. */
  private async loadClarificationRow(clarificationId: string): Promise<ClarificationRow> {
    const rowRes = await pool.query(
      `SELECT id, clarification_source, vendor_request_id,
              scheduled_by_invocation_id, tenant_id, agent_id, thread_id,
              (workflow_resume_payload->'pauseContext'->>'originalQuestion') AS question
       FROM agent_scheduled_invocations WHERE id = $1`,
      [clarificationId],
    );
    return rowRes.rows[0] as ClarificationRow;
  }

  /** Fire-and-forget: memory, then reflection. Never awaited and never allowed
   *  to throw — the run has already been resumed by the time this runs, and a
   *  broken learning module must not turn a delivered answer into an error the
   *  caller retries. */
  private captureClarificationLearning(
    row: ClarificationRow,
    outcome: 'answered' | 'declined',
    response?: string,
  ): void {
    if (!row.question) return;
    try {
      const { captureClarificationOutcome } = require('../learning/correction-capture');
      captureClarificationOutcome({
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        clarificationId: row.id,
        question: row.question,
        outcome,
        response,
      }).catch((err: Error) => log.warn({ err }, 'Non-fatal: clarification capture failed'));
    } catch (err) {
      log.warn({ err }, 'Non-fatal: clarification capture module load failed');
    }

    // Only a decline is a signal worth reflecting on. An answered question is
    // the system working; a question nobody could answer is the agent asking
    // for something this workspace cannot give it, which is the pattern the
    // reflection engine exists to notice.
    if (outcome !== 'declined') return;
    try {
      const { reflectionTriggerService } = require('../reflection-engine/trigger-service');
      reflectionTriggerService.onLateFeedbackFlagged(
        row.agent_id,
        row.tenant_id,
        row.id,
      ).catch((err: Error) => log.warn({ err }, 'Non-fatal: clarification reflection trigger failed'));
    } catch (err) {
      log.warn({ err }, 'Non-fatal: reflection trigger module load failed');
    }
  }

  /** A person was asked and cannot answer. The run resumes now rather than
   *  waiting out its window.
   *
   *  Declining is an answer. Before it existed the only way to say no was
   *  silence: the ask sat for a day (a week for a blocker), the agent stayed
   *  parked the whole time, and the lapse became a record only operators read.
   *  The agent was never told the question had been considered and refused, so
   *  it asked again on the next run.
   *
   *  It resumes through the same helper as an answer, because the run cannot
   *  tell the difference between kinds of input — only the text differs, and
   *  that text has to say plainly that no answer is coming so the agent stops
   *  waiting for one. */
  async declineClarification(args: {
    tenantId: string;
    clarificationId: string;
    reason?: string;
    resolvedBy: string;
  }): Promise<void> {
    // An Anchor intervention cannot be declined, and the check comes before the
    // status transition so a refusal never strands the row mid-flight.
    //
    // Every other clarification resumes by handing text to the agent, which can
    // read "no answer is available" and act on it. An Anchor row resumes by
    // handing text to a live browser session through `respondToIntervention` —
    // the vendor exposes no abort — so the same decline would type that
    // sentence into somebody's browser as though it were the instruction they
    // were waiting for. Anchor self-terminates its own interventions well
    // inside the window, so nothing is stranded by refusing.
    const sourceRes = await pool.query(
      `SELECT clarification_source FROM agent_scheduled_invocations
       WHERE id = $1 AND tenant_id = $2`,
      [args.clarificationId, args.tenantId],
    );
    if (sourceRes.rows[0]?.clarification_source === 'anchor_intervention') {
      throw new Error('anchor_intervention clarifications cannot be declined');
    }

    // Same shape as the answer: the decline is recorded (migration 419) in
    // the statement that moves the row.
    const transition = await pool.query(
      `UPDATE agent_scheduled_invocations
       SET status = 'resume_inflight', updated_at = NOW(),
           resolution_kind = 'declined', resolved_by = $3, resolved_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
         AND objective = 'clarification-expiry'
       RETURNING id`,
      [args.clarificationId, args.tenantId, args.resolvedBy],
    );
    if (!transition.rowCount) {
      throw new Error('clarification already resolved or not found');
    }

    const row = await this.loadClarificationRow(args.clarificationId);

    const trimmedReason = args.reason?.trim();
    const resumeText = trimmedReason
      ? `No answer is available: ${trimmedReason}. Do not wait for one. Continue using your own judgement, or stop and report what remains unresolved.`
      : 'No answer is available. Do not wait for one. Continue using your own judgement, or stop and report what remains unresolved.';

    await resolveClarification(row, resumeText);

    await pool.query(
      `INSERT INTO messages (id, tenant_id, thread_id, role, content, input_tokens, output_tokens, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'user', $3, 0, 0, NOW())`,
      [row.tenant_id, row.thread_id, resumeText],
    );

    try {
      await insertAuditLog(null, row.tenant_id, {
        userId: args.resolvedBy,
        threadId: row.thread_id,
        internalAgentId: row.agent_id,
        action: 'clarification_declined',
        inputArgs: {
          clarificationId: row.id,
          clarificationSource: row.clarification_source,
          reasonProvided: !!trimmedReason,
        },
        outcome: 'success',
        triggeredBy: 'human',
      });
    } catch (err) {
      log.warn({ err, clarificationId: row.id }, 'Non-fatal: audit log insert failed for clarification decline');
    }

    this.captureClarificationLearning(row, 'declined', trimmedReason);
  }

  // Approve request [FIX: SE-008] with tamper detection
  // Build the trust-decisions payload for a resolved approval and enqueue it on the same
  // transaction client, so a resolved approval is never recorded without its decision being
  // scheduled for delivery to the trust ledger.
  private async enqueueTrustDecision(
    client: PoolClient,
    approval: HitlApprovalRequest,
    decision: 'approved' | 'rejected',
    decidedBy: string,
  ): Promise<void> {
    const agentId = approval.agentId;
    const gateReason = approval.reason;
    if (!agentId || !gateReason) return;
    const actionClasses = [
      ...new Set((approval.pendingToolCalls ?? []).map((tc) => bareToolActionName(tc.name))),
    ];
    if (actionClasses.length === 0) return;
    const decidedAt = new Date().toISOString();
    const payload: TrustDecisionsPayload = {
      tenantId: approval.tenantId,
      agentId,
      gateReason,
      approvalId: approval.id,
      decisions: actionClasses.map((actionClass) => ({
        actionClass,
        decision,
        decidedBy,
        decidedAt,
        sourceKey: `${approval.id}:${actionClass}`,
      })),
    };
    await enqueueActionTrustOutbox(client, { tenantId: approval.tenantId, approvalId: approval.id, payload });
  }

  /** `approvalNote` widens the shared input locally rather than in
   *  @liftoffos/governance-types: it is what a person typed on this surface,
   *  not part of the governance contract every service shares. */
  async approveRequest(
    input: ResolveApprovalInput & { approvalNote?: string; editedToolInputs?: ApprovedEdits },
  ): Promise<HitlApprovalRequest> {
    const approval = await this.getApprovalRequest(input.approvalId);

    if (!approval) {
      throw new Error('Approval request not found');
    }

    if (approval.status !== 'pending') {
      throw new Error(`Cannot approve: request status is ${approval.status}`);
    }

    if (approval.expiresAt < new Date()) {
      throw new Error('Cannot approve: request has expired');
    }

    // [FIX: SE-008] Verify hash matches
    const currentHash = this.hashToolCalls(approval.pendingToolCalls);
    if (currentHash !== approval.toolCallsHash) {
      throw new Error('TAMPER_DETECTED: pending_tool_calls have been modified');
    }

    // The reviewer's own version of the calls, recorded beside the agent's
    // rather than over them: the hash above verifies the calls AS PROPOSED, so
    // an in-place edit is indistinguishable from tampering. Keys naming no
    // pending call are dropped here rather than at dispatch, where there would
    // be nothing left to point at.
    const edits = parseApprovedEdits(input.editedToolInputs);
    const pendingIds = new Set(approval.pendingToolCalls.map((c) => c.id));
    const scopedEdits = edits
      ? Object.fromEntries(Object.entries(edits).filter(([id]) => pendingIds.has(id)))
      : undefined;
    const storedEdits =
      scopedEdits && Object.keys(scopedEdits).length > 0 ? scopedEdits : null;

    // What the yes covers, recorded with the yes.
    //
    // The fingerprint is over the calls that will RUN — the edits applied — and
    // the granted set is the reasons in force for those calls under the
    // settings as they are at this moment. Consumption verifies the first and
    // recomputes the second; a control tightened in between shows up as a
    // reason the grant does not cover, and only that reason is asked again.
    // The reason the person was actually shown is always in the set: whatever
    // the recompute says, they said yes to that.
    const finalCalls = applyApprovedEdits(approval.pendingToolCalls, storedEdits);
    const finalToolCallsHash = this.hashToolCalls(finalCalls);
    const grant = await this.grantFor(approval, finalCalls);

    const result = await withTenantScope(approval.tenantId, async (client) => {
      // `AND status = 'pending'` is what makes first-wins true. The check
      // above is a read-then-write: two people deciding at once both pass it,
      // both write, and the later one silently overwrites the earlier — an
      // approve landing after a reject flips a refused action to approved and
      // resumes the tool calls. Deciding inside the UPDATE means exactly one
      // caller matches a row; the loser sees zero and is told it was already
      // decided.
      const r = await client.query(
        `UPDATE hitl_approval_requests SET
          status = 'approved',
          decision = 'approved',
          decided_by = $2,
          decided_by_role = $3,
          decided_at = NOW(),
          updated_at = NOW(),
          edited_tool_inputs = $4::jsonb,
          final_tool_calls_hash = $5,
          granted_obligations = $6::jsonb,
          obligations_evaluator_version = $7
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [
          input.approvalId,
          input.decidedBy,
          input.decidedByRole,
          storedEdits ? JSON.stringify(storedEdits) : null,
          finalToolCallsHash,
          JSON.stringify(grant.reasons),
          grant.version,
        ]
      );
      if (r.rowCount === 0) {
        // Same message the pre-check raises, so the existing error mapping
        // still turns this into 409 ALREADY_DECIDED for every caller.
        const current = await client.query(
          `SELECT status FROM hitl_approval_requests WHERE id = $1`,
          [input.approvalId],
        );
        throw new Error(
          `Cannot approve: request status is ${current.rows[0]?.status ?? 'unknown'}`,
        );
      }
      await this.enqueueTrustDecision(client, approval, 'approved', input.decidedBy);
      return r;
    });

    log.info({
      approvalId: input.approvalId,
      decidedBy: input.decidedBy,
      noteProvided: !!input.approvalNote?.trim(),
      // Which calls the person actually changed, not merely which they opened.
      editedCallIds: editedCallIds(approval.pendingToolCalls, storedEdits),
    }, 'HITL approval request approved');

    const approved = this.mapApprovalRequest(result.rows[0]);

    // A staged batch's apply among the approved calls binds the batch to this
    // approval against its digest as staged — the grant, host-written on both
    // rows (ADR-052 rule 5, clauses 5 and 6). Awaited: the apply verifies this
    // binding, and an approval that returned before the bind landed would
    // refuse the very apply the person just said yes to.
    await this.bindStagedBatches(approved, finalCalls, 'approved');

    // Why the approver said yes, kept as memory. A rejection has always taught
    // the agent something; an approval taught it nothing, so the loop only ever
    // learned what not to do. Fire-and-forget for the same reason the rejection
    // capture is: the decision is already recorded and the run is already
    // moving, and a broken learning module must not turn a delivered approval
    // into an error the caller retries.
    if (input.approvalNote?.trim()) {
      try {
        const { captureApprovalNote } = require('../learning/correction-capture');
        captureApprovalNote(
          approved.tenantId,
          approved.agentId,
          approved.pendingToolCalls || [],
          input.approvalNote,
        ).catch((err: Error) => log.warn({ err }, 'Non-fatal: approval note capture failed'));
      } catch (err) {
        log.warn({ err }, 'Non-fatal: approval note capture module load failed');
      }
    }

    // Persist standing policy so future gates auto-approve for this agent+reason.
    // Suppressed for high-risk reasons (super-destructive / merge-to-main / sensitive):
    // those always require a fresh decision, so alwaysApply is ignored here even if a
    // surface sent it. See standingApprovalAllowed.
    // For external_content_write the grant is additionally CLASS-SCOPED: it stores exactly
    // the action classes observed on the approved call (bare tool names), so "always allow"
    // grants only those classes rather than the whole gate reason. Other reasons remain
    // reason-wide (actionClasses omitted).
    if (input.alwaysApply && approved.agentId && approved.reason && standingApprovalAllowed(approved.reason)) {
      const actionClasses = approved.reason === 'external_content_write'
        ? [...new Set((approved.pendingToolCalls ?? []).map((tc) => bareToolActionName(tc.name)))]
        : undefined;
      createGovernanceApprovalPolicy({
        tenantId: approved.tenantId,
        agentId: approved.agentId,
        gateReason: approved.reason,
        decision: 'approved',
        createdBy: input.decidedBy,
        ...(actionClasses ? { actionClasses } : {}),
      }).catch(err => log.warn({ err, approvalId: input.approvalId }, 'Non-fatal: alwaysApply policy creation failed (REST path)'));
    } else if (input.alwaysApply && approved.reason && !standingApprovalAllowed(approved.reason)) {
      log.info({ approvalId: input.approvalId, gateReason: approved.reason }, 'alwaysApply ignored — standing approval not allowed for this gate reason');
    }

    return approved;
  }

  // Reject request
  async rejectRequest(input: ResolveApprovalInput): Promise<HitlApprovalRequest> {
    const approval = await this.getApprovalRequest(input.approvalId);

    if (!approval) {
      throw new Error('Approval request not found');
    }

    if (approval.status !== 'pending') {
      throw new Error(`Cannot reject: request status is ${approval.status}`);
    }

    const result = await withTenantScope(approval.tenantId, async (client) => {
      // See approveRequest: the status predicate is what makes this first-wins
      // rather than last-write-wins.
      const r = await client.query(
        `UPDATE hitl_approval_requests SET
          status = 'rejected',
          decision = 'rejected',
          decided_by = $2,
          decided_by_role = $3,
          rejection_reason = $4,
          decided_at = NOW(),
          updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [input.approvalId, input.decidedBy, input.decidedByRole, input.rejectionReason || null]
      );
      if (r.rowCount === 0) {
        const current = await client.query(
          `SELECT status FROM hitl_approval_requests WHERE id = $1`,
          [input.approvalId],
        );
        throw new Error(
          `Cannot reject: request status is ${current.rows[0]?.status ?? 'unknown'}`,
        );
      }
      await this.enqueueTrustDecision(client, approval, 'rejected', input.decidedBy);
      return r;
    });

    log.info({
      approvalId: input.approvalId,
      decidedBy: input.decidedBy,
      reason: input.rejectionReason,
    }, 'HITL approval request rejected');

    // A rejected ask cancels the batch it was about (clause 4); the draft the
    // vendor holds is left unpublished and can never be applied.
    await this.bindStagedBatches(approval, approval.pendingToolCalls ?? [], 'rejected');

    // Phase 6B: Capture correction as agent memory (fire-and-forget).
    // Wrapped in try/catch — broken module must never crash rejectRequest().
    try {
      const { captureCorrection } = require('../learning/correction-capture');
      captureCorrection(
        approval.tenantId,
        approval.agentId,
        approval.pendingToolCalls || [],
        'rejected',
        input.rejectionReason
      ).catch((err: Error) => log.warn({ err }, 'Non-fatal: correction capture failed'));
    } catch (err) {
      log.warn({ err }, 'Non-fatal: correction capture module load failed');
    }

    // Skills flywheel: post hitl_rejected feedback for any injected skills.
    if ((approval.injectedSkillIds as string[] | undefined)?.length ?? 0 > 0) {
      postSkillFeedback({
        tenantId: approval.tenantId,
        agentId: approval.agentId,
        taskId: approval.taskId ?? undefined,
        feedback: (approval.injectedSkillIds as string[]).map(skillId => ({
          skillId, skillName: '', outcome: 'hitl_rejected' as const,
        })),
      }).catch(err => log.warn({ err: (err as Error).message }, 'hitl: skill-feedback callback failed (non-fatal)'));
    }

    // Trigger reflection engine on immediate rejections — same as late feedback.
    // A rejection is a rejection regardless of timing; the reflection engine
    // should analyze it to generate higher-level lessons.
    try {
      const { reflectionTriggerService } = require('../reflection-engine/trigger-service');
      reflectionTriggerService.onLateFeedbackFlagged(
        approval.agentId,
        approval.tenantId,
        input.approvalId,
      ).catch((err: Error) => log.warn({ err }, 'Non-fatal: rejection reflection trigger failed'));
    } catch (err) {
      log.warn({ err }, 'Non-fatal: reflection trigger module load failed');
    }

    const rejected = this.mapApprovalRequest(result.rows[0]);

    // Persist standing policy so future gates auto-reject for this agent+reason.
    // Suppressed for high-risk reasons (see standingApprovalAllowed) — a blanket
    // auto-reject is also withheld so each occurrence surfaces to a human.
    if (input.alwaysApply && rejected.agentId && rejected.reason && standingApprovalAllowed(rejected.reason)) {
      createGovernanceApprovalPolicy({
        tenantId: rejected.tenantId,
        agentId: rejected.agentId,
        gateReason: rejected.reason,
        decision: 'rejected',
        createdBy: input.decidedBy,
      }).catch(err => log.warn({ err, approvalId: input.approvalId }, 'Non-fatal: alwaysApply policy creation failed (REST path)'));
    } else if (input.alwaysApply && rejected.reason && !standingApprovalAllowed(rejected.reason)) {
      log.info({ approvalId: input.approvalId, gateReason: rejected.reason }, 'alwaysApply ignored — standing approval not allowed for this gate reason');
    }

    return rejected;
  }

  // Record late feedback from Platform Backend.
  //
  // Late feedback represents a human decision that arrived AFTER the original
  // HITL approval expired (the agent already moved on without waiting). The
  // decision is still useful for agent learning, so we:
  //   1. Look up the original approval to recover agent_id, tenant_id, task_id
  //   2. Verify tenant isolation
  //   3. Insert into human_feedback (the table reflection-engine reads from)
  //      with idempotency on feedback_id, so retries from Platform Backend
  //      don't duplicate the row
  //   4. Return whether this was a fresh write or a no-op duplicate
  //
  // The reflection trigger is fired by the router after a successful fresh
  // write — keeping it out of this method makes the unit test trivially
  // mockable without a Cloud Tasks dependency.
  async recordLateFeedback(input: {
    feedbackId: string;
    tenantId: string;
    approvalId: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    decidedByRole: string;
    rejectionReason?: string;
  }): Promise<{ inserted: boolean; agentId: string | null }> {
    // Look up the original approval to get agent_id, task_id, injected_skill_ids, and verify tenant.
    const approvalResult = await pool.query(
      `SELECT agent_id, tenant_id, task_id, injected_skill_ids FROM hitl_approval_requests WHERE id = $1`,
      [input.approvalId]
    );

    if (approvalResult.rows.length === 0) {
      log.warn({
        feedbackId: input.feedbackId,
        approvalId: input.approvalId,
        tenantId: input.tenantId,
      }, 'Late feedback received for unknown approval');
      return { inserted: false, agentId: null };
    }

    const approval = approvalResult.rows[0];
    if (approval.tenant_id !== input.tenantId) {
      // Cross-tenant attempt — surface as not-found, never confirm existence.
      log.warn({
        feedbackId: input.feedbackId,
        approvalId: input.approvalId,
        callingTenantId: input.tenantId,
      }, 'Cross-tenant late feedback attempt rejected');
      return { inserted: false, agentId: null };
    }

    const agentId = approval.agent_id as string;
    const taskId = approval.task_id as string | null;

    // Encode the decision as a structured feedback row. The reflection
    // engine reads `feedback` (text) and `feedback_type` (string) — we put
    // the rejection reason into the text body when present, and tag the
    // type so reflection can weight late approvals vs late rejections
    // differently if it ever wants to.
    const feedbackType = input.decision === 'approved' ? 'late_approval' : 'late_rejection';
    const feedbackText =
      input.decision === 'rejected' && input.rejectionReason
        ? `Late rejection by ${input.decidedByRole} (${input.decidedBy}): ${input.rejectionReason}`
        : `Late ${input.decision} by ${input.decidedByRole} (${input.decidedBy})`;

    // Idempotent insert keyed on feedback_id (unique partial index from
    // migration 057). Returning the id tells us whether this was a fresh
    // write or a duplicate caught by ON CONFLICT.
    const insertResult = await pool.query(
      `INSERT INTO human_feedback (agent_id, tenant_id, task_id, feedback, feedback_type, feedback_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (feedback_id) WHERE feedback_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [agentId, input.tenantId, taskId, feedbackText, feedbackType, input.feedbackId]
    );

    const inserted = insertResult.rows.length > 0;

    log.info({
      event: 'hitl_late_feedback_recorded',
      feedbackId: input.feedbackId,
      approvalId: input.approvalId,
      tenantId: input.tenantId,
      agentId,
      decision: input.decision,
      inserted,
    }, inserted ? 'Late feedback recorded' : 'Late feedback already recorded (idempotent)');

    // Skills flywheel: post skill outcome feedback for late decisions.
    if (inserted) {
      const injectedSkillIds = (approval.injected_skill_ids as string[] | undefined) ?? [];
      if (injectedSkillIds.length > 0) {
        postSkillFeedback({
          tenantId: input.tenantId,
          agentId,
          taskId: taskId ?? undefined,
          feedback: injectedSkillIds.map(skillId => ({
            skillId, skillName: '',
            outcome: input.decision === 'approved' ? 'hitl_approved' as const : 'hitl_rejected' as const,
          })),
        }).catch(err => log.warn({ err: (err as Error).message }, 'hitl: late-feedback skill callback failed (non-fatal)'));
      }
    }

    // Phase 6B: Capture late rejection as correction memory.
    // Wrapped in try/catch — broken module must never crash recordLateFeedback().
    if (inserted && input.decision === 'rejected') {
      try {
         
        const { captureCorrection } = require('../learning/correction-capture');
        captureCorrection(
          input.tenantId,
          agentId,
          [], // pendingToolCalls not available on the approval lookup
          'rejected',
          input.rejectionReason
        ).catch((err: Error) => log.warn({ err }, 'Non-fatal: late correction capture failed'));
      } catch (err) {
        log.warn({ err }, 'Non-fatal: correction capture module load failed');
      }
    }

    return { inserted, agentId };
  }

  /**
   * Resolve oversight settings for a tenant.
   *
   * Cache-aside against the authoritative store in platform-backend. The
   * earlier cache-only implementation returned `null` on cache miss, which
   * caused tool-interceptor's `if (!oversight) return toolCall` early-exit
   * to silently bypass the user's `communication='draft'` setting (for
   * example, for a tenant whose oversight row exists in PB but was never
   * reflected in `tenant_oversight_cache`).
   *
   * Order of resolution:
   *   1. Local `tenant_oversight_cache` row (pub/sub-populated, fast path)
   *   2. Synchronous fetch from PB `/api/internal/oversight/:tenantId`,
   *      then upsert the cache so subsequent reads stay fast
   *   3. Platform-safe defaults — never null — so the gate can never
   *      silently disable itself when both cache and PB are absent
   *
   * Return type is intentionally non-nullable: any caller that previously
   * special-cased `null` to bypass enforcement is now a type error and gets
   * caught at compile time.
   */
  async getOversightSettings(tenantId: string): Promise<OversightSettings> {
    const cached = await this.readOversightCache(tenantId);
    if (cached) return cached;

    // Cache miss — fetch from PB. PB's endpoint uses
    // getOrCreateOversightSettings, so it always returns a usable shape.
    try {
      const wire = await fetchOversightSettings(tenantId);
      if (wire) {
        await this.upsertOversightCache(tenantId, wire);
        return {
          tenantId: wire.tenantId,
          autonomy: wire.autonomy,
          escalation: wire.escalation,
          sensitiveWork: wire.sensitiveWork,
          communication: wire.communication,
          escalationSemantics: semanticsOf(wire.escalationSemantics),
          communicationSemantics: semanticsOf(wire.communicationSemantics),
        };
      }
    } catch (err) {
      log.warn(
        { tenantId, err: (err as Error).message },
        'getOversightSettings: PB fetch failed; falling back to platform-safe defaults',
      );
    }

    // Both cache and PB unavailable — return defaults that fail closed.
    // `communication='review'` puts every outbound call through the
    // sensitive-work gate; `autonomy='controlled'` resolves to HITL level
    // 2 in getDefaultHitlLevel. The agent invocation continues, but no
    // outbound action ships without explicit approval.
    log.error(
      { tenantId },
      'getOversightSettings: both cache miss AND PB fetch failed — returning fail-closed defaults',
    );
    return {
      tenantId,
      autonomy: 'controlled',
      escalation: 'important',
      communication: 'review',
      sensitiveWork: {
        customerCommunication: true,
        financialActions: true,
        dataChanges: true,
        externalPublishing: true,
        hiringDecisions: true,
      },
    };
  }

  /** Pure cache read; returns null on miss so the cache-aside caller can
   *  decide what to do next. Kept as a private helper so the public API
   *  stays non-nullable. */
  private async readOversightCache(
    tenantId: string,
  ): Promise<OversightSettings | null> {
    const result = await pool.query(
      `SELECT * FROM tenant_oversight_cache WHERE tenant_id = $1`,
      [tenantId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      tenantId: row.tenant_id,
      autonomy: row.autonomy,
      escalation: row.escalation,
      sensitiveWork: row.sensitive_work,
      communication: row.communication,
      // A row synced before migration 428 carries NULLs and reads as 1.
      escalationSemantics: semanticsOf(row.escalation_semantics),
      communicationSemantics: semanticsOf(row.communication_semantics),
    };
  }

  /** Write-through after a successful fetch from PB. entity_version is
   *  carried for compatibility with the pub/sub-driven upsert in
   *  events/subscriber.ts:handleOversightUpdated. */
  private async upsertOversightCache(
    tenantId: string,
    wire: {
      autonomy: 'autonomous' | 'balanced' | 'controlled';
      escalation: 'exceptions' | 'important' | 'sensitive';
      communication: 'draft' | 'auto' | 'review';
      sensitiveWork: Record<string, boolean | undefined>;
      currentVersion?: number;
      escalationSemantics?: number;
      communicationSemantics?: number;
    },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO tenant_oversight_cache
         (tenant_id, entity_version, autonomy, escalation, sensitive_work, communication,
          escalation_semantics, communication_semantics, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         entity_version = EXCLUDED.entity_version,
         autonomy = EXCLUDED.autonomy,
         escalation = EXCLUDED.escalation,
         sensitive_work = EXCLUDED.sensitive_work,
         communication = EXCLUDED.communication,
         escalation_semantics = EXCLUDED.escalation_semantics,
         communication_semantics = EXCLUDED.communication_semantics,
         synced_at = NOW()`,
      [
        tenantId,
        wire.currentVersion ?? 0,
        wire.autonomy,
        wire.escalation,
        JSON.stringify(wire.sensitiveWork),
        wire.communication,
        // Stored as read, so a snapshot says what the control plane said and
        // an absent value stays absent (reads as 1) rather than becoming a 1
        // the control plane never sent.
        wire.escalationSemantics ?? null,
        wire.communicationSemantics ?? null,
      ],
    );
  }

  // Get default HITL level from autonomy
  getDefaultHitlLevel(autonomy: string): number {
    switch (autonomy) {
      case 'controlled':
        return 2;
      case 'balanced':
        return 3;
      case 'autonomous':
        return 4;
      default:
        return 3;
    }
  }

  // Resolve effective HITL level (team override -> tenant default)
  async resolveHitlLevel(tenantId: string, teamHitlLevel?: number): Promise<number> {
    if (teamHitlLevel !== undefined && teamHitlLevel !== null) {
      return teamHitlLevel;
    }

    const oversight = await this.getOversightSettings(tenantId);
    return this.getDefaultHitlLevel(oversight?.autonomy || 'balanced');
  }

  /** The standing decisions the governance engine holds for this agent, by
   *  reason — the one input to the obligation evaluator that is read rather
   *  than derived.
   *
   *  Two callers, two failure conventions. At the GATE and at approval a read
   *  failure is fail-open, the gate's own rule: no standing policy, the reason
   *  stays in force, the person is asked. At CONSUMPTION (`strict`) a read
   *  failure is "the reasons in force cannot be established", and the caller
   *  defers rather than consuming a grant against a set it could not compute —
   *  a policy that could not be read is not the same as a policy that is not
   *  there, and treating it so would ask again about a control nobody
   *  tightened. */
  async standingPoliciesFor(
    tenantId: string,
    agentId: string,
    opts: { strict?: boolean } = {},
  ): Promise<Partial<Record<GateReason, StandingPolicy>>> {
    const out: Partial<Record<GateReason, StandingPolicy>> = {};
    await Promise.all(REASON_PRECEDENCE.map(async (reason) => {
      try {
        const policy = await getGovernanceApprovalPolicy(tenantId, agentId, reason, { strict: opts.strict === true });
        if (policy?.decision === 'approved' || policy?.decision === 'rejected') {
          out[reason] = {
            decision: policy.decision,
            ...(Array.isArray(policy.actionClasses) ? { actionClasses: policy.actionClasses } : {}),
          };
        }
      } catch (err) {
        if (opts.strict) {
          throw new Error(`standing policy for ${reason} unreadable: ${(err as Error).message}`);
        }
        // fail-open: no standing policy for this reason
      }
    }));
    return out;
  }

  /** The oversight settings, or a throw when they cannot be read.
   *
   *  `getOversightSettings` answers a cache miss plus a failed fetch with
   *  fail-closed DEFAULTS, which is right for a gate deciding whether to ask
   *  and wrong for consumption recomputing what a yes covered: the defaults
   *  are stricter than most tenants' settings, so they would surface as a
   *  control "tightened" in between and re-ask about a change nobody made. */
  private async getOversightSettingsStrict(tenantId: string): Promise<OversightSettings> {
    const cached = await this.readOversightCache(tenantId);
    if (cached) return cached;
    const wire = await fetchOversightSettings(tenantId);
    if (!wire) throw new Error('oversight settings unavailable: cache miss and empty fetch');
    await this.upsertOversightCache(tenantId, wire);
    return {
      tenantId: wire.tenantId,
      autonomy: wire.autonomy,
      escalation: wire.escalation,
      sensitiveWork: wire.sensitiveWork,
      communication: wire.communication,
    };
  }

  /** The hire's level as it is NOW. The approval row holds the level the
   *  gate fired under; a hire moved to a stricter level since is a control
   *  tightened in between, and the recompute has to see it. Lenient reads
   *  fall back to the recorded level; strict ones throw, the way the other
   *  reads do at consumption. */
  private async hitlLevelNow(
    approval: HitlApprovalRequest,
    opts: { strict?: boolean },
  ): Promise<number> {
    try {
      const r = await pool.query(
        `SELECT hitl_level FROM agents WHERE id = $1 AND tenant_id = $2`,
        [approval.agentId, approval.tenantId],
      );
      const level = r.rows[0]?.hitl_level;
      if (typeof level === 'number') return level;
      if (opts.strict) throw new Error('hire not found');
      return approval.hitlLevel;
    } catch (err) {
      if (opts.strict) throw new Error(`hire level unreadable: ${(err as Error).message}`);
      return approval.hitlLevel;
    }
  }

  /** The obligation config for an approval's calls under the settings as they
   *  are NOW: live oversight, policies and the hire's level, the classification
   *  the gate captured when it fired. Used at approval (to record the grant)
   *  and at consumption (to recompute it). At consumption pass `strict`: a
   *  settings, policy or level read that fails THROWS, and the consumption
   *  point turns that into a deferral, never a recompute over defaults. */
  async obligationConfigFor(
    approval: HitlApprovalRequest,
    opts: { strict?: boolean } = {},
  ): Promise<ObligationConfig> {
    const [oversight, standingPolicies, hitlLevel] = await Promise.all([
      opts.strict ? this.getOversightSettingsStrict(approval.tenantId) : this.getOversightSettings(approval.tenantId),
      this.standingPoliciesFor(approval.tenantId, approval.agentId, opts),
      this.hitlLevelNow(approval, opts),
    ]);
    const view = approval.gateView ?? null;
    return {
      hitlLevel,
      oversight,
      tools: (view?.tools ?? []) as ModelTool[],
      trustLevel: view?.trustLevel,
      externalContentGateDisabled: view?.externalContentGateDisabled,
      triggerTarget: view?.triggerTarget as ObligationConfig['triggerTarget'],
      declaredStep: view?.declaredStep as ObligationConfig['declaredStep'],
      runningTotals: view?.runningTotals,
      standingPolicies,
    };
  }

  /** What a yes on these final calls covers. The reason the gate fired with —
   *  the one the person was shown — is always in the set. */
  private async grantFor(
    approval: HitlApprovalRequest,
    finalCalls: ToolCallRequest[],
  ): Promise<{ version: number; reasons: GateReason[] }> {
    const evaluated = evaluateApprovalObligations(finalCalls, await this.obligationConfigFor(approval));
    const reasons = new Set<GateReason>(evaluated.reasons);
    if (approval.reason) reasons.add(approval.reason as GateReason);
    return { version: evaluated.version, reasons: REASON_PRECEDENCE.filter((r) => reasons.has(r)) };
  }

  /** The staged batches the decided calls name — an apply-role tool, per the
   *  classification the gate captured — bound to the approval on a yes and
   *  cancelled on a no. Non-throwing past the lookup of the tool: a batch that
   *  cannot be found is a batch the apply will refuse for itself. */
  private async bindStagedBatches(
    approval: HitlApprovalRequest,
    calls: ReadonlyArray<ToolCallRequest>,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    const tools = (approval.gateView?.tools ?? []) as ModelTool[];
    for (const call of calls) {
      const tool = resolveGateTool(call, tools) as (ModelTool & { writeRole?: string }) | undefined;
      if (tool?.writeRole !== 'apply') continue;
      const sep = tool.name.indexOf('__');
      if (sep < 0) continue;
      const connector = tool.name.slice(0, sep);
      const applyTool = tool.name.slice(sep + 2);
      try {
        const repo = stagedBatchRepository();
        const batch = await repo.findForApply({
          tenantId: approval.tenantId, agentId: approval.agentId, connector, applyTool, applyArgs: call.input,
        });
        if (!batch) {
          log.warn({ approvalId: approval.id, tool: tool.name }, 'staged apply decided, but no staged batch matches the call; the apply will refuse');
          continue;
        }
        if (decision === 'approved') {
          const bound = await repo.bindApproval(approval.tenantId, batch.id, approval.id, approval.expiresAt ?? undefined);
          log.info({ approvalId: approval.id, batchId: batch.id, bound: bound !== null, digest: batch.digest }, 'staged batch bound to its approval');
        } else {
          await repo.cancelById(approval.tenantId, batch.id, `approval ${approval.id} rejected`);
          log.info({ approvalId: approval.id, batchId: batch.id }, 'staged batch cancelled with its rejected approval');
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, approvalId: approval.id, tool: tool.name }, 'Non-fatal: staged batch binding failed');
      }
    }
  }

  // Map database row to HitlApprovalRequest
  private mapApprovalRequest(row: Record<string, unknown>): HitlApprovalRequest {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      workflowId: row.workflow_id as string,
      taskId: row.task_id as string,
      agentId: row.agent_id as string,
      hitlLevel: row.hitl_level as number,
      pendingToolCalls: this.parseToolCalls(row.pending_tool_calls),
      toolCallsHash: row.tool_calls_hash as string,
      reason: row.reason as string,
      status: row.status as ApprovalStatus,
      decidedBy: row.decided_by as string | null,
      decidedByRole: row.decided_by_role as string | null,
      decision: row.decision as 'approved' | 'rejected' | null,
      rejectionReason: row.rejection_reason as string | null,
      decidedAt: row.decided_at ? new Date(row.decided_at as string) : null,
      idempotencyKey: row.idempotency_key as string | null,
      expiresAt: new Date(row.expires_at as string),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      injectedSkillIds: Array.isArray(row.injected_skill_ids) ? (row.injected_skill_ids as string[]) : [],
      source: (row.source as 'agent' | 'sandbox_code') ?? 'agent',
      context: (row.context as Record<string, unknown> | null) ?? null,
      actionSummary: (row.action_summary as string | null) ?? null,
      whySummary: (row.why_summary as string | null) ?? null,
      detail: (row.detail as string | null) ?? null,
      threadId: (row.thread_id as string | null) ?? null,
      editedToolInputs: parseApprovedEdits(row.edited_tool_inputs) ?? null,
      finalToolCallsHash: (row.final_tool_calls_hash as string | null) ?? null,
      grantedObligations: Array.isArray(row.granted_obligations)
        ? (row.granted_obligations as GateReason[])
        : null,
      obligationsEvaluatorVersion: typeof row.obligations_evaluator_version === 'number'
        ? row.obligations_evaluator_version
        : null,
      gateView: (row.gate_view as ApprovalGateView | null | undefined) ?? null,
    };
  }

  private parseToolCalls(raw: unknown): ToolCallRequest[] {
    if (Array.isArray(raw)) {
      return raw as ToolCallRequest[];
    }
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    }
    return [];
  }
}

export const hitlEnforcementService = new HitlEnforcementService();
