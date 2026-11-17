// Deterministic, zero-LLM bound on tool results returned to the OpenAI /
// OpenRouter / Gemini agent loops.
//
// WHY only these engines: they route every tool call through mcp-bridge's
// dispatchFunctionCall (this is where the bound is wired), and — unlike the
// Anthropic path, whose Claude Agent SDK manages its own context/compaction —
// Liftoff owns their loops and there is nothing shrinking an oversized tool
// result before it enters the model context. A single large connector/vendor
// result can therefore blow the window. Anthropic bypasses mcp-bridge entirely,
// so it is untouched by this module by construction.
//
// This is NOT compression: no model call, no timeout, no failure mode. It is a
// shape-preserving structural bound (reusing truncateForPrompt), with a marker
// telling the agent it was truncated so it can paginate/refine — the same
// cap-and-signal pattern the file-Read tool already uses.

import { truncateForPrompt } from '../engine/truncate-for-prompt';
import { sealFrames, truncateWithinFrames } from '../../workspace/frame-balance';
import { scrubLogger } from '../../observability/scrub-logger';

// ON BY DEFAULT.
//
// Without the bound, an unbounded tool result goes into a model's context, and
// a protection that only exists where somebody remembered to set a variable is
// a protection that is missing wherever it was forgotten — a new environment,
// a script, a local run, a worker deployed from a different template.
//
// So the default is the protection and the variable is the OPT-OUT. Anything
// other than an explicit '0' or 'false' leaves it on, including an unset
// variable.
export function toolResultBoundEnabled(): boolean {
  const raw = process.env.TOOL_RESULT_BOUND_ENABLED;
  return raw !== '0' && raw?.toLowerCase() !== 'false';
}

// Per-result character budget, calibrated against the size distribution of
// real tool results, where ordinary results run from hundreds to a few
// thousand characters. At 50,000 the bound touches only the sub-1% pathological
// tail and every ordinary result passes through untouched.
//
// The deploy sets TOOL_RESULT_MAX_CHARS explicitly to this same number rather
// than relying on the default, because "unset" and "deliberately 50,000" are
// indistinguishable from the outside — and a limit nobody can see is an easy
// one to lose months to. Tunable without a redeploy.
//
// `tool_result_size_observed` (below) records the distribution continuously,
// so the next revision of this number reads a live denominator
// instead of a measurement that ages silently.
const DEFAULT_MAX_CHARS = 50_000;
export function maxChars(): number {
  const raw = Number(process.env.TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CHARS;
}

// UntrustedContentFramer delimiters (see workspace/untrusted-content-wrapper.ts).
// When a result is framed, we bound the INNER body and keep the BEGIN/END
// delimiters intact — truncating them would break the untrusted-data boundary.
//
// ANCHORED, and deliberately so: these two find the frame that IS the whole
// text block, which is the case where the header and footer can be lifted off
// and the body bounded between them. A frame framed IN PLACE sits inside a
// serialised result and matches neither — that case is handled by cutting
// frame-aware (workspace/frame-balance) rather than by lifting anything off,
// and it is why every cut below goes through that module.
const BEGIN_RE = /^<UNTRUSTED_[0-9a-fA-F]{32,64}_BEGIN>[\s\S]*?\n\n/;
const END_RE = /\n\n<UNTRUSTED_[0-9a-fA-F]{32,64}_END>\s*$/;

const TRUNCATE_HINT = ' — narrow your query or paginate to fetch the rest]';

// Reduce a bare string to `budget` chars: structure-aware for JSON (keeps ids /
// keys across items, drops bulk via truncateForPrompt), plain slice otherwise.
function reduce(text: string, budget: number): string {
  if (text.length <= budget) return text;
  try {
    return truncateForPrompt(JSON.parse(text), budget);
  } catch {
    return truncateWithinFrames(
      text,
      budget,
      (dropped) => `\n…[truncated: ${dropped} more chars${TRUNCATE_HINT}`,
    );
  }
}

/** Bound one text block to `max` chars, preserving untrusted-frame delimiters. */
export function boundToolText(text: string, max: number = maxChars()): string {
  if (text.length <= max) return text;
  const begin = text.match(BEGIN_RE);
  const end = text.match(END_RE);
  if (begin && end) {
    const header = begin[0];
    const footer = end[0];
    const inner = text.slice(header.length, text.length - footer.length);
    const innerBudget = Math.max(0, max - header.length - footer.length);
    return header + reduce(inner, innerBudget) + footer;
  }
  // Sealed rather than trusted. Every cut `reduce` makes is frame-aware, so
  // this adds nothing today; it is what keeps the invariant true of whatever
  // the next reducer does, at the last point before the model reads the text.
  return sealFrames(reduce(text, max));
}

/** Bound the text blocks of a CallToolResult in place. Never touches an error
 *  result — a TOOL_ERROR envelope is small and must reach the model verbatim. */
export function boundToolResult(result: unknown, max: number = maxChars()): unknown {
  const r = result as { content?: Array<{ type?: string; text?: string } | unknown>; isError?: boolean };
  if (!r || r.isError || !Array.isArray(r.content)) return result;
  // Keeps the calibration alive. The threshold was measured once, from a query
  // that cannot be re-run because nothing stores tool-result sizes; this makes
  // the distribution a standing observation instead, so a shift in what
  // connectors return shows up as data rather than as a context overflow.
  recordObservedSize(r.content, max);
  r.content = r.content.map((c) => {
    const block = c as { type?: string; text?: string };
    return block && block.type === 'text' && typeof block.text === 'string' && block.text.length > max
      ? { ...block, text: boundToolText(block.text, max) }
      : c;
  });
  return result;
}

// ── Spill (B3) ──────────────────────────────────────────────────────────
//
// Truncation loses information. When a tool returns 200k characters, the part
// past the cap is often exactly the part the agent needed — and the agent has
// no way to ask for it back, because the bytes are gone.
//
// Where the agent has a filesystem, the full result is written there instead
// and the model gets a preview plus the path. Nothing is lost: the agent reads
// the rest on demand, and the context stays bounded either way.
//
// Only `execution_enabled` agents have a sandbox. A connector-only agent has no
// filesystem at all, so for those the existing truncation stands — the correct
// fallback, and no behaviour change from today.

/** Where spilled results live inside the sandbox. */
export const SPILL_DIR = '/tmp/results';

/** How much of the result stays inline. Enough to see the shape and decide
 *  whether to read the file, without re-creating the problem being solved. */
const PREVIEW_CHARS = 2_000;

/** Aggregate budget for ONE turn's tool results. A single result under the
 *  per-result cap can still be one of twenty, and twenty mid-sized results
 *  overflow a window just as effectively as one huge one. */
const DEFAULT_TURN_BUDGET_CHARS = 200_000;
export function turnBudgetChars(): number {
  const raw = Number(process.env.TOOL_RESULT_TURN_BUDGET_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TURN_BUDGET_CHARS;
}

export interface SpillTarget {
  /** Resolves to the sandbox this invocation owns, or null when it has none. */
  writeFile: (path: string, content: string) => Promise<void>;
}

/** Running total for ONE TURN, so the aggregate budget survives across the many
 *  dispatch calls a single turn makes.
 *
 *  Keyed by invocation id because that is what every dispatch seam carries; the
 *  key is not the lifetime. A step's turn clears it when that turn ends
 *  (`invokeStepLLM`'s finally), and the invocation-end callers clear it again so
 *  the map cannot grow for the life of the process.
 *
 *  This comment used to say "cleared by the adapter at turn end" while the only
 *  callers were both at INVOCATION end, so a 21-step run shared one allowance
 *  across all of it and every result after the trip came back quarter-sized for
 *  the rest of the run. The budget is a context budget; a turn is what has a
 *  context. */
const turnUsage = new Map<string, number>();

export function noteTurnUsage(invocationId: string, chars: number): number {
  const next = (turnUsage.get(invocationId) ?? 0) + chars;
  turnUsage.set(invocationId, next);
  return next;
}

export function resetTurnUsage(invocationId: string): void {
  turnUsage.delete(invocationId);
}

export function turnUsageFor(invocationId: string): number {
  return turnUsage.get(invocationId) ?? 0;
}

/**
 * Spill one oversized text block to the agent's filesystem, returning the
 * replacement text (preview + path + how to read it).
 *
 * Returns null when the spill could not happen, so the caller falls back to
 * bounding. Never throws: a failed spill must degrade to truncation, not fail
 * the tool call.
 */
export interface SpilledText {
  /** Replacement text: preview, the path, and how to read the rest. */
  text: string;
  /** Where the whole block is. Present whenever the spill succeeded, which is
   *  the only case this function returns non-null at all. */
  path: string;
  /** Characters in the complete block, before any of it was replaced. */
  bytes: number;
}

export async function spillToolText(
  text: string,
  target: SpillTarget,
  toolCallId: string,
): Promise<SpilledText | null> {
  const path = `${SPILL_DIR}/${toolCallId.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`;
  try {
    await target.writeFile(path, text);
  } catch {
    return null;
  }

  // The frame delimiters, when present, must survive: the preview is still
  // untrusted content and must stay inside the boundary that says so.
  const begin = text.match(BEGIN_RE);
  const end = text.match(END_RE);
  const header = begin?.[0] ?? '';
  const footer = end?.[0] ?? '';
  const inner = header || footer
    ? text.slice(header.length, text.length - footer.length)
    : text;

  // `header`/`footer` are empty when the frame is not the whole block — it is
  // framed in place, inside a serialised result — and then the preview is a cut
  // straight through the body. Frame-aware, for the same reason every other cut
  // here is: a preview that opens a frame and never closes it hands the model an
  // untrusted region with no end.
  const previewed = truncateWithinFrames(
    inner,
    PREVIEW_CHARS,
    (dropped) => `\n…[${dropped} more characters written to ${path}. `
      + `Read that file to see the rest — nothing was lost.]`,
  );

  return { text: sealFrames(header + previewed + footer), path, bytes: text.length };
}

/** Emit the largest text-block size seen on a result so the budget can be set
 *  from real distributions instead of a default nobody measured. One line per
 *  bounded tool call; cheap, and the only way to calibrate honestly. */
function recordObservedSize(content: unknown[], max: number): void {
  let largest = 0;
  for (const c of content) {
    const block = c as { type?: string; text?: string };
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > largest) {
      largest = block.text.length;
    }
  }
  if (largest === 0) return;
  scrubLogger.info({
    event: 'tool_result_size_observed',
    metric: 'tool_result.chars',
    chars: largest,
    budget: max,
    exceeded: largest > max,
  });
}
