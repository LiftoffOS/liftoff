// Tool failures the MODEL caused, and which only the model can fix.
//
// A tool call rejected for malformed arguments never ran. Nothing was
// attempted, no external system was touched, and no fact about the world
// changed. The only thing wrong is the call itself, and the only party who can
// correct it is the caller.
//
// The runtime already had a fast-trip for this shape, but it was gated on
// `parseToolErrorEnvelope`, which requires the platform's own `TOOL_ERROR `
// marker. Errors raised by an MCP server or a vendor SDK carry no marker, so
// the trip never fired for them: they fell through to the recovery LLM, which
// is free to decide `whoCanUnblock: 'customer'`.
//
// For example: asked to summarise what shipped across the user's repos, an
// agent calls `search` with no `query`, gets back
// `MCP error -32602: Input validation error: Invalid arguments for tool
// search`, and stops to ask the person "What would you like to search for?".
// The person had not asked for a search. They had asked for a summary. They
// are being asked to supply an argument for a call they did not make, to a
// tool they did not choose, and the run is gated on their answer.
//
// So this classifier exists to keep a class of failure away from the human
// entirely. It is deliberately narrow: it matches only the phrasings that mean
// "this call was rejected BEFORE execution because it did not match the
// schema", never a tool that ran and returned an unhappy result.

/** What was wrong, and the detail worth handing back to the model. */
export interface ModelAuthoredToolError {
  /** Always 'invalid_arguments' today. Named so the union can grow without
   *  callers re-reading the shape. */
  kind: 'invalid_arguments';
  /** The provider's own words, trimmed. The model needs the specifics — which
   *  field, what was expected — or the correction is just a scolding. */
  detail: string;
}

/**
 * Signals that a call was rejected as malformed.
 *
 * - `-32602` is JSON-RPC "Invalid params", which is what an MCP server returns
 *   when arguments fail its input schema. It is a protocol-level code, not
 *   prose, so it cannot drift.
 * - The two phrases are the MCP SDK's and the schema layer's wording for the
 *   same rejection, kept because a server may report the text without the code.
 *
 * Deliberately NOT here: bare "invalid", "bad request", "400". Those also
 * describe a call that DID run against a remote system and was refused on its
 * merits, which is a different situation with a different remedy.
 */
const REJECTED_BEFORE_EXECUTION = [
  /-32602\b/,
  /invalid arguments for tool\b/i,
  /input validation error\b/i,
];

/**
 * Classify a tool error as the model's own to fix, or return null.
 *
 * Null means "not obviously the caller's mistake" and leaves the existing
 * recovery path untouched — this only ever removes cases from that path, it
 * never adds any.
 */
export function classifyModelAuthoredToolError(
  errorText: unknown,
): ModelAuthoredToolError | null {
  if (typeof errorText !== 'string') return null;
  const trimmed = errorText.trim();
  if (!trimmed) return null;
  if (!REJECTED_BEFORE_EXECUTION.some((re) => re.test(trimmed))) return null;
  return { kind: 'invalid_arguments', detail: trimmed };
}

/**
 * What the model is told, in place of the person being told anything.
 *
 * Three jobs, and it does badly without all three: say the call never ran (so
 * the model does not assume side effects), carry the validation detail (so the
 * correction is actionable rather than a nudge), and rule out the escape hatch
 * this whole module exists to close — asking the person for an argument the
 * model chose to need.
 */
/**
 * The human-readable detail on an anomaly, whatever its shape.
 *
 * The anomaly union carries its detail under a different key per kind —
 * `error`, `reason`, `reference`, `userMessage` — and the workflow recovery
 * path logged NONE of them: `hybrid_loop.anomaly_triggered` records the kind
 * and nothing else, and the recovery audit stores `{ kind, stepId }`. So a
 * run that recovered the wrong way left no trace of WHAT it was recovering
 * from, on either surface.
 *
 * That is not a small gap. Without it a tool failure that asks a person an
 * unanswerable question cannot be diagnosed from logs at all — the
 * conversational path logs `adapter_anomaly_observed` with the context, and
 * this path had no equivalent.
 *
 * Truncated, because an anomaly detail can carry a whole tool response.
 */
export function anomalyDetailText(anomaly: unknown, max = 500): string | undefined {
  if (!anomaly || typeof anomaly !== 'object') return undefined;
  const a = anomaly as Record<string, unknown>;
  for (const key of ['error', 'reason', 'reference', 'expected', 'userMessage', 'originalQuestion']) {
    const v = a[key];
    if (typeof v === 'string' && v.trim()) {
      return v.length > max ? `${v.slice(0, max)}…` : v;
    }
  }
  // A rejected recovery proposal carries the names it may not use rather than
  // a sentence; the names ARE the detail.
  const rejected = a.rejected;
  if (Array.isArray(rejected) && rejected.length > 0) {
    const v = `rejected: ${rejected.map((n) => String(n)).join(', ')}`;
    return v.length > max ? `${v.slice(0, max)}…` : v;
  }
  return undefined;
}

/** The code carried on a synthesized tool-error contract for this class.
 *
 *  The workflow path hands `{ code, recovery }` to the recovery advisor and
 *  reads it back when deciding whether the advisor is allowed to involve a
 *  person. Naming the code here keeps those two sites from drifting apart on a
 *  string literal. */
export const MODEL_AUTHORED_TOOL_ERROR_CODE = 'invalid_arguments';

/**
 * A tool-error contract for the workflow recovery path, or undefined.
 *
 * The conversational path intercepts this class before the advisor is asked at
 * all. The workflow path cannot: its recovery is a step-graph decision, and
 * short-circuiting it would advance the cursor past a step that never produced
 * an output. So instead the advisor is TOLD what the failure is, in the same
 * `{ code, recovery }` shape a first-class ToolExecutionError already supplies
 * — which is the difference between "some tool failed, ask the customer" and
 * "the call was malformed, here is how to fix it".
 */
export function modelAuthoredToolErrorContract(
  error: unknown,
  toolName?: string,
): { code: string; recovery: string } | undefined {
  const text = error instanceof Error ? error.message : error;
  const classified = classifyModelAuthoredToolError(text);
  if (!classified) return undefined;
  return {
    code: MODEL_AUTHORED_TOOL_ERROR_CODE,
    recovery: correctionForModelAuthoredToolError(toolName, classified),
  };
}

export function correctionForModelAuthoredToolError(
  toolName: string | undefined,
  error: ModelAuthoredToolError,
): string {
  const named = toolName && toolName.trim() ? `"${toolName.trim()}"` : 'that tool';
  return [
    `The call to ${named} was rejected before it ran because its arguments did not match the tool's schema.`,
    'Nothing was executed and nothing changed, so this is not a failure you need to report or work around.',
    'Re-read the tool\'s input schema and call it again with valid arguments, or use a different tool.',
    'Do not ask the person to supply an argument for a call you chose to make — they did not choose the tool and cannot know its schema.',
    `Validation detail: ${error.detail}`,
  ].join(' ');
}
