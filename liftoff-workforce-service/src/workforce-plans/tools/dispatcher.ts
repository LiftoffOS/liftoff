// CAIO Workforce Planning Tool Dispatcher
//
// Registers CAIO tools, filters them by the caller's role before handing
// them to the LLM, and dispatches tool_use events back to the matching
// executor.
//
// Security model:
//   1. The system prompt only lists tools the caller's role can call, so
//      the LLM never "sees" tools it shouldn't invoke.
//   2. The role matrix is re-checked at dispatch time as defense in depth
//      in case the LLM hallucinates a tool name.
//   3. Every invocation and every denial is audit-logged so forensic
//      analysis can spot privilege escalation attempts.
//   4. Tool results are sanitized before being handed back to the LLM.
//      Sanitization strips HTML/control chars and truncates long strings
//      to mitigate prompt injection via user-controlled fields.
//
// Adapted from platform-backend src/workforce-plans/tools/dispatcher.ts.
// Import paths use .js extensions (ESM). Sanitize is local (no PB dep).

import { log } from '../../infrastructure/logging.js';
import { writeAuditLog } from '../audit-log.js';
import { canRoleCallTool, toolsForRole } from './role-matrix.js';
import { BRING_IN_COLLEAGUE_TOOL, bringInColleagueTool } from './bring-in-colleague.js';
import { sanitizeToolResult } from './sanitize.js';
import type {
  WorkforcePlanTool,
  WorkforcePlanToolContext,
  WorkforcePlanToolResult,
} from './types.js';

/** Registry of available tools. Populated by `registerWorkforcePlanTool()`.
 *  Callers go through tools/index.ts, whose accessors call
 *  `registerWorkforcePlanTools()` before reading the registry — nothing
 *  outside this directory should read it directly, or an empty registry
 *  becomes a silently toolless CAIO again. */
const TOOL_REGISTRY: Map<string, WorkforcePlanTool> = new Map();

export function registerWorkforcePlanTool(tool: WorkforcePlanTool): void {
  if (TOOL_REGISTRY.has(tool.definition.name)) {
    throw new Error(`Workforce plan tool already registered: ${tool.definition.name}`);
  }
  TOOL_REGISTRY.set(tool.definition.name, tool);
}

/** Remove a tool. Used by the remote workspace-action registration when a
 *  manifest drops a tool or replaces its definition; a name that is not
 *  registered is a no-op. */
export function unregisterWorkforcePlanTool(name: string): void {
  TOOL_REGISTRY.delete(name);
}

/** Test-only — clear the registry between test runs. */
export function _resetWorkforcePlanToolRegistry(): void {
  TOOL_REGISTRY.clear();
}

/** Get the LLMToolDefinition[] for the given role, in registration order.
 *  The chat service hands this to the LLM as the `tools` field on each
 *  completion request. */
export function getToolDefinitionsForRole(
  role: WorkforcePlanToolContext['role'],
  opts: { handover?: boolean } = {},
) {
  const offered = new Set(toolsForRole(role, opts));
  const out = [];
  for (const tool of TOOL_REGISTRY.values()) {
    if (offered.has(tool.definition.name)) {
      out.push(tool.definition);
    }
  }
  // Not in the registry, because it is never dispatched: the chat service
  // intercepts the call and hands the turn over (see bring-in-colleague.ts).
  // Listed last so it never displaces a working tool in the model's view.
  if (offered.has(BRING_IN_COLLEAGUE_TOOL)) out.push(bringInColleagueTool);
  return out;
}

/** Look up a tool by name (no role filtering). */
export function getRegisteredWorkforcePlanTool(name: string): WorkforcePlanTool | undefined {
  return TOOL_REGISTRY.get(name);
}

/** Dispatch a single tool call. Never throws — wraps all failures into a
 *  WorkforcePlanToolResult with ok=false so the LLM can recover. */
export async function dispatchToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: WorkforcePlanToolContext,
): Promise<WorkforcePlanToolResult> {
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    log.warn(
      { toolName, tenantId: ctx.tenantId },
      'Workforce plan chat: unknown tool requested',
    );
    return {
      toolName,
      ok: false,
      data: { error: `Unknown tool: ${toolName}` },
    };
  }

  if (!canRoleCallTool(toolName, ctx.role)) {
    log.warn(
      { toolName, role: ctx.role, tenantId: ctx.tenantId, accountId: ctx.accountId },
      'Workforce plan chat: tool call denied by role matrix',
    );
    // Audit log denials so forensic analysis can spot LLM hallucinations
    // or attempted privilege escalation.
    void writeAuditLog(
      'workforce_plans.tool_call_denied',
      { tenantId: ctx.tenantId, userId: ctx.accountId },
      { tool: toolName, role: ctx.role, inputKeys: Object.keys(input) },
    );
    return {
      toolName,
      ok: false,
      data: { error: `Tool ${toolName} is not available for your role.` },
    };
  }

  // Audit log successful invocations. We log the tool name and input keys
  // (not full input — input may contain large strings) so forensic analysis
  // can see what data categories were accessed.
  void writeAuditLog(
    'workforce_plans.tool_call',
    { tenantId: ctx.tenantId, userId: ctx.accountId },
    { tool: toolName, role: ctx.role, inputKeys: Object.keys(input) },
  );

  try {
    const raw = await tool.execute(input, ctx);
    const sanitized = sanitizeToolResult(raw);
    return {
      toolName,
      ok: true,
      data:
        sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
          ? (sanitized as Record<string, unknown>)
          : { result: sanitized },
    };
  } catch (err) {
    log.error(
      { toolName, tenantId: ctx.tenantId, error: (err as Error).message },
      'Workforce plan chat: tool execution failed',
    );
    return {
      toolName,
      ok: false,
      data: { error: `Tool execution failed: ${(err as Error).message}` },
    };
  }
}
