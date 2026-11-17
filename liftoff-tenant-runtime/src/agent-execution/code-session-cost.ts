// Nested code_session spend for an agent invocation.
//
// A code_session hands a bounded coding task to a vendor-native coding agent
// (Claude Code / Codex / Gemini CLI) running in its own subprocess against the
// vendor API directly. That spend is real, it is often the largest single cost
// in a run, and until this existed it reached NOTHING: not the invocation's
// cost, not the published invocation.completed event, not the Operating Unit
// buckets. The outer engine's token stream cannot see it — the nested agent is
// a separate process making its own API calls.
//
// Derived from the completed tool calls the completion path already holds, the
// same way computeGroundingCost derives per-call web-search cost from the
// steps. Deliberately NOT an accumulator keyed by invocation id: a run that
// never reaches a terminal state would leak one forever, and there is no need
// for shared state when the answer is already sitting in the run's own results.
//
// Kept in a leaf module (no imports beyond types) so it is cheaply unit-testable
// AND shared verbatim between the two invocation-completion sites in service.ts
// (success + error-salvage) — they must agree, or a run that errored after a
// coding session would bill a different amount than one that did not.

/** The model id recorded when a vendor reports tokens but names no model.
 *
 *  ONE definition, used both for the `llm_usage_log` row and for the
 *  unpriced-token metric's `model` label, so a spend you find in the metric can
 *  be found in the table by the same name. Per-provider because "Codex told us
 *  nothing" and "the Gemini CLI told us nothing" are different gaps that get
 *  closed by different work. */
export function unknownModelSentinel(provider: string): string {
  return `${provider}-code-session-unknown-model`;
}

/** Tokens spent under one vendor that nothing here could price. */
export interface UnpricedTokens {
  input: number;
  output: number;
}

/** What a nested coding session cost, split by whether it could be priced.
 *
 *  `costUsd` is spend we have a real figure for — either the vendor's own
 *  (the Claude Agent SDK reports one per model) or the platform rate table's,
 *  applied when the vendor at least named the model.
 *
 *  `unpricedByProvider` is what is left: tokens really spent under a vendor that
 *  named no model at all, so no rate can be looked up. Keyed by the NESTED
 *  vendor rather than the outer agent's, because `prefer_provider` lets a
 *  session run on a different vendor entirely and attributing that spend to the
 *  outer one would point the investigation at the wrong place. Reported
 *  separately rather than folded in at a guessed rate: the caller counts these
 *  through the same unpriced-token meter every other pricing site uses, so the
 *  gap is measurable instead of invisible. */
export interface CodeSessionCost {
  costUsd: number;
  unpricedByProvider: Record<string, UnpricedTokens>;
}

/** Shape this reads off a completed tool call. Structural on purpose — the
 *  completion path stores tool calls loosely typed, and this module must not
 *  drag the adapter's types into the pricing path to read three numbers. */
interface CompletedToolCall {
  name?: string;
  output?: unknown;
}

interface CodeSessionToolOutput {
  provider_used?: unknown;
  exit_reason?: unknown;
  cost_usd?: unknown;
  unpriced_tokens?: { input?: unknown; output?: unknown };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Is this completed call a code_session?
 *
 * Name FIRST, output shape as the fallback — and the fallback is the part that
 * matters. On the Claude Agent SDK path the adapter's
 * tool_call_started→finished correlation does not match a callId, so completed
 * calls land with `name: 'unknown'`; the real name is recovered later from the
 * trajectory recorder, and only when the recorder is active. Keying purely on
 * the name would therefore price coding sessions on some engines and silently
 * skip them on the SDK path entirely — the exact shape of bug this change
 * exists to remove.
 *
 * `provider_used` + `exit_reason` together are unique to a CodeSessionOutput,
 * so the shape check cannot pick up another tool's result.
 */
function isCodeSessionCall(name: string | undefined, output: CodeSessionToolOutput | null): boolean {
  // The name arrives MCP-qualified — `mcp__liftoff-tool-gateway__code_session`,
  // not the bare tool name.
  if (name === 'code_session' || name?.endsWith('__code_session')) return true;
  return Boolean(output && output.provider_used !== undefined && output.exit_reason !== undefined);
}

/**
 * Sum what every code_session in this run spent.
 *
 * Tolerates the tool output arriving as an object OR as the JSON string the
 * MCP layer serialises it to, because which one lands here depends on the
 * dispatch path and a pricing function that silently returns zero for the
 * wrong one is exactly the failure this whole change is about.
 */
export function computeCodeSessionCost(
  toolCalls: ReadonlyArray<CompletedToolCall> | undefined,
): CodeSessionCost {
  const total: CodeSessionCost = { costUsd: 0, unpricedByProvider: {} };
  if (!toolCalls || toolCalls.length === 0) return total;

  for (const call of toolCalls) {
    const output = parseOutput(call?.output);
    if (!isCodeSessionCall(call?.name, output) || !output) continue;

    total.costUsd += num(output.cost_usd);

    const input = num(output.unpriced_tokens?.input);
    const outputTokens = num(output.unpriced_tokens?.output);
    if (input === 0 && outputTokens === 0) continue;

    // The vendor that actually ran the session. Falls back to 'unknown' rather
    // than to the outer agent's provider: a session whose output did not say
    // which vendor ran it must not be filed under one that may not have.
    const provider = typeof output.provider_used === 'string' ? output.provider_used : 'unknown';
    const bucket = total.unpricedByProvider[provider] ?? { input: 0, output: 0 };
    bucket.input += input;
    bucket.output += outputTokens;
    total.unpricedByProvider[provider] = bucket;
  }

  return total;
}

/**
 * Get to the CodeSessionOutput through however many wrappers the engine put
 * around it.
 *
 * This is the part that decides whether any of this works. On the Claude Agent
 * SDK path the completed call's `result` is `JSON.stringify(tool_use_result)`, and
 * `tool_use_result` for an MCP tool is the MCP envelope
 * `{content: [{type: 'text', text: '<the real JSON>'}]}`. So the payload
 * arrives as a string wrapping an envelope wrapping a string wrapping the
 * object. Reading only the outermost layer finds no `cost_usd`, contributes
 * zero, and reports success — nested spend would stay invisible exactly as it
 * is today, with tests passing.
 *
 * Handles all four layerings (raw object, JSON string, envelope, envelope in a
 * string) rather than assuming one, because which arrives depends on the engine
 * and this must not quietly become a no-op on any of them.
 */
function parseOutput(output: unknown): CodeSessionToolOutput | null {
  const value = typeof output === 'string' ? tryParse(output) : output;
  if (!value || typeof value !== 'object') return null;

  const direct = value as CodeSessionToolOutput;
  if (direct.provider_used !== undefined || direct.cost_usd !== undefined) return direct;

  // MCP content blocks arrive in TWO shapes and the difference is the whole
  // ballgame. The Claude Agent SDK path stores a
  // JSON string of the BARE block array — `[{"type":"text","text":"<json>"}]` —
  // not the wrapped `{content:[...]}` the SDK's own docs describe. Handling
  // only the wrapped form found nothing, contributed zero, and logged nothing,
  // so a session's nested cost would be billed at the outer figure alone
  // while every unit test passed. Both forms, therefore.
  const blocks = Array.isArray(value)
    ? (value as unknown[])
    : Array.isArray((value as { content?: unknown }).content)
      ? ((value as { content: unknown[] }).content)
      : null;

  if (blocks) {
    for (const block of blocks as Array<{ type?: string; text?: unknown }>) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const inner = tryParse(block.text);
      if (inner && typeof inner === 'object') return inner as CodeSessionToolOutput;
    }
  }

  // A bare array that carried no readable block is not a code_session output.
  return Array.isArray(value) ? null : direct;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
