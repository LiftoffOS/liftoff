// The divergence from the reference loop: the value to type is a Choice over
// the literals the task supplied, never a text model's output.
//
// The reference sends the goal, the field and the page to a small OpenAI-wire
// model (~350–600 ms per field, ~$0.00003) and types what it returns. That is
// declined here: nothing typed into a customer's browser comes from a
// generation. So the TYPE_TEXT head is a speculative `type_text_value` Choice
// in the same request over the literals extracted here — quoted strings,
// emails, URLs, numbers, dates, and any value the assistant passed as a
// parameter — plus `none`. `none` winning means the page needs text the task
// did not supply, and the loop hands off: a form that needs invented text runs
// the rest of the task at Stagehand speed. The seam is this one function.

export interface TaskLiterals {
  /** Stable ids the model chooses between, each mapping to the literal. */
  byId: Map<string, string>;
}

const QUOTED = /"([^"\n]{1,200})"|'([^'\n]{1,200})'|[“]([^”\n]{1,200})[”]/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A URL, without the punctuation a sentence hangs on its end.
const URL_RE = /https?:\/\/[^\s"'<>)]+?(?=[.,;:!?]*(?:\s|$|["'<>)]))/g;
// A date in the common written forms: 2026-09-21, 21/09/2026, 9/21/26,
// 21 September 2026, September 21, Sep 21 2026.
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?(?:\s+\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{2,4})?)\b/gi;
const NUMBER = /(?<![\w.-])[+-]?\d[\d,]*(?:\.\d+)?(?![\w-])/g;

/** At most this many literals are offered; a task with more is not a task. */
export const MAX_LITERALS = 64;

/**
 * The literals a task supplies, in a stable order with stable ids. Values
 * the assistant passed as parameters come first: they were meant to be typed.
 */
export function extractLiterals(prompt: string, parameters?: Record<string, unknown>): TaskLiterals {
  const seen = new Set<string>();
  const values: string[] = [];
  const add = (v: string | undefined) => {
    const t = (v ?? '').trim();
    if (!t || t.length > 2_000 || seen.has(t) || values.length >= MAX_LITERALS) return;
    seen.add(t);
    values.push(t);
  };
  for (const v of Object.values(parameters ?? {})) {
    if (typeof v === 'string') add(v);
    else if (typeof v === 'number' || typeof v === 'boolean') add(String(v));
  }
  for (const m of prompt.matchAll(QUOTED)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of prompt.matchAll(EMAIL)) add(m[0]);
  for (const m of prompt.matchAll(URL_RE)) add(m[0]);
  for (const m of prompt.matchAll(DATE_RE)) add(m[0]);
  for (const m of prompt.matchAll(NUMBER)) add(m[0]);
  const byId = new Map<string, string>();
  values.forEach((v, i) => byId.set(`l${i + 1}`, v));
  return { byId };
}

/** The first web address the task names, for a task that starts on a blank
 *  page: "go to X and do Y" carries its X here. Only http and https, because
 *  what follows is a navigation in a browser a person is watching. */
export function firstUrlIn(prompt: string, parameters?: Record<string, unknown>): string | null {
  const fromParameters = Object.values(parameters ?? {})
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => [...v.matchAll(URL_RE)].map((m) => m[0]));
  const fromPrompt = [...prompt.matchAll(URL_RE)].map((m) => m[0]);
  for (const candidate of [...fromParameters, ...fromPrompt]) {
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    } catch {
      // Not an address; the next candidate.
    }
  }
  return null;
}
