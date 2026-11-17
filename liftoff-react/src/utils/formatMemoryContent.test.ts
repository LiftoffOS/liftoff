import { describe, it, expect } from 'vitest'
import { formatMemoryContent, prettifyToolNames, truncateOnWord } from './formatMemoryContent'

describe('prettifyToolNames', () => {
  it('reduces a fully-qualified MCP tool id to its final segment', () => {
    expect(prettifyToolNames('mcp__liftoff-tool-gateway__google-mail-14a82d9e__list_messages'))
      .toBe('list_messages')
    expect(prettifyToolNames('mcp__liftoff-tool-gateway__corpus_search')).toBe('corpus_search')
  })

  it('leaves non-MCP tool names untouched', () => {
    expect(prettifyToolNames('ToolSearch')).toBe('ToolSearch')
    expect(prettifyToolNames('Read')).toBe('Read')
  })

  it('prettifies every tool in a sequence without eating the separators', () => {
    const seq = 'ToolSearch → mcp__liftoff-tool-gateway__google-mail-14a82d9e__list_messages → Read'
    expect(prettifyToolNames(seq)).toBe('ToolSearch → list_messages → Read')
  })
})

describe('formatMemoryContent', () => {
  it('strips markdown bold and joins the Rule/Why/Applies lines', () => {
    const raw = '**Rule:** Use this tool sequence: ToolSearch → mcp__liftoff-tool-gateway__corpus_search\n**Why:** Completed task without errors\n**Applies when:** Similar tasks requiring ToolSearch'
    expect(formatMemoryContent(raw)).toBe(
      'Rule: Use this tool sequence: ToolSearch → corpus_search · Why: Completed task without errors · Applies when: Similar tasks requiring ToolSearch',
    )
  })

  it('leaves a plain single-line memory readable', () => {
    const raw = 'When generating spreadsheets for this user, always use xlsx format instead of csv.'
    expect(formatMemoryContent(raw)).toBe(raw)
  })

  it('has no leftover asterisks or newlines', () => {
    const out = formatMemoryContent('**Rule:** foo\n**Why:** bar')
    expect(out).not.toMatch(/\*/)
    expect(out).not.toMatch(/\n/)
  })
})

describe('truncateOnWord', () => {
  it('returns short strings unchanged', () => {
    expect(truncateOnWord('short text', 140)).toBe('short text')
  })

  it('never cuts in the middle of a word', () => {
    const text = 'the quick brown fox jumps over the lazy dog again and again'
    const out = truncateOnWord(text, 20)
    expect(out.endsWith('…')).toBe(true)
    // everything before the ellipsis is whole words
    const body = out.slice(0, -1).trimEnd()
    expect(text.startsWith(body)).toBe(true)
    expect(text[body.length] === ' ' || body.length === text.length).toBe(true)
  })

  it('hard-cuts a single oversized token as a fallback', () => {
    const out = truncateOnWord('x'.repeat(200), 140)
    expect(out.length).toBe(141) // 140 chars + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })
})
