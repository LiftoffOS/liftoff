import { describe, it, expect } from 'vitest'
import { toChatMessageItem } from './toChatMessageItem'

// The one mapping the three platform assistants' pages share. What it must do:
// move what the person SENT off the name the transcript reads as "what the
// team PRODUCED", and let everything else, including who else had a hand in
// the reply, through untouched.
describe('toChatMessageItem', () => {
  const stored = {
    id: 'm1',
    role: 'assistant' as const,
    content: 'Here is the team I propose.',
    createdAt: '2026-09-19T10:00:00.000Z',
    messageType: null,
    attachments: [
      { kind: 'upload' as const, name: 'brief.pdf' },
      { kind: 'connector' as const, name: 'Q3 plan', connectorType: 'notion' },
    ],
    contributors: [{ id: 'caio', label: 'Chief AI Officer' }],
    author: 'caio',
    authorLabel: 'Chief AI Officer',
    visualizationBlocks: [],
  }

  it('remaps attachments to sentAttachments and drops the original field', () => {
    const item = toChatMessageItem(stored)

    expect(item.sentAttachments).toEqual([
      { kind: 'upload', name: 'brief.pdf', connectorType: undefined },
      { kind: 'connector', name: 'Q3 plan', connectorType: 'notion' },
    ])
    expect('attachments' in item).toBe(false)
  })

  it('passes contributors, the surface\'s own fields and a null messageType through', () => {
    const item = toChatMessageItem(stored)

    expect(item.contributors).toEqual([{ id: 'caio', label: 'Chief AI Officer' }])
    expect(item.author).toBe('caio')
    expect(item.authorLabel).toBe('Chief AI Officer')
    expect(item.visualizationBlocks).toEqual([])
    expect(item.messageType).toBeNull()
  })

  it('leaves sentAttachments undefined when nothing was attached', () => {
    expect(toChatMessageItem({ ...stored, attachments: undefined }).sentAttachments).toBeUndefined()
    expect(toChatMessageItem({ ...stored, attachments: null }).sentAttachments).toBeUndefined()
  })
})
