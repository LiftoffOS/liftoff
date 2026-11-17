// Which held arguments a reviewer can edit, and what happens to the rest.
//
// The point of the editor is that what shipped is what was reviewed. Two ways
// that fails quietly: an argument nobody was shown gets dropped on the way out,
// and an untouched draft is recorded as an override.

import { describe, it, expect } from 'vitest'
import { editableFieldsOf, withEditedFields, hasRealEdits } from './editableToolInput'

const INPUT = {
  to: 'buyer@example.com',
  subject: 'Your quote',
  body: 'We can offer this at 5,000. '.repeat(6),
  amount: 5000,
  threadId: 'abc-123',
  attachments: [{ name: 'quote.pdf' }],
  metadata: { source: 'crm' },
  apiKey: 'sk-live-secret',
}

describe('editableFieldsOf', () => {
  it('offers the text and number arguments a person would adjust', () => {
    const paths = editableFieldsOf(INPUT).map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(['to', 'subject', 'body', 'amount']))
  })

  it('does not offer nested structures, which cannot be edited safely by hand', () => {
    const paths = editableFieldsOf(INPUT).map((f) => f.path)
    expect(paths).not.toContain('attachments')
    expect(paths).not.toContain('metadata')
  })

  it('never offers a secret, whose value is not even shown', () => {
    // The read-only row renders "Hidden". An editor over it would write the
    // mask back as though it were the credential.
    expect(editableFieldsOf(INPUT).map((f) => f.path)).not.toContain('apiKey')
  })

  it('gives long text room and short text a line', () => {
    const fields = editableFieldsOf(INPUT)
    expect(fields.find((f) => f.path === 'body')?.multiline).toBe(true)
    expect(fields.find((f) => f.path === 'subject')?.multiline).toBe(false)
  })

  it('treats anything with a newline as long, however short', () => {
    expect(editableFieldsOf({ note: 'one\ntwo' })[0].multiline).toBe(true)
  })

  it('labels a field the way a person reads it', () => {
    expect(editableFieldsOf({ thread_id: 'x' })[0].label).toBe('Thread id')
  })

  it('returns nothing for a call with no editable arguments', () => {
    expect(editableFieldsOf({ ids: ['a'], nested: { x: 1 } })).toEqual([])
    expect(editableFieldsOf(null)).toEqual([])
  })
})

describe('withEditedFields', () => {
  it('carries every untouched argument through', () => {
    // A partial object would reach the runtime as an edit that deleted
    // everything the editor happened not to show.
    const next = withEditedFields(INPUT, 'subject', 'Revised quote')
    expect(next.attachments).toBe(INPUT.attachments)
    expect(next.apiKey).toBe(INPUT.apiKey)
    expect(next.subject).toBe('Revised quote')
  })

  it('sends a number back as a number', () => {
    // A tool that declared an integer and receives "4500" rejects it, and the
    // reviewer has no way to see why.
    expect(withEditedFields(INPUT, 'amount', '4500').amount).toBe(4500)
  })

  it('keeps a half-typed number as text so the box stays usable', () => {
    expect(withEditedFields(INPUT, 'amount', '').amount).toBe('')
    expect(withEditedFields(INPUT, 'amount', '-').amount).toBe('-')
  })

  it('leaves a text field as text even when it looks numeric', () => {
    expect(withEditedFields(INPUT, 'subject', '2026').subject).toBe('2026')
  })

  it('does not mutate the original', () => {
    withEditedFields(INPUT, 'subject', 'changed')
    expect(INPUT.subject).toBe('Your quote')
  })
})

describe('hasRealEdits', () => {
  it('is false when the reviewer opened the editor and changed nothing', () => {
    expect(hasRealEdits(INPUT, { ...INPUT })).toBe(false)
  })

  it('ignores key order', () => {
    expect(hasRealEdits({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false)
  })

  it('is true for a changed value', () => {
    expect(hasRealEdits(INPUT, { ...INPUT, subject: 'Revised' })).toBe(true)
  })

  it('is true for a removed argument, which is the edit that matters most', () => {
    const { subject: _subject, ...withoutSubject } = INPUT
    expect(hasRealEdits(INPUT, withoutSubject)).toBe(true)
  })

  it('is false when there is no edited version at all', () => {
    expect(hasRealEdits(INPUT, undefined)).toBe(false)
  })
})
