// Trajectory & efficiency metrics (DETERMINISTIC).
//
// The plan names DeepEval's metric primitives (ToolCorrectnessMetric,
// StepEfficiencyMetric, TaskCompletionMetric). DeepEval is a PYTHON framework
// and cannot run inside this TypeScript service, so the DETERMINISTIC metrics
// (ToolCorrectness vs the designed toolset, StepEfficiency, loop/cost/latency,
// per-step attribution) are implemented natively here with the same semantics.
// TaskCompletion is inherently semantic and lives in the LLM-judge (judge/goal.ts).
// See the audit notes: "DeepEval is Python — native TS equivalents" is a
// deliberate, documented deviation from the literal tool named in the plan.

import type { ReconstructedRun, Stage } from '../reconstruct/trace-model';
import { collectToolUses, collectToolResults, toolCallSignature } from './trajectory-util';
import { loadDesignedToolset } from '../toolset';

export interface StepAttribution {
  order: number;
  name: string;
  inDesignedSet: boolean;
  errored: boolean;
  redundant: boolean;
  stage: Stage;
}

export interface TrajectoryMetrics {
  /** Fraction of tool calls in the designed set AND not errored — the
   *  DeepEval ToolCorrectness analogue scored against the designed toolset.
   *  null when the designed set is unresolved OR only a lossy reconstruction is
   *  available (raw-table runs) — scoring against an incomplete set is
   *  misleading, so it is not reported. */
  toolCorrectness: number | null;
  /** Fraction of non-redundant steps (1 = no repeats). */
  stepEfficiency: number;
  toolCallCount: number;
  redundantCallCount: number;
  loopDetected: boolean;
  costUsd: number | null;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  perStep: StepAttribution[];
}

const STAGE_FOR_FAMILY: Array<[RegExp, Stage]> = [
  [/^(memory_retrieve|corpus_search|org__get_existing_structure|connectors__list_available|agent_templates__|get_)/, 'tool-selection'],
  [/^(delegate_to_agent)/, 'delegation'],
  [/^(workforce_plan__|teambuilder__|provisioning__|memory_save)/, 'tool-execution'],
];

function stageForTool(name: string): Stage {
  for (const [re, stage] of STAGE_FOR_FAMILY) if (re.test(name)) return stage;
  return 'tool-execution';
}

export function computeMetrics(run: ReconstructedRun, reconstructedCatalog?: string[]): TrajectoryMetrics {
  const uses = collectToolUses(run.trajectory);
  const results = collectToolResults(run.trajectory);
  const designed = loadDesignedToolset(run, reconstructedCatalog);

  const sigCount = new Map<string, number>();
  for (const u of uses) {
    const sig = toolCallSignature(u.name, u.input);
    sigCount.set(sig, (sigCount.get(sig) ?? 0) + 1);
  }

  let inSetCorrect = 0;
  let redundant = 0;
  const seenSig = new Set<string>();
  const perStep: StepAttribution[] = [];
  for (const u of uses) {
    const r = results.get(u.id);
    const errored = r?.isError === true;
    // Strip only a genuine MCP prefix (mcp__server__name); leave designed names
    // like workforce_plan__draft intact.
    const bare = u.name.startsWith('mcp__') ? u.name.slice(u.name.lastIndexOf('__') + 2) : u.name;
    // Membership only counts against a RELIABLE designed set (captured toolset /
    // hardcoded system catalog). Against a lossy reconstructed set (raw-table
    // runs) we can't tell in-set from missing-from-reconstruction, so treat as
    // in-set (don't penalise) — toolCorrectness is nulled below in that case.
    const inSet = designed.tools && designed.reliable ? designed.tools.has(u.name) || designed.tools.has(bare) : true;
    const sig = toolCallSignature(u.name, u.input);
    const isRedundant = seenSig.has(sig);
    if (isRedundant) redundant++;
    seenSig.add(sig);
    if (inSet && !errored) inSetCorrect++;
    perStep.push({ order: u.order, name: u.name, inDesignedSet: inSet, errored, redundant: isRedundant, stage: stageForTool(u.name) });
  }

  const total = uses.length;
  const loopDetected = [...sigCount.values()].some((c) => c >= 3);
  const inv = run.raw.invocation;
  const latencyMs =
    inv?.completedAt && inv?.startedAt ? new Date(inv.completedAt).getTime() - new Date(inv.startedAt).getTime() : null;

  return {
    // null when the designed set is unresolved OR only a lossy reconstruction is
    // available — a tool-correctness score against an incomplete set is
    // misleading (it scores legitimately-available tools as wrong).
    toolCorrectness: designed.tools && designed.reliable ? (total === 0 ? 1 : inSetCorrect / total) : null,
    stepEfficiency: total === 0 ? 1 : (total - redundant) / total,
    toolCallCount: total,
    redundantCallCount: redundant,
    loopDetected,
    costUsd: inv?.costUsd ?? null,
    latencyMs,
    inputTokens: inv?.inputTokens ?? run.raw.loopMeta?.cumulativeInputTokens ?? 0,
    outputTokens: inv?.outputTokens ?? run.raw.loopMeta?.cumulativeOutputTokens ?? 0,
    perStep,
  };
}
