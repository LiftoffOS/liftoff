// Structured choices on the question the agent already knows how to ask.
//
// `ask_user` exists and works: the agent pauses, a question reaches the person,
// the answer resumes the run. What it cannot do is offer OPTIONS. So an agent
// that needs to know which of three environments you meant writes a paragraph
// listing them and hopes the free-text reply is unambiguous, and half the time
// it gets "the second one" and has to ask again.
//
// This is deliberately NOT approval. Approval asks "may I do this thing I have
// decided to do"; a clarification asks "which thing did you mean". Conflating
// them would put scoping questions through the governance surface, where they
// would sit in a review queue instead of in the conversation.
//
// Normalized at one platform-agnostic point, because the shapes a model emits
// for "a list of choices" are endlessly varied — bare strings, {label},
// {label,value}, {title,description} — and every surface downstream would
// otherwise have to handle all of them.

/** Max options before a list stops being a choice and becomes a menu. Four,
 *  plus the implicit "something else", is what fits in a Slack message and in a
 *  person's head. */
export const MAX_CHOICES = 4;

/** Always appended, never counted against MAX_CHOICES. A closed list that does
 *  not admit "none of these" forces a wrong answer. */
export const OTHER_CHOICE_LABEL = 'Something else';

export interface ClarifyChoice {
  /** What the person reads. */
  label: string;
  /** What comes back on selection. Defaults to the label when the model did not
   *  give one — a value nobody chose a name for is just the label. */
  value: string;
  /** Optional one-line elaboration, shown where the surface has room. */
  description?: string;
}

export interface ClarifyRequest {
  question: string;
  choices: ClarifyChoice[];
  /** True when several may be picked at once. */
  multiSelect: boolean;
}

/** Anything a model might plausibly emit for one choice. */
type RawChoice =
  | string
  | {
      label?: unknown;
      title?: unknown;
      name?: unknown;
      text?: unknown;
      value?: unknown;
      description?: unknown;
      detail?: unknown;
    };

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Normalize whatever the model produced into choices, or return null when it
 * did not really produce any.
 *
 * Returning null rather than an empty list matters: an `ask_user` with no
 * choices is a perfectly good free-text question, and it should stay one rather
 * than becoming a broken picker with nothing to pick.
 */
export function normalizeChoices(raw: unknown): ClarifyChoice[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out: ClarifyChoice[] = [];
  const seen = new Set<string>();

  for (const item of raw as RawChoice[]) {
    let label: string | null = null;
    let value: string | null = null;
    let description: string | undefined;

    if (typeof item === 'string') {
      label = item.trim() || null;
    } else if (item && typeof item === 'object') {
      label = firstString(item.label, item.title, item.name, item.text);
      value = firstString(item.value);
      description = firstString(item.description, item.detail) ?? undefined;
    }
    if (!label) continue;

    // A duplicate label is not a choice — it is the same option twice, and it
    // makes the answer ambiguous whichever the person picks.
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ label, value: value ?? label, ...(description ? { description } : {}) });
    if (out.length >= MAX_CHOICES) break;
  }

  return out.length > 0 ? out : null;
}

/** Build the request, or null when this is an ordinary free-text question. */
export function buildClarifyRequest(
  question: string,
  rawChoices: unknown,
  multiSelect?: unknown,
): ClarifyRequest | null {
  const choices = normalizeChoices(rawChoices);
  if (!choices) return null;
  return { question, choices, multiSelect: multiSelect === true };
}

/**
 * Render for a surface that has no interactive controls (plain chat, a Slack
 * message body, an email).
 *
 * Numbered, because "the second one" is what people actually type, and a
 * numbered list makes that answer unambiguous.
 */
export function renderChoicesAsText(req: ClarifyRequest): string {
  const lines = req.choices.map((c, i) => {
    const suffix = c.description ? ` — ${c.description}` : '';
    return `${i + 1}. ${c.label}${suffix}`;
  });
  lines.push(`${req.choices.length + 1}. ${OTHER_CHOICE_LABEL}`);

  const howMany = req.multiSelect
    ? 'Reply with the numbers that apply, or describe what you need.'
    : 'Reply with the number, or describe what you need.';

  return `${req.question}\n\n${lines.join('\n')}\n\n${howMany}`;
}

/**
 * Resolve a free-text reply against the offered choices.
 *
 * Accepts a number, a label, or a prefix of a label, because those are what
 * people send. Returns null when the reply does not match any of them — which
 * is not a failure: it means they answered in their own words, and that answer
 * should be used as-is rather than forced into a bucket.
 */
export function resolveChoiceReply(
  req: ClarifyRequest,
  reply: string,
): ClarifyChoice[] | null {
  const text = reply.trim().toLowerCase();
  if (!text) return null;

  const picked: ClarifyChoice[] = [];
  const add = (c: ClarifyChoice): void => {
    if (!picked.some((p) => p.value === c.value)) picked.push(c);
  };

  // Numbers: "2", "2 and 4", "1,3".
  const numbers = text.match(/\d+/g) ?? [];
  for (const n of numbers) {
    const idx = Number(n) - 1;
    // The trailing "something else" index is a deliberate non-match: it means
    // none of these, and the caller should treat the reply as free text.
    if (idx >= 0 && idx < req.choices.length) add(req.choices[idx]);
  }

  // Labels, exact then prefix.
  for (const c of req.choices) {
    const label = c.label.toLowerCase();
    if (text === label || text.includes(label)) add(c);
  }
  if (picked.length === 0) {
    for (const c of req.choices) {
      const label = c.label.toLowerCase();
      if (label.startsWith(text) && text.length >= 3) add(c);
    }
  }

  if (picked.length === 0) return null;
  // A single-select question that matched several is ambiguous; take the first,
  // which for a numbered reply is the one they typed first.
  return req.multiSelect ? picked : picked.slice(0, 1);
}
