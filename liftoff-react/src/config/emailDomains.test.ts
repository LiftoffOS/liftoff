/**
 * The login page's email-domain allow-list.
 *
 * The allow-list is read from import.meta.env at MODULE LOAD, so every case
 * stubs the env and re-imports the module rather than calling a setter. That
 * mirrors how the real build works: the value is compiled into the bundle.
 *
 * The property that matters most is the default. An empty or absent
 * VITE_ALLOWED_EMAIL_DOMAINS must mean NO restriction, because a deployment
 * that leaves it unset expects open signup and a regression here would close it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

type EmailDomains = typeof import('./emailDomains')

async function loadWith(value: string | undefined): Promise<EmailDomains> {
  vi.resetModules()
  if (value === undefined) {
    vi.stubEnv('VITE_ALLOWED_EMAIL_DOMAINS', '')
  } else {
    vi.stubEnv('VITE_ALLOWED_EMAIL_DOMAINS', value)
  }
  return await import('./emailDomains')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('with no allow-list configured (the default)', () => {
  it('imposes no restriction at all', async () => {
    const m = await loadWith(undefined)
    expect(m.isEmailDomainRestricted()).toBe(false)
    expect(m.isEmailDomainAllowed('person@example.com')).toBe(true)
    expect(m.isEmailDomainAllowed('someone@example.org')).toBe(true)
  })

  it('does not constrain the Google account chooser', async () => {
    const m = await loadWith(undefined)
    expect(m.googleHostedDomain()).toBeUndefined()
  })

  it('treats a whitespace-only value as absent', async () => {
    const m = await loadWith('  ,   , ')
    expect(m.isEmailDomainRestricted()).toBe(false)
    expect(m.isEmailDomainAllowed('person@example.com')).toBe(true)
  })
})

describe('with a single domain configured', () => {
  it('accepts that domain and refuses every other', async () => {
    const m = await loadWith('acme.com')
    expect(m.isEmailDomainAllowed('person@acme.com')).toBe(true)
    expect(m.isEmailDomainAllowed('person@gmail.com')).toBe(false)
    expect(m.isEmailDomainAllowed('person@acme.co')).toBe(false)
  })

  it('is case-insensitive on both the address and the list', async () => {
    const m = await loadWith(' Acme.COM ')
    expect(m.isEmailDomainAllowed('Person@ACME.com')).toBe(true)
  })

  it('refuses an address with no domain part', async () => {
    const m = await loadWith('acme.com')
    expect(m.isEmailDomainAllowed('')).toBe(false)
    expect(m.isEmailDomainAllowed('operator')).toBe(false)
    expect(m.isEmailDomainAllowed('operator@')).toBe(false)
  })

  // Matches the backend's isEmailDomainAllowed, which splits on '@' and takes
  // index 1. Both sides must agree or the login page would admit an address the
  // API then refuses.
  it('refuses a double-@ address, as the backend does', async () => {
    const m = await loadWith('acme.com')
    expect(m.isEmailDomainAllowed('operator@evil@acme.com')).toBe(false)
  })

  it('hints the Google chooser at that domain', async () => {
    const m = await loadWith('acme.com')
    expect(m.googleHostedDomain()).toBe('acme.com')
  })

  it('names the domain in the message the toast shows', async () => {
    const m = await loadWith('acme.com')
    expect(m.domainNotAllowedMessage()).toContain('acme.com')
  })
})

describe('with several domains configured', () => {
  it('accepts any of them', async () => {
    const m = await loadWith('acme.com, acme.org')
    expect(m.isEmailDomainAllowed('a@acme.com')).toBe(true)
    expect(m.isEmailDomainAllowed('b@acme.org')).toBe(true)
    expect(m.isEmailDomainAllowed('person@gmail.com')).toBe(false)
  })

  // `hd` takes one domain, so there is nothing honest to send.
  it('leaves the Google chooser unfiltered', async () => {
    const m = await loadWith('acme.com, acme.org')
    expect(m.googleHostedDomain()).toBeUndefined()
  })

  it('lists them all in the user-facing message', async () => {
    const m = await loadWith('acme.com, acme.org')
    expect(m.describeAllowedDomains()).toBe('acme.com or acme.org')
  })
})

describe('DomainNotAllowedError', () => {
  it('carries the code the login page switches on', async () => {
    const m = await loadWith('acme.com')
    const err = new m.DomainNotAllowedError()
    expect(err.code).toBe(m.DOMAIN_NOT_ALLOWED_CODE)
    expect(err.code).toBe('auth/domain-not-allowed')
    expect(err.message).toContain('acme.com')
  })
})
