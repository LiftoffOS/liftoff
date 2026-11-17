// The browser record's two sanitizers: a URL and a piece of browser text, each
// returned with the facts a reader needs beside it.
//
// A browser trail records WHERE something happened and WHAT was said about it,
// and both are fidelity data: the resource id in a path, the filter in a query
// string and the view in an SPA fragment are the exact record, filter or view
// the person used, and an agent that mirrors their workflow needs them. So
// `recordedUrl` keeps the HTTP(S) origin, the path with its ids, ordinary
// query parameters and the fragment, and replaces ONLY what the protected
// data policy names: URL credentials, the value of a parameter whose name
// says it is a password, token, key, signature, credential, session id,
// one-time code, PIN or card number, and, on an OAuth / SAML / password-reset
// / magic-link / invitation / verification callback route, the protocol
// `code` and `state` and any opaque path token. On ANY route, a protocol
// parameter (`state`, `code`, `nonce`, `session_state`) whose value has the
// shape of an opaque token is replaced too: a hosted sign-in page carries the
// OAuth transaction state on a route no list of callback paths names, and
// the value's shape is what says it is a transaction, not a business value.
// A generic business parameter merely named `key`, `state`, `code`,
// `session` or `auth` is kept (`state=CA`, `code=SPRING`).
//
// `sanitizeBrowserText` is for natural-language instructions and outcomes: it
// finds embedded HTTP(S) URLs and passes each through `recordedUrl`, removes a
// bounded, context-labelled protected assignment (`password=...`, `OTP
// 123456`, `CVV: ...`, a card, SSN or labelled account number, a recovery
// code), and finishes with the canonical credential redactor. It never passes
// prose to a URL parser as though the whole string were a URL, and it never
// blanket-redacts an ordinary number, email address or business value.
//
// Every sanitizer returns `{ text, truncated, protectedDataOmitted }` so a
// caller carries those facts through storage and the wire instead of trying
// to infer them later from a `[redacted]` token.
//
// `recordedUrl` is SELF-CONTAINED by design: the tenant runtime's takeover
// recorder embeds its source into the session's page with
// `Function.prototype.toString()`, so it may reference nothing outside its
// own body — no import, no module-level constant, no helper. A test in each
// consumer re-evaluates the source in a bare realm to hold it to that.

import { redactSensitiveText } from './credentials';

/** What every sanitizer answers. */
export interface SanitizedText {
  text: string;
  /** The text was cut at the cap. */
  truncated: boolean;
  /** A component was replaced or removed by the protected data policy. */
  protectedDataOmitted: boolean;
}

/** Longest recorded URL. */
export const RECORDED_URL_CAP = 2048;

/**
 * The safe projection of a URL for the browser record.
 *
 * Self-contained: see the file comment before adding anything this body
 * would reference from outside itself.
 */
export function recordedUrl(raw: string): SanitizedText {
  const CAP = 2048;
  const MARK = '[redacted]';
  const input = typeof raw === 'string' ? raw : '';
  let omitted = false;

  // Split a parameter name into lowercase segments at `_`, `-`, `.` and
  // camelCase boundaries, so `accessToken`, `access_token`, `x-access-token`
  // and `ACCESS-TOKEN` all read the same way.
  const segmentsOf = (name: string): string[] => {
    const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.\s]+/g, ' ').toLowerCase();
    return spaced.split(' ').filter((s) => s.length > 0);
  };
  const PROTECTED_SEGMENTS: Record<string, true> = {
    password: true, passwd: true, pwd: true, passcode: true, passphrase: true,
    secret: true, token: true, jwt: true, saml: true, samlresponse: true, samlrequest: true,
    assertion: true, otp: true, pin: true, cvv: true, cvv2: true, cvc: true,
    signature: true, sig: true, credential: true, credentials: true,
    apikey: true, accesstoken: true, refreshtoken: true, authtoken: true, idtoken: true,
    privatekey: true, accesskey: true, secretkey: true, sessionid: true, sessionkey: true,
    cardnumber: true, ccnumber: true, ccnum: true, cardno: true, pan: true,
  };
  const has = (segs: string[], s: string): boolean => segs.indexOf(s) !== -1;
  const isProtectedName = (name: string): boolean => {
    const segs = segmentsOf(name);
    if (segs.length === 0) return false;
    for (const s of segs) if (PROTECTED_SEGMENTS[s]) return true;
    // Compounds whose parts are generic on their own.
    if (has(segs, 'key') && (has(segs, 'api') || has(segs, 'access') || has(segs, 'private') || has(segs, 'secret'))) return true;
    if (has(segs, 'session') && (has(segs, 'id') || has(segs, 'key'))) return true;
    if (has(segs, 'auth') && has(segs, 'token')) return true;
    if ((has(segs, 'card') || has(segs, 'cc')) && (has(segs, 'number') || has(segs, 'no') || has(segs, 'num'))) return true;
    return false;
  };
  const isCallbackRoute = (path: string): boolean => {
    const p = path.toLowerCase();
    return /(^|\/)(oauth2?|openid|oidc|saml|sso|callback|password[-_]?reset|reset[-_]?password|forgot[-_]?password|password\/reset|magic[-_]?link|magiclink|accept[-_]?invit(?:e|ation)|invit(?:e|ation)s?\/[^/]+|verify(?:[-_]?email)?|verification|confirm[-_]?email|email[-_]?confirm|activate)(\/|$)/.test(p);
  };
  const isOpaqueToken = (segment: string): boolean => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
    if (/^[0-9a-f]{16,}$/i.test(segment)) return true;
    if (/^[A-Za-z0-9_-]{20,}$/.test(segment) && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment)) return true;
    if (/^[A-Za-z0-9+/=_-]{32,}$/.test(segment)) return true;
    return false;
  };
  // A protocol parameter: replaced on a callback route whatever its value,
  // and on any route when its value is token-shaped.
  const PROTOCOL_PARAMS: Record<string, true> = { code: true, state: true, nonce: true, sessionstate: true };
  const isProtocolName = (name: string): boolean => PROTOCOL_PARAMS[segmentsOf(name).join('')] === true;
  // Rewrite `a=1&b=2` keeping structure; a protected value becomes the mark.
  const scrubQuery = (query: string, callback: boolean): string => {
    if (!query) return query;
    return query.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      let decoded = name;
      try { decoded = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* keep the raw name */ }
      let protectedName = isProtectedName(decoded) || (callback && isProtocolName(decoded));
      if (!protectedName && isProtocolName(decoded)) {
        let value = pair.slice(eq + 1);
        try { value = decodeURIComponent(value.replace(/\+/g, ' ')); } catch { /* keep the raw value */ }
        protectedName = isOpaqueToken(value);
      }
      if (!protectedName) return pair;
      omitted = true;
      return name + '=' + MARK;
    }).join('&');
  };
  const scrubPath = (path: string, callback: boolean): string => {
    if (!callback) return path;
    return path.split('/').map((segment) => {
      if (segment && isOpaqueToken(segment)) { omitted = true; return MARK; }
      return segment;
    }).join('/');
  };
  // A fragment can be an SPA route with its own query (`#/orders?tab=1`),
  // a bare parameter list (`#access_token=...`) or an anchor (`#row-4`).
  const scrubFragment = (fragment: string, callback: boolean): string => {
    if (!fragment) return fragment;
    const q = fragment.indexOf('?');
    if (q !== -1) {
      const route = fragment.slice(0, q);
      const routeCallback = callback || isCallbackRoute(route);
      return scrubPath(route, routeCallback) + '?' + scrubQuery(fragment.slice(q + 1), routeCallback);
    }
    if (fragment.indexOf('=') !== -1 && /^[^/]*=|&/.test(fragment)) {
      return scrubQuery(fragment, callback);
    }
    return scrubPath(fragment, callback || isCallbackRoute(fragment));
  };
  const finish = (text: string): SanitizedText => {
    const truncated = text.length > CAP;
    return { text: truncated ? text.slice(0, CAP) : text, truncated, protectedDataOmitted: omitted };
  };

  let u: URL | null;
  try { u = new URL(input); } catch { u = null; }
  if (u === null) {
    // Not a URL: kept as bounded text, with nothing to parse.
    return finish(input);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // about:blank, data:, blob: and their kin carry no policy-bearing parts
    // worth parsing; the scheme and path are all there is, credentials aside.
    if (u.username || u.password) { u.username = ''; u.password = ''; omitted = true; }
    return finish(u.href);
  }
  if (u.username || u.password) { u.username = ''; u.password = ''; omitted = true; }
  const callback = isCallbackRoute(u.pathname);
  const path = scrubPath(u.pathname, callback);
  const search = u.search ? '?' + scrubQuery(u.search.slice(1), callback) : '';
  const hash = u.hash ? '#' + scrubFragment(u.hash.slice(1), callback) : '';
  return finish(u.origin + path + search + hash);
}

/** Longest browser text kept when a caller names no cap. */
export const BROWSER_TEXT_DEFAULT_CAP = 4000;

const MARK = '[redacted]';

/** An HTTP(S) URL embedded in prose: bounded, stopping before whitespace, a
 *  closing quote or bracket, or trailing sentence punctuation. */
const EMBEDDED_URL_RE = /https?:\/\/[^\s<>"'`\])]{1,2048}/g;

/** `password=...`, `token: ...`, `api key = ...`: a protected label, a
 *  separator, then one bounded value. The separator is required so prose
 *  such as "type the password in the field" is untouched. */
const LABELED_ASSIGNMENT_RE =
  /\b(password|passwd|pwd|passcode|passphrase|secret|api[ _-]?key|access[ _-]?key|private[ _-]?key|secret[ _-]?key|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|id[ _-]?token|bearer[ _-]?token|token|otp|one[ -]?time[ -]?(?:code|password|passcode)|verification[ -]?code|security[ -]?code|recovery[ -]?code|backup[ -]?code|mfa[ -]?code|2fa[ -]?code|pin|cvv2?|cvc|security[ -]?answer)\b\s*(?:[:=]|\bis\b)\s*["'“‘]?([^\s"'”’,;)\]]{3,512})/gi;

/** `OTP 123456`, `CVV 123`, `PIN 1234`, `code 987654`: a one-time label and
 *  a bare number beside it, with no separator at all. */
const BARE_CODE_RE =
  /\b(otp|one[ -]?time[ -]?(?:code|password|passcode)|verification[ -]?code|security[ -]?code|recovery[ -]?code|backup[ -]?code|mfa[ -]?code|2fa[ -]?code|cvv2?|cvc|pin)\b[ \t]*#?[ \t]*(\d[\d -]{2,14}\d)\b/gi;

/** A card number: 13 to 19 digits with optional single spaces or dashes,
 *  confirmed by the Luhn check so an ordinary long number is left alone. */
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** A US Social Security number in its written form. */
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

/** A labelled account, routing, IBAN or SWIFT value. */
const LABELED_ACCOUNT_RE =
  /\b(account|acct|routing|aba|iban|swift|bic|sort[ -]?code)[ -]?(?:number|no\.?|num|#)?\s*[:=#]\s*["']?([A-Z0-9][A-Z0-9 -]{4,33})\b/gi;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Sanitize a natural-language browser instruction or outcome.
 *
 * Order: embedded URLs through `recordedUrl`, then the context-labelled
 * protected assignments, then the canonical credential redactor, then the
 * cap. Redaction runs before the cut so a value straddling the cap cannot
 * survive as a prefix.
 */
export function sanitizeBrowserText(raw: string, cap: number = BROWSER_TEXT_DEFAULT_CAP): SanitizedText {
  const input = typeof raw === 'string' ? raw : '';
  let omitted = false;
  let out = input;

  EMBEDDED_URL_RE.lastIndex = 0;
  out = out.replace(EMBEDDED_URL_RE, (m: string) => {
    // A URL that already carries the mark has been through the policy: the
    // pass is idempotent, so a sanitized text can be sanitized again. The
    // match stops before the mark's closing bracket, so the open half is
    // what is looked for.
    if (m.includes(MARK.slice(0, -1))) return m;
    // Trailing sentence punctuation belongs to the prose, not the URL.
    const trail = /[.,;:!?]+$/.exec(m);
    const url = trail ? m.slice(0, m.length - trail[0].length) : m;
    const safe = recordedUrl(url);
    if (safe.protectedDataOmitted) omitted = true;
    return safe.text + (trail ? trail[0] : '');
  });

  LABELED_ASSIGNMENT_RE.lastIndex = 0;
  out = out.replace(LABELED_ASSIGNMENT_RE, (m: string, label: string, value: string) => {
    // Already replaced by the URL pass (the value's closing bracket is not
    // part of the match): leave the mark as it is.
    if (value.startsWith('[redacted') || value.startsWith('[REDACTED')) return m;
    omitted = true;
    return m.slice(0, m.length - value.length) + MARK;
  });

  BARE_CODE_RE.lastIndex = 0;
  out = out.replace(BARE_CODE_RE, (m: string, _label: string, value: string) => {
    omitted = true;
    return m.slice(0, m.length - value.length) + MARK;
  });

  CARD_CANDIDATE_RE.lastIndex = 0;
  out = out.replace(CARD_CANDIDATE_RE, (m: string) => {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    omitted = true;
    return MARK;
  });

  SSN_RE.lastIndex = 0;
  out = out.replace(SSN_RE, () => { omitted = true; return MARK; });

  LABELED_ACCOUNT_RE.lastIndex = 0;
  out = out.replace(LABELED_ACCOUNT_RE, (m: string, _label: string, value: string) => {
    if (!/\d/.test(value)) return m;
    omitted = true;
    return m.slice(0, m.length - value.length) + MARK;
  });

  const canonical = redactSensitiveText(out);
  if (canonical !== out) omitted = true;
  out = canonical;

  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : BROWSER_TEXT_DEFAULT_CAP;
  const truncated = out.length > limit;
  return { text: truncated ? out.slice(0, limit) : out, truncated, protectedDataOmitted: omitted };
}
