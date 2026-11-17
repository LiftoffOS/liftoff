// What a workflow step is told about EVERY earlier step's output, not just its
// predecessor's.
//
// The predecessor's hand-off already has the right contract: park the whole
// value where there is a workspace, compress semantically rather than
// positionally, say plainly when the rest is gone, and measure. Earlier
// outputs were serialised as one object under one per-value budget, and the
// deterministic bound's answer to any overflow is to cut every string to its
// first 200 characters — so a 4,982-character research result reached the
// step that was told to draw on it as a preamble and nothing else. This module
// gives each earlier output the predecessor's contract, and adds the one thing
// a section of many values needs that a single value does not: a ceiling on
// the whole, enforced on the text that is actually rendered.
//
// Three phases, and the order is the design:
//
//   1. plan        pure. Decide from serialised sizes which entries are shown
//                  in full and which as a one-line stub, under the ceiling.
//   2. materialise I/O, only for entries the plan selected AND that exceed the
//                  per-value budget: offload to the workspace, compress. Never
//                  for a stubbed entry — a compression is a model call.
//   3. render      pure. Produce the section and prove it fits; if a note ran
//                  longer than reserved, demote the lowest-priority full entry
//                  and render again.
//
// Identity is the step id throughout. Priority is what the step names first,
// then failed placeholders, then recency. Layout is graph order.

import { compressForPrompt } from './compress-for-prompt';
import { frameStepOutputForPrompt } from './framed-web-output';
import { offloadLargeValue, offloadLocation, type OffloadResult, type WorkspaceWriter } from './offload-large-value';
import { renderPriorOutput } from './prior-output-view';
import { salvageNoteLine, type SalvageNote } from './step-salvage-prompt';
import { serializeForPrompt } from './truncate-for-prompt';

export interface EarlierEntry {
  stepId: string;
  /** serializeForPrompt(value).length, computed once. */
  chars: number;
  /** The tool that produced it, from the graph. Undefined for a reasoning
   *  step's recorded output and for a failed placeholder. */
  producedBy?: string;
  /** producedBy is a tool whose result may only be used WHOLE. */
  mustBeWhole: boolean;
  /** The value is the `__stepFailed` placeholder for a step that did not run. */
  failed: boolean;
  /** The value was produced by a salvage turn from partial material. When set,
   *  the rendered entry — full or stub — is followed by one code-authored line
   *  naming the calls that did not return, so the step reading it treats what
   *  depended on them as unknown rather than empty. Trusted metadata: the
   *  output itself carries no marker. */
  salvaged?: SalvageNote;
}

export interface EarlierPlan {
  /** Shown through the fits / parked / gone contract, in priority order. */
  full: string[];
  /** One line each: what it is, its size, where the whole value is. */
  stub: string[];
  /** Counted only in the omission notice: their stubs alone did not fit. */
  omitted: string[];
  /** Every entry in priority order. The renderer's demotion keeps this order
   *  when it moves an entry from full to stub, so "lowest priority" means the
   *  same thing in both phases. */
  order: string[];
}

/** A materialised view of one oversized output, memoised by step id for the
 *  current loop invocation. Rebuilt after a resume: the workspace a parked
 *  value was written to ends with the segment that wrote it. */
export interface PreparedView {
  /** compressForPrompt output, at most the per-value budget. Empty for a
   *  complete-required value, which is never summarised. */
  summary: string;
  offloaded: OffloadResult | null;
  chars: number;
}

/** The id label, the JSON framing, and the longest note renderPriorOutput can
 *  attach to a full entry (the parked path line or the gone notice). The one
 *  estimate in the plan: a compressed summary's exact length is not known
 *  until it is made, and the render step turns the estimate into a bound. */
export const FRAME_RESERVE = 240;

const HEADER = 'Earlier step outputs (by step id):';

function omissionNotice(n: number): string {
  return `[${n} additional earlier outputs omitted from this prompt.]`;
}

/** The one-line form of an entry that is not shown in full. Generated, not
 *  estimated: its real length is the entry's stub cost in planning. */
export function stubFor(entry: EarlierEntry, parked: OffloadResult | null): string {
  const source = entry.producedBy ?? 'an earlier reasoning step';
  if (entry.failed) {
    return `[${entry.stepId}: this step did NOT run; its result is unknown, NOT empty]`;
  }
  if (entry.mustBeWhole) {
    if (parked) {
      return `[${entry.stepId}: ${entry.chars} characters from ${source}, a result this step may only use WHOLE, `
        + `not shown here; the complete value is ${offloadLocation(parked)}. `
        + `Read and process all of it rather than answering from memory of it]`;
    }
    return `[${entry.stepId}: ${entry.chars} characters from ${source}, a result this step may only use WHOLE; `
      + `it is too large for this prompt and was not saved anywhere. Do not answer from memory of it; `
      + `if this step depends on it, say so and stop]`;
  }
  if (parked) {
    return `[${entry.stepId}: ${entry.chars} characters from ${source}, not shown here; `
      + `the whole value is ${offloadLocation(parked)}]`;
  }
  return `[${entry.stepId}: ${entry.chars} characters from ${source}, not shown here and not saved anywhere; `
    + `if this step depends on it, say so and stop]`;
}

/** An entry's rendered text with its partial-material line under it, when the
 *  entry was salvaged. Applied to full and stub renderings alike, and counted
 *  in every cost the plan and the renderer compute, so the line can never push
 *  a section it was not budgeted for over the ceiling. */
function withSalvageNote(entry: EarlierEntry, rendered: string): string {
  return entry.salvaged ? `${rendered}\n${salvageNoteLine(entry.stepId, entry.salvaged)}` : rendered;
}

/** Priority order for promotion to full: referenced ids first, in first-mention
 *  order; then failed placeholders, most recent first; then the rest, most
 *  recent first. `entries` arrive in registry (graph) order, so later is more
 *  recent. */
function priorityOrder(entries: EarlierEntry[], referenced: string[]): string[] {
  const ids = new Set(entries.map((e) => e.stepId));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!ids.has(id) || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of referenced) push(id);
  const recent = [...entries].reverse();
  for (const e of recent) if (e.failed) push(e.stepId);
  for (const e of recent) push(e.stepId);
  return out;
}

/** The most stubs, in priority order, whose lines plus the notice for the
 *  rest fit in `room`. Returns the kept ids (priority order) and the dropped.
 *  `alreadyOmitted` is counted into the notice, whose length depends on the
 *  total it names. */
function fitStubs(
  order: string[],
  stubCost: Map<string, number>,
  room: number,
  alreadyOmitted = 0,
): { kept: string[]; dropped: string[] } {
  for (let k = order.length; k >= 0; k--) {
    let used = 0;
    for (let i = 0; i < k; i++) used += stubCost.get(order[i]) ?? 0;
    const dropped = order.length - k + alreadyOmitted;
    if (dropped > 0) used += omissionNotice(dropped).length + 1;
    if (used <= room) return { kept: order.slice(0, k), dropped: order.slice(k) };
  }
  return { kept: [], dropped: order };
}

export function planEarlierOutputs(
  entries: EarlierEntry[],
  opts: { referenced: string[]; ceiling: number; valueBudget: number },
): EarlierPlan {
  if (entries.length === 0) return { full: [], stub: [], omitted: [], order: [] };
  const byId = new Map(entries.map((e) => [e.stepId, e]));
  const order = priorityOrder(entries, opts.referenced);

  // 1. Stub first, for every entry, costed by the line it would actually get.
  const stubCost = new Map<string, number>();
  for (const e of entries) stubCost.set(e.stepId, withSalvageNote(e, stubFor(e, null)).length + 1);
  const base = HEADER.length + 1;
  const room = opts.ceiling - base;

  // 4. Stubs alone over the ceiling: the highest-priority stubs that fit, and
  //    one counted notice for the rest. Nothing is promoted.
  let totalStubs = 0;
  for (const c of stubCost.values()) totalStubs += c;
  if (totalStubs > room) {
    const { kept, dropped } = fitStubs(order, stubCost, room);
    return { full: [], stub: kept, omitted: dropped, order };
  }

  // 3. Promotion, walking the priority list. An entry is promoted while the
  //    stubs of everything else, the fulls so far, and its own full cost fit.
  const full: string[] = [];
  let fullTotal = 0;
  let stubsRemaining = totalStubs;
  for (const id of order) {
    const entry = byId.get(id)!;
    const cost = Math.min(entry.chars, opts.valueBudget) + FRAME_RESERVE
      + (entry.salvaged ? salvageNoteLine(id, entry.salvaged).length + 1 : 0);
    const own = stubCost.get(id) ?? 0;
    if (stubsRemaining - own + fullTotal + cost <= room) {
      full.push(id);
      fullTotal += cost;
      stubsRemaining -= own;
    }
  }
  const promoted = new Set(full);
  return { full, stub: order.filter((id) => !promoted.has(id)), omitted: [], order };
}

/**
 * Build (or return the memoised) materialised view of one oversized output.
 *
 * Offload first, so a parked value is never also summarised with a note
 * promising more than it has; then compress — except for a complete-required
 * value, which is never summarised: its view is the handle or nothing, and the
 * caller decides between the fail-closed error and the no-summary stub.
 */
export async function prepareView(
  entry: EarlierEntry,
  value: unknown,
  deps: {
    writer: WorkspaceWriter | null;
    attribution: { tenantId: string; agentId?: string; invocationId?: string };
    valueBudget: number;
  },
  memo: Map<string, PreparedView>,
): Promise<PreparedView> {
  const hit = memo.get(entry.stepId);
  if (hit) return hit;
  const offloaded = await offloadLargeValue(value, {
    writer: deps.writer,
    label: `step-output-${entry.stepId}`,
    budget: deps.valueBudget,
  });
  const summary = entry.mustBeWhole
    ? ''
    : await compressForPrompt(value, {
      maxChars: deps.valueBudget,
      attribution: deps.attribution,
      purpose: 'workflow_step_output_compression',
    });
  const view: PreparedView = { summary, offloaded, chars: entry.chars };
  memo.set(entry.stepId, view);
  return view;
}

function renderFull(
  entry: EarlierEntry,
  value: unknown,
  prepared: PreparedView | undefined,
  valueBudget: number,
): string | null {
  const label = entry.producedBy ? `${entry.stepId} (from ${entry.producedBy})` : entry.stepId;
  // Both branches, deliberately. A structured web result is framed wherever it
  // reaches the model, and framing only the within-budget branch would leave
  // every LARGE web result unframed — which is the case that matters.
  if (entry.chars <= valueBudget) {
    return `${label}: ${renderPriorOutput({
      summary: frameStepOutputForPrompt(serializeForPrompt(value), entry.producedBy),
      offloaded: null,
      mustBeWhole: entry.mustBeWhole,
      exceeded: false,
      producedBy: entry.producedBy,
      chars: entry.chars,
    })}`;
  }
  // Oversized: only a materialised view can render it in full. A missing view
  // is not rendered from the raw value — that would be the positional cut this
  // module exists to end — so the caller falls back to the stub.
  if (!prepared) return null;
  if (entry.mustBeWhole && !prepared.offloaded) return null;
  return `${label}: ${renderPriorOutput({
    summary: frameStepOutputForPrompt(prepared.summary, entry.producedBy),
    offloaded: prepared.offloaded,
    mustBeWhole: entry.mustBeWhole,
    exceeded: true,
    producedBy: entry.producedBy,
    chars: entry.chars,
  })}`;
}

/**
 * Render the section for one step's prompt and prove it fits.
 *
 * Layout is graph order (the order of `entries`); the plan says which entries
 * are full. If the text is over the ceiling — a summary at exactly the budget
 * plus a note longer than reserved — the lowest-priority full entry is demoted
 * to its stub and the section rendered again; each pass removes one full
 * entry, so it terminates. If no full entry remains and the stubs still do not
 * fit (a demoted entry's parked stub is longer than the one it was planned
 * with), the lowest-priority stubs are dropped into the omission notice.
 */
export function renderEarlierOutputs(
  plan: EarlierPlan,
  entries: Map<string, EarlierEntry>,
  values: Record<string, unknown>,
  prepared: Map<string, PreparedView>,
  ceiling: number,
  valueBudget: number,
): { text: string; shown: string[]; stubbed: string[]; omitted: string[]; chars: number } {
  const full = [...plan.full];
  let stub = [...plan.stub];
  let omitted = [...plan.omitted];
  const graphOrder = [...entries.keys()];

  const layout = (): string => {
    const fullSet = new Set(full);
    const stubSet = new Set(stub);
    const lines = [HEADER];
    for (const id of graphOrder) {
      const entry = entries.get(id)!;
      if (fullSet.has(id)) {
        const line = renderFull(entry, values[id], prepared.get(id), valueBudget);
        if (line !== null) {
          lines.push(withSalvageNote(entry, line));
          continue;
        }
        // Could not be rendered in full after all: its stub instead.
        lines.push(withSalvageNote(entry, stubFor(entry, prepared.get(id)?.offloaded ?? null)));
        continue;
      }
      if (stubSet.has(id)) lines.push(withSalvageNote(entry, stubFor(entry, prepared.get(id)?.offloaded ?? null)));
    }
    if (omitted.length > 0) lines.push(omissionNotice(omitted.length));
    return lines.join('\n');
  };

  const inPriority = (ids: string[]): string[] => plan.order.filter((id) => ids.includes(id));

  let text = layout();
  while (text.length > ceiling) {
    if (full.length > 0) {
      // Demote the lowest-priority full entry; its stub is exact, and carries
      // the parked path when the materialised view has one.
      const demoted = full.pop()!;
      stub = inPriority([...stub, demoted]);
      text = layout();
      continue;
    }
    if (stub.length === 0) break;
    const stubCost = new Map<string, number>();
    for (const id of stub) {
      const entry = entries.get(id)!;
      stubCost.set(id, withSalvageNote(entry, stubFor(entry, prepared.get(id)?.offloaded ?? null)).length + 1);
    }
    const room = ceiling - (HEADER.length + 1);
    const { kept, dropped } = fitStubs(stub, stubCost, room, omitted.length);
    stub = kept;
    omitted = [...omitted, ...dropped];
    text = layout();
    break;
  }

  // Which entries actually rendered in full: an oversized entry whose view
  // could not render fell back to its stub inside layout().
  const shown = full.filter((id) => {
    const entry = entries.get(id)!;
    return renderFull(entry, values[id], prepared.get(id), valueBudget) !== null;
  });
  const stubbed = [...stub, ...full.filter((id) => !shown.includes(id))];
  return { text, shown, stubbed, omitted, chars: text.length };
}
