import { describe, it, expect } from 'vitest'
import { validateBindingFilter } from './validateBindingFilter'

describe('validateBindingFilter — google_mail', () => {
  it('passes the empty string (caller may not have configured a filter)', () => {
    expect(validateBindingFilter('google_mail', '')).toEqual({ ok: true })
    expect(validateBindingFilter('google_mail', '   ')).toEqual({ ok: true })
  })

  it('accepts single supported operators', () => {
    expect(validateBindingFilter('google_mail', 'label:support-agent').ok).toBe(true)
    expect(validateBindingFilter('google_mail', 'to:hello@example.com').ok).toBe(true)
    expect(validateBindingFilter('google_mail', 'from:billing@example.com').ok).toBe(true)
  })

  it('accepts combinations and parenthesised groups', () => {
    expect(
      validateBindingFilter(
        'google_mail',
        'label:support-agent to:hello@example.com',
      ).ok,
    ).toBe(true)
    expect(
      validateBindingFilter('google_mail', '(label:support-agent OR label:urgent)').ok,
    ).toBe(true)
  })

  it('flags unsupported operators with a non-blocking warning', () => {
    const r = validateBindingFilter('google_mail', 'is:unread')
    expect(r.ok).toBe(false)
    expect(r.warning).toMatch(/Filter uses syntax outside the supported subset/)
    expect(r.warning).toMatch(/label:, to:, from:/)
  })

  it('flags mixed valid + invalid as not-ok (single bad token taints the whole filter)', () => {
    const r = validateBindingFilter('google_mail', 'label:support-agent has:attachment')
    expect(r.ok).toBe(false)
  })

  it('is case-insensitive on operator names', () => {
    expect(validateBindingFilter('google_mail', 'LABEL:support').ok).toBe(true)
    expect(validateBindingFilter('google_mail', 'FROM:noreply@example.com').ok).toBe(true)
  })
})

describe('validateBindingFilter — microsoft_outlook_mail', () => {
  it('passes the empty string', () => {
    expect(validateBindingFilter('microsoft_outlook_mail', '').ok).toBe(true)
  })

  it('accepts a single from/.../eq clause', () => {
    expect(
      validateBindingFilter(
        'microsoft_outlook_mail',
        "from/emailAddress/address eq 'support@example.com'",
      ).ok,
    ).toBe(true)
  })

  it('accepts toRecipients/any(...)', () => {
    expect(
      validateBindingFilter(
        'microsoft_outlook_mail',
        "toRecipients/any(r:r/emailAddress/address eq 'support@example.com')",
      ).ok,
    ).toBe(true)
  })

  it('accepts categories/any(...)', () => {
    expect(
      validateBindingFilter(
        'microsoft_outlook_mail',
        "categories/any(c:c eq 'Tier 1')",
      ).ok,
    ).toBe(true)
  })

  it('accepts AND-joined supported clauses (case-insensitive)', () => {
    expect(
      validateBindingFilter(
        'microsoft_outlook_mail',
        "from/emailAddress/address eq 'a@x.com' and toRecipients/any(r:r/emailAddress/address eq 'b@x.com')",
      ).ok,
    ).toBe(true)
    expect(
      validateBindingFilter(
        'microsoft_outlook_mail',
        "from/emailAddress/address eq 'a@x.com' AND categories/any(c:c eq 'Urgent')",
      ).ok,
    ).toBe(true)
  })

  it('flags unsupported operators (isRead, subject contains, etc.)', () => {
    const r1 = validateBindingFilter('microsoft_outlook_mail', 'isRead eq false')
    expect(r1.ok).toBe(false)
    expect(r1.warning).toMatch(/from\/.*\/eq/)

    const r2 = validateBindingFilter(
      'microsoft_outlook_mail',
      "contains(subject, 'urgent')",
    )
    expect(r2.ok).toBe(false)
  })

  it('flags mixed supported + unsupported AND-joined clauses', () => {
    const r = validateBindingFilter(
      'microsoft_outlook_mail',
      "from/emailAddress/address eq 'a@x.com' and isRead eq false",
    )
    expect(r.ok).toBe(false)
  })
})
