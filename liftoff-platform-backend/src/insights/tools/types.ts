// Insights Chat Tool Types
//
// The chat-service (Phase 6) hands a user message + conversation history to
// the LLM along with a list of tools the LLM may call. Each tool is defined
// by an LLMToolDefinition (the schema the LLM sees) plus an executor (what
// actually runs when the LLM picks it). This file is the typed contract
// between the dispatcher and the per-tool implementations.

import type { LLMToolDefinition } from '../../llm/types';
import type { ActorOrigin } from '../../workspace-actions/actor';
import type { TenantMemberRole } from '../chat-repository';

/** The role keys we use for filtering tools. Member roles in tenant_members
 *  table are: owner, admin, member, viewer. Imported from chat-repository so
 *  the matrix here stays in sync with the permission matrix used by the
 *  thread visibility checks. */
export type InsightsRole = TenantMemberRole;

/** Context handed to every tool executor. The dispatcher fills this in
 *  before calling the executor — tools never read from request.params or
 *  global state, only from this typed object. */
export interface InsightsToolContext {
  tenantId: string;
  /** The accountId of the user invoking the chat. Used by tools that filter
   *  to "own data only" (e.g. get_human_activity for member role). */
  accountId: string;
  /** The user's role in tenant_members. The dispatcher has already verified
   *  the role is allowed to call this tool, but tools may still narrow their
   *  output based on it (e.g. member sees only their own work). */
  role: InsightsRole;
  /** The conversation this turn belongs to. Browser sessions are per-thread —
   *  the pane the person is watching belongs to THIS conversation — so a tool
   *  that drives one needs it. Optional because the analytics tools predate it
   *  and do not read it. */
  threadId?: string;
  /** Present when the turn came through a coding tool (the MCP chat worker):
   *  every workspace action this turn takes is attributed to that tool. */
  origin?: ActorOrigin;
  /** An answer-mode turn: a team brought this assistant in for a question and
   *  no person is present. Carried onto the workspace actor so an action that
   *  needs a person to do something refuses instead of producing it. */
  unattended?: boolean;
}

/** A single tool the LLM can call. */
export interface InsightsTool {
  /** Schema-only definition handed to the LLM. */
  definition: LLMToolDefinition;
  /** Executor — runs after the LLM picks this tool. Returns a JSON-stringifiable
   *  object that gets sanitized and serialized into a ToolResult message. */
  execute(input: Record<string, unknown>, ctx: InsightsToolContext): Promise<unknown>;
}

/** Result of a successful or failed tool execution, ready to be wrapped as
 *  an LLMToolResult and fed back into the next assistant turn. */
export interface InsightsToolResult {
  toolName: string;
  /** True if the tool ran without throwing. False if it threw or was forbidden. */
  ok: boolean;
  /** The sanitized payload (or an error description if !ok). Always a plain
   *  object so it can be JSON.stringify'd. */
  data: Record<string, unknown>;
}
