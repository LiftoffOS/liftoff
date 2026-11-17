// Build-time email-domain restriction for sign-in and signup.
//
// `VITE_ALLOWED_EMAIL_DOMAINS` is a comma-separated allow-list injected at
// build time the same way the Firebase values are (Dockerfile ARG <- cloudbuild
// --build-arg <- trigger substitution). UNSET OR EMPTY MEANS NO RESTRICTION,
// and that is deliberately the default: open signup is the backend's `*` entry
// in Remote Config `allowed_domains`, and only a build that should be
// restricted sets this. Defaulting to open means a build that leaves the
// variable out can never silently close signup.
//
// This is a front-door gate, not the authorization boundary. The backend decides
// access on its own list (platform-backend `ALLOWED_DOMAINS`, else Firebase
// Remote Config `allowed_domains`). This exists so someone on the wrong domain
// is told why at the login page, instead of authenticating successfully and
// then meeting a 403 on every subsequent request.

const rawAllowedDomains: string = import.meta.env.VITE_ALLOWED_EMAIL_DOMAINS || ''

export const ALLOWED_EMAIL_DOMAINS: readonly string[] = rawAllowedDomains
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter((d) => d.length > 0)

/** Whether this build restricts sign-in to an allow-list of email domains. */
export function isEmailDomainRestricted(): boolean {
  return ALLOWED_EMAIL_DOMAINS.length > 0
}

// Mirrors the backend's `isEmailDomainAllowed` (platform-backend
// src/config/allowedDomains.ts) including its edge cases, so the two cannot
// disagree about a given address: no `@` is rejected, and `a@b@c.com` takes the
// middle segment as the domain and is therefore rejected too.
export function isEmailDomainAllowed(email: string): boolean {
  if (!isEmailDomainRestricted()) return true
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) return false
  return ALLOWED_EMAIL_DOMAINS.includes(domain)
}

// Google's `hd` OAuth parameter pre-filters the account chooser to one hosted
// domain, so a person never picks an account that is about to be rejected. It
// is a convenience, never the check: Google treats it as a hint and the
// verification still happens against the returned profile. Only meaningful for
// a single domain; with several, the chooser stays unfiltered.
export function googleHostedDomain(): string | undefined {
  return ALLOWED_EMAIL_DOMAINS.length === 1 ? ALLOWED_EMAIL_DOMAINS[0] : undefined
}

/** Human-readable list of the accepted domains, for user-facing copy. */
export function describeAllowedDomains(): string {
  if (ALLOWED_EMAIL_DOMAINS.length === 0) return ''
  if (ALLOWED_EMAIL_DOMAINS.length === 1) return ALLOWED_EMAIL_DOMAINS[0]
  return (
    ALLOWED_EMAIL_DOMAINS.slice(0, -1).join(', ') +
    ' or ' +
    ALLOWED_EMAIL_DOMAINS[ALLOWED_EMAIL_DOMAINS.length - 1]
  )
}

export const DOMAIN_NOT_ALLOWED_CODE = 'auth/domain-not-allowed'

/** The message shown in the login-page toast when a domain is rejected. */
export function domainNotAllowedMessage(): string {
  return `Only ${describeAllowedDomains()} email addresses can be used here. Sign in with your ${describeAllowedDomains()} account.`
}

// Carries `code` so the login page can tell this apart from a Firebase error in
// the same `catch`, which is how every other auth failure is already routed.
export class DomainNotAllowedError extends Error {
  readonly code = DOMAIN_NOT_ALLOWED_CODE

  constructor(message: string = domainNotAllowedMessage()) {
    super(message)
    this.name = 'DomainNotAllowedError'
  }
}
