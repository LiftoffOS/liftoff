// A tool argument may never contain template syntax.
//
// WHY THIS EXISTS
// ───────────────
// `applyTemplate` resolves `{{input.message.threadId}}` for steps that declare
// a `toolInputTemplate`, and now throws when it cannot. But an `llm_reason`
// step has no template — the MODEL writes the arguments. It reads a system
// prompt and step descriptions full of `{{…}}` placeholders, and it can copy
// one through verbatim.
//
// It did. Production, 2026-08-17T01:00:22Z, Customer Support Representative:
//
//     google-mail-…__mark_as_read
//     {"user_id":"14a82d9e-…","thread_id":"{{input.message.threadId}}"}
//     outcome: success
//
// A thread id that cannot exist, passed schema validation because it is a
// non-empty string, reached Gmail, and came back recorded as a SUCCESS with an
// empty vendor response. A human reading that audit row would conclude the mail
// was handled.
//
// The template engine cannot prevent this — no substitution is running. The
// only place that can is the dispatch boundary every tool call crosses, which
// is why the check lives here and is called from the one chokepoint rather
// than from each request builder. Same reasoning as the dispatch-family
// resolver: a rule enforced at N call sites is a rule enforced at N-1 of them
// as soon as somebody adds one.
//
// SCOPE. This rejects the literal `{{ … }}` form the substituter itself
// recognises. It deliberately does not try to detect "looks like a placeholder"
// in general — a guard that guesses would eventually refuse a legitimate
// argument, and refusing real work to prevent a typo is the worse trade.

/** Mirrors the substituter's own `{{root.path}}` recognition. Kept as its own
 *  literal rather than imported so a future loosening of the substituter's
 *  grammar cannot silently widen what this guard lets through — the two are
 *  meant to agree, and a test asserts they do. */
const TEMPLATE_SYNTAX_RE = /\{\{\s*[a-zA-Z_][\w]*(?:\.[^}]*)?\}\}/;

export interface UnsubstitutedRef {
  /** Dotted argument path, e.g. `thread_id` or `message.body`. */
  argPath: string;
  /** The offending value, verbatim. */
  value: string;
}

/**
 * Find every string in a tool's arguments that still carries template syntax.
 *
 * Walks nested objects and arrays: a placeholder buried in
 * `{"message":{"body":"Hi {{input.name}}"}}` reaches the vendor exactly as
 * readily as a top-level one.
 */
export function findUnsubstitutedTemplates(
  payload: unknown,
  basePath = '',
): UnsubstitutedRef[] {
  const found: UnsubstitutedRef[] = [];

  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (TEMPLATE_SYNTAX_RE.test(value)) found.push({ argPath: path || '(root)', value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };

  walk(payload, basePath);
  return found;
}

/** Thrown instead of dispatching. Carries the offending paths so the recovery
 *  advisor is told which argument to rewrite, rather than being handed prose it
 *  has to parse. */
export class UnsubstitutedTemplateError extends Error {
  readonly code = 'UNSUBSTITUTED_TEMPLATE';
  constructor(
    readonly toolName: string,
    readonly refs: UnsubstitutedRef[],
  ) {
    super(
      `Tool "${toolName}" was called with unresolved template syntax in `
      + `${refs.length === 1 ? 'argument' : 'arguments'} `
      + refs.map((r) => `${r.argPath}=${JSON.stringify(r.value)}`).join(', ')
      + '. A `{{…}}` placeholder is instruction syntax, not a value: it is resolved for steps '
      + 'that declare a toolInputTemplate, and never by the vendor. Supply the real value — '
      + 'read it from an earlier step\'s output, or if the run does not carry it, say so instead '
      + 'of passing the placeholder through.',
    );
    this.name = 'UnsubstitutedTemplateError';
  }
}

/**
 * Refuse a tool call whose arguments still contain template syntax.
 *
 * Throws rather than returning a verdict: every caller of this would have to
 * throw anyway, and an ignorable return value is how a guard becomes decorative.
 */
export function assertNoUnsubstitutedTemplates(toolName: string, payload: unknown): void {
  const refs = findUnsubstitutedTemplates(payload);
  if (refs.length > 0) throw new UnsubstitutedTemplateError(toolName, refs);
}
