// CAIO Workforce Planning Tool Types
//
// Shared type contract between the tool dispatcher and per-tool implementations.
// The workforce planning chat service hands a user message + history to the LLM
// along with a filtered tool list. Each tool is a schema + executor.
//
// Adapted from platform-backend src/workforce-plans/tools/types.ts with these
// differences:
//   - TenantMemberRole is inlined (no PB insight deps)
//   - LLMToolDefinition imported from local llm/types.ts
//   - Import paths use .js extensions (ESM)

import type { LLMToolDefinition } from '../../llm/types.js';
import type { CallerOrigin } from '../caller-context.js';

/** Tenant member roles. Inlined here instead of importing from PB insights so
 *  this service has no dependency on platform-backend's internal type tree. */
export type TenantMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

/** The role keys used for filtering tools. Workforce plan permissions stay
 *  aligned with existing tenant policy by reusing the same role set. */
export type WorkforcePlanRole = TenantMemberRole;

/** Context handed to every tool executor. The dispatcher fills this in
 *  before calling the executor. Tools never read from request.params or
 *  global state — only from this typed object. */
export interface WorkforcePlanToolContext {
  tenantId: string;
  /** The accountId of the user invoking the chat. Used when creating plans
   *  so the plan's `account_id` column records the authenticated caller,
   *  not a client-supplied value. */
  accountId: string;
  /** The user's role in tenant_members. The dispatcher has already verified
   *  the role is allowed to call this tool — but tools may still narrow
   *  behaviour based on it. */
  role: WorkforcePlanRole;
  /** The id of the workforce plan attached to the current thread (if any).
   *  Set when the CAIO has already called workforce_plan__draft in this
   *  conversation, so subsequent turns can update the same plan instead of
   *  creating a new one. Undefined on the first turn of a new thread. */
  workforcePlanId?: string;
  /** The id of the current team_plan_threads row. Tools use this when they
   *  need to wire a newly-created plan back to the thread (e.g. the first
   *  workforce_plan__draft call). The chat service always sets this when
   *  dispatching tools from a chat turn. */
  threadId?: string;
  /** The executing turn (migration 031). A conversation search excludes it, so
   *  it does not return the question that asked it. Undefined on a threadless
   *  greeting, which has no turn row. */
  turnId?: string;
  /** Where the turn came from when it came through a coding tool. Tools that
   *  act on the workspace through platform-backend send it back with the
   *  caller headers so the action is attributed to that tool. */
  origin?: CallerOrigin;
}

/** A single tool the LLM can call. */
export interface WorkforcePlanTool {
  /** Schema-only definition handed to the LLM. */
  definition: LLMToolDefinition;
  /** Executor — runs after the LLM picks this tool. Returns a JSON-stringifiable
   *  object that gets sanitized and serialized into a ToolResult message. */
  execute(
    input: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<unknown>;
}

/** Result of a successful or failed tool execution, ready to be wrapped as
 *  an LLMToolResult and fed back into the next assistant turn. */
export interface WorkforcePlanToolResult {
  toolName: string;
  /** True if the tool ran without throwing. False if forbidden or errored. */
  ok: boolean;
  /** Sanitized payload (or error description if !ok). Always a plain object. */
  data: Record<string, unknown>;
}
