// The deterministic layer of "no assistant ever shows a person its inner
// workings": what can be recognised by shape is removed by shape.
//
// Three vocabularies are known exactly, so a person never sees them whatever
// a model does:
//   - a UUID, which is what every id on this platform looks like (teams,
//     threads, runs, connectors, accounts), together with the "id" word and
//     the punctuation a sentence hangs it on;
//   - a connector tool name, `vendor__function`, whose double underscore no
//     English sentence contains;
//   - the exact names of the tools a turn was offered, which the caller
//     knows and passes in.
//
// Everything else that counts as inner workings (a field's name, narrated
// mechanics, speaking about the person in the third person) is the output
// guard's (common/output-guard.ts), which reads the paragraph. This runs
// before it, and again at every repository's appendMessage, so the stored
// row is clean whichever code path wrote it.
//
// Every quantifier is bounded, as the redact package's are: this runs on
// model output at streaming speed and a pathological regex would be a
// denial of service the model could trigger.
//
// Mirrored in workforce-service (its own deployable) with the same tests.

const HEX = '[0-9a-fA-F]';
const UUID = `${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`;
/** A UUID as prose carries it: bare, or in back-ticks or single quotes. Double
 *  quotes are left standing on purpose: in JSON they are the value's, and a
 *  visualization block whose id value became `,` would no longer parse. */
const WRAPPED_UUID = `[\`']?${UUID}[\`']?`;
const ID_WORD = '(?:id|ID|Id|identifier|Identifier|uuid|UUID)';
/** "id X", "id: X", "identifier = X", "ID is X". */
const ID_PHRASE = `${ID_WORD}\\s{0,3}(?:is\\s{0,3}|[:=]\\s{0,3})?${WRAPPED_UUID}`;

/** The passes, in order: each takes the identifier and the words a sentence
 *  hangs it on, so what is left still reads. Later passes see what earlier
 *  ones left. */
const PASSES: ReadonlyArray<readonly [RegExp, string]> = [
  // A JSON string value: the quotes stay, the id goes, the document parses.
  [new RegExp(`(?<=")${UUID}(?=")`, 'g'), ''],
  // " (id X)" and " (X)": the parenthetical goes, with the space before it.
  [new RegExp(`\\s{0,3}\\(\\s{0,3}(?:${ID_PHRASE}|${WRAPPED_UUID})\\s{0,3}\\)`, 'g'), ''],
  // "(id X, paused, …)": the first item goes, the rest keeps its bracket.
  [new RegExp(`\\(\\s{0,3}(?:${ID_PHRASE}|${WRAPPED_UUID})\\s{0,3},\\s{0,3}`, 'g'), '('],
  // ", id X" inside a list or before a closing bracket.
  [new RegExp(`,\\s{0,3}(?:${ID_PHRASE}|${WRAPPED_UUID})(?=\\s{0,3}[,)\\].;])`, 'g'), ''],
  // "with id X", "whose id is X", "the id X", "id: X", and the dash or colon
  // a sentence hangs one on: "(601 tasks) — id X".
  [new RegExp(`\\s{0,3}(?:[\u2014\u2013-]|:)?\\s{0,3}(?:with|whose|the|its|of)?\\s{0,3}${ID_PHRASE}`, 'g'), ''],
  // Whatever is left: a bare UUID.
  [new RegExp(WRAPPED_UUID, 'g'), ''],
];

/** A connector tool name: vendor__function. Never English, but a shape code
 *  can carry (a Django lookup, say), so a fenced code block keeps it. */
const CONNECTOR_TOOL_NAME = /\b[a-z0-9]{1,40}__[a-z0-9_]{1,80}\b/g;

/** The tidy-up after a removal: doubled spaces, a space before punctuation,
 *  an empty bracket, a space after an opening bracket. */
const TIDY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\(\s{0,3}\)/g, ''],
  [/\(\s{1,3}/g, '('],
  [/[ \t]{2,}/g, ' '],
  [/ (?=[,.;:)!?])/g, ''],
  [/([([]) /g, '$1'],
  // A dash or colon left hanging before the punctuation that closes the
  // sentence: "(601 tasks) —." after the id it introduced went.
  [/\s{0,3}(?:[\u2014\u2013]|(?<=\s)-|:)\s{0,3}(?=[.,;:)!?\n]|$)/g, ''],
  // A sentence that ended on the id: "Reviewer. ID: X." leaves "Reviewer..";
  // exactly two dots, so an ellipsis is left alone.
  [/(?<!\.)\.\.(?!\.)/g, '.'],
];

function escapeForRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ScrubOptions {
  /** The exact tool names the turn was offered: removed whole. */
  toolNames?: readonly string[];
  /** The text is a fenced code block: identifiers and tool names still go,
   *  but a double-underscore token is left, because code has those. */
  inCode?: boolean;
}

/**
 * Remove every identifier and tool name from `text`, and tidy what is left.
 *
 * `toolNames` are the exact tool names the turn was offered (the caller knows
 * them; nothing is guessed): they are removed whole. JSON stays parseable: a
 * value that was an identifier becomes an empty string.
 */
export function scrubIdentifiers(text: string, opts: ScrubOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of PASSES) out = out.replace(pattern, replacement);
  if (!opts.inCode) out = out.replace(CONNECTOR_TOOL_NAME, '');
  for (const name of opts.toolNames ?? []) {
    if (!name) continue;
    // Whole-token, with any back-ticks the model put around it.
    out = out.replace(new RegExp(`\`?\\b${escapeForRegExp(name)}\\b\`?`, 'g'), '');
  }
  if (out === text) return text;
  for (const [pattern, replacement] of TIDY) out = out.replace(pattern, replacement);
  return out;
}
