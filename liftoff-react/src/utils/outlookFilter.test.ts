import { describe, it, expect } from 'vitest'
import { parseOutlookAqs, aqsToOData, odataToAqs } from './outlookFilter'

describe('parseOutlookAqs', () => {
  it('returns empty tokens for blank input', () => {
    expect(parseOutlookAqs('')).toEqual({ ok: true, tokens: [] })
    expect(parseOutlookAqs('   ')).toEqual({ ok: true, tokens: [] })
  })

  it('parses a single from token', () => {
    expect(parseOutlookAqs('from:amy@acme.com')).toEqual({
      ok: true,
      tokens: [{ kind: 'from', value: 'amy@acme.com' }],
    })
  })

  it('parses to and category tokens', () => {
    expect(parseOutlookAqs('to:bob@acme.com')).toEqual({
      ok: true,
      tokens: [{ kind: 'to', value: 'bob@acme.com' }],
    })
    expect(parseOutlookAqs('category:work')).toEqual({
      ok: true,
      tokens: [{ kind: 'category', value: 'work' }],
    })
  })

  it('parses multiple tokens separated by whitespace', () => {
    const r = parseOutlookAqs('from:a@x.com to:b@x.com category:work')
    expect(r.ok).toBe(true)
    expect(r.tokens).toEqual([
      { kind: 'from', value: 'a@x.com' },
      { kind: 'to', value: 'b@x.com' },
      { kind: 'category', value: 'work' },
    ])
  })

  it('accepts uppercase keys', () => {
    expect(parseOutlookAqs('From:a@x.com').tokens?.[0]).toEqual({
      kind: 'from',
      value: 'a@x.com',
    })
  })

  it('rejects unsupported tokens', () => {
    expect(parseOutlookAqs('subject:hello')).toEqual({
      ok: false,
      badToken: 'subject:hello',
    })
  })

  it('rejects tokens without colons', () => {
    expect(parseOutlookAqs('hello world')).toEqual({ ok: false, badToken: 'hello' })
  })

  it("rejects values containing single quotes (breaks OData literal)", () => {
    expect(parseOutlookAqs("from:o'connor@acme.com").ok).toBe(false)
  })
})

describe('aqsToOData', () => {
  it('emits OData equality for from:', () => {
    expect(aqsToOData([{ kind: 'from', value: 'amy@acme.com' }])).toBe(
      "from/emailAddress/address eq 'amy@acme.com'",
    )
  })

  it('emits any() lambda for to:', () => {
    expect(aqsToOData([{ kind: 'to', value: 'bob@acme.com' }])).toBe(
      "toRecipients/any(r: r/emailAddress/address eq 'bob@acme.com')",
    )
  })

  it('emits any() lambda for category:', () => {
    expect(aqsToOData([{ kind: 'category', value: 'work' }])).toBe(
      "categories/any(c: c eq 'work')",
    )
  })

  it('ANDs multiple clauses', () => {
    expect(
      aqsToOData([
        { kind: 'from', value: 'a@x.com' },
        { kind: 'category', value: 'work' },
      ]),
    ).toBe("from/emailAddress/address eq 'a@x.com' and categories/any(c: c eq 'work')")
  })

  it('returns empty string for no tokens', () => {
    expect(aqsToOData([])).toBe('')
  })
})

describe('odataToAqs', () => {
  it('reverses a from clause', () => {
    expect(odataToAqs("from/emailAddress/address eq 'amy@acme.com'")).toBe('from:amy@acme.com')
  })

  it('reverses a to clause', () => {
    expect(
      odataToAqs("toRecipients/any(r: r/emailAddress/address eq 'bob@acme.com')"),
    ).toBe('to:bob@acme.com')
  })

  it('reverses a category clause', () => {
    expect(odataToAqs("categories/any(c: c eq 'work')")).toBe('category:work')
  })

  it('reverses an ANDed compound', () => {
    expect(
      odataToAqs(
        "from/emailAddress/address eq 'a@x.com' and categories/any(c: c eq 'work')",
      ),
    ).toBe('from:a@x.com category:work')
  })

  it('returns null for unsupported clauses (caller falls back to raw)', () => {
    expect(odataToAqs("subject eq 'invoice'")).toBeNull()
  })

  it('returns empty string for empty input', () => {
    expect(odataToAqs('')).toBe('')
  })

  it('round-trips with aqsToOData for the supported subset', () => {
    const aqs = 'from:a@x.com to:b@x.com category:work'
    const parsed = parseOutlookAqs(aqs)
    expect(parsed.ok).toBe(true)
    const odata = aqsToOData(parsed.tokens!)
    expect(odataToAqs(odata)).toBe(aqs)
  })
})
