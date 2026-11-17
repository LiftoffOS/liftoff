import { describe, it, expect } from 'vitest'
import { markdownPreviewLine, stripMarkdown } from './markdown'

/** Compact surfaces show model-authored text with no room to render it. The
 *  markers have to come off, because a card that prints `**bold**` reads as
 *  broken text rather than as emphasis. */
describe('stripMarkdown', () => {
  it('takes off bold, italic, and strikethrough markers', () => {
    expect(stripMarkdown('Grant it **Viewer** access')).toBe('Grant it Viewer access')
    expect(stripMarkdown('Grant it __Viewer__ access')).toBe('Grant it Viewer access')
    expect(stripMarkdown('Grant it *Viewer* access')).toBe('Grant it Viewer access')
    expect(stripMarkdown('Grant it ~~Editor~~ access')).toBe('Grant it Editor access')
  })

  it('keeps the code and drops the backticks', () => {
    expect(stripMarkdown('returned `undefined` for the sheet'))
      .toBe('returned undefined for the sheet')
  })

  it('keeps link and image text, not the target', () => {
    expect(stripMarkdown('See [the sheet](https://docs.google.com/x)')).toBe('See the sheet')
    expect(stripMarkdown('![a chart](https://example.com/c.png)')).toBe('a chart')
  })

  it('takes off line-leading block markers', () => {
    expect(stripMarkdown('## Access problem')).toBe('Access problem')
    expect(stripMarkdown('- Re-share the sheet')).toBe('Re-share the sheet')
    expect(stripMarkdown('1. Re-share the sheet')).toBe('Re-share the sheet')
    expect(stripMarkdown('> quoted')).toBe('quoted')
  })

  it('leaves plain text exactly as it is', () => {
    expect(stripMarkdown('Which spreadsheet holds the Q3 figures?'))
      .toBe('Which spreadsheet holds the Q3 figures?')
  })
})

describe('markdownPreviewLine', () => {
  it('previews the first line without its markup', () => {
    const question = [
      'Please do one or more of the following for spreadsheet **1G833gSE**:',
      '',
      '1. **Re-share the sheet** with the service account (id: `2b820bc9`).',
    ].join('\n')

    expect(markdownPreviewLine(question))
      .toBe('Please do one or more of the following for spreadsheet 1G833gSE:')
  })

  it('skips leading blank lines rather than previewing nothing', () => {
    expect(markdownPreviewLine('\n\nWhich sheet holds the figures?'))
      .toBe('Which sheet holds the figures?')
  })

  it('answers with an empty string when there is nothing to show', () => {
    expect(markdownPreviewLine('   \n  ')).toBe('')
  })
})
