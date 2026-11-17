import { describe, it, expect } from 'vitest'
import { splitMarkdownSections } from './markdownSections'
import { RESPONSIBILITIES_TEMPLATE, GUIDANCE_TEMPLATE } from '../components/guidanceTemplates'

describe('splitMarkdownSections', () => {
  it('splits a body into its headed sections, in source order', () => {
    const sections = splitMarkdownSections(
      '## Responsibilities\nOwns the brief.\n\n## Goals\nRep walks in ready.',
    )
    expect(sections).toEqual([
      { heading: 'Responsibilities', body: 'Owns the brief.' },
      { heading: 'Goals', body: 'Rep walks in ready.' },
    ])
  })

  it('covers every part of the responsibilities template', () => {
    expect(splitMarkdownSections(RESPONSIBILITIES_TEMPLATE).map(s => s.heading)).toEqual([
      'Responsibilities',
      'Goals',
      'Workflows',
      'Instructions',
      'Outcomes',
    ])
  })

  it('covers every part of the guidance template', () => {
    expect(splitMarkdownSections(GUIDANCE_TEMPLATE).map(s => s.heading)).toEqual([
      'Specific instructions',
      'Rules',
      'Constraints',
      'Edge cases',
      'Anything to avoid',
    ])
  })

  it('keeps text before the first heading as a headingless section', () => {
    expect(splitMarkdownSections('A lead-in line.\n\n## Goals\nShip it.')).toEqual([
      { heading: null, body: 'A lead-in line.' },
      { heading: 'Goals', body: 'Ship it.' },
    ])
  })

  it('returns one headingless section for a body with no headings', () => {
    expect(splitMarkdownSections('Just prose, no headings.')).toEqual([
      { heading: null, body: 'Just prose, no headings.' },
    ])
  })

  it('keeps multi-line bodies whole, blank lines and lists included', () => {
    const [section] = splitMarkdownSections('## Workflows\n1. Pull accounts\n\n2. Draft email\n')
    expect(section.body).toBe('1. Pull accounts\n\n2. Draft email')
  })

  it('reads any heading level', () => {
    expect(splitMarkdownSections('# One\na\n### Three\nb').map(s => s.heading))
      .toEqual(['One', 'Three'])
  })

  it('leaves a # inside a fenced block as content', () => {
    const sections = splitMarkdownSections('## Instructions\n```\n# not a heading\n```\nAfter.')
    expect(sections).toEqual([
      { heading: 'Instructions', body: '```\n# not a heading\n```\nAfter.' },
    ])
  })

  it('keeps a heading that has no body', () => {
    expect(splitMarkdownSections('## Outcomes')).toEqual([{ heading: 'Outcomes', body: '' }])
  })

  it('returns nothing for an empty body', () => {
    expect(splitMarkdownSections('')).toEqual([])
    expect(splitMarkdownSections('   \n\n')).toEqual([])
  })
})
