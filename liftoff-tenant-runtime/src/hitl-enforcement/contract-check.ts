// Does a write, outbound or destructive call do what the agent was built and
// approved to do? The contract is the distiller's output the runtime already
// holds on the agent record: the approved graph's step when one dispatched
// the call, the instructions and role otherwise. Nothing here reads the
// operator's responsibilities text; that is upstream of the artifact and a
// distillation that dropped part of it is a distill-time defect.
//
// Applied at ONE decision point: `checkHitlGate` routes every allow after its
// hard invariants through `allow()`, and this is the only place the check
// runs. It runs when the batch has at least one call whose effect is write,
// outbound or destructive, the result is an allow, the caller supplied a
// contract and the kill is on. One `ask` of the `contract_check` set with one
// `relation_<i>` head per eligible call; the batch gates if any one call is a
// confident `outside`, and the gated call is named in `detail`.
//
// Add-only, fail-secure. Only `outside` at or above OUTSIDE_T changes the
// decision, and in one direction: the call is gated with `contract_deviation`.
// `within`, `unclear`, a sub-threshold `outside` and `null` from the client
// leave the decision exactly as it was. The verdict never clears a gate.

import { log } from '../infrastructure/logging';
import { ask } from '../typesafe/client';
import {
  asEntry,
  contractCheckSet,
  CONTRACT_ARGS_MAX_CHARS,
  CONTRACT_INSTRUCTIONS_MAX_CHARS,
  CONTRACT_RECENT_TOOLS,
  CONTRACT_ROLE_MAX_CHARS,
} from '../typesafe/questions';
import { isContractCheckEnabled } from '../typesafe/flags';
import { redactSecrets, redactString } from '../security/log-redactor';
import { toolIsReadOnly } from '../tool-gateway/tool-effect';
import { isInProcessBookkeepingTool, isOwnWorkspaceChatTool, isPlatformOwnTool, isSelfWakeTool, resolveGateTool } from './tool-name-resolution';
import type { GateResult, ModelTool, ToolCallRequest } from './types';
import type { TriggerTarget } from './in-place-reply';

/** The contract a call is judged against. Supplied by the caller, because
 *  the gate itself holds no instruction text. */
export type HitlContract =
  | {
      kind: 'step';
      stepId: string;
      description: string;
      toolName: string;
      /** The step's toolInputTemplate, when authored. */
      template?: string;
    }
  | {
      kind: 'instructions';
      instructions: string;
      role: string;
    };

export interface ContractCheckContext {
  toolCalls: ToolCallRequest[];
  tools: ModelTool[];
  tenantId: string;
  /** The RUNTIME agent id; translated by the client before the usage post. */
  agentId?: string;
  invocationId?: string;
  contract?: HitlContract;
  triggerTarget?: TriggerTarget;
  /** The last tool names this run dispatched, most recent last. */
  recentToolNames?: string[];
}

/** The whole call's budget: a gate decision waits at most this long. */
export const CONTRACT_CHECK_DEADLINE_MS = 30_000;

/** Longest single argument value kept before eliding. */
const ARG_VALUE_MAX_CHARS = 500;

export interface ContractCheckRecord {
  kind: HitlContract['kind'];
  stepId?: string;
  p: number;
}

/** A write, outbound or destructive call: not a read, and not the agent's own
 *  bookkeeping or wake. An unresolved tool has no known effect and enters. */
export function isEligibleCall(call: ToolCallRequest, tools: ModelTool[]): boolean {
  // A call that changes nothing outside this platform is not a candidate:
  // the contract governs what the team does to the world it was hired into,
  // and it never names how the team remembers, asks, waits or hands over.
  if (isInProcessBookkeepingTool(call.name)) return false;
  if (isSelfWakeTool(call.name)) return false;
  if (isOwnWorkspaceChatTool(call.name)) return false;
  if (isPlatformOwnTool(call.name)) return false;
  const tool = resolveGateTool(call, tools);
  return !toolIsReadOnly(tool as { effect?: 'read' | 'write' | 'spawn'; categories?: string[] } | undefined);
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Arguments sanitised with the runtime's redactor (sensitive key names and
 *  `redactString`'s value patterns), long values elided, the whole bounded.
 *  Page and tool content in here is untrusted data. */
export function boundedArguments(input: unknown): string {
  const elided = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      return v.length > ARG_VALUE_MAX_CHARS ? `${v.slice(0, ARG_VALUE_MAX_CHARS)}… [${v.length - ARG_VALUE_MAX_CHARS} more]` : v;
    }
    if (Array.isArray(v)) return depth > 4 ? '[…]' : v.slice(0, 20).map((x) => elided(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 4) return '{…}';
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) out[k] = elided(x, depth + 1);
      return out;
    }
    return v;
  };
  let text: string;
  try {
    text = JSON.stringify(elided(redactSecrets(input ?? {}), 0));
  } catch {
    text = '{}';
  }
  return cut(text, CONTRACT_ARGS_MAX_CHARS);
}

/** The trigger, by identity only: never the payload. */
function triggerOf(t: TriggerTarget | undefined): { source: string; entity?: Record<string, string> } | null {
  if (!t) return null;
  const entity: Record<string, string> = {};
  const idOf = (v: unknown): string | undefined =>
    typeof v === 'string' || typeof v === 'number' ? cut(redactString(String(v)), 200) : undefined;
  const repository = idOf(t.repository) ?? idOf(t.repositoryId);
  const number = idOf(t.number);
  const thread = idOf(t.threadId) ?? idOf(t.thread_id) ?? idOf(t.id);
  if (repository) entity.repository = repository;
  if (number) entity.number = number;
  if (thread) entity.thread = thread;
  return { source: t.source ?? 'unknown', ...(Object.keys(entity).length ? { entity } : {}) };
}

/** The contract within its bounds. */
export function boundedContract(c: HitlContract): HitlContract {
  if (c.kind === 'step') {
    return {
      kind: 'step',
      stepId: c.stepId,
      description: cut(c.description, CONTRACT_INSTRUCTIONS_MAX_CHARS),
      toolName: c.toolName,
      ...(c.template !== undefined ? { template: cut(c.template, CONTRACT_ARGS_MAX_CHARS) } : {}),
    };
  }
  return {
    kind: 'instructions',
    instructions: cut(c.instructions, CONTRACT_INSTRUCTIONS_MAX_CHARS),
    role: cut(c.role, CONTRACT_ROLE_MAX_CHARS),
  };
}

/** The sections of a markdown document whose heading names the role or its
 *  responsibilities, headings included; empty when it has none. */
function roleSectionsOf(md: string): { sections: string[]; sawHeading: boolean } {
  const sections: string[] = [];
  let keep = false;
  let sawHeading = false;
  for (const line of md.split('\n')) {
    const heading = /^#{1,3}\s+(.*)$/.exec(line.trim());
    if (heading) {
      sawHeading = true;
      keep = /\b(role|responsibilit|identity|who you are)/i.test(heading[1]);
      if (keep) sections.push(line);
      continue;
    }
    if (keep) sections.push(line);
  }
  return { sections, sawHeading };
}

/** The `role` half of an instructions contract, from the two documents the
 *  distiller writes onto the agent record.
 *
 *  `instructionsMd` carries the distiller's fixed heading `## Role` (one
 *  paragraph on who the agent is running as); that section is taken whole.
 *  The system prompt has no fixed headings: its role and responsibilities
 *  sections are taken when it carries them under headings, else the identity
 *  text that opens it, up to its first heading, else the whole prompt. Both
 *  halves are joined, the fixed heading first, and bounded by the caller
 *  through `boundedContract`. */
export function roleOf(systemPrompt: string, instructionsMd?: string | null): string {
  const parts: string[] = [];
  const md = roleSectionsOf(instructionsMd ?? '');
  if (md.sections.length > 0) parts.push(md.sections.join('\n').trim());
  const prompt = roleSectionsOf(systemPrompt);
  if (prompt.sections.length > 0) {
    parts.push(prompt.sections.join('\n').trim());
  } else if (!prompt.sawHeading) {
    parts.push(systemPrompt.trim());
  } else {
    const lines = systemPrompt.split('\n');
    const first = lines.findIndex((l) => /^#{1,3}\s+/.test(l.trim()));
    parts.push(lines.slice(0, first).join('\n').trim());
  }
  return parts.filter((p) => p.length > 0).join('\n\n');
}

/** The instructions contract from the agent record the run holds: the user
 *  instructions, and the role from the system prompt and instructionsMd.
 *  Undefined when the record carries none of the three, which reads as no
 *  contract. */
export function instructionsContractOf(
  instruction: { systemPrompt?: string | null; userInstructions?: string | null; instructionsMd?: string | null } | undefined,
): HitlContract | undefined {
  const systemPrompt = instruction?.systemPrompt ?? '';
  const userInstructions = instruction?.userInstructions ?? '';
  const instructionsMd = instruction?.instructionsMd ?? '';
  if (!systemPrompt.trim() && !userInstructions.trim() && !instructionsMd.trim()) return undefined;
  return { kind: 'instructions', instructions: userInstructions, role: roleOf(systemPrompt, instructionsMd) };
}

/** The step contract from the declared step the workflow path already builds. */
export function stepContractOf(step: { stepId: string; toolName: string; description?: string; template?: string }): HitlContract {
  return {
    kind: 'step',
    stepId: step.stepId,
    description: step.description ?? '',
    toolName: step.toolName,
    ...(step.template ? { template: step.template } : {}),
  };
}

/** Once per invocation: a caller that passed no contract gets today's gate,
 *  unchecked, and the missing wiring is visible in the log. */
const noContractLogged = new Set<string>();
const NO_CONTRACT_LOG_CAP = 10_000;
function logNoContractOnce(ctx: ContractCheckContext): void {
  const key = ctx.invocationId ?? `${ctx.tenantId}:${ctx.agentId ?? ''}`;
  if (noContractLogged.has(key)) return;
  if (noContractLogged.size >= NO_CONTRACT_LOG_CAP) noContractLogged.clear();
  noContractLogged.add(key);
  log.warn(
    {
      event: 'contract_check.no_contract',
      metric: 'hitl.contract_check.no_contract',
      tenant_id: ctx.tenantId,
      agent_id: ctx.agentId,
      invocation_id: ctx.invocationId,
      tool_names: ctx.toolCalls.map((c) => c.name),
    },
    'contract check: the caller supplied no contract, so this allow is unchecked',
  );
}
export function _resetNoContractLogForTesting(): void {
  noContractLogged.clear();
}

/**
 * The one place the contract check runs. Returns the result it was given in
 * every case but one: an allow, on a batch with an eligible call, under a
 * contract, with the kill on, where the vendor answers a confident `outside`
 * for at least one call.
 */
export async function allow(result: GateResult, ctx: ContractCheckContext): Promise<GateResult> {
  if (result.shouldGate) return result;
  if (!isContractCheckEnabled()) return result;
  const eligible = ctx.toolCalls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => isEligibleCall(call, ctx.tools));
  if (eligible.length === 0) return result;
  if (!ctx.contract) {
    logNoContractOnce(ctx);
    return result;
  }

  const set = contractCheckSet(eligible.length);
  const state = asEntry({
    contract: boundedContract(ctx.contract),
    trigger: triggerOf(ctx.triggerTarget),
    calls: eligible.map(({ call }, i) => ({
      call: i,
      tool: call.name,
      arguments: boundedArguments(call.input),
    })),
    recent: (ctx.recentToolNames ?? []).slice(-CONTRACT_RECENT_TOOLS),
  });
  const answer = await ask(set, state, {
    deadlineMs: CONTRACT_CHECK_DEADLINE_MS,
    tenantId: ctx.tenantId,
    ...(ctx.agentId ? { runtimeAgentId: ctx.agentId } : {}),
    ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
  });
  if (!answer) return result;

  const threshold = set.thresholds.OUTSIDE_T as number;
  let gated: { call: ToolCallRequest; p: number } | null = null;
  for (let i = 0; i < eligible.length; i++) {
    const head = answer.answers[`relation_${i}`] as { choice?: string; probabilities?: Record<string, number> } | undefined;
    const p = head?.probabilities?.outside ?? 0;
    if (head?.choice === 'outside' && p >= threshold && (!gated || p > gated.p)) {
      gated = { call: eligible[i].call, p };
    }
  }
  if (!gated) return result;

  const record: ContractCheckRecord = {
    kind: ctx.contract.kind,
    ...(ctx.contract.kind === 'step' ? { stepId: ctx.contract.stepId } : {}),
    p: gated.p,
  };
  const which = ctx.contract.kind === 'step' ? `step ${ctx.contract.stepId}` : 'instructions';
  log.info(
    {
      event: 'hitl_gate_contract_deviation',
      metric: 'hitl.gate.contract_deviation',
      tenant_id: ctx.tenantId,
      agent_id: ctx.agentId,
      invocation_id: ctx.invocationId,
      tool_name: gated.call.name,
      contract: which,
      probability: gated.p,
      call_id: answer.callId,
    },
    'contract check: a call is outside what the agent was built and approved to do; gated for a person',
  );
  return {
    shouldGate: true,
    reason: 'contract_deviation',
    detail: `${gated.call.name} is outside the ${which} (p=${gated.p.toFixed(2)})`,
    context: { contract_check: record },
  };
}
