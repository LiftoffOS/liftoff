// Sandbox parity phase gate.
// Plan §17 — per-phase env var SANDBOX_PARITY_PHASE on tenant-runtime.
// Tools whose phase > current return `phase_not_enabled` to the LLM with a
// clear error so the model can pick an alternative or report.
//
// Phase 1: skeleton — health, auth, /v1/auth/tickets
// Phase 2: shell + file + bash + util + sandbox-meta
// Phase 3: browser core + state + network + tabs + cookies + captcha
// Phase 4: vscode + nodejs + code router
// Phase 5: mcp + events + proxy
// Phase 6: cost calibration + rollout flags (no new tools)

export type SandboxParityPhase = 1 | 2 | 3 | 4 | 5 | 6;

export function currentParityPhase(): SandboxParityPhase {
  const raw = parseInt(process.env.SANDBOX_PARITY_PHASE ?? '6', 10);
  if (Number.isNaN(raw) || raw < 1) return 1;
  if (raw > 6) return 6;
  return raw as SandboxParityPhase;
}

const TOOL_PHASE: Record<string, SandboxParityPhase> = {};

const phase2Prefixes = ['shell_', 'file_', 'bash_', 'util_', 'sandbox_'];
const phase3Prefixes = ['browser_'];
const phase4Prefixes = ['nodejs_', 'code_', 'vscode_'];
const phase5Prefixes = ['mcp_', 'proxy_'];

export function phaseForTool(toolName: string): SandboxParityPhase {
  const cached = TOOL_PHASE[toolName];
  if (cached) return cached;
  let phase: SandboxParityPhase = 1;
  if (phase2Prefixes.some(p => toolName.startsWith(p))) phase = 2;
  if (phase3Prefixes.some(p => toolName.startsWith(p))) phase = 3;
  if (phase4Prefixes.some(p => toolName.startsWith(p))) phase = 4;
  if (phase5Prefixes.some(p => toolName.startsWith(p))) phase = 5;
  TOOL_PHASE[toolName] = phase;
  return phase;
}

export function isToolEnabledForCurrentPhase(toolName: string): boolean {
  return phaseForTool(toolName) <= currentParityPhase();
}

/**
 * Per-tenant override: a comma-separated list of tenantIds that always get the
 * latest phase regardless of SANDBOX_PARITY_PHASE. Used during staged rollout.
 */
export function isTenantAllowed(tenantId: string): boolean {
  const list = (process.env.SANDBOX_PARITY_ALLOWED_TENANTS ?? '').trim();
  if (list.length === 0) return true; // empty = everyone
  return list.split(',').map(s => s.trim()).includes(tenantId);
}
