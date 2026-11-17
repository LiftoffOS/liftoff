// Insights Tool Dispatcher
//
// The chat service hands the LLM a list of tool definitions and lets it pick
// one. When the LLM picks, it sends back an LLMToolCall with `name` and
// `input`. This dispatcher takes that call and:
//
//   1. Verifies the tool exists in the registry
//   2. Verifies the user's role is allowed to call it (defense in depth —
//      the system prompt should already exclude tools the user can't call)
//   3. Calls the executor
//   4. Sanitizes the result
//   5. Wraps it as an InsightsToolResult
//
// On any failure (unknown tool, forbidden, executor throw), we return an
// InsightsToolResult with `ok: false` and an error description so the LLM
// can recover gracefully and tell the user something useful.
//
// The dispatcher logs every tool invocation for audit. Per the security
// section of the implementation plan: "Each tool invocation by the LLM
// (tool name, parameters, data categories accessed)."

import { log, logAudit } from '../../infrastructure/logging';
import { canRoleCallTool, toolsForRole } from './role-matrix';
import { BRING_IN_COLLEAGUE_TOOL, insightsBringInColleagueTool } from './bring-in-colleague';
import { datasetTools } from '../../datasets/tools';
import { chatRecallTools } from '../../chat-recall/tools';
import { generatedFileTools } from '../../generated-files/assistant-tools';
import { sanitizeToolResult } from './sanitize';
import type { InsightsTool, InsightsToolContext, InsightsToolResult } from './types';

/** Registry of available tools. Populated by `registerTool()`. The chat
 *  service initializes this once at startup by importing each tool module
 *  and calling `registerTool()`. */
const TOOL_REGISTRY: Map<string, InsightsTool> = new Map();

export function registerTool(tool: InsightsTool): void {
  if (TOOL_REGISTRY.has(tool.definition.name)) {
    throw new Error(`Tool already registered: ${tool.definition.name}`);
  }
  TOOL_REGISTRY.set(tool.definition.name, tool);
}

/** Test-only — clear the registry between test runs. */
export function _resetToolRegistry(): void {
  TOOL_REGISTRY.clear();
}

/** Get the LLMToolDefinition[] for the given role, in registration order.
 *  This is what the chat service hands to llmClient.completeStream() as
 *  the `tools` field. */
export function getToolDefinitionsForRole(
  role: InsightsToolContext['role'],
  opts: { answerOnly?: boolean; asColleague?: boolean } = {},
) {
  // The role matrix decides who may call what; the steward rule, an
  // answer-only turn and a hand-over narrow the list further (role-matrix.ts).
  const offered = new Set(toolsForRole(role, opts));
  const out = [];
  for (const tool of TOOL_REGISTRY.values()) {
    if (offered.has(tool.definition.name)) {
      out.push(tool.definition);
    }
  }
  // Neither of the two below is in the registry, because neither is dispatched
  // through it: the chat service intercepts both.
  //
  // The dataset tools are intercepted for a specific reason. Every registry
  // result goes through `sanitizeToolResult`, which truncates any string value
  // at 500 characters — right for a tenant-controlled agent name, fatal for
  // these, whose whole output is prose the platform itself wrote and already
  // bounded (a view, a page of rows, a digest). Dispatching them here would
  // cut a 12,000-character page of query rows to 500 and the model would read
  // a fifth of a line. So they run the way Liftoff runs them, against the same
  // renderer, and both assistants read identical words.
  if (offered.has(BRING_IN_COLLEAGUE_TOOL)) out.push(insightsBringInColleagueTool);
  for (const tool of datasetTools) {
    if (offered.has(tool.name)) out.push(tool);
  }
  // Intercepted for the same reason: its result is prose this platform wrote,
  // and the registry's sanitizer would cut it.
  for (const tool of generatedFileTools) {
    if (offered.has(tool.name)) out.push(tool);
  }
  // And again for the same reason, most sharply of all: a recall result IS a
  // transcript, so a 500-character cut would return the first line of the
  // first message and nothing else.
  for (const tool of chatRecallTools) {
    if (offered.has(tool.name)) out.push(tool);
  }
  return out;
}

/** Look up a tool by name (no role filtering). */
export function getRegisteredTool(name: string): InsightsTool | undefined {
  return TOOL_REGISTRY.get(name);
}

/** Dispatch a single tool call. Never throws — wraps all failures into an
 *  InsightsToolResult with ok=false. */
export async function dispatchToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: InsightsToolContext,
): Promise<InsightsToolResult> {
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    log.warn({ toolName, tenantId: ctx.tenantId }, 'Insights chat: unknown tool requested');
    return {
      toolName,
      ok: false,
      data: { error: `Unknown tool: ${toolName}` },
    };
  }

  if (!canRoleCallTool(toolName, ctx.role)) {
    log.warn(
      { toolName, role: ctx.role, tenantId: ctx.tenantId, accountId: ctx.accountId },
      'Insights chat: tool call denied by role matrix',
    );
    // Audit log denials so we can spot LLM-side hallucinations or attempted
    // privilege escalation.
    logAudit(
      'insights.tool_call_denied',
      { tenantId: ctx.tenantId, userId: ctx.accountId },
      { tool: toolName, role: ctx.role, inputKeys: Object.keys(input) },
    );
    return {
      toolName,
      ok: false,
      data: { error: `Tool ${toolName} is not available for your role.` },
    };
  }

  // Audit log successful invocations. We log the tool name and a summary of
  // the input keys (not full input — input may contain large strings) so
  // forensic analysis can see what data categories were accessed.
  logAudit(
    'insights.tool_call',
    { tenantId: ctx.tenantId, userId: ctx.accountId },
    { tool: toolName, role: ctx.role, inputKeys: Object.keys(input) },
  );

  try {
    const raw = await tool.execute(input, ctx);
    const sanitized = sanitizeToolResult(raw);
    return {
      toolName,
      ok: true,
      data: (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
        ? sanitized as Record<string, unknown>
        : { result: sanitized }),
    };
  } catch (err) {
    log.error(
      { toolName, tenantId: ctx.tenantId, error: (err as Error).message },
      'Insights chat: tool execution failed',
    );
    return {
      toolName,
      ok: false,
      data: { error: `Tool execution failed: ${(err as Error).message}` },
    };
  }
}
