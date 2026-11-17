// How big are tool results on the path that actually runs, and what happens to
// the big ones?
//
// Neither question is answerable today, and the reason is worth stating because
// it is not a gap anybody left carelessly.
//
// `tool-result-bound.ts` measures exactly this and measures it well. It records
// `tool_result_size_observed` on every result it bounds, deliberately, so the
// 50,000-character budget could be recalibrated from live data rather than from
// a one-off query nobody can re-run. But it is wired into `mcp-bridge`, and
// mcp-bridge is on the OpenAI / OpenRouter / Gemini loops only — the Anthropic
// path bypasses it by construction, because the Claude Agent SDK manages its own
// context.
//
// So the measurement exists, it is correct, and on the Anthropic path it
// observes nothing. Anything believed about tool-result sizes on that path is
// inference from a distribution measured on a different one.
//
// This closes that. It wraps every tool the gateway exposes — connector,
// standard, vendor, delegation, all of them — so it happens once, above the
// engine, and therefore on every engine.
//
// It BOUNDS as well as observes. Moving only the measurement here left the
// enforcement where it always was: `boundToolResult` is imported by exactly one
// caller, mcp-bridge, which serves the OpenAI / Gemini / Grok / OpenRouter
// loops. The Anthropic path measured its results and then passed every one of
// them through whole.
//
// One research turn can accumulate hundreds of thousands of characters of web
// results across dozens of tool calls, including single fetches over the
// 50,000 budget (`exceeded: true, parked: false`), then spend dozens of
// reasoning steps re-reading that context and die on the wall clock having
// produced nothing the person asked for. A budget that is observed and not
// applied is not a budget.
//
// It also records `parked`, which the older event does not, and that is the
// field the next decision needs. An oversized result is either written somewhere
// the agent can still query, or it is cut and the remainder is gone. Those are
// opposite outcomes, and the completeness field on the result is what tells them
// apart — read here rather than inferred from the result's own prose.
//
// AND IT PARKS. Bounding an oversized result keeps the window safe and throws
// the remainder away: the part past the cut is often exactly the part the run
// needed, and the agent has no way to ask for it back because the bytes are
// gone. Parking is the same protection without the loss — the records go to
// platform-backend as a dataset of THIS run, the model gets a view of them, and
// `dataset_query` / `dataset_extract` / `dataset_list` (which every gateway run
// already has) read back only what is asked for.
//
// The fallbacks are ordered by how much they keep: park, else spill to the
// sandbox when the run has one, else truncate as before. Each is a strictly
// weaker copy of the same promise, and the weakest of them is today's
// behaviour — so nothing here can make an oversized result worse than it was.

import { scrubLogger } from '../observability/scrub-logger';
import { readCompleteness } from './result-completeness';
import { parkToolResultViaBackend } from '../clients/platform-backend-client';
import {
  boundToolResult,
  maxChars,
  noteTurnUsage,
  spillToolText,
  toolResultBoundEnabled,
  turnBudgetChars,
} from '../agent-execution/adapter/tool-result-bound';

/** Structural shape of an SDK tool definition — name plus a handler returning
 *  content blocks. Declared here rather than imported so this module does not
 *  pull the SDK into its own graph for a wrapper that only reads a length. */
interface ObservableTool {
  name: string;
  handler: (args: never, extra: never) => Promise<{ content?: unknown[] } | unknown>;
}

/** Largest text block on a result, and whether the whole result is reachable.
 *
 *  `parked` is READ from the completeness field both parking mechanisms now set,
 *  not recovered by searching the text for a directory name. The old scan was a
 *  guess at a fact the producer held and discarded into prose: it could report
 *  false for a result parked perfectly well (any change to the note's wording),
 *  and true for a result that merely mentioned the path. A measurement derived
 *  from a substring search is not a measurement.
 *
 *  Unmeasured reads as NOT parked, which is the safe direction: it says the
 *  remainder may be gone rather than asserting a recoverable copy exists. */
function measure(result: unknown): { chars: number; parked: boolean } {
  const content = (result as { content?: unknown[] } | null)?.content;
  const completeness = readCompleteness(result);
  const parked = completeness?.complete === false && completeness.full !== undefined;
  if (!Array.isArray(content)) return { chars: 0, parked };

  let chars = 0;
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    if (b.text.length > chars) chars = b.text.length;
  }
  return { chars, parked };
}

/** Whether any text block on a result is past the bound. Cheap, and the guard
 *  that keeps an ordinary tool call from making a network request. */
function hasOversizedText(content: unknown[], limit: number): boolean {
  return content.some((c) => {
    const b = c as { type?: string; text?: string };
    return b?.type === 'text' && typeof b.text === 'string' && b.text.length > limit;
  });
}

/** The size past which a result is worth a decision rather than a note. Read
 *  from the same variable the existing bound uses, so the two cannot drift into
 *  disagreeing about what "oversized" means — this observes the threshold, it
 *  does not own it. */
function budget(): number {
  const raw = Number(process.env.TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 50_000;
}

/**
 * Wrap each tool so its result size is recorded on the way past.
 *
 * Fail-open in the strong sense: the wrapper never inspects arguments, never
 * alters the result, and swallows any error from its own measurement. A tool
 * that throws still throws, with its own error, before this records anything —
 * observing a failure's size would be measuring the error string.
 */
/** `_meta` key marking a result this wrapper has already spilled/bounded and
 *  counted against the turn budget.
 *
 *  mcp-bridge dispatches its in-process tools through `client.callTool`, which
 *  reaches these very handlers — so without a marker its own bound would run a
 *  second time and, worse, `noteTurnUsage` would count the same characters
 *  twice, tripping the aggregate budget at half its configured size on exactly
 *  the engines this change is not meant to alter. Rides in `_meta`, which
 *  round-trips the MCP protocol, rather than on a symbol that serialization
 *  would drop. */
export const BOUNDED_META_KEY = 'liftoff/bounded';

export interface BoundOptions {
  /** Keys the aggregate per-turn budget. Absent disables the aggregate half;
   *  the per-result bound still applies. */
  invocationId?: string;
  /** The run's sandbox writer, when it has one. Present means an oversized
   *  result is SPILLED (preview + path, nothing lost) instead of truncated.
   *  Absent — a connector-only agent with no filesystem — falls back to the
   *  bound, which is the same fallback mcp-bridge makes. */
  writeFile?: ((path: string, content: string) => Promise<boolean>) | null;
  /** The workspace whose datasets an oversized result is parked under. Absent
   *  disables parking and leaves the spill-or-truncate path exactly as it was:
   *  a caller with no tenant has nowhere to park to. */
  tenantId?: string;
  /** The job the dataset belongs to, and what `dataset_list` lists: the
   *  conversation when there is one (it accumulates across turns), else the
   *  run. Absent disables parking for the same reason. */
  datasetScopeId?: string;
}

/** True when this wrapper already handled the result. */
export function wasBounded(result: unknown): boolean {
  const meta = (result as { _meta?: Record<string, unknown> } | null)?._meta;
  return Boolean(meta && meta[BOUNDED_META_KEY]);
}

function markBounded<T>(result: T): T {
  const r = result as { _meta?: Record<string, unknown> };
  if (!r || typeof r !== 'object') return result;
  r._meta = { ...(r._meta ?? {}), [BOUNDED_META_KEY]: true };
  return result;
}

/**
 * Spill, bound, and count one result against the turn budget.
 *
 * Fail-open in every direction: any throw leaves the result exactly as the tool
 * produced it. Bounding is a protection against a large result, not a reason to
 * fail a call that succeeded.
 */
async function spillAndBound(
  result: unknown,
  toolName: string,
  opts: BoundOptions,
): Promise<unknown> {
  const r = result as { content?: unknown[]; isError?: boolean };
  // An error envelope is small and must reach the model verbatim — the same
  // carve-out boundToolResult makes.
  if (!r || r.isError || !Array.isArray(r.content)) return result;

  const limit = maxChars();
  // What the model will read, as each fallback in turn hands it on. The park
  // route answers with a NEW envelope rather than mutating this one, so the
  // steps below work on this rather than on `result`.
  let current: unknown = result;

  // PARK FIRST. It is the only one of the three that keeps the whole result
  // AND leaves the agent able to ask for any of it — from another instance,
  // after the sandbox is gone. Attempted only when there is something
  // oversized to park, so an ordinary tool call makes no request.
  let parked = false;
  if (opts.tenantId && opts.datasetScopeId && hasOversizedText(r.content, limit)) {
    const out = await parkToolResultViaBackend(
      opts.tenantId,
      result,
      { scopeId: opts.datasetScopeId },
      { label: `${toolName} result`, source: 'agent_tool', sourceRef: toolName },
    );
    if (out.ok === true) {
      parked = true;
      current = out.result;
      scrubLogger.info({
        event: 'tool_result_parked',
        metric: 'tool_result.parked',
        toolName,
        invocationId: opts.invocationId,
        datasets: out.parked.length,
        records: out.parked.reduce((n, d) => n + d.recordCount, 0),
      });
    } else {
      scrubLogger.info({
        event: 'tool_result_park_failed',
        metric: 'tool_result.park_failed',
        toolName,
        invocationId: opts.invocationId,
        reason: out.reason,
      });
    }
  }

  // Then spill, for what parking did not take: no tenant, no job, or a park
  // that failed. Identical context cost to truncating, nothing lost.
  const spillable = (current as { content?: unknown[] }).content;
  if (!parked && opts.writeFile && Array.isArray(spillable)) {
    const write = opts.writeFile;
    const target = { writeFile: async (path: string, content: string) => { await write(path, content); } };
    for (let i = 0; i < spillable.length; i++) {
      const block = spillable[i] as { type?: string; text?: string };
      if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= limit) continue;
      const spilled = await spillToolText(
        block.text,
        target,
        `${opts.invocationId ?? 'no-invocation'}-${toolName}-${i}`,
      );
      if (spilled) spillable[i] = { ...block, text: spilled.text };
    }
  }

  // Anything still oversized (parked but with a long view, no filesystem, or a
  // failed write) is truncated with a marker telling the model to paginate.
  const bounded = boundToolResult(current) as { content?: Array<{ text?: string }> };

  // Aggregate budget. One result under the per-result cap can still be one of
  // sixty: a run can breach the per-result cap only once and still put
  // hundreds of thousands of characters into the window. A
  // parked result counts too — a dataset view is small, but sixty of them are
  // a window.
  if (opts.invocationId && Array.isArray(bounded?.content)) {
    const size = bounded.content.reduce(
      (n, c) => n + (typeof c?.text === 'string' ? c.text.length : 0), 0,
    );
    const used = noteTurnUsage(opts.invocationId, size);
    if (used > turnBudgetChars()) {
      scrubLogger.info({
        event: 'tool_result_turn_budget_exceeded',
        metric: 'tool_result.turn_budget_exceeded',
        invocationId: opts.invocationId,
        used,
        budget: turnBudgetChars(),
        toolName,
      });
      return markBounded(boundToolResult(bounded, Math.max(1_000, Math.floor(limit / 4))));
    }
  }
  return markBounded(bounded);
}

/**
 * Record the size of a DIRECT MCP result — a vendor-hosted server (GitHub,
 * Notion, Stripe) or a workspace's own custom MCP server.
 *
 * Those bypass this module's wrapper by construction: the SDK dispatches them
 * over its own transport, so they never reach an in-process handler, and the
 * gateway's park-spill-bound path cannot see them. They are NOT parked here,
 * and that is a decision rather than an oversight — the envelope is the
 * vendor's, the classification of what is safe to replace is per-server work,
 * and nothing yet measures how big those results actually are.
 *
 * So this MEASURES ONLY. The same event and the same fields the gateway path
 * emits, distinguishable by `direct: true`, so the follow-up decision is taken
 * from a live distribution rather than from an analogy with a different path.
 *
 * Never throws: a measurement must never be able to fail a tool call.
 */
export function observeDirectMcpResultSize(
  toolName: string,
  result: unknown,
  invocationId: string | undefined,
): void {
  try {
    const { chars } = measure(result);
    if (chars === 0) return;
    const max = budget();
    scrubLogger.info({
      event: 'tool_result_size_observed',
      metric: 'tool_result.chars',
      chars,
      budget: max,
      exceeded: chars > max,
      // Nothing here parks: the field is stated rather than omitted so a query
      // over this event does not have to treat "absent" as "unknown".
      parked: false,
      direct: true,
      toolName,
      invocationId,
    });
  } catch {
    // A measurement must never be able to fail a tool call.
  }
}

export function observeAndBoundToolResults<T extends ObservableTool>(
  tools: T[],
  opts: BoundOptions = {},
): T[] {
  return tools.map((t) => ({
    ...t,
    handler: async (args: never, extra: never) => {
      let result = await t.handler(args, extra);
      try {
        const { chars, parked } = measure(result);
        // Zero-length and empty results are the common case and say nothing
        // about the distribution's shape; recording them would be one log line
        // per tool call across the fleet to learn that most results are small.
        if (chars > 0) {
          const max = budget();
          scrubLogger.info({
            event: 'tool_result_size_observed',
            metric: 'tool_result.chars',
            chars,
            budget: max,
            exceeded: chars > max,
            // The field the older event does not carry, and the one the next
            // decision turns on: over budget AND not parked means the agent
            // lost the remainder.
            parked,
            toolName: t.name,
          });
        }
      } catch {
        // A measurement must never be able to fail a tool call.
      }
      try {
        if (toolResultBoundEnabled()) {
          result = await spillAndBound(result, t.name, opts);
        }
      } catch {
        // Nor may a bound. A result that survived the tool is returned whole
        // rather than lost to the protection meant to make it manageable.
      }
      return result;
    },
  }));
}
