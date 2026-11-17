import { describe, it, expect } from 'vitest'
import {
  countEditedBlocks,
  draftFromMarkdown,
  draftIsEdited,
  inlineToText,
  joinProseBlocks,
  markdownFromDraft,
  markerFor,
  parseInline,
  splitProseBlocks,
} from './inlineProse'

// Lifted from accounts-payable-specialist.yaml, which is the shape this has to
// survive: a bold lead-in, numbered steps, and a step carrying a placeholder.
const WORKFLOW = `**Whenever a new incoming invoice email arrives:**
1. Extract the vendor name, invoice number and total amount
2. Verify the invoice total matches the sum of line items
3. If no PO match: create the Bill with a "No PO, Review Required" flag; {{connector:opt-team-chat}} an alert with the vendor and amount`

describe('splitProseBlocks', () => {
  it('separates a lead-in from the steps under it', () => {
    const blocks = splitProseBlocks(WORKFLOW)
    expect(blocks.map(b => b.kind)).toEqual(['lead', 'ol', 'ol', 'ol'])
    expect(blocks[0].text).toBe('**Whenever a new incoming invoice email arrives:**')
  })

  it('keeps a placeholder in the block text rather than resolving it', () => {
    const blocks = splitProseBlocks(WORKFLOW)
    expect(blocks[3].text).toContain('{{connector:opt-team-chat}}')
  })

  it('joins a step the catalog wrapped over several indented lines', () => {
    // content-repurposing-specialist.yaml writes steps this way. Treating each
    // source line as its own block would shatter one step into fragments.
    const blocks = splitProseBlocks([
      '4. {{connector:req-documents}}',
      '   from so a set stays together in a list. When a newsletter platform is',
      '   connected, prepare the issue there.',
    ].join('\n'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('ol')
    expect(blocks[0].text).toBe(
      '{{connector:req-documents}} from so a set stays together in a list. ' +
      'When a newsletter platform is connected, prepare the issue there.',
    )
  })

  it('ends a block at a blank line', () => {
    const blocks = splitProseBlocks('First paragraph.\n\nSecond paragraph.')
    expect(blocks.map(b => b.text)).toEqual(['First paragraph.', 'Second paragraph.'])
  })

  it('reads bullets as their own kind', () => {
    const blocks = splitProseBlocks('- Never send without approval\n- Always log the email')
    expect(blocks.map(b => b.kind)).toEqual(['ul', 'ul'])
    expect(blocks[0].text).toBe('Never send without approval')
  })
})

describe('markerFor', () => {
  it('numbers a step by its position, not by what the source said', () => {
    const blocks = splitProseBlocks(WORKFLOW)
    expect([0, 1, 2, 3].map(i => markerFor(blocks, i))).toEqual(['', '1.', '2.', '3.'])
  })

  it('renumbers the steps below an inserted one', () => {
    const blocks = splitProseBlocks(WORKFLOW)
    blocks.splice(2, 0, { kind: 'ol', text: 'Check for a duplicate bill' })
    expect([1, 2, 3, 4].map(i => markerFor(blocks, i))).toEqual(['1.', '2.', '3.', '4.'])
  })

  it('restarts numbering after a non-list block breaks the run', () => {
    const blocks = splitProseBlocks('1. One\n2. Two\n\n**Next:**\n1. Fresh')
    expect(markerFor(blocks, 3)).toBe('1.')
  })
})

describe('markdownFromDraft', () => {
  it('round-trips a template body through a draft unchanged in meaning', () => {
    const source = `## Workflows\n${WORKFLOW}\n\n## Outcomes\nEvery invoice processed within 24 hours.`
    const draft = draftFromMarkdown(source)
    const out = markdownFromDraft(draft)

    expect(out).toContain('## Workflows')
    expect(out).toContain('## Outcomes')
    // The thing that must never be lost: placeholders survive the round trip,
    // because the backend resolves them against the person's real connections.
    expect(out).toContain('{{connector:opt-team-chat}}')
    expect(draftFromMarkdown(out)).toEqual(draft)
  })

  it('keeps a placeholder after the line holding it is rewritten', () => {
    const draft = draftFromMarkdown(`## Workflows\n${WORKFLOW}`)
    draft[0].blocks[3] = {
      ...draft[0].blocks[3],
      text: 'If no PO match: flag it and {{connector:opt-team-chat}} the finance lead',
      edited: true,
    }
    expect(markdownFromDraft(draft)).toContain('{{connector:opt-team-chat}}')
  })

  it('renumbers in the output after a step is inserted', () => {
    const draft = draftFromMarkdown(`## Workflows\n${WORKFLOW}`)
    draft[0].blocks.splice(2, 0, { kind: 'ol', text: 'Check for a duplicate', edited: true })
    const out = markdownFromDraft(draft)
    expect(out).toContain('2. Check for a duplicate')
    expect(out).toContain('3. Verify the invoice total')
    expect(out).toContain('4. If no PO match')
  })

  it('drops a heading whose lines were all removed without leaving a stray', () => {
    const draft = draftFromMarkdown('## Rules\n- One rule')
    draft[0].blocks = []
    expect(markdownFromDraft(draft)).toBe('## Rules')
  })
})

describe('draft state helpers', () => {
  it('reports a draft as unedited until a line is marked', () => {
    const draft = draftFromMarkdown(`## Workflows\n${WORKFLOW}`)
    expect(draftIsEdited(draft)).toBe(false)
    expect(countEditedBlocks(draft)).toBe(0)
    draft[0].blocks[1].edited = true
    expect(draftIsEdited(draft)).toBe(true)
    expect(countEditedBlocks(draft)).toBe(1)
  })
})

describe('parseInline', () => {
  it('pulls a placeholder out as its own segment', () => {
    const segments = parseInline('flag it; {{connector:opt-team-chat}} an alert')
    expect(segments).toEqual([
      { kind: 'text', text: 'flag it; ' },
      { kind: 'token', token: 'connector:opt-team-chat' },
      { kind: 'text', text: ' an alert' },
    ])
  })

  it('reads bold and inline code, the only inline markdown the catalog uses', () => {
    expect(parseInline('**Payment runs:**')).toEqual([{ kind: 'text', text: 'Payment runs:', bold: true }])
    expect(parseInline('set `dry_run` first')).toEqual([
      { kind: 'text', text: 'set ' },
      { kind: 'code', text: 'dry_run' },
      { kind: 'text', text: ' first' },
    ])
  })

  it('is inverted exactly by inlineToText', () => {
    const source = '**Note:** post to {{pick:alert-channel}} with `--force` set'
    expect(inlineToText(parseInline(source))).toBe(source)
  })

  it('leaves an unmatched asterisk alone rather than dropping it', () => {
    expect(inlineToText(parseInline('2 * 3 = 6'))).toBe('2 * 3 = 6')
  })

  it('makes a bare {{id}} a token when the template declares that input', () => {
    const declared = (id: string) => id === 'company_website'
    expect(parseInline('Read {{company_website}} weekly', declared)).toEqual([
      { kind: 'text', text: 'Read ' },
      { kind: 'token', token: 'company_website' },
      { kind: 'text', text: ' weekly' },
    ])
  })

  it('leaves a bare {{id}} the template does not declare as literal text', () => {
    // Somebody's own words, or an example. Swallowing it would be worse than
    // showing it, which is the trade the prefixed forms do not have to make.
    const declared = (id: string) => id === 'company_website'
    expect(parseInline('name it {{final_v2}} please', declared)).toEqual([
      { kind: 'text', text: 'name it {{final_v2}} please' },
    ])
  })

  it('leaves every bare {{id}} alone when no template is in hand', () => {
    expect(parseInline('Read {{company_website}} weekly')).toEqual([
      { kind: 'text', text: 'Read {{company_website}} weekly' },
    ])
  })

  it('keeps a bold run that carries a placeholder bold', () => {
    // The defect this model exists for: tokenising first cut the run at the
    // placeholder, neither half still looked like `**...**`, and the reader
    // got the asterisks.
    expect(parseInline('**keep it in {{pick:working-folder}} always**')).toEqual([
      { kind: 'text', text: 'keep it in ', bold: true },
      { kind: 'token', token: 'pick:working-folder', bold: true },
      { kind: 'text', text: ' always', bold: true },
    ])
  })

  it('round-trips a bold run carrying a placeholder as ONE bold run', () => {
    const source = '**keep it in {{pick:working-folder}} always** and then stop'
    expect(inlineToText(parseInline(source))).toBe(source)
  })

  it('leaves a placeholder outside a bold run unbolded', () => {
    expect(parseInline('**Heading:** post to {{pick:alert-channel}}')).toEqual([
      { kind: 'text', text: 'Heading:', bold: true },
      { kind: 'text', text: ' post to ' },
      { kind: 'token', token: 'pick:alert-channel' },
    ])
  })

  it('round-trips an input token back to its braces', () => {
    const declared = () => true
    const source = 'Argue from {{company_website}} only'
    expect(inlineToText(parseInline(source, declared))).toBe(source)
  })
})

describe('joinProseBlocks', () => {
  it('keeps list items contiguous and separates everything else by a blank line', () => {
    const blocks = splitProseBlocks(WORKFLOW)
    const out = joinProseBlocks(blocks)
    expect(out).toBe([
      '**Whenever a new incoming invoice email arrives:**',
      '',
      '1. Extract the vendor name, invoice number and total amount',
      '2. Verify the invoice total matches the sum of line items',
      '3. If no PO match: create the Bill with a "No PO, Review Required" flag; ' +
        '{{connector:opt-team-chat}} an alert with the vendor and amount',
    ].join('\n'))
  })
})
