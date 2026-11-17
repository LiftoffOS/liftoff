// Which keys a step's recorded output must actually carry.
//
// A step declaring `outputField` is told WHERE to put its result — "record it
// under the key task" — and nothing at all about what shape that value needs.
// The schema is `z.unknown()`. So a step whose downstream reads are
// `{{steps.s1.repo}}` and `{{steps.s1.task_summary}}` is perfectly entitled, as
// far as anything it can see, to record `task: "fix the lint error"`.
//
// And then extraction of `task` SUCCEEDS — so no output-shape error fires —
// and every downstream read resolves to undefined. The tool steps that read it
// fail to their onFailure branch and the run escalates with no answer. A step
// description that lists the fields as "Record {workflow, repo, ...}" beside
// `outputField: "task"` reads as "these are your output" rather than "these go
// inside task", and a model resolves that the natural way.
//
// The graph already knows the answer. Every reader of this step names the key
// it wants, in a template or a condition, so the required shape is derivable
// rather than something the distiller has to remember to state.
//
// Derived, not declared, on purpose: a distilled description can drift from the
// reads beneath it, and then the two disagree with nobody to arbitrate. The
// reads ARE the contract — a key nothing reads is not required, and a key
// something reads is not optional.
//
// THERE ARE THREE READER FORMS, NOT TWO, and the third is the one that costs
// most when it is missed. A template read and a condition read both THROW when
// the key is absent, so a breach announces itself. A `loop.over` read does not:
// the collection resolves to undefined, the body runs zero times, and the step
// reports having iterated something it never saw. Nothing failed, so nothing is
// retried.
//
// For example, a battle-card step with `loop.over: "steps.s7.cards_to_refresh"`,
// one card per competitor that changed. s7 is told in prose to record
// `cards_to_refresh`, but if the only readers collected here were templates and
// conditions, the contract this module renders names NO keys at all — so
// `record_step_output` accepts anything and the model is never told that key
// is required, let alone that a loop will iterate it. `Loop.over did not
// resolve to an array`; the step routes to its failure branch; zero cards are
// written; the digest goes out anyway.
//
// The array half is not a detail. The sentence this module renders ends "a key
// you cannot determine must still be present, set to null" — and null is the
// one value a loop cannot iterate. Told to produce a key it had nothing for,
// a model following that instruction exactly would break the loop again. An
// iterated key's empty value is `[]`.

import { loopCollectionRef } from './template';

/** `{{steps.<id>.<key>}}` in a tool input template. */
const TEMPLATE_STEP_READ = /\{\{\s*steps\.(\w+)\.(\w+)/g;
/** `$.steps.<id>.<key>` in a condition. */
const CONDITION_STEP_READ = /\$\.steps\.(\w+)\.(\w+)/g;

interface StepLike {
  stepId: string;
  condition?: string;
  toolInputTemplate?: string;
  description?: string;
  /** Read through `loopCollectionRef` rather than parsed here: the executor's
   *  own branching decides what this string addresses, and a second answer to
   *  "what does `steps.s5` mean" is how the validator and the executor drifted
   *  apart once already. */
  loop?: { over?: string };
}

/** One key a later step reads off this step's output. */
export interface StepOutputRead {
  key: string;
  /** A later step's loop ITERATES this key. It must be a JSON array, and `[]`
   *  when there is nothing — the one place the "set to null" instruction below
   *  must not apply, because a null collection runs the body zero times and
   *  reports success. */
  iterated: boolean;
}

/**
 * The keys other steps read off `stepId`, in graph order, deduplicated, each
 * marked with whether a loop iterates it.
 *
 * Empty when nothing reads this step — which is a real answer, not a failure:
 * a step whose output nobody addresses has no shape to satisfy, and saying so
 * beats inventing a requirement.
 *
 * A key read BOTH ways stays iterated: a template that interpolates the same
 * key does not relax the array requirement a loop puts on it.
 */
export function readsFromStep(steps: StepLike[] | undefined, stepId: string): StepOutputRead[] {
  if (!steps || !stepId) return [];
  const reads: StepOutputRead[] = [];
  const at = new Map<string, number>();
  const record = (key: string, iterated: boolean): void => {
    const seen = at.get(key);
    if (seen === undefined) {
      at.set(key, reads.length);
      reads.push({ key, iterated });
      return;
    }
    if (iterated) reads[seen].iterated = true;
  };
  const collect = (text: string | undefined, re: RegExp): void => {
    if (!text) return;
    // A fresh regex per scan: these are module-level and `g`-flagged, so
    // sharing `lastIndex` across calls would make one scan skip what the
    // previous one consumed.
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const [, ref, key] = m;
      if (ref !== stepId || !key) continue;
      record(key, false);
    }
  };
  for (const s of steps) {
    if (s.stepId === stepId) continue;   // a step reading itself proves nothing
    collect(s.toolInputTemplate, TEMPLATE_STEP_READ);
    collect(s.condition, CONDITION_STEP_READ);
    // The loop's collection, judged by the executor's own parser. `over` takes
    // three forms (`{{steps.s7.x}}`, `steps.s7.x`, and a bare path relative to
    // the previous output) and only the step-registry ones name a step.
    const over = s.loop?.over;
    if (typeof over !== 'string' || over.trim() === '') continue;
    const ref = loopCollectionRef(over);
    if (!ref || ref.root !== 'steps') continue;
    const [refStepId, ...rest] = ref.path.split('.');
    // Only the FIRST segment under the step id is a key of the recorded value.
    // A deeper read (`steps.s7.analysis.cards`) still requires `analysis`, and
    // what is iterated is a path inside it rather than the key itself — so the
    // array requirement is not attributed to the wrong level.
    if (refStepId !== stepId || rest.length === 0) continue;
    record(rest[0], rest.length === 1);
  }
  return reads;
}

/**
 * The sentence appended to the step's own instruction, or empty.
 *
 * Names every key and says plainly that they go INSIDE the recorded value —
 * the exact ambiguity that produced a bare string where an object was needed —
 * and states the array contract for every key a loop iterates, which the
 * general "set to null" instruction would otherwise break.
 */
export function describeRequiredStepOutput(root: string, reads: readonly StepOutputRead[]): string {
  if (reads.length === 0) return '';
  const quoted = (rs: readonly StepOutputRead[]): string => rs.map((r) => `"${r.key}"`).join(', ');
  const iterated = reads.filter((r) => r.iterated);
  return (
    ` The "${root}" value MUST be an object, and later steps read these keys from inside it: `
    + `${quoted(reads)}. `
    + `Put them inside "${root}" — not alongside it — and use exactly these names. `
    + `A key you cannot determine must still be present, set to null.`
    + describeIteratedKeys(iterated)
  );
}

/** The exception to "set to null", stated for the keys it applies to.
 *
 *  A loop over a null or an absent key runs its body zero times and the step
 *  reports success, so this is the difference between a card per competitor and
 *  no cards at all with nothing anywhere saying so. */
export function describeIteratedKeys(iterated: readonly StepOutputRead[]): string {
  if (iterated.length === 0) return '';
  const names = iterated.map((r) => `"${r.key}"`).join(', ');
  const [subject, verb] = iterated.length === 1 ? ['key', 'is'] : ['keys', 'are'];
  return (
    ` The ${subject} ${names} ${verb} the exception: a later step iterates `
    + `${iterated.length === 1 ? 'it' : 'them'} item by item, so `
    + `${iterated.length === 1 ? 'it' : 'each'} MUST be a JSON array. `
    + `When there is nothing to iterate, record an empty array — not null, not an `
    + `object, and never an omitted key.`
  );
}

/**
 * The earlier steps this step refers to, in the order it first mentions them.
 *
 * Three ways a step names another: a template read (`{{steps.<id>.`) in its
 * tool input or its description, a condition read (`$.steps.<id>.`), and plain
 * prose ("from step s3", "steps s2 and s3"). The prose form is matched against
 * the graph's OWN ids — a token match of each known id — so ids like `step-1`
 * or `wait-48h` are found, and nothing about the id's shape is assumed.
 *
 * Order is what the author wrote: matches carry their offset and are sorted by
 * it. The description is scanned first; template and condition text is placed
 * after it, so a prose mention outranks a template read of the same id and a
 * template-only read still lands after every prose mention. Deduplicated on
 * first mention.
 *
 * This decides PRIORITY in a step prompt's earlier-outputs section — which
 * outputs are rendered in full before the section's ceiling is reached — so a
 * missed reference costs data only when the section is over its ceiling. The
 * structured `reads` field is the follow-up that removes the parser.
 */
export function stepsReferencedBy(step: StepLike, knownIds: readonly string[]): string[] {
  const found: Array<{ id: string; offset: number }> = [];
  const known = new Set(knownIds);
  const description = step.description ?? '';

  // Prose: each known id as a token. The boundary is anything that is not an
  // id character on either side, so `s1` does not match inside `s12` and
  // `step-1` is not found inside `step-10`.
  for (const id of known) {
    if (id === step.stepId) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(id)}(?![A-Za-z0-9_-])`, 'g');
    for (const m of description.matchAll(re)) {
      found.push({ id, offset: (m.index ?? 0) + m[1].length });
    }
  }

  // Template and condition reads, offset past the description so they sort
  // after every prose mention while keeping their own order.
  const collect = (text: string | undefined, re: RegExp, base: number): void => {
    if (!text) return;
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const id = m[1];
      if (!id || id === step.stepId || !known.has(id)) continue;
      found.push({ id, offset: base + (m.index ?? 0) });
    }
  };
  collect(description, TEMPLATE_STEP_READ, 0);
  const afterDescription = description.length + 1;
  collect(step.toolInputTemplate, TEMPLATE_STEP_READ, afterDescription);
  collect(step.condition, CONDITION_STEP_READ, afterDescription + (step.toolInputTemplate?.length ?? 0) + 1);

  found.sort((a, b) => a.offset - b.offset);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f.id);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
