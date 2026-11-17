// The markdown <-> HTML conversion the editor runs on, and the [[ autocomplete
// filter. Their own module: a file that exports a component alongside plain
// functions cannot be fast-refreshed, and these are pure enough to unit-test
// without standing up a TipTap editor.
import type { KnowledgeMentionItem } from './KnowledgeMentionList'
import { INLINE_EMPHASIS } from '../utils/inlineProse'

/**
 * Filter that drives the [[ autocomplete. Pulled out of the closure so it can
 * be unit-tested without standing up a TipTap editor.
 *
 * - Title-substring match (case-insensitive)
 * - Connector gate: include manual-URL items (connectorId === null) AND items
 *   from currently-bound connectors. The rest are hidden so operators can't
 *   add new orphan pins through the autocomplete.
 * - Cap at 8 for UX (no operator scrolls past 8 in a dropdown).
 */
export function filterKnowledgeMentionItems(
  items: KnowledgeMentionItem[],
  query: string,
  boundConnectorIds: string[],
): KnowledgeMentionItem[] {
  const q = query.toLowerCase()
  const bound = new Set(boundConnectorIds)
  return items
    .filter(item => item.title.toLowerCase().includes(q))
    .filter(item => item.connectorId === null || bound.has(item.connectorId))
    .slice(0, 8)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Converts [[knowledge:id:title]] markers in a line to mention span HTML.
//
// The line arrives ALREADY escaped by markdownToHtml, so the captured id and
// label are interpolated verbatim. Escaping them a second time would encode the
// ampersand of an existing entity (`&amp;` → `&amp;amp;`) and the value would
// gain an `amp;` on every save, because htmlToMarkdown decodes exactly once.
function inlineKnowledgeMarkersToHtml(line: string): string {
  return line.replace(
    /\[\[knowledge:([^:\]]+):([^\]]+)\]\]/g,
    (_, id: string, label: string) =>
      `<span data-type="knowledgeMention" data-id="${id}" data-label="${label}">${label}</span>`,
  )
}

// Converts [[agent:id:label]] markers in a line to agent mention span HTML.
// Same pre-escaped contract as inlineKnowledgeMarkersToHtml above.
function inlineAgentMarkersToHtml(line: string): string {
  return line.replace(
    /\[\[agent:([^:\]]+):([^\]]+)\]\]/g,
    (_, id: string, label: string) =>
      `<span data-type="agentMention" data-id="${id}" data-label="${label}">${label}</span>`,
  )
}

// A [[knowledge:]] or [[agent:]] marker, captured so emphasis can be applied
// around one without ever reaching inside it.
const MENTION_MARKER = /(\[\[(?:knowledge|agent):[^\]]+\]\])/

// Converts the two inline marks the catalog uses — `**bold**` and `` `code` ``
// — to the editor's own <strong>/<code>.
//
// All 69 catalog templates use `**` for their run-in headings and five use
// backticks for CRM field names; none of it rendered, because the schema had
// the marks switched off. The read-only detail page has always rendered both
// (utils/inlineProse), so the same prose came out bold in the gallery and
// asterisked in the editor.
//
// Marker-aware on purpose. The line arrives with mentions still as literal
// `[[knowledge:id:label]]` text, and a label carrying `**` would otherwise be
// rewritten mid-marker — which the marker regex would then fail to match, and
// the mention would be gone with nothing reporting it. Splitting on the marker
// first means emphasis only ever sees prose.
//
// Runs on ALREADY-ESCAPED text, like the marker converters below: the content
// between the markers is interpolated verbatim.
function inlineEmphasisToHtml(line: string): string {
  return line
    .split(MENTION_MARKER)
    .map(part => {
      if (MENTION_MARKER.test(part)) return part
      return part
        .split(INLINE_EMPHASIS)
        .map(piece => {
          if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
            return `<strong>${piece.slice(2, -2)}</strong>`
          }
          if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
            return `<code>${piece.slice(1, -1)}</code>`
          }
          return piece
        })
        .join('')
    })
    .join('')
}

// Flatten pasted HTML into a sequence of <p>/<h2> blocks before TipTap
// parses it. The editor schema disables every block type except paragraph
// and heading; without preprocessing, list items would have their wrapper
// stripped and their text content concatenated into a single paragraph
// (the bug users hit when pasting bulleted lists from rendered output).
//
// Rules:
//   - <br> → </p><p>  (was a HardBreak; now a paragraph split)
//   - <li>...</li> → <p>...</p>  (each list item becomes its own paragraph)
//   - <ul>/<ol>/<dl>/<dt>/<dd> and other block wrappers → stripped, content kept
//   - <div>/<section>/<article>/<nav>/<header>/<footer>/<main>/<aside> → stripped
//
// Exported for unit testing.
export const transformPastedHTML = (html: string): string => {
  return html
    .replace(/<br\s*\/?>/gi, '</p><p>')
    .replace(/<li\b[^>]*>/gi, '<p>')
    .replace(/<\/li\s*>/gi, '</p>')
    .replace(/<\/?(ul|ol|dl|dt|dd|section|article|div|nav|header|footer|main|aside)\b[^>]*>/gi, '')
}

// Convert markdown to HTML for the editor.
//
// Paragraphs in TipTap are wrapped in <p>; in CommonMark they are separated
// by a blank line (`\n\n`). Older stored values used a single `\n` per
// paragraph (the buggy storage format) — we normalise either form by
// collapsing runs of newlines to `\n\n` and splitting on that, so legacy
// data heals into proper paragraphs on the next save without re-inflating
// on every round-trip.
//
// Exported for unit testing.
/** Lines that begin a new block whatever else they look like: a heading, a list
 *  item, or a bolded run-in heading.
 *
 *  Lists matter here even though the editor schema has no list nodes. Without
 *  them, `1.` and `2.` would glue into one run-on paragraph, which is worse
 *  than the shredding this all replaces. */
const STARTS_NEW_BLOCK = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\*\*)/

/** A line that opens lower-case is the back half of a sentence the author's
 *  editor wrapped, so it belongs to the line above.
 *
 *  This is the discriminator, and it has to exist because a single `\n` means
 *  two different things depending on who wrote the value. Prose written
 *  elsewhere (agent templates, anything pasted from an editor that hard-wraps)
 *  uses it as a soft wrap mid-sentence. Values stored by older versions of this
 *  component used it as the paragraph separator, and those are healed into real
 *  paragraphs. Capitalisation separates the two cases without a format flag:
 *  a wrapped clause continues in lower case, a new paragraph starts a sentence.
 *
 *  Deliberately conservative. A wrapped line that happens to begin with a
 *  proper noun starts its own paragraph instead of rejoining, because splitting
 *  one paragraph in two is a smaller error than welding two together. */
const CONTINUES_PREVIOUS = /^[a-z(]/

/** Rejoin hard-wrapped lines inside one blank-line-delimited block. */
function reflowWrappedLines(block: string): string[] {
  const out: string[] = []
  for (const raw of block.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // A heading is always a block of its own, so the line under it starts a
    // new one however it opens. Without this, `## Workflows` swallowed the
    // sentence beneath it and the section title vanished from the editor.
    const prevIsHeading = out.length > 0 && /^#{1,6}\s/.test(out[out.length - 1])
    const continues =
      out.length > 0 &&
      !prevIsHeading &&
      !STARTS_NEW_BLOCK.test(line) &&
      CONTINUES_PREVIOUS.test(line)
    if (continues) out[out.length - 1] += ` ${line}`
    else out.push(line)
  }
  return out
}

export const markdownToHtml = (markdown: string): string => {
  if (!markdown) return ''
  const blocks = markdown
    .replace(/\r\n/g, '\n')
    // A blank line is the only paragraph break. A single newline is a soft
    // wrap in CommonMark and must NOT start a paragraph: this used to be
    // `.replace(/\n+/g, '\n\n')`, which made every physical line its own
    // paragraph. Text typed in this editor round-trips as `\n\n`, so nobody
    // noticed until prose written elsewhere arrived here — agent templates are
    // hard-wrapped at ~100 characters, and every wrapped sentence broke apart
    // mid-clause when a template was opened for editing.
    .split(/\n[ \t]*\n/)
    .flatMap(reflowWrappedLines)
    .filter(b => b.length > 0)
  return blocks
    .map(block => {
      if (block.startsWith('## ')) {
        return `<h2>${escapeHtml(block.slice(3))}</h2>`
      }
      // Escape BEFORE the marker conversion, never after: htmlToMarkdown reads
      // this back through innerHTML, so an unescaped `<` opened a real tag and
      // the parser swallowed the rest of the paragraph ("use <div> for layout"
      // came back as "use "). The heading branch above has always escaped; this
      // branch did not, which is why only body text lost characters.
      return `<p>${inlineAgentMarkersToHtml(inlineKnowledgeMarkersToHtml(inlineEmphasisToHtml(escapeHtml(block))))}</p>`
    })
    .join('')
}

// Convert editor HTML back to markdown, preserving [[knowledge:]] and
// [[agent:]] markers. Paragraphs are joined with `\n\n` (CommonMark
// paragraph break) so ReactMarkdown's read-only render below treats them
// as separate paragraphs (single `\n` is a soft break in CommonMark and
// would collapse to a space).
//
// The editor schema only allows <p>, <h2>, and mention spans inside <p>.
// HardBreak is disabled at the StarterKit level and transformPastedHTML
// strips <br> from any incoming HTML — so in practice <br> is impossible.
// We still split paragraphs on <br> as a defense-in-depth measure: the
// previous failure mode here was *silent data loss* (textContent on a
// <br> is ''), and a future regression re-enabling HardBreak would
// reproduce that exactly. The handling is cheap; keep it.
//
// Exported for unit testing.
export const htmlToMarkdown = (html: string): string => {
  const div = document.createElement('div')
  div.innerHTML = html

  const blocks: string[] = []
  div.childNodes.forEach(node => {
    if (node.nodeName === 'H2') {
      blocks.push(`## ${node.textContent || ''}`)
    } else if (node.nodeName === 'P') {
      const chunks: string[] = ['']
      const appendToCurrent = (s: string) => {
        chunks[chunks.length - 1] += s
      }
      // One node's markdown, recursing so a mark WRAPPING a mention still
      // writes the mention out. `textContent` on a <strong> would flatten the
      // span inside it to its label and the [[knowledge:id:...]] marker would
      // be gone on the next save, which is the silent-loss failure this file
      // has already been bitten by once.
      const markdownOf = (n: ChildNode): string => {
        if (n.nodeType !== Node.ELEMENT_NODE) return n.textContent ?? ''
        const el = n as Element
        const dataType = el.getAttribute('data-type')
        if (dataType === 'knowledgeMention' || dataType === 'agentMention') {
          const kind = dataType === 'knowledgeMention' ? 'knowledge' : 'agent'
          const id = el.getAttribute('data-id') ?? ''
          const label = el.getAttribute('data-label') ?? el.textContent ?? ''
          return `[[${kind}:${id}:${label}]]`
        }
        const inner = Array.from(el.childNodes).map(markdownOf).join('')
        // Only the two marks markdownToHtml emits are written back. Anything
        // else the DOM happens to carry contributes its text and no syntax,
        // which is what this branch did for every element before.
        if (el.nodeName === 'STRONG' || el.nodeName === 'B') return `**${inner}**`
        if (el.nodeName === 'CODE') return `\`${inner}\``
        return inner
      }

      node.childNodes.forEach(child => {
        if (child.nodeName === 'BR') {
          chunks.push('')
          return
        }
        appendToCurrent(markdownOf(child))
      })
      for (const chunk of chunks) {
        if (chunk.length > 0) blocks.push(chunk)
      }
    }
  })

  return blocks.join('\n\n')
}
