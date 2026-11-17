// Unit tests for filterKnowledgeMentionItems, the markdown↔HTML
// converters, and transformPastedHTML — the paste preprocessor that
// makes the TipTap-backed MarkdownTextarea robust against pasted lists
// and <br>s.

import { describe, expect, it } from 'vitest'
import {
  filterKnowledgeMentionItems,
  markdownToHtml,
  htmlToMarkdown,
  transformPastedHTML,
} from './markdownConversion'
import type { KnowledgeMentionItem } from './KnowledgeMentionList'

const zd1: KnowledgeMentionItem = { id: 'k1', title: 'Password Reset', connectorId: 'c-zd' }
const zd2: KnowledgeMentionItem = { id: 'k2', title: 'Refund Policy', connectorId: 'c-zd' }
const gd1: KnowledgeMentionItem = { id: 'k3', title: 'Onboarding Doc', connectorId: 'c-gd' }
const manual: KnowledgeMentionItem = { id: 'k4', title: 'Manual URL', connectorId: null }

describe('filterKnowledgeMentionItems', () => {
  it('returns only items from bound connectors plus manual-URL items', () => {
    const out = filterKnowledgeMentionItems([zd1, zd2, gd1, manual], '', ['c-zd'])
    expect(out.map(i => i.id).sort()).toEqual(['k1', 'k2', 'k4'])
  })

  it('returns only manual items when no connectors are bound', () => {
    const out = filterKnowledgeMentionItems([zd1, zd2, gd1, manual], '', [])
    expect(out.map(i => i.id)).toEqual(['k4'])
  })

  it('applies case-insensitive title substring match', () => {
    const out = filterKnowledgeMentionItems([zd1, zd2, gd1, manual], 'REFUND', ['c-zd', 'c-gd'])
    expect(out.map(i => i.id)).toEqual(['k2'])
  })

  it('caps results at 8 even when more match', () => {
    const many: KnowledgeMentionItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `id-${i}`, title: `Doc ${i}`, connectorId: 'c-zd',
    }))
    const out = filterKnowledgeMentionItems(many, 'doc', ['c-zd'])
    expect(out).toHaveLength(8)
  })

  it('always allows manual-URL items regardless of bound connectors', () => {
    expect(filterKnowledgeMentionItems([manual], '', [])).toEqual([manual])
    expect(filterKnowledgeMentionItems([manual], '', ['c-zd'])).toEqual([manual])
  })

  it('excludes items from unbound connectors entirely', () => {
    const out = filterKnowledgeMentionItems([zd1, gd1], '', ['c-other'])
    expect(out).toEqual([])
  })
})

// Markdown↔HTML round-trip. TipTap stores each paragraph as a <p>; we have
// to emit `\n\n` between them (CommonMark paragraph break) so that the
// read-only ReactMarkdown render preserves the user's line breaks. Single
// `\n` is a soft break in CommonMark and gets collapsed to a space, which
// is the symptom users were reporting.

describe('markdownToHtml', () => {
  it('returns empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('')
  })

  it('wraps a single paragraph in <p>', () => {
    expect(markdownToHtml('Hello world')).toBe('<p>Hello world</p>')
  })

  it('emits separate <p> blocks for paragraphs separated by \\n\\n', () => {
    expect(markdownToHtml('Para A\n\nPara B')).toBe('<p>Para A</p><p>Para B</p>')
  })

  it('normalises legacy single-\\n storage into separate <p> blocks', () => {
    // Older stored values used a single `\n` per paragraph. The new
    // converter heals them into proper paragraph blocks.
    expect(markdownToHtml('Line one\nLine two')).toBe('<p>Line one</p><p>Line two</p>')
  })

  it('collapses runs of blank lines so round-tripped data does not re-inflate', () => {
    expect(markdownToHtml('A\n\n\n\nB')).toBe('<p>A</p><p>B</p>')
  })

  // Prose written outside this editor is hard-wrapped, and every wrapped line
  // used to become its own paragraph — sentences visibly broke mid-clause when
  // an agent template was opened in the team builder. A lower-case opening is
  // what marks the back half of a wrapped sentence.
  it('rejoins a sentence its author hard-wrapped', () => {
    expect(markdownToHtml('Tracks each competitor and summarizes\nwhat changed, for live\ndeals.'))
      .toBe('<p>Tracks each competitor and summarizes what changed, for live deals.</p>')
  })

  it('keeps numbered items apart while rejoining their wrapped tails', () => {
    const md = '1. Review their homepage, changelog, open\njob postings.\n2. Compare against last\nweek.'
    expect(markdownToHtml(md)).toBe(
      '<p>1. Review their homepage, changelog, open job postings.</p><p>2. Compare against last week.</p>',
    )
  })

  it('starts a new block on a bolded run-in heading, and renders the mark', () => {
    const md = 'Refresh the card.\n**Battle cards:** maintain one per competitor with\na consistent structure.'
    expect(markdownToHtml(md)).toBe(
      '<p>Refresh the card.</p><p><strong>Battle cards:</strong> maintain one per competitor with a consistent structure.</p>',
    )
  })

  it('renders inline code, which five templates use for CRM field names', () => {
    expect(markdownToHtml('Stamp `last_enriched_at` on every record'))
      .toBe('<p>Stamp <code>last_enriched_at</code> on every record</p>')
  })

  it('leaves a lone asterisk alone', () => {
    expect(markdownToHtml('2 * 3 = 6')).toBe('<p>2 * 3 = 6</p>')
  })

  it('does not reach inside a mention marker to emphasise its label', () => {
    // The label is carried on data-label, so a `**` inside one must not be
    // rewritten mid-marker: the marker regex would stop matching and the
    // mention would be gone with nothing reporting it.
    expect(markdownToHtml('See [[knowledge:k1:a **b** c]] first'))
      .toBe('<p>See <span data-type="knowledgeMention" data-id="k1" data-label="a **b** c">a **b** c</span> first</p>')
  })

  it('does not weld a wrapped line onto a heading', () => {
    expect(markdownToHtml('## Workflows\nrun the sweep every Monday.'))
      .toBe('<h2>Workflows</h2><p>run the sweep every Monday.</p>')
  })

  it('recognises a leading "## " as an <h2>', () => {
    expect(markdownToHtml('## Heading\n\nBody')).toBe('<h2>Heading</h2><p>Body</p>')
  })

  it('escapes HTML in <h2> content', () => {
    expect(markdownToHtml('## <script>')).toBe('<h2>&lt;script&gt;</h2>')
  })

  it('handles \\r\\n line endings (Windows clipboard)', () => {
    expect(markdownToHtml('A\r\n\r\nB')).toBe('<p>A</p><p>B</p>')
  })

  it('escapes HTML in paragraph content too, not just headings', () => {
    expect(markdownToHtml('use <div> for layout')).toBe('<p>use &lt;div&gt; for layout</p>')
  })
})

// These are the characters an operator actually types into a responsibilities
// field. Before the paragraph branch escaped, htmlToMarkdown parsed them as
// real markup on the way back and the value was silently rewritten on every
// keystroke: `<` ate the rest of the sentence, `&amp;` shed its entity.
describe('markdown→HTML→markdown preserves literal characters', () => {
  const roundTrip = (s: string) => htmlToMarkdown(markdownToHtml(s))

  it('keeps an apostrophe', () => {
    expect(roundTrip("What's the best beer garden")).toBe("What's the best beer garden")
  })

  it('keeps angle brackets instead of truncating at the first one', () => {
    expect(roundTrip('use <div> for layout')).toBe('use <div> for layout')
  })

  it('keeps an ampersand', () => {
    expect(roundTrip('Fish & Chips')).toBe('Fish & Chips')
  })

  it('keeps an entity the operator typed literally', () => {
    expect(roundTrip('a &amp; b')).toBe('a &amp; b')
  })

  it('keeps a double quote', () => {
    expect(roundTrip('the "primary" contact')).toBe('the "primary" contact')
  })

  it('is stable over repeated saves', () => {
    const original = 'Escalate if <urgent> & flagged "P1"'
    expect(roundTrip(roundTrip(roundTrip(original)))).toBe(original)
  })

  it('keeps a mention label containing an ampersand', () => {
    const original = 'See [[knowledge:k1:Terms & Conditions]] first'
    expect(roundTrip(original)).toBe(original)
  })

  // Bold and inline code are marks now. Every one of these would come back
  // stripped if htmlToMarkdown read <strong> as textContent, which is how the
  // catalog's 202 bold runs would have been erased on the first save.
  it('keeps a bold run', () => {
    expect(roundTrip('**Battle cards:** one per competitor')).toBe('**Battle cards:** one per competitor')
  })

  it('keeps inline code', () => {
    expect(roundTrip('Stamp `last_enriched_at` on it')).toBe('Stamp `last_enriched_at` on it')
  })

  it('keeps a bold run and inline code in one line', () => {
    const original = '**Refresh:** set `lead_score` and stamp it'
    expect(roundTrip(original)).toBe(original)
  })

  it('is stable over repeated saves with marks present', () => {
    const original = '**Battle cards:** check `lead_score` before writing'
    expect(roundTrip(roundTrip(roundTrip(original)))).toBe(original)
  })

  it('keeps a mention that a bold run wraps', () => {
    // A mark CAN wrap an inline node, and flattening one to textContent loses
    // the marker. This is the case the recursive walk exists for.
    const original = '**See [[knowledge:k1:Runbook]] first**'
    expect(roundTrip(original)).toBe(original)
  })

  it('keeps a placeholder token inside a bold run', () => {
    const original = '**Post to {{pick:alert-channel}} first**'
    expect(roundTrip(original)).toBe(original)
  })
})

describe('htmlToMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('')
  })

  it('extracts a single paragraph', () => {
    expect(htmlToMarkdown('<p>Hello world</p>')).toBe('Hello world')
  })

  it('joins multiple <p> blocks with \\n\\n (CommonMark paragraph break)', () => {
    // Critical: ReactMarkdown collapses single-\n joins to a space at
    // render time, which is what the original bug was. Double-newline is
    // the correct paragraph separator.
    expect(htmlToMarkdown('<p>Para A</p><p>Para B</p>')).toBe('Para A\n\nPara B')
  })

  it('drops empty <p> blocks instead of letting them inflate over saves', () => {
    expect(htmlToMarkdown('<p>A</p><p></p><p>B</p>')).toBe('A\n\nB')
  })

  it('preserves an <h2> heading as `## `', () => {
    expect(htmlToMarkdown('<h2>Heading</h2><p>Body</p>')).toBe('## Heading\n\nBody')
  })

  it('round-trips a multi-paragraph value through markdown→HTML→markdown', () => {
    const original = 'First paragraph.\n\nSecond paragraph.\n\nThird.'
    expect(htmlToMarkdown(markdownToHtml(original))).toBe(original)
  })

  it('preserves [[knowledge:]] markers verbatim through round-trip', () => {
    const html =
      '<p>See <span data-type="knowledgeMention" data-id="k1" data-label="Refund Policy">Refund Policy</span> for context.</p>'
    expect(htmlToMarkdown(html)).toBe('See [[knowledge:k1:Refund Policy]] for context.')
  })

  it('preserves [[agent:]] markers verbatim through round-trip', () => {
    const html =
      '<p>Escalate to <span data-type="agentMention" data-id="a1" data-label="Compliance">Compliance</span>.</p>'
    expect(htmlToMarkdown(html)).toBe('Escalate to [[agent:a1:Compliance]].')
  })

  // <br> handling. TipTap's clipboard text parser converts each `\n` in
  // pasted plain text into a hard-break <br> INSIDE the surrounding <p>,
  // not a paragraph split. StarterKit's HardBreak extension also produces
  // <br> for Shift+Enter. textContent on <br> is '', so the old converter
  // silently ate every soft break. We now split the paragraph on each <br>
  // so every visual line becomes its own markdown block.

  it('splits paragraph on <br> so a pasted multi-line block survives save', () => {
    expect(htmlToMarkdown('<p>Line one<br>Line two<br>Line three</p>')).toBe(
      'Line one\n\nLine two\n\nLine three',
    )
  })

  it('preserves text around <br> inside the same paragraph', () => {
    expect(htmlToMarkdown('<p>A<br>B</p>')).toBe('A\n\nB')
  })

  it('collapses consecutive <br><br> to a single paragraph break', () => {
    expect(htmlToMarkdown('<p>A<br><br>B</p>')).toBe('A\n\nB')
  })

  it('preserves [[knowledge:]] markers across <br>-delimited lines', () => {
    const html =
      '<p>See <span data-type="knowledgeMention" data-id="k1" data-label="Refund">Refund</span><br>for context.</p>'
    expect(htmlToMarkdown(html)).toBe('See [[knowledge:k1:Refund]]\n\nfor context.')
  })

  it('handles <br>-delimited content across multiple <p> blocks', () => {
    expect(htmlToMarkdown('<p>A<br>B</p><p>C<br>D</p>')).toBe('A\n\nB\n\nC\n\nD')
  })
})

// transformPastedHTML: the paste preprocessor that runs on incoming HTML
// BEFORE TipTap parses it. The editor schema disables lists / blockquote /
// hardBreak / etc., so without preprocessing TipTap strips list structure
// and the items get concatenated into one paragraph (exactly the symptom
// users hit when pasting bulleted responsibilities). The preprocessor
// flattens those shapes into a clean sequence of <p> blocks.

describe('transformPastedHTML', () => {
  it('returns plain HTML unchanged when it has no list / br / wrapper nodes', () => {
    expect(transformPastedHTML('<p>Hello</p><p>World</p>')).toBe('<p>Hello</p><p>World</p>')
  })

  it('converts <br> to a paragraph split', () => {
    expect(transformPastedHTML('<p>A<br>B</p>')).toBe('<p>A</p><p>B</p>')
  })

  it('handles self-closing <br/> and uppercase <BR>', () => {
    expect(transformPastedHTML('<p>A<br/>B<BR>C</p>')).toBe('<p>A</p><p>B</p><p>C</p>')
  })

  it('converts <li> wrappers to <p> so list items survive', () => {
    expect(transformPastedHTML('<ul><li>Item A</li><li>Item B</li></ul>')).toBe(
      '<p>Item A</p><p>Item B</p>',
    )
  })

  it('flattens an ordered list the same way', () => {
    expect(transformPastedHTML('<ol><li>1. First</li><li>2. Second</li></ol>')).toBe(
      '<p>1. First</p><p>2. Second</p>',
    )
  })

  it('preserves attributes on <li> while still flattening to <p>', () => {
    expect(transformPastedHTML('<ol><li class="foo" data-x="y">Item</li></ol>')).toBe(
      '<p>Item</p>',
    )
  })

  it('strips wrapping <div>/<section>/<article> blocks without losing content', () => {
    expect(
      transformPastedHTML(
        '<div><section><p>Inside</p></section></div>',
      ),
    ).toBe('<p>Inside</p>')
  })

  it('strips definition list wrappers (<dl>/<dt>/<dd>)', () => {
    expect(
      transformPastedHTML('<dl><dt>Term</dt><dd>Definition</dd></dl>'),
    ).toBe('TermDefinition')
  })

  it('handles a real-world list-style paste from a rendered markdown source', () => {
    // This is roughly the shape of what a copy-from-chat clipboard payload
    // looks like when the source was a rendered markdown bullet list.
    const pasted =
      '<ol><li>Read the customer\'s full email.</li>' +
      '<li>Categorize by issue type.</li>' +
      '<li>Search the help center.</li></ol>'
    expect(transformPastedHTML(pasted)).toBe(
      '<p>Read the customer\'s full email.</p>' +
      '<p>Categorize by issue type.</p>' +
      '<p>Search the help center.</p>',
    )
  })

  it('combines <br> and list flattening in one pass', () => {
    expect(
      transformPastedHTML('<p>Intro<br>continued.</p><ul><li>One</li><li>Two</li></ul>'),
    ).toBe('<p>Intro</p><p>continued.</p><p>One</p><p>Two</p>')
  })
})
