// Which controls the record must not read a value from, decided from the
// page's own declarations.
//
// The rule (Part D of the browser-trail plan): a value entered into a control
// is part of the work and is recorded unless the control is classified as
// authentication, payment, high-risk identity or file input. The class is
// kept so the reader knows a step happened without receiving its value.
//
// ONE function, shared by SOURCE between the takeover recorder in the page
// (which embeds it through `Function.prototype.toString()` and can inspect the
// actual containing form before reading a value) and the Stagehand step
// policy in Node (which has only a description and the page URL). That is
// why it takes a plain evidence object rather than an element, and why it is
// written self-contained: no import, no module-level constant, nothing but
// what its own body carries.
//
// Ordered classes:
//
//   authentication  type=password; autocomplete current-password,
//                   new-password or one-time-code; a password, passcode,
//                   passphrase, secret, token, API/access key, OTP,
//                   authenticator, verification/security code, PIN or
//                   recovery/backup code label; EVERY editable control in a
//                   form that contains one of those fields (so the username
//                   or email of a sign-in form is omitted too); and every
//                   editable control on a recognised sign-in / login / MFA /
//                   password-reset route, which covers a split-step sign-in
//                   whose password is on the next screen
//   payment         every cc-* autocomplete token; a card number, cardholder,
//                   CVV, CVC, expiry/expiration, bank account, routing, IBAN
//                   or SWIFT label. A billing or shipping name or address
//                   beside a protected card field stays recordable: it is
//                   ordinary workflow data. A checkout / payment / card route
//                   strengthens card and bank labels and protects nothing
//                   else
//   sensitive_identity
//                   SSN / SIN / social security, tax id, national id,
//                   passport, driver's licence, government id, date of
//                   birth, biometric, medical / health / diagnosis, insurance
//                   or member id, security-answer labels
//   file            type=file. A hidden input is ignored: it is not a
//                   person's interaction
//
// Page declarations are imperfect. A malicious or badly labelled page can
// defeat semantic classification, which is why every reader still runs the
// credential redactor and why the product copy says "protected fields are
// not recorded when identified", never that every secret is detected.

/** What a caller knows about a control. Every field is optional; the
 *  classifier reads what is there. */
export interface ProtectedControlEvidence {
  /** The control's tag name, lowercase. */
  tag?: string;
  /** An input's type attribute, lowercase. */
  type?: string;
  /** Its accessible name (label, aria-label, placeholder, title, caption). */
  name?: string;
  /** Its name attribute. */
  attrName?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  /** Any further label text the caller has (a step description, say). */
  description?: string;
  /** The same evidence for every editable control of the containing form. */
  formFields?: ProtectedControlEvidence[];
  /** The page URL, raw or safe: only its route is read. */
  url?: string;
}

export type ProtectedControlClass = 'authentication' | 'payment' | 'sensitive_identity' | 'file' | '';

/**
 * Classify a control. Returns the protected class, or '' when the value may
 * be recorded.
 *
 * Self-contained by design: see the file comment before adding anything it
 * would reference from outside its own body.
 */
export function classifyProtectedControl(evidence: ProtectedControlEvidence): ProtectedControlClass {
  const e = evidence || {};
  const norm = (s: unknown): string => (typeof s === 'string' ? s : '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const type = norm(e.type);
  const tag = norm(e.tag);
  const autocomplete = norm(e.autocomplete);
  const labels = [e.name, e.attrName, e.id, e.placeholder, e.description].map(norm).filter((s) => s.length > 0).join(' | ');

  if (type === 'hidden') return '';
  if (type === 'file') return 'file';

  const AUTH_LABEL = /\b(password|passwd|pwd|passcode|pass code|passphrase|pass phrase|secret|token|api key|apikey|access key|accesskey|otp|one time (?:code|password|passcode)|authenticator|verification code|verify code|security code|pin|pin code|recovery code|backup code|2fa|mfa|totp)\b/;
  const PAYMENT_LABEL = /\b(card number|cardnumber|card no|card num|credit card|debit card|cardholder|card holder|name on card|cvv|cvv2|cvc|csc|expiry|expiration|exp date|exp month|exp year|bank account|account number|account no|routing|aba|iban|swift|bic|sort code)\b/;
  // A bare MM/YY, "card" or "expires" is a card field only on a checkout;
  // elsewhere it is a date or a record. A bare "account" is not a bank
  // account even there (an account email, an account name): only the bank
  // labels above, with their qualifier, are payment data.
  const PAYMENT_ROUTE_LABEL = /\b(card|exp|expires|mm yy|mm yyyy|security code|name on card)\b/;
  const IDENTITY_LABEL = /\b(ssn|sin|social security|social insurance|tax id|tax identification|tin|ein|itin|national id|national identity|national insurance|passport|driver'?s? licen[cs]e|drivers licen[cs]e|driving licen[cs]e|dl number|government id|date of birth|birth date|birthdate|dob|birthday|biometric|fingerprint|medical|health|diagnosis|insurance (?:id|number|member)|member id|policy number|security answer|secret answer|mother'?s maiden)\b/;
  const AUTH_ROUTE = /(^|\/|\s)(login|log in|logon|signin|sign in|auth|authenticate|authentication|sso|oauth2?|oidc|saml|mfa|2fa|two factor|otp|verify|verification|password|reset password|forgot password|recover|recovery|session\/new|sessions\/new|account\/recover)(\/|\s|$)/;
  const PAYMENT_ROUTE = /(^|\/|\s)(checkout|payment|payments|pay|billing|card|cards|subscribe|purchase|wallet)(\/|\s|$)/;

  // A route keeps its slashes; only separators inside a segment are spaced,
  // so `sign-in` and `reset_password` read as their words.
  const routeNorm = (s: string): string => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const routeOf = (url: unknown): string => {
    const raw = typeof url === 'string' ? url : '';
    if (!raw) return '';
    let path = raw;
    let hash = '';
    try {
      const u = new URL(raw);
      path = u.pathname;
      hash = u.hash;
    } catch (_) {
      const cut = raw.split('?')[0] || '';
      path = cut.split('#')[0] || '';
      hash = raw.indexOf('#') !== -1 ? raw.slice(raw.indexOf('#')) : '';
    }
    const fragmentRoute = hash.replace(/^#!?/, '').split('?')[0] || '';
    return routeNorm(path) + ' ' + routeNorm(fragmentRoute);
  };
  const route = routeOf(e.url);

  const ownClass = (ev: ProtectedControlEvidence): ProtectedControlClass => {
    const t = norm(ev.type);
    const ac = norm(ev.autocomplete);
    const l = [ev.name, ev.attrName, ev.id, ev.placeholder, ev.description].map(norm).filter((s) => s.length > 0).join(' | ');
    if (t === 'hidden') return '';
    if (t === 'file') return 'file';
    if (t === 'password') return 'authentication';
    if (ac === 'current password' || ac === 'new password' || ac === 'one time code') return 'authentication';
    if (ac.indexOf('cc ') === 0 || ac === 'cc') return 'payment';
    if (AUTH_LABEL.test(l)) {
      // "security code" on a checkout is the card's, not a one-time code.
      if (/\bsecurity code\b/.test(l) && !/\b(otp|password|authenticator|2fa|mfa|verification)\b/.test(l) && PAYMENT_ROUTE.test(route)) return 'payment';
      return 'authentication';
    }
    if (PAYMENT_LABEL.test(l)) return 'payment';
    if (PAYMENT_ROUTE.test(route) && PAYMENT_ROUTE_LABEL.test(l)) return 'payment';
    if (IDENTITY_LABEL.test(l)) return 'sensitive_identity';
    return '';
  };

  const own = ownClass({ tag, type, autocomplete, name: labels });
  if (own) return own;

  const editable = (ev: ProtectedControlEvidence): boolean => {
    const t = norm(ev.type);
    const g = norm(ev.tag);
    if (g === 'textarea' || g === 'select') return true;
    if (g === 'input') return t !== 'hidden' && t !== 'submit' && t !== 'button' && t !== 'reset' && t !== 'image';
    if (!g) return true;
    return false;
  };
  if (!editable({ tag, type })) return '';

  // A sign-in form protects every editable control in it.
  const fields = Array.isArray(e.formFields) ? e.formFields : [];
  for (let i = 0; i < fields.length && i < 200; i++) {
    if (ownClass(fields[i] || {}) === 'authentication') return 'authentication';
  }
  // A sign-in route protects every editable control on the page.
  if (AUTH_ROUTE.test(route)) return 'authentication';
  return '';
}
