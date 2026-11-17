// Grader tool surface for the agentic deliverable judge.
//
// buildGraderCatalog assembles a sandbox-scoped McpToolCatalog from the same
// createToolGatewayMcpServer the real agent runs use, but with NO connectors
// (integrations: []) so the only meaningful tools are the isolated sandbox
// primitives (file_* / shell_exec) that dispatch to the sandbox-executor.
// graderDenyGate is the read-only permission gate: a default-deny allowlist so
// the judge can inspect + verify in the sandbox but can never mutate a tenant's
// systems — and, critically, can never call code_session (which would escape the
// sandbox to in-process Bash).

import { isUtf8 } from 'node:buffer';
import { Storage } from '@google-cloud/storage';
import type { ReconstructedRun } from '../../reconstruct/trace-model';
import type { McpToolCatalog, HitlGate, ResolvedProvider } from '../../../agent-execution/adapter';
import { logger } from '../../../infrastructure/logging';

const SEED_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Synthetic instruction version for grader tool-gateway dispatch. The grade is
 *  not a real agent instruction, but ToolGatewayService.validateIdentity requires
 *  a TRUTHY instructionVersion (`if (!input.instructionVersion) throw`), so 0 is
 *  rejected — the seed AND the judge's own sandbox calls must carry a non-zero
 *  value or every execution_environment dispatch 500s. Keep both call sites on
 *  this constant so they stay in lockstep. */
const GRADER_INSTRUCTION_VERSION = 1;

/** Always-on gateway built-ins the grader must NEVER call, regardless of the
 *  catalog: code_session (escapes to in-process Bash), delegate_to_agent /
 *  spawn_task_graph (spawn sub-agents), and the tenant-system-mutating built-ins
 *  (notifications_send / memory_save / audit_log). Registered unconditionally by
 *  createToolGatewayMcpServer, so the read-only connector filter can't drop them. */
const DANGEROUS_GRADER_TOOLS = new Set<string>([
  'code_session',
  'delegate_to_agent',
  'spawn_task_graph',
  'notifications_send',
  'memory_save',
  'audit_log',
  'find_teammates',
  'schedule_followup',
]);

/** Catalog-scoped read-only gate. A tool is allowed only if it is in THIS grade's
 *  catalog (which is sandbox tools + read-filtered connectors, via
 *  sandboxCapabilities + allowedActionTypes:['read']) AND not a dangerous built-in.
 *  Native web_search/web_fetch bypass canUseTool via allowedTools, but are allowed
 *  here too if they reach the gate. Everything else is a hard deny (no hitlPause →
 *  the SDK denies and the judge continues; there is no human in the grading loop). */
export function graderGateFor(catalog: McpToolCatalog): HitlGate {
  const inCatalog = new Set(catalog.tools.map((t) => t.name));
  return async ({ toolName }) => {
    if (DANGEROUS_GRADER_TOOLS.has(toolName)) {
      return { allow: false, reason: `grader: tool '${toolName}' is not permitted` };
    }
    if (toolName === 'web_search' || toolName === 'web_fetch' || inCatalog.has(toolName)) {
      return { allow: true };
    }
    return { allow: false, reason: `grader is read-only; tool '${toolName}' is not in the grader catalog` };
  };
}

/** A connector binding the grader may read from (subset of the agent's own
 *  integrations). Empty = sandbox-only grading (Phase 1). */
export type GraderIntegration = { id: string; type?: string; selectedObjects?: string[]; config?: Record<string, unknown> };

/** Build the sandbox-scoped tool catalog for one grade. traceId = invocationId =
 *  gradeId and NO threadId, so every sandbox tool call shares one /workspace
 *  (session keyed by threadId ?? traceId in the sandbox handler). When
 *  `integrations` is non-empty, the agent's connectors are added but filtered to
 *  READ actions only (allowedActionTypes:['read']) so the judge can fetch a
 *  connector-hosted deliverable (Drive doc / Sheet) without any write path. */
export async function buildGraderCatalog(
  run: ReconstructedRun,
  provider: ResolvedProvider,
  gradeId: string,
  integrations: GraderIntegration[] = [],
): Promise<McpToolCatalog> {
  const { createToolGatewayMcpServer } = await import('../../../tool-gateway/mcp-server');
  const { getToolGatewayDispatcher } = await import('../../../tool-gateway/dispatcher');
  const allowedConnectors = integrations
    .flatMap((i) => (i.type ? [i.type, i.id] : [i.id]))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  const gatewayResult = await createToolGatewayMcpServer({
    tenantId: run.ref.tenantId,
    agentId: run.ref.agentId,
    instructionVersion: GRADER_INSTRUCTION_VERSION,
    traceId: gradeId,
    allowedConnectors,
    toolGateway: getToolGatewayDispatcher(),
    integrations,
    externalAgents: [],
    sandboxCapabilities: ['file', 'shell'],
    // Read actions only — a connector-hosted deliverable is fetched, never mutated.
    allowedActionTypes: integrations.length > 0 ? ['read'] : [],
    // Passed through verbatim — the gateway input accepts every
    // ResolvedProvider. It only picks code_session's default sub-provider, and
    // the grader denies code_session anyway.
    resolvedProvider: provider,
    // traceId (below, = gradeId) keys the per-judge /workspace; invocationId must be
    // the REAL graded invocation so the sandbox tool call's awaited audit_logs +
    // sandbox_usage_log inserts (both FK'd to invocations, keyed on session.invocationId
    // via tool-gateway service.ts payload.invocationId) don't violate the FK. gradeId is
    // synthetic and would fail every sandbox call.
    invocationId: run.ref.key,
    hitlLevel: 3,
  });

  const servers: McpToolCatalog['servers'] = [
    { kind: 'in-process', id: 'liftoff-tool-gateway', config: gatewayResult.mcpServer },
  ];
  const tools: McpToolCatalog['tools'] = (gatewayResult.modelTools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    // Same source as the execution catalog (service.ts buildToolGatewayAndCatalog):
    // the shapes the gateway registered. The judge runs on whichever provider it
    // is pointed at, so it needs the arguments for the same reason a graded run
    // does.
    inputSchema: gatewayResult.toolInputSchemas?.[t.name] ?? { type: 'object', properties: {} },
    serverId: 'liftoff-tool-gateway',
    categories: (t as { categories?: string[] }).categories,
    draftVariant: (t as { draftVariant?: string }).draftVariant,
  }));

  return { servers, tools };
}

/** Seed the judge's sandbox /workspace with the session's captured deliverable
 *  artifacts so the judge inspects/executes the REAL files, not just serialized
 *  text. Runs against the SAME sandbox session (sessionId=gradeId) the judge's
 *  tools use, so it must be called before the judge's invoke(). Text files land
 *  at /workspace/<name>; binary files land at /workspace/<name>.b64 (base64) for
 *  the judge to `base64 -d` when it needs the raw bytes. Best-effort: a failed
 *  seed just leaves the judge to rely on the in-prompt text. */
export async function seedSandboxArtifacts(
  run: ReconstructedRun,
  gradeId: string,
  artifactUris: string[],
): Promise<void> {
  if (artifactUris.length === 0) return;
  const { getToolGatewayDispatcher } = await import('../../../tool-gateway/dispatcher');
  const dispatcher = getToolGatewayDispatcher();
  const storage = new Storage();
  for (const uri of artifactUris) {
    const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (!m) continue;
    const name = (uri.split('/').pop() ?? 'artifact').replace(/[^\w.-]/g, '_');
    try {
      const [meta] = await storage.bucket(m[1]).file(m[2]).getMetadata();
      if (Number(meta.size ?? 0) > SEED_MAX_FILE_BYTES) continue;
      const [buf] = await storage.bucket(m[1]).file(m[2]).download();
      const binary = !isUtf8(buf);
      const path = binary ? `/workspace/${name}.b64` : `/workspace/${name}`;
      const content = binary ? buf.toString('base64') : buf.toString('utf8');
      await dispatcher.execute({
        tenantId: run.ref.tenantId,
        agentId: run.ref.agentId,
        // instructionVersion + idempotencyKey are REQUIRED by ExecuteInput /
        // validateIdentity (the old `as never` cast hid their absence → 500s).
        instructionVersion: GRADER_INSTRUCTION_VERSION,
        traceId: gradeId,
        invocationId: run.ref.key,
        idempotencyKey: `${gradeId}-seed-${name}`,
        connector: 'execution_environment',
        entityType: 'sandbox',
        actionType: 'file_write',
        // `workspaceSessionId = gradeId` keeps the seed in the SAME per-judge
        // /workspace the judge reads, while `payload.invocationId = run.ref.key`
        // (the REAL graded invocation) makes the sandbox call's awaited
        // audit_logs + sandbox_usage_log FK inserts succeed.
        workspaceSessionId: gradeId,
        payload: { path, content, invocationId: run.ref.key },
        estimatedCredits: 1,
        _internalSkipHitl: true,
      });
    } catch (err) {
      logger.warn({ uri, err: (err as Error).message }, 'agentic grader: artifact seed failed (non-fatal)');
    }
  }
}
