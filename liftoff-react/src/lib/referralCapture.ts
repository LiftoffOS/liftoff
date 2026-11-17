/**
 * Referral attribution capture.
 *
 * The programme's one shared link is `https://example.com/?ref=<code>`, so
 * the code arrives on whatever page the person lands on — `/`, `/login`, a
 * deep link — and is gone the moment they navigate. Nothing else in this
 * app persists it, and until it reaches account creation the whole programme
 * cannot attribute anybody.
 *
 * This module is the entire frontend surface of attribution: there is no UI, no
 * banner and no acknowledgement. It captures the code, holds it for the
 * attribution window, and hands it to the signup call. Everything that decides
 * anything — whether the code is real, whether the referral is eligible, what
 * it earns — happens on the backend.
 *
 * Three deliberate properties:
 *
 * LAST TOUCH. A second link overwrites the first. Last-click is the default
 * across affiliate tooling and the model partners expect, and it is the
 * simplest to explain; first-touch mainly matters where several partners
 * compete over one lead, which is not the situation for a
 * customer-to-customer programme.
 *
 * THIRTY DAYS, click to ACCOUNT CREATION — not click to payment. Somebody who
 * signs up on day 29 and subscribes in month four still earns the referrer
 * credit, because the backend binds the code at account creation and the
 * earning event is the first paid invoice. A longer window would buy mainly
 * stale attribution: a person who clicked, forgot, and found Liftoff
 * organically months later is a customer we already acquired.
 *
 * NEVER LOAD-BEARING. Every function here swallows its own failures. Private
 * browsing, a full quota and a disabled storage policy all cost the
 * attribution and nothing else — a signup must never fail because a referral
 * could not be remembered.
 */

const STORAGE_KEY = 'liftoff.referral'

/** Click to account creation, in days. Mirrors the backend's window, which is
 *  the one that actually decides: this only stops a stale code being sent. */
const ATTRIBUTION_WINDOW_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** Codes are `{slug}-{4 hex}`. Bounded and character-checked here so a junk
 *  query parameter is never stored, never sent, and can never be a vector for
 *  anything the backend has to defend against. */
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

export interface CapturedReferral {
  code: string
  /** ISO timestamp of the click, sent so the backend can check the window
   *  against the same instant this side did. */
  clickedAt: string
}

function readStored(): CapturedReferral | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CapturedReferral>
    if (typeof parsed?.code !== 'string' || typeof parsed?.clickedAt !== 'string') return null
    if (!CODE_PATTERN.test(parsed.code)) return null
    const clickedAt = Date.parse(parsed.clickedAt)
    if (Number.isNaN(clickedAt)) return null
    if (Date.now() - clickedAt > ATTRIBUTION_WINDOW_DAYS * DAY_MS) return null
    return { code: parsed.code, clickedAt: parsed.clickedAt }
  } catch {
    return null
  }
}

/**
 * Reads `?ref=` off the current URL and stores it, last touch winning.
 *
 * Called once at startup, before render, so a code on the landing URL is held
 * even if the person never signs up in this session. The query parameter is
 * left in the address bar: stripping it would fight the router for history
 * state to hide something nobody minds seeing, and a reload would then lose a
 * code this has already stored anyway.
 */
export function captureReferralCode(search: string = window.location.search): void {
  try {
    const code = new URLSearchParams(search).get('ref')?.trim().toLowerCase()
    if (!code || !CODE_PATTERN.test(code)) return
    const value: CapturedReferral = { code, clickedAt: new Date().toISOString() }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage unavailable — the referral is lost, the visit is not.
  }
}

/** The live capture, or null when there is none or it has aged out. */
export function getCapturedReferral(): CapturedReferral | null {
  return readStored()
}

/**
 * Forgets the stored code.
 *
 * Called once the signup that carried it has been accepted. The binding is
 * durable on the backend from that moment, and keeping the code here would let
 * a second account created in the same browser — a colleague signing up on a
 * shared machine — claim the same referral a second time.
 */
export function clearCapturedReferral(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do: a code that cannot be removed also could not be read.
  }
}
