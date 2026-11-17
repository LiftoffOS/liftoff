// User-created agents: reconstruct the DESIGNED/available tool catalog by
// re-running the real tool-gateway assembly (createToolGatewayMcpServer) from
// the agent's compiled instruction — the same path production uses. The
// available set is not persisted (only executed calls live in
// invocations.tool_calls), so this reconstruction is what makes the
// tool-conformance out-of-set check meaningful for user-created agents.
//
// Inputs (compiled_instructions, latest version): allowedConnectors +
// allowedActionTypes (from the instruction JSON), integrations (column),
// capability_tier, runtime_config.sandboxCapabilities, plus the tenant's
// oversight settings (drives the draft-mode tool filter). Read-only:
// constructing the MCP server resolves the catalog without executing any tool.

import { getPoolForService } from '../../infrastructure/database';
import { getToolGatewayDispatcher } from '../../tool-gateway/dispatcher';
import { createToolGatewayMcpServer } from '../../tool-gateway/mcp-server';
import { hitlEnforcementService } from '../../hitl-enforcement';
import { logger as log } from '../../infrastructure/logging';
import type { RunRef } from './trace-model';

// Per-process memo — the catalog depends only on (tenant, agent) latest
// instruction + tenant oversight, so a batch of runs for one agent reuses it.
const memo = new Map<string, Promise<string[] | null>>();

export function clearCatalogMemo(): void {
  memo.clear();
}

export async function reconstructUserDesignedCatalog(ref: RunRef): Promise<string[] | null> {
  if (ref.agentKind !== 'user-created') return null;
  const key = `${ref.tenantId}:${ref.agentId}`;
  const cached = memo.get(key);
  if (cached) return cached;
  const p = build(ref).catch((err) => {
    log.warn({ message: 'diagnostics: user catalog reconstruction failed', agentId: ref.agentId, err: (err as Error).message });
    return null;
  });
  memo.set(key, p);
  return p;
}

async function build(ref: RunRef): Promise<string[] | null> {
  const pool = getPoolForService('default');
  // to_jsonb(*) avoids hard-coding column names that may vary across migrations.
  const res = await pool.query(
    `SELECT to_jsonb(t) AS row
       FROM (SELECT * FROM compiled_instructions
              WHERE tenant_id = $1 AND agent_id = $2
              ORDER BY version DESC LIMIT 1) t`,
    [ref.tenantId, ref.agentId],
  );
  const row = (res.rows[0] as { row?: Record<string, unknown> } | undefined)?.row;
  if (!row) return null;

  const instruction = (row.instruction as Record<string, unknown>) ?? {};
  const allowedConnectors = (instruction.allowedConnectors as string[]) ?? [];
  const allowedActionTypes = (instruction.allowedActionTypes as string[]) ?? [];
  const integrations =
    (row.integrations as Array<{ id: string; type?: string; selectedObjects?: string[] }>) ??
    (instruction.integrations as Array<{ id: string; type?: string; selectedObjects?: string[] }>) ??
    [];
  const runtimeConfig = (row.runtime_config as { sandboxCapabilities?: readonly ('shell' | 'file' | 'browser' | 'vscode')[] }) ?? {};
  const sandboxCapabilities = runtimeConfig.sandboxCapabilities ?? [];

  let oversight;
  try {
    oversight = await hitlEnforcementService.getOversightSettings(ref.tenantId);
  } catch (err) {
    log.warn({ message: 'diagnostics: oversight fetch failed during catalog reconstruction', err: (err as Error).message });
  }

  const result = await createToolGatewayMcpServer({
    tenantId: ref.tenantId,
    agentId: ref.agentId,
    instructionVersion: Number(row.version ?? 1),
    traceId: `diagnostics-catalog-${ref.key}`,
    allowedConnectors,
    allowedActionTypes,
    integrations,
    sandboxCapabilities,
    oversight,
    toolGateway: getToolGatewayDispatcher(),
    invocationId: ref.key,
  });

  // Keep BOTH the full (possibly MCP-prefixed) name and the bare suffix so the
  // out-of-set check matches regardless of how the executed call was recorded.
  const names = new Set<string>();
  for (const t of result.modelTools) {
    names.add(t.name);
    // Also store the bare suffix for genuinely MCP-prefixed names so the
    // conformance check matches regardless of how the executed call was
    // recorded. Names without an `mcp__` prefix are added as-is only.
    if (t.name.startsWith('mcp__')) names.add(t.name.slice(t.name.lastIndexOf('__') + 2));
  }
  return [...names];
}
