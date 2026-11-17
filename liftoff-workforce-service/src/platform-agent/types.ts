// Platform-agent execution module — shared types.
//
// Both CAIO (chat) and HRBP (Cloud Tasks fan-out) execute on the same
// runPlatformAgent loop. They differ only in agentId, tool list, dispatch
// handler, audit-action label, and usagePurpose. Everything else — the
// 50-iteration max, the context-window guard, audit-row emission at started /
// per-tool / completed, terminator semantics — is identical.

import type { LLMToolDefinition } from '../llm/types.js';

export type PlatformAgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; tool: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: unknown }
  | { type: 'complete'; summary: PlatformAgentExecutionResult }
  /** `closingCallFailed`: the call that failed was the closing one, after a
   *  bound had closed the reply. The work is then unfinished (the bound
   *  closed it), and a caller that continues work may queue the
   *  continuation even though no reply was written. */
  | { type: 'error'; code: string; message: string; closingCallFailed?: boolean };

export interface PlatformAgentExecutionInput {
  /** internal_agents.id of the system agent (CAIO or HRBP). */
  agentId: string;
  /** Tenant context for audit-log writes and tool calls. */
  tenantId: string;
  /** The user message (chat) or structured task (HRBP) that kicks the loop. */
  objective: string;
  /** Images attached to that message, already fetched and base64-encoded.
   *
   *  Chat only. The HRBP runs structured tasks with nobody present to attach
   *  anything, so this is absent there and the loop behaves exactly as it did.
   *  Only ever populated when the control plane's registry says the resolved
   *  model can see one — anything it cannot see was described in words inside
   *  `objective` before this call. */
  objectiveImages?: Array<{ mimeType: string; dataBase64: string; alt?: string }>;
  /** Prior conversation turns (chat). Empty for HRBP. */
  priorMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Filtered tool list available to this agent. */
  tools: LLMToolDefinition[];
  /** Per-invocation context handed to every dispatchToolCall.
   *
   *  Nothing in here reaches the system prompt. It used to carry
   *  `renderedPlanState`, substituted into `{{PLAN_STATE}}` per turn, which made
   *  the prompt move whenever a tool rewrote the plan and cost the cache prefix
   *  on the busiest turns. Volatile state belongs on the conversation, where the
   *  caller budgets it. */
  toolContext: Record<string, unknown>;
  /** Dispatch a tool call. The result.data is serialized as the tool_result
   *  content for the next turn. */
  dispatchToolCall: (
    name: string,
    input: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data: unknown }>;
  /** Action namespace for audit-log rows, e.g. 'caio.chat_turn',
   *  'hrbp.provision_spec'. Started / per-tool / completed rows append
   *  '.started' / '.tool_called' / '.completed' to this prefix. */
  auditAction: string;
  /** Drives llm_usage_log.purpose so /insights cost bucketing is preserved.
   *  Pass 'caio_workforce_planning' for CAIO chat, 'hrbp_provision_spec'
   *  for HRBP. See "Cost attribution vs audit visibility" rule in the
   *  implementation plan. */
  usagePurpose: string;
  /** Who caused this run, in platform-backend's attribution format:
   *  `human:<accountId>`, `agent:<uuid>`, `cron`, `event:<topic>`, or
   *  `system:<subsystem>` (see triggeredBySchema in PB's
   *  agent-audit-logs/router.ts).
   *
   *  This is per-caller, not a constant: a CAIO chat turn is started by the
   *  person typing, while an HRBP provisioning run is dispatched by CAIO. The
   *  loop previously hardcoded the bare literal `'agent'`, which passes the
   *  schema but attributes every platform-agent run to nobody — and makes
   *  human-initiated CAIO turns count as AI-internal in the /insights
   *  human-vs-AI split, which keys off `triggered_by NOT LIKE 'human:%'`. */
  triggeredBy: string;
  /** Optional thread id (chat). Audit rows carry it for /activity grouping. */
  threadId?: string;
  /** What a tool result contributes to the next turn's context.
   *
   *  Absent means "the serialization, as it always was", which is how the HRBP
   *  fan-out is unaffected: it has no dataset tools, so parking its results
   *  would hand it a dataset id it cannot read — a worse outcome than a large
   *  result, because it loses the content AND offers no way back to it.
   *
   *  Supplied by CAIO chat, where the three dataset tools ARE on offer. Must
   *  resolve rather than throw: a tool call that succeeded must not fail
   *  because the thing that makes its result manageable did. */
  parkToolResult?: (toolName: string, data: unknown, serialized: string) => Promise<string>;
  /** Asked between iterations and before each tool call: has somebody stopped
   *  this run? Optional, so HRBP's fan-out is unaffected — only the CAIO chat
   *  has a person sitting in front of it to press the button.
   *
   *  Must resolve rather than throw: a failed check has to read as "nobody
   *  asked", never as a stop. */
  shouldStop?: () => Promise<boolean>;
  /** Asked at the same boundaries: did somebody type something while this run
   *  was working? Returns the message already framed for the model (sender
   *  attribution plus "this continues the current task"), or null when nothing
   *  is waiting. The loop appends it as its own user turn and answers it in
   *  THIS run rather than starting a second one on the thread.
   *
   *  Optional for the same reason as shouldStop, and must resolve rather than
   *  throw: a failed check has to read as "nothing waiting". */
  claimUserMessage?: () => Promise<string | null>;
  /** Set when the run's text is a reply a person is waiting to read. Such a
   *  reply is closed rather than abandoned: when the tool rounds are spent,
   *  the token budget is used, or `deadlineAt` (epoch ms) has passed, the loop
   *  makes one more model call with no tools, so the person gets an answer
   *  from what the run has rather than the narration that preceded its last
   *  tool call. Absent for a run whose text nobody reads (HRBP provisioning),
   *  which simply ends. */
  reply?: {
    deadlineAt?: number;
    /** Whether a further continuation may follow this turn (there is a
     *  message to continue from and the cap for it is not reached). True, or
     *  absent, asks the closing reply for the [continue]/[done] verdict;
     *  false asks instead that the reply say the person can ask it to go
     *  on, since nothing would read a verdict. */
    askVerdict?: boolean;
  };
}

export interface PlatformAgentExecutionResult {
  ok: boolean;
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
  inputTokens: number;
  outputTokens: number;
  /** Why the loop ended.
   *   - 'normal'         — assistant produced a non-tool-use final turn.
   *   - 'tool_blocker'   — HRBP's transition_to_blocker tool fired.
   *   - 'max_iterations' — hit MAX_ITERATIONS without converging (a reply
   *                        was still closed with a final, tool-less call).
   *   - 'deadline'       — the reply's deadline passed; closed the same way.
   *   - 'context_full'   — a call's prompt filled the guarded share of the
   *                        model's context window (a reply was still closed
   *                        with a final, tool-less call).
   *   - 'stopped'        — a person asked it to stop (chat only).
   *   - 'handed_over'    — the CAIO's bring_in_colleague tool fired: the rest
   *                        of the reply is a colleague's, so the loop ends
   *                        here and the caller runs the hand-over. What was
   *                        said before the call is the text.
   *   - 'output_truncated' — one response hit the per-turn output ceiling
   *                        INSIDE an unfinished tool call, so there is
   *                        nothing to prefill from and re-running the turn
   *                        would truncate it the same way. Not a bound of
   *                        this loop's (the rounds, the window, the
   *                        deadline) and not the provider's fault: the
   *                        ceiling is ours, and the turn ends on it with
   *                        whatever it had already said.
   *   - 'error'          — LLM call threw or other unexpected error. */
  terminator: 'normal' | 'tool_blocker' | 'max_iterations' | 'deadline' | 'context_full' | 'stopped' | 'handed_over' | 'output_truncated' | 'error';
  /** Set only when a bound closed a reply: whether the closing reply said
   *  work it was asked for is still to do (`[continue]`, or no verdict line
   *  at all) rather than finished (`[done]`). The verdict travels here, as
   *  a fact, and never in the text. */
  unfinished?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/** Thrown by HRBP's provisioning__transition_to_blocker tool. runPlatformAgent
 *  catches it as a graceful terminator (terminator='tool_blocker'). */
export class HrbpBlockerException extends Error {
  constructor(public readonly reason: string, public readonly detail?: string) {
    super(reason);
    this.name = 'HrbpBlockerException';
  }
}

/** Thrown by the CAIO's dispatch for `bring_in_colleague`. runPlatformAgent
 *  catches it as a graceful terminator (terminator='handed_over'): no
 *  synthetic tool_result, no further model call, because the colleague takes
 *  the rest of the reply and looping back would have the model summarise what
 *  the person is about to read. The dispatch that threw it holds the
 *  colleague and the request; the loop carries nothing but the ending. */
export class PlatformAgentHandoverException extends Error {
  constructor() {
    super('handed over to a colleague');
    this.name = 'PlatformAgentHandoverException';
  }
}
