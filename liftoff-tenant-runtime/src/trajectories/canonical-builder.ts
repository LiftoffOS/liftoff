// Part 6 §F — assemble a CanonicalTrajectory from the per-invocation buffer.
//
// Prepends the initial user objective as the first user message so the
// at-rest document is self-contained (the recorder only captures assistant
// + tool turns; the initial prompt isn't in the SDK stream).

import { getRun } from './recorder';
import type { CanonicalTrajectory } from './types';
import type { ExecutionEngineId, NestedSpecialistEngineId } from '../agent-execution/adapter/types';
import { resolveExecutionEngine, isResolvedProvider } from '../agent-execution/adapter/engine-resolver';

export function buildCanonical(opts: {
  invocationId: string;
  systemPrompt: string;
  objective: string;
  toolDefs: Array<{ name: string; description: string; input_schema: unknown }>;
  meta: {
    tenantId: string;
    agentId: string;
    triggeredByUserId?: string;
    parentInvocationId?: string;
    nestedKind?: 'code_session';
    /** Nested code_session specialist engine. Passed only by the
     * code_session writer; recorded as `nested_engine`, never as the outer
     * execution_engine. */
    nestedEngine?: NestedSpecialistEngineId;
    /** Explicit outer engine override. When omitted for a non-nested
     * run, the engine is resolved from `run.provider` + the engine env flags,
     * matching the invocation row's execution_engine. */
    executionEngine?: ExecutionEngineId;
    vendorMcpServers?: string[];
    completed: boolean;
    // Mirrors invocations.outcome, 'gated' included (migration 329).
    outcome: import('../invocations/types').InvocationOutcome;
  };
}): CanonicalTrajectory | null {
  const run = getRun(opts.invocationId);
  if (!run || run.messages.length === 0) return null;

  const initialUser = { role: 'user' as const, content: [{ type: 'text' as const, text: opts.objective }] };
  const messages = [initialUser, ...run.messages];

  const toolCallCount = messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'tool_use').length;

  // The CONCRETE outer engine. Nested code_session runs are NOT outer
  // engines: they carry `nested_engine` and leave execution_engine unset (the
  // spawning outer engine lives on the parent invocation's trajectory). For a
  // top-level run, resolve from run.provider so it matches the invocation row.
  const executionEngine: ExecutionEngineId | undefined = opts.meta.nestedKind
    ? undefined
    : (opts.meta.executionEngine
      ?? (isResolvedProvider(run.provider) ? resolveExecutionEngine(run.provider, process.env) : undefined));

  return {
    schema_version: '1.1',
    trajectory_meta: {
      tenant_id: opts.meta.tenantId,
      agent_id: opts.meta.agentId,
      invocation_id: opts.invocationId,
      ...(opts.meta.triggeredByUserId ? { triggered_by_user_id: opts.meta.triggeredByUserId } : {}),
      ...(opts.meta.parentInvocationId ? { parent_invocation_id: opts.meta.parentInvocationId } : {}),
      ...(opts.meta.nestedKind ? { nested_kind: opts.meta.nestedKind } : {}),
      ...(executionEngine ? { execution_engine: executionEngine } : {}),
      ...(opts.meta.nestedEngine ? { nested_engine: opts.meta.nestedEngine } : {}),
      ...(opts.meta.vendorMcpServers?.length ? { vendor_mcp_servers: opts.meta.vendorMcpServers } : {}),
      provider: run.provider,
      model: run.model,
      started_at: new Date(run.startedAt).toISOString(),
      completed: opts.meta.completed,
      tool_call_count: toolCallCount,
      outcome: opts.meta.outcome,
    },
    system: opts.systemPrompt ? [{ type: 'text', text: opts.systemPrompt }] : [],
    messages,
    tools: opts.toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Record<string, unknown>,
    })),
    _provider_extras: run.providerExtras,
  };
}
