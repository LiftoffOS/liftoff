// Model-authored text arrives as markdown. Rendered surfaces run it through
// the Markdown component; compact ones — a list card showing the first line of
// a question — need the words without the markup, because a card that clamps
// to one line has nowhere to put a heading or a list, and printing the raw
// string puts `**` and backticks in front of the reader.
//
// Display-only. The stored text is untouched.

/** Take the markdown markers off a string and keep the words. */
export function stripMarkdown(text: string): string {
  return text
    // Fences and inline code: keep the code, drop the backticks.
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`([^`]+)`/g, '$1')
    // Images before links, so a leading ! does not survive as a stray mark.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Emphasis. Bold first: **x** would otherwise leave a lone * each side.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // Line-leading block markers: headings, quotes, bullets, ordered items.
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .trim()
}

/** The first line of a markdown body, as plain text, for a one-line preview.
 *
 *  The first *non-blank* line: a body that opens with a heading or a blank
 *  line previewed as an empty card, which reads as a question with no text. */
export function markdownPreviewLine(text: string): string {
  const lines = stripMarkdown(text).split('\n')
  return lines.find((line) => line.trim().length > 0)?.trim() ?? ''
}
