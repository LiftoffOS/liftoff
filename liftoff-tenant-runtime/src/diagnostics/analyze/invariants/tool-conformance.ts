// Tool-conformance invariants — ALL FOUR agents, judged vs the DESIGNED
// toolset. Scenario-INDEPENDENT (unlike the shipped per-scenario assertions):
//   - every tool_call name ∈ the agent's designed set (no hallucinated/out-of-set)
//   - role-allowed (CAIO / Insights matrices)
//   - oversight-allowed (no raw outbound when communication='draft')
//   - designed-sequence respected (HRBP distill→create→record/update;
//     CAIO draft→commit→approve)
//   - expected outputs present (Insights visualization blocks)
//
// Violations → out-of-set / role-violation / oversight-violation / sequence-break
// / missing-expected-tool Findings. Deterministic — part of the dev-gating signal.

import type { Finding, ReconstructedRun } from '../../reconstruct/trace-model';
import { collectToolUses } from '../trajectory-util';
import { loadDesignedToolset } from '../../toolset';

export interface ConformanceContext {
  /** Caller role for the role-gate matrices (CAIO/Insights). Unknown → skip. */
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  /** Oversight communication mode. 'draft' → outbound must use draft variant. */
  communication?: 'auto' | 'review' | 'draft';
  /** Reconstructed available catalog for user-created agents (see toolset loader). */
  reconstructedCatalog?: string[];
}

/** Outbound tools that, under communication='draft', must be replaced by their
 *  draft variant. A raw call to one of these is an oversight violation. */
const OUTBOUND_TOOLS = new Set([
  'gmail_send_email',
  'outlook_send_email',
  'slack_post_message',
  'slack_send_message',
  'twilio_send_sms',
]);
const DRAFT_VARIANT = /(_draft$|^create_draft|__draft$)/;

/** Strip ONLY a genuine MCP server prefix (`mcp__<server>__send` → `send`).
 *  Designed names that merely contain `__` (e.g. `workforce_plan__draft`) are
 *  returned unchanged — they ARE the canonical names in their runtimes. */
function bare(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  return name.slice(name.lastIndexOf('__') + 2);
}

/** Membership tolerant of MCP prefixing on either side. */
function inSet(set: Set<string>, name: string): boolean {
  return set.has(name) || set.has(bare(name));
}

/** Runtime/provider-injected meta-tools that are NOT in any agent's DESIGNED
 *  toolset but are legitimately available at execution time, so they must not
 *  trip the out-of-set check. `ToolSearch` is the OpenAI deferred-tool-search
 *  meta-tool (surfaced from `tool_search_call_item`); the runtime injects it for
 *  large catalogs regardless of the agent's design. Matched case-insensitively
 *  and tolerant of MCP prefixing. */
const INJECTED_META_TOOLS = new Set(['toolsearch', 'tool_search']);

/** Native tools the EXECUTION ADAPTER injects at runtime, independent of the
 *  agent's designed catalog — so a call to one is NOT a design
 *  violation. These come from the Claude Agent SDK `claude_code` preset, which
 *  the Anthropic adapter (src/agent-execution/adapter/anthropic/index.ts) and
 *  the code_session anthropic runner (runners/anthropic.ts: Bash/Read/Write/
 *  Edit/Glob/Grep/Task) wire onto every Anthropic-path agent ALONGSIDE our MCP
 *  catalog, plus the platform's own harness primitive (RemoteTrigger). The LLM
 *  API only lets a model call tools it was actually given, so a call to one of
 *  these means the runtime supplied it; the only reason it isn't in the captured
 *  `tools` array is that the array records our MCP catalog, not the SDK preset.
 *  Names are the SDK's exact CapitalCase identifiers; our liftoff catalog is
 *  snake_case / `mcp__`-prefixed, so there is no collision. Mirrors ToolSearch. */
const RUNTIME_INJECTED_TOOLS = new Set([
  // Claude Agent SDK `claude_code` preset (the agentic coding toolset).
  'Bash', 'BashOutput', 'KillShell', 'KillBash',
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Glob', 'Grep',
  'Task', 'TodoWrite',
  'WebFetch', 'WebSearch',
  'ExitPlanMode',
  // Platform harness primitive.
  'RemoteTrigger',
]);

/** True when the tool is a runtime/adapter-injected primitive (meta-tool or SDK
 *  preset), not part of any agent's designed liftoff catalog — so calling it is
 *  never an out-of-set design violation. Tolerant of MCP prefixing on either. */
function isRuntimeInjectedTool(name: string): boolean {
  if (INJECTED_META_TOOLS.has(name.toLowerCase()) || INJECTED_META_TOOLS.has(bare(name).toLowerCase())) return true;
  return RUNTIME_INJECTED_TOOLS.has(name) || RUNTIME_INJECTED_TOOLS.has(bare(name));
}

/** True when the tool belongs to a bound vendor-hosted MCP server — a call to
 *  `mcp__<serverId>__<tool>` where `serverId` is one of the trajectory's bound
 *  vendor MCP servers (trajectory_meta.vendor_mcp_servers; GitHub/Stripe/custom
 *  MCP). The adapter registers these as remote servers and introspects their
 *  tools at connect time, so they are reachable by the model but never
 *  enumerated in the captured `tools` array. The LLM API only permits calling a
 *  tool the runtime supplied, so a bound-server call is in-set, not a violation. */
function isBoundVendorMcpTool(name: string, boundServers: readonly string[]): boolean {
  if (boundServers.length === 0 || !name.startsWith('mcp__')) return false;
  return boundServers.some((id) => name.startsWith(`mcp__${id}__`));
}

export function auditToolConformance(run: ReconstructedRun, ctx: ConformanceContext = {}): Finding[] {
  const findings: Finding[] = [];
  const designed = loadDesignedToolset(run, ctx.reconstructedCatalog);
  const uses = collectToolUses(run.trajectory);
  const boundVendorServers = run.trajectory.trajectory_meta.vendor_mcp_servers ?? [];

  // 1. Out-of-set / hallucinated tool. Only a gating violation against a
  //    RELIABLE designed set (captured trajectory toolset / hardcoded system
  //    catalog). Against a LOSSY reconstructed set (raw-table runs with no
  //    captured trajectory) the check yields only false positives — the LLM API
  //    already guarantees a model can't call a tool it wasn't given, and the
  //    reconstruction misses dynamically-surfaced tools (deferred/ToolSearch,
  //    vendor-hosted MCP, adapter presets) — so it is downgraded to a single
  //    logged coverage gap (no silent drop), not per-call errors.
  if (designed.tools && designed.reliable) {
    for (const u of uses) {
      if (isRuntimeInjectedTool(u.name)) continue; // adapter/runtime-injected primitive, not a design violation
      if (isBoundVendorMcpTool(u.name, boundVendorServers)) continue; // tool of a bound vendor MCP server — reachable via the remote server, in-set
      if (!inSet(designed.tools, u.name)) {
        findings.push({
          invariant: 'conformance.out_of_set',
          severity: 'error',
          component: 'tool-selection',
          message: `tool ${u.name} is not in ${run.ref.agentKind}'s designed toolset`,
          evidence: { name: u.name, designedSize: designed.tools.size },
          failureMode: 'MAST.out_of_set_tool',
        });
      }
    }
  } else if (designed.tools && !designed.reliable) {
    // Lossy reconstructed set — report unmatched calls as a coverage gap, not
    // violations. (Injected primitives + bound vendor MCP are still excluded.)
    const unmatched = uses.filter(
      (u) => !isRuntimeInjectedTool(u.name) && !isBoundVendorMcpTool(u.name, boundVendorServers) && !inSet(designed.tools!, u.name),
    );
    if (unmatched.length > 0) {
      findings.push({
        invariant: 'conformance.designed_set_unreliable',
        severity: 'info',
        component: 'tool-selection',
        message: `out-of-set check skipped — only a lossy reconstructed toolset is available (no captured trajectory); ${unmatched.length} call(s) not in the reconstruction, not flagged as violations`,
        evidence: { agentKind: run.ref.agentKind, unmatchedCount: unmatched.length, sample: unmatched.slice(0, 8).map((u) => u.name) },
      });
    }
  } else {
    // User-created without a reconstructed catalog — coverage gap, not a pass.
    findings.push({
      invariant: 'conformance.designed_set_unresolved',
      severity: 'info',
      component: 'tool-selection',
      message: 'designed toolset could not be resolved (user-created catalog not reconstructed) — out-of-set check skipped',
      evidence: { agentKind: run.ref.agentKind },
    });
  }

  // 2. Role-allowed (CAIO / Insights matrices).
  if (designed.isRoleAllowed && ctx.role) {
    for (const u of uses) {
      if (designed.tools && inSet(designed.tools, u.name) && !designed.isRoleAllowed(bare(u.name), ctx.role) && !designed.isRoleAllowed(u.name, ctx.role)) {
        findings.push({
          invariant: 'conformance.role_violation',
          severity: 'error',
          component: 'tool-selection',
          message: `tool ${u.name} called but role '${ctx.role}' is not permitted to call it`,
          evidence: { name: u.name, role: ctx.role },
          failureMode: 'MAST.role_violation',
        });
      }
    }
  }

  // 3. Oversight-allowed — raw outbound under draft mode.
  if (ctx.communication === 'draft') {
    for (const u of uses) {
      if (OUTBOUND_TOOLS.has(u.name) && !DRAFT_VARIANT.test(u.name)) {
        findings.push({
          invariant: 'conformance.oversight_violation',
          severity: 'critical',
          component: 'oversight-gate',
          message: `outbound tool ${u.name} called raw under communication='draft' — must use the draft variant`,
          evidence: { name: u.name },
          failureMode: 'MAST.oversight_bypass',
        });
      }
    }
  }

  // 4. Designed-sequence respected.
  if (designed.designedSequence) {
    findings.push(...checkSequence(run, uses, designed.designedSequence));
  }

  // 5. Expected outputs present (Insights visualization blocks).
  if (designed.expectedOutputs === 'visualization_blocks') {
    const vizCount = run.raw.visualizationBlockCount ?? 0;
    // Only require viz when the agent actually produced a substantive answer
    // (it called at least one data tool).
    if (uses.length > 0 && vizCount === 0) {
      findings.push({
        invariant: 'conformance.missing_expected_output',
        severity: 'warn',
        component: 'output',
        message: 'insights agent fetched data but rendered no visualization blocks',
        evidence: { toolCalls: uses.length, visualizationBlocks: vizCount },
        failureMode: 'TRAIL.missing_output_format',
      });
    }
  }

  return findings;
}

/** firstOrder per stage; consecutive stages with finite first-order must be
 *  non-decreasing. A later stage preceding an earlier one is a sequence break.
 *  Also flags a missing prerequisite when a later stage fired but an earlier
 *  mandatory stage never did. */
function checkSequence(
  run: ReconstructedRun,
  uses: Array<{ name: string; order: number }>,
  stages: string[][],
): Finding[] {
  const findings: Finding[] = [];
  const firstOrder = stages.map((stage) => {
    let best = Infinity;
    for (const u of uses) if (stage.includes(u.name)) best = Math.min(best, u.order);
    return best;
  });

  for (let i = 1; i < stages.length; i++) {
    const prev = firstOrder[i - 1];
    const cur = firstOrder[i];
    if (cur === Infinity) continue; // stage i not used — nothing to order.
    if (prev === Infinity) {
      // A later stage fired but its prerequisite stage never did. For HRBP/CAIO
      // the earlier stages are genuine prerequisites (create needs distill;
      // commit needs draft).
      findings.push({
        invariant: 'conformance.sequence_missing_prerequisite',
        severity: 'error',
        component: 'planning',
        message: `stage ${i} tool fired but no stage ${i - 1} tool (${stages[i - 1].join('/')}) ran first`,
        evidence: { stageIndex: i, missingStage: stages[i - 1], agentKind: run.ref.agentKind },
        failureMode: 'MAST.sequence_break',
      });
    } else if (cur < prev) {
      findings.push({
        invariant: 'conformance.sequence_break',
        severity: 'error',
        component: 'planning',
        message: `stage ${i} tool ran before stage ${i - 1} tool — designed sequence violated`,
        evidence: { stageIndex: i, prevFirstOrder: prev, curFirstOrder: cur, agentKind: run.ref.agentKind },
        failureMode: 'MAST.sequence_break',
      });
    }
  }
  return findings;
}
