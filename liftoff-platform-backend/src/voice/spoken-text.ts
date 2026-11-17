// Turning written text into something worth hearing.
//
// Agent replies are written for a screen: headings, bullets, links, code fences,
// bold. Synthesised verbatim, that comes out as "star star important star star"
// and a URL read character by character for nine seconds. Worse, we bill per
// character, so every character of markup is paid for twice — once in money and
// once in the listener's patience.
//
// One normaliser for every speaking path, not one per provider. A per-provider
// cleaner would mean the same reply sounds different depending on a vendor
// choice the listener cannot see, and any fix would have to be made twice.
//
// The rule throughout: drop what is only notation, keep what carries meaning.
// A link's TEXT is meaning; its URL is notation. A code fence's contents are
// meaning to a reader and noise to a listener, so they are named rather than
// read.

/**
 * Longest reply worth turning into an audio file.
 *
 * A whole-file voice reply is listened to start to finish or not at all, so a
 * long written answer becomes minutes of audio nobody plays. The full text still
 * lands in the thread; only the spoken version is shortened, and it says so
 * rather than stopping mid-thought.
 */
const MAX_SPOKEN_FILE_CHARS = 1800;

/** Longest run of code we will describe rather than skip entirely. */
const SHORT_CODE_CHARS = 60;

/**
 * Rewrite a written reply as speakable text.
 *
 * Returns an empty string when nothing speakable is left — a reply that was only
 * a code block, say. Callers treat that as "nothing to say", not as an error.
 */
export function toSpokenText(markdown: string): string {
  let text = markdown;

  // Fenced code first, before any inline rule can get inside one and mangle it.
  // A short snippet is worth naming; a long one is skipped, because "const x
  // equals await fetch open paren" helps nobody.
  //
  // The language tag is only a language tag when a newline follows it. Without
  // that condition ```npm test``` loses the word "npm", which reads as a
  // different instruction rather than a garbled one.
  const describeCode = (body: string): string => {
    const code = body.trim();
    if (code.length === 0) return '';
    return code.length <= SHORT_CODE_CHARS ? ` ${code} ` : ' (code omitted) ';
  };
  text = text.replace(/```[\w-]*[ \t]*\r?\n([\s\S]*?)```/g, (_all, body: string) =>
    describeCode(String(body)),
  );
  text = text.replace(/```([^`\n]+)```/g, (_all, body: string) => describeCode(String(body)));

  // Images before links: both are bracket forms and the image is the longer one.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_all, alt: string) =>
    alt.trim() ? ` ${alt} ` : ' (image) ',
  );
  // Links keep their text and lose the destination.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Inline code: the content is usually a name worth hearing.
  text = text.replace(/`([^`]+)`/g, '$1');

  // Emphasis markers. Bold before italic so the doubled markers go first.
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2');

  // Headings lose their hashes but keep their words, and gain a full stop so the
  // chunker treats them as their own utterance instead of running them into the
  // paragraph below.
  text = text.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '$1.');

  // List markers: the bullet is notation, the item is content. Same for the
  // number in an ordered list — a spoken "one." before each item is the reading
  // voice's job, not ours.
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');

  // Block quotes and horizontal rules are pure layout.
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/^\s*([-*_])\s*(?:\1\s*){2,}$/gm, '');

  // Table pipes would otherwise be read as nothing at all while gluing cells
  // together; a comma is how a person reads a row aloud.
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_all, row: string) =>
    String(row)
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0 && !/^:?-{2,}:?$/.test(cell))
      .join(', '),
  );

  // A bare URL left in prose. Its text was never meaningful to a listener.
  text = text.replace(/\bhttps?:\/\/\S+/g, ' (link) ');

  // Collapse the whitespace all of the above left behind. Paragraph breaks
  // become sentence breaks so the chunker can still hear them.
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\n{2,}/g, '. ');
  text = text.replace(/\n/g, ' ');
  text = text.replace(/[ \t]{2,}/g, ' ');

  // The substitutions above can leave doubled or orphaned punctuation.
  text = text.replace(/\s+([.,!?;:])/g, '$1');
  text = text.replace(/([.,!?;:])\1+/g, '$1');
  text = text.replace(/\.\s*\./g, '.');

  text = text.trim();

  // Punctuation with no words around it is what is left when the input was
  // blank or was nothing but layout — the paragraph rule above turns a run of
  // newlines into a full stop. There is nothing to say, so say nothing.
  if (!/[\p{L}\p{N}]/u.test(text)) return '';

  return text;
}

/**
 * Shorten a reply to something worth hearing as a file.
 *
 * Cuts at a sentence boundary where it can, so the audio ends on a finished
 * thought rather than mid-clause, and says the rest is in writing — silence
 * after a truncation sounds like a failure.
 */
export function toSpokenFile(markdown: string): string {
  const spoken = toSpokenText(markdown);
  if (spoken.length <= MAX_SPOKEN_FILE_CHARS) return spoken;

  const window = spoken.slice(0, MAX_SPOKEN_FILE_CHARS);
  const lastStop = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  const cut = lastStop > MAX_SPOKEN_FILE_CHARS / 2 ? window.slice(0, lastStop + 1) : window.trim();
  return `${cut} The rest of my answer is in the message.`;
}
