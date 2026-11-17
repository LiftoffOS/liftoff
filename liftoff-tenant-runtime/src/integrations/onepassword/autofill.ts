// The one saved-login fill, for every browser vendor, at every point the
// runtime itself moves the page.
//
// Deterministic, no model in it. The sign-in controls are the ones the pane
// already finds: the walker and classifier the pane's readers run in the
// recorder's isolated world (pane-actions.ts `loginControlsOf`), which
// classify `type=password`, the current-/new-password and one-time-code
// autocomplete tokens, password and OTP labels, every editable control in a
// form holding one of those, and every editable control on a recognised
// sign-in route (the username-first case). The value goes `resolveLogin` →
// `typeIntoControl` on that control and is dropped. The pane's own `type`
// action refuses every authentication control, so this is the only way a
// password reaches a form on any of the four vendors.
//
// The sequence, awaited by every caller:
//
//   1. `findLoginForUrl` first, from the cached overviews, no secret read:
//      none → nothing, and the page is not even walked.
//   2. Walk the page for its authentication-class editable controls:
//      password = the first `type=password`; one-time code = the first with
//      `autocomplete=one-time-code`; username = the first remaining
//      text / email / tel control. No controls → not a sign-in page, nothing
//      recorded. Two saved logins matching a page that IS a sign-in page →
//      a `saved_login_skipped` step saying so and, on the pane, the request
//      for the person to take over; on any other page of that site, nothing,
//      because the request gates the assistant until the person answers and
//      a search page is not the step that needs them.
//   3. `resolveLogin`, then type through the pane's own path: username, then
//      password with Enter. A username-only page (username-first sign-in)
//      is typed, submitted, settled and walked once more, and the password
//      follows when one is now present.
//   4. Settle (domcontentloaded, bounded). An OTP control now present with a
//      TOTP field on the item: `resolveLogin` again for a fresh code, fill,
//      submit, settle.
//   5. The outcome, observed rather than assumed: `confirmed` when no
//      authentication control remains and the URL is off the sign-in route;
//      `submitted` when the form was submitted but that check did not pass;
//      `failed` when a password control is visible again at the same URL.
//      Once per origin per session; `failed` blocks a retry on that origin
//      for the session.
//
// The record carries the control's name and the masked username, in a step
// with `protectedDataOmitted` true and `protectedKind` `authentication`,
// never the value. The task trail takes the step as a `BrowserTaskStep`; the
// pane takes it as a `recordBrowserActivity` row; a run-owned session's
// navigation before its task starts parks it for that task's trail. Logs
// carry the host only. Nothing here throws out to a caller: a login that
// cannot be applied is a step, not a failed navigation.

import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { recordedUrl, sanitizeBrowserText } from '@liftoffos/redact';
import { logger } from '../../infrastructure/logging';
import type { BrowserSession } from '../../browser-sessions/types';
import type { BrowserTaskStep } from '../web-fetch/step-policy';
import { classifyProtectedControl } from '../../browser-sessions/takeover-capture/protected-control';
import type { SessionCapture } from '../../browser-sessions/takeover-capture/session-capture';
import type { LoginControl, SubmitControl } from '../../browser-sessions/pane-actions';
import { findLoginForUrl, isLoginSourceAvailable, resolveLogin, type ResolvedLogin } from './logins';

export type LoginOutcome = 'confirmed' | 'submitted' | 'failed' | 'skipped' | 'none';

export const SAVED_LOGIN_STEP_TYPES = {
  confirmed: 'saved_login_confirmed',
  submitted: 'saved_login_submitted',
  failed: 'saved_login_failed',
  skipped: 'saved_login_skipped',
} as const;

/** Where a step lands: the caller's trail, the pane's activity row, or the
 *  parked list a run-owned session's next task drains. */
export type LoginRecorder = (step: BrowserTaskStep, outcome: Exclude<LoginOutcome, 'none'>) => Promise<void> | void;

/** A navigation or a submit is waited for this long at most. */
export const LOGIN_SETTLE_TIMEOUT_MS = 4_000;
/** The recorder's world is between documents for a moment after a submit;
 *  the walk is retried this often, this many times. */
const WALK_RETRY_MS = 200;
const WALK_RETRIES = 10;
/** Origins remembered per session, and sessions remembered, at most. */
const ORIGINS_PER_SESSION_CAP = 200;
const SESSIONS_CAP = 2_000;
/** Steps parked for a run-owned session's next task, at most, and for how long. */
const PENDING_STEPS_CAP = 10;
const PENDING_STEPS_TTL_MS = 10 * 60_000;

// ── Once per origin per session ─────────────────────────────────────────────

const attempted = new Map<string, Map<string, LoginOutcome>>();

function attemptedOn(sessionId: string, origin: string): LoginOutcome | undefined {
  return attempted.get(sessionId)?.get(origin);
}

function markAttempted(sessionId: string, origin: string, outcome: LoginOutcome): void {
  let origins = attempted.get(sessionId);
  if (!origins) {
    if (attempted.size >= SESSIONS_CAP) {
      const oldest = attempted.keys().next().value;
      if (oldest !== undefined) attempted.delete(oldest);
    }
    origins = new Map();
    attempted.set(sessionId, origins);
  }
  if (origins.size >= ORIGINS_PER_SESSION_CAP && !origins.has(origin)) {
    const oldest = origins.keys().next().value;
    if (oldest !== undefined) origins.delete(oldest);
  }
  origins.set(origin, outcome);
}

/** For the tests: forget every origin of every session. */
export function _resetSavedLoginAttemptsForTesting(): void {
  attempted.clear();
  pending.clear();
}

// ── Steps parked for a run-owned session's next task ───────────────────────

const pending = new Map<string, { steps: BrowserTaskStep[]; expiresAt: number }>();

function parkStep(vendorSessionId: string, step: BrowserTaskStep): void {
  const entry = pending.get(vendorSessionId) ?? { steps: [], expiresAt: 0 };
  if (entry.steps.length < PENDING_STEPS_CAP) entry.steps.push(step);
  entry.expiresAt = Date.now() + PENDING_STEPS_TTL_MS;
  pending.set(vendorSessionId, entry);
}

/** The steps a navigation parked for this session before its task began:
 *  drained once, by the task entry (browser-task.ts), into the task's trail. */
export function takePendingLoginSteps(vendorSessionId: string): BrowserTaskStep[] {
  const entry = pending.get(vendorSessionId);
  if (!entry) return [];
  pending.delete(vendorSessionId);
  return entry.expiresAt > Date.now() ? entry.steps : [];
}

// ── The step and its wording ────────────────────────────────────────────────

/** The username with all but its first character masked; an email keeps
 *  its domain. */
export function maskUsername(username: string): string {
  const at = username.indexOf('@');
  if (at > 0) return `${username.charAt(0)}…@${username.slice(at + 1)}`;
  if (username.length <= 1) return username ? '…' : '';
  return `${username.charAt(0)}…`;
}

function stepOf(outcome: Exclude<LoginOutcome, 'none'>, action: string, url: string): BrowserTaskStep {
  const safeUrl = recordedUrl(url);
  const safeAction = sanitizeBrowserText(action, 2000);
  return {
    type: SAVED_LOGIN_STEP_TYPES[outcome],
    action: safeAction.text,
    pageUrl: safeUrl.text,
    actionTruncated: safeAction.truncated,
    pageUrlTruncated: safeUrl.truncated,
    protectedDataOmitted: true,
    protectedKind: 'authentication',
    pageUrlProtectedDataOmitted: safeUrl.protectedDataOmitted,
    at: new Date(),
  };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Whether a URL is on a recognised sign-in route, by the same route rule
 *  the classifier applies to every editable control on such a page. */
function onSignInRoute(url: string): boolean {
  return classifyProtectedControl({ tag: 'input', type: 'text', url }) === 'authentication';
}

// ── The fill ────────────────────────────────────────────────────────────────

type Capture = SessionCapture;
interface LoginControls { url: string; controls: LoginControl[]; submits: SubmitControl[] }

export interface PickedControls {
  password: LoginControl | null;
  otp: LoginControl | null;
  username: LoginControl | null;
  /** More than one box could take the username and nothing on the page says
   *  which. Nothing is typed: a wrong value in a live sign-in form is a
   *  failed attempt against the person's account, and some sites count it
   *  toward a lockout. */
  usernameAmbiguous: boolean;
}

/** A control's name, for matching: camelCase split at a LETTER boundary
 *  only (splitting at a digit turns "2FA code" into "2 fa code"), separators
 *  as spaces, lowercase. */
function norm(text: string): string {
  return (text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `autocomplete` is a space-separated TOKEN LIST, not one value: a box can
 *  be `one-time-code webauthn` (the documented conditional-UI pattern) or
 *  carry a `section-*` prefix, and matching the whole attribute misses both.
 *  Each token keeps its hyphens, because the hyphens are part of the token
 *  name; a page that wrote the name with spaces instead is invalid HTML and
 *  is honoured all the same by keeping the joined form too. */
function autocompleteTokens(control: LoginControl): string[] {
  const raw = (control.autocomplete ?? '').toLowerCase().trim();
  if (!raw) return [];
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  return tokens.concat(raw.replace(/\s+/g, '-'));
}

function hasToken(control: LoginControl, ...tokens: string[]): boolean {
  const own = autocompleteTokens(control);
  return tokens.some((t) => own.includes(t));
}

/** A box that takes a one-time code, by its name, for a page that declares
 *  no token. Narrow on purpose: a bare "code" is a discount code as often as
 *  a login one. */
const OTP_LABEL = /\b(one time (?:code|password|passcode)|otp|totp|2 ?fa|m ?fa|authenticator|verification code|verify code|authentication code|security code|login code|sign in code|sms code|passcode|recovery code|backup code)\b/;

/** A box that takes a password, for the show-password case, where the page
 *  swaps `type=password` for `type=text` on the same box. */
const PASSWORD_LABEL = /\b(password|passwd|pwd|passphrase)\b/;

/** A box that takes the person's identifier. */
const USERNAME_LABEL = /\b(user ?name|user id|userid|user|login|log in|sign in|email|e mail|account|phone|mobile|member id|customer id)\b/;

/** Of several equally-preferred boxes, the one the person can see. */
function visibleFirst(controls: LoginControl[]): LoginControl | null {
  return controls.find((c) => !c.offscreen) ?? controls[0] ?? null;
}

/**
 * Which box takes what, over the authentication-class controls the walk
 * returned.
 *
 * The class is deliberately wide: the classifier marks EVERY editable
 * control on a recognised sign-in route as authentication, which is right
 * for a record that must not keep a value, and far too wide for choosing
 * where to type. A header search box on a `/login` page is in the set. So
 * the username is taken on evidence, in order, and never on position alone:
 *
 *   1. the page's own declaration (`autocomplete` username or email),
 *   2. the sign-in form the password is in, nearest the password,
 *   3. a name that reads as an identifier,
 *   4. the only candidate there is, on a page with no password box (the
 *      username-first step),
 *
 * and when none of those answers, nothing is typed.
 */
export function pickControls(controls: LoginControl[]): PickedControls {
  const textish = (c: LoginControl): boolean =>
    c.inputType === 'text' || c.inputType === 'email' || c.inputType === 'tel' || c.inputType === '' || c.inputType === 'number';

  // The password: the type says it, else the page's own token, else the name
  // (a box the page revealed by swapping the type for `text`).
  const password = controls.find((c) => c.inputType === 'password')
    ?? controls.find((c) => hasToken(c, 'current-password', 'new-password'))
    ?? controls.find((c) => textish(c) && PASSWORD_LABEL.test(norm(c.name)))
    ?? null;
  const rest = controls.filter((c) => c !== password);

  // The one-time code: the token list, else the name.
  const otp = rest.find((c) => hasToken(c, 'one-time-code'))
    ?? visibleFirst(rest.filter((c) => textish(c) && OTP_LABEL.test(norm(c.name))))
    ?? null;

  // What is left that could hold an identifier: never a code box, never a
  // password box under another type.
  const candidates = rest.filter((c) => c !== otp && textish(c)
    && !OTP_LABEL.test(norm(c.name)) && !PASSWORD_LABEL.test(norm(c.name))
    && !hasToken(c, 'one-time-code', 'current-password', 'new-password'));

  const declared = visibleFirst(candidates.filter((c) => hasToken(c, 'username', 'email')));
  const inPasswordForm = password && password.formKey
    ? candidates.filter((c) => c.formKey === password.formKey)
    : [];
  const passwordAt = password ? controls.indexOf(password) : -1;
  const nearestToPassword = inPasswordForm.length > 0
    ? inPasswordForm.slice().sort((a, b) =>
      Math.abs(controls.indexOf(a) - passwordAt) - Math.abs(controls.indexOf(b) - passwordAt))[0]
    : null;
  const named = visibleFirst(candidates.filter((c) => USERNAME_LABEL.test(norm(c.name))));
  const username = declared
    ?? visibleFirst(inPasswordForm.filter((c) => USERNAME_LABEL.test(norm(c.name))))
    ?? nearestToPassword
    ?? named
    ?? (!password && candidates.length === 1 ? candidates[0] : null);

  // Ambiguous only where a guess would be typed and submitted on its own: a
  // page with no password box, several candidates, and no evidence. With a
  // password box the password is still worth filling (a second step whose
  // other boxes are the page's own), and the username is simply left.
  return { password, otp, username, usernameAmbiguous: !username && !password && candidates.length > 1 };
}

/** The walk, retried while the world is between documents. */
async function walk(capture: Capture, loginControlsOf: (c: Capture) => Promise<LoginControls>): Promise<LoginControls> {
  let last: unknown = null;
  for (let i = 0; i < WALK_RETRIES; i++) {
    try {
      return await loginControlsOf(capture);
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, WALK_RETRY_MS));
    }
  }
  throw last instanceof Error ? last : new Error('the page could not be walked');
}

/**
 * Apply the saved login for the page the session is on. The page is the one
 * the caller holds when it holds one (the Jev loop's own, Stagehand's, the
 * pane action's), else the session's pooled page. Never throws.
 */
export async function applySavedLogin(
  session: BrowserSession,
  tenantId: string,
  record: LoginRecorder,
  opts: { page?: Page } = {},
): Promise<LoginOutcome> {
  try {
    if (opts.page) return await fillOn(opts.page, session, tenantId, record);
    const { withPage } = await import('../../browser-sessions/cdp-page');
    return await withPage(session.vendor, session.vendorSessionId, tenantId, (page) => fillOn(page, session, tenantId, record), 'savedLogin');
  } catch (err) {
    logger.warn(
      { session_id: session.id, vendor: session.vendor, err: (err as Error).message, event: 'saved_login_unavailable' },
      'saved login: the fill could not reach the page',
    );
    return 'none';
  }
}

async function fillOn(page: Page, session: BrowserSession, tenantId: string, record: LoginRecorder): Promise<LoginOutcome> {
  const startUrl = page.url();
  const origin = originOf(startUrl);
  if (!origin) return 'none';
  const before = attemptedOn(session.id, origin);
  if (before === 'confirmed' || before === 'submitted' || before === 'failed') return 'none';

  // 1. The login, from the cached overviews.
  const match = await findLoginForUrl(tenantId, startUrl);
  if (match === null) return 'none';
  const host = hostOf(startUrl);
  // Two matches already recorded for this origin: nothing more to say.
  if (match === 'ambiguous' && before === 'skipped') return 'none';

  const { paneCaptureFor, loginControlsOf, typeIntoControl, clickControl } = await import('../../browser-sessions/pane-actions');
  // A skip is recorded once per origin per session and does not block a
  // later attempt there: the page may have been unreadable this time and a
  // sign-in page the next.
  const skip = async (reason: string, url: string): Promise<LoginOutcome> => {
    if (before !== 'skipped') await record(stepOf('skipped', reason, url), 'skipped');
    markAttempted(session.id, origin, 'skipped');
    logger.info({ session_id: session.id, host, reason, event: 'saved_login_skipped' }, 'saved login: not applied');
    return 'skipped';
  };

  // 2. The sign-in controls, from the pane's own walk.
  let capture: Capture;
  try {
    capture = await paneCaptureFor(session, tenantId);
  } catch (err) {
    return skip(`the page could not be read: ${(err as Error).message}`, startUrl);
  }
  let walked: LoginControls;
  try {
    walked = await walk(capture, loginControlsOf);
  } catch (err) {
    return skip(`the page could not be read: ${(err as Error).message}`, startUrl);
  }
  // The walk read the capture's main document; the page in hand must be
  // that document, or a click aimed by the walk's boxes would land in
  // another tab.
  if (walked.url !== page.url()) {
    logger.warn({ session_id: session.id, host, event: 'saved_login_page_mismatch' }, 'saved login: the page in hand is not the document the reader walked; nothing filled');
    return 'none';
  }
  let picked = pickControls(walked.controls);
  if (picked.usernameAmbiguous) {
    return skip('more than one box on this page could take the username, and nothing on the page says which', walked.url);
  }
  if (!picked.password && !picked.username && !picked.otp) return 'none';

  // Two saved logins match, and this is the sign-in page: the person's step.
  if (match === 'ambiguous') {
    markAttempted(session.id, origin, 'skipped');
    await record(stepOf('skipped', 'two saved logins match this site', walked.url), 'skipped');
    await askPersonWhenOnPane(session, tenantId);
    logger.info({ session_id: session.id, host, event: 'saved_login_ambiguous' }, 'saved login: two saved logins match; nothing filled');
    return 'skipped';
  }

  // 3. The secret, for this fill only.
  const login = await resolveLogin(tenantId, match);
  if (login === 'unusable') return skip('the 1Password item has no username and password', walked.url);
  if (!login) return skip('the login could not be read from 1Password', walked.url);
  const controlName = (c: LoginControl | null): string => (c ? (c.name || c.role || c.tag) : '');
  const masked = maskUsername(login.username);
  let armed: Promise<unknown> | null = null;
  const armNavigation = (p: Page): void => {
    armed = p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: LOGIN_SETTLE_TIMEOUT_MS }).catch(() => undefined);
  };
  const settle = async (): Promise<void> => {
    if (armed) await armed;
    armed = null;
    await page.waitForLoadState('domcontentloaded', { timeout: LOGIN_SETTLE_TIMEOUT_MS }).catch(() => undefined);
  };
  /** The control that sends this box's form, when the page has one: the
   *  same form first, else the nearest one in the page's own order. */
  const submitFor = (control: LoginControl): SubmitControl | null => {
    const inSameForm = control.formKey
      ? walked.submits.filter((b) => b.formKey === control.formKey)
      : [];
    const pool = inSameForm.length > 0 ? inSameForm : walked.submits;
    const visible = pool.filter((b) => !b.offscreen);
    const candidates = visible.length > 0 ? visible : pool;
    if (candidates.length === 0) return null;
    return candidates.slice().sort((a, b) => Math.abs(a.order - control.order) - Math.abs(b.order - control.order))[0];
  };
  /**
   * Type into a box, and send the form when this is the last box.
   *
   * Enter sends a form through HTML's implicit submission, which needs the
   * box to HAVE a form: an input that belongs to none — the shape a page
   * built out of components rather than a `<form>` produces — receives
   * Enter and does nothing at all. So a box with a form owner is sent with
   * Enter, as before, and a box without one is sent by clicking the
   * control whose name says it sends. Enter is still pressed when no such
   * control is on the page, because some pages listen for it themselves.
   */
  const type = async (control: LoginControl, text: string, submit: boolean): Promise<string | null> => {
    const button = submit && !control.formKey ? submitFor(control) : null;
    const typed = await typeIntoControl(capture, page, control, text, { submit: submit && !button, armNavigation });
    if (typed.outcome !== 'typed') {
      return typed.outcome === 'obscured'
        ? `${controlName(control)} is covered by ${typed.coveredBy || 'another element'}`
        : `${controlName(control)}: ${typed.outcome.replace(/_/g, ' ')}`;
    }
    if (button) {
      const clicked = await clickControl(capture, page, button, { armNavigation });
      if (clicked.outcome !== 'clicked') {
        // The form could not be sent by its own control; Enter is the last
        // thing to try, and the step says so when it does not take either.
        await typeIntoControl(capture, page, control, text, { submit: true, armNavigation }).catch(() => undefined);
      }
    }
    return null;
  };
  const finish = async (outcome: Exclude<LoginOutcome, 'none'>, action: string, url: string): Promise<LoginOutcome> => {
    markAttempted(session.id, origin, outcome);
    await record(stepOf(outcome, action, url), outcome);
    logger.info({ session_id: session.id, host, outcome, event: 'saved_login_applied' }, 'saved login: applied');
    return outcome;
  };
  const filled: string[] = [];
  /** The step's action: the controls filled, then a reason when there is one. */
  const actionOf = (reason?: string): string => [filled.join(', '), reason ?? ''].filter((part) => part.length > 0).join('; ');
  let submittedAt = walked.url;

  // The username, then the password; a username-first page submits the
  // username alone and looks again.
  if (picked.username) {
    const problem = await type(picked.username, login.username, !picked.password && !picked.otp);
    if (problem) return skip(problem, walked.url);
    filled.push(`${controlName(picked.username)} · ${masked}`);
    if (!picked.password && !picked.otp) {
      await settle();
      const again = await walk(capture, loginControlsOf).catch(() => null);
      if (again) {
        walked = again;
        picked = pickControls(again.controls);
        picked.username = null;
      } else {
        picked = { password: null, otp: null, username: null, usernameAmbiguous: false };
      }
    }
  }
  if (picked.password) {
    const problem = await type(picked.password, login.password, true);
    if (problem) return skip(problem, walked.url);
    filled.push(controlName(picked.password));
    submittedAt = walked.url;
    await settle();
  }

  // 4. A one-time code, from a fresh read: the code rotates every 30 s. A
  //    code box the item cannot answer is the person's step: nothing filled
  //    so far means nothing was submitted, and the step says why.
  let after = await walk(capture, loginControlsOf).catch(() => null);
  const otpControl = after ? pickControls(after.controls).otp : null;
  const noCodeInItem = 'the page asks for a one-time code the 1Password item does not hold';
  if (otpControl && login.totpCode === undefined && login.totpError === undefined) {
    if (filled.length === 0) return skip(noCodeInItem, after?.url ?? submittedAt);
    // Something was filled and submitted; the step says why it stopped there.
    return finish('submitted', actionOf(noCodeInItem), after?.url ?? submittedAt);
  } else if (otpControl) {
    const reread = await resolveLogin(tenantId, match);
    const fresh: ResolvedLogin | null = reread && reread !== 'unusable' ? reread : null;
    if (!fresh || !fresh.totpCode) {
      const reason = fresh?.totpError ?? login.totpError ?? 'the one-time code could not be computed';
      if (filled.length === 0) return skip(reason, after?.url ?? submittedAt);
      return finish('submitted', actionOf(reason), after?.url ?? submittedAt);
    }
    const problem = await type(otpControl, fresh.totpCode, true);
    if (problem) {
      if (filled.length === 0) return skip(problem, after?.url ?? submittedAt);
      return finish('submitted', actionOf(problem), after?.url ?? submittedAt);
    }
    filled.push(controlName(otpControl));
    submittedAt = after?.url ?? submittedAt;
    await settle();
    after = await walk(capture, loginControlsOf).catch(() => null);
  }

  // 5. The outcome, observed.
  const action = actionOf();
  if (!after) return finish('submitted', action, submittedAt);
  const remaining = pickControls(after.controls);
  if (after.controls.length === 0 && !onSignInRoute(after.url)) return finish('confirmed', action, after.url);
  if (remaining.password && after.url === submittedAt) return finish('failed', action, after.url);
  return finish('submitted', action, after.url);
}

/** On the pane, two matching logins hand the step to the person: the
 *  request to take over the copilot already provides. */
async function askPersonWhenOnPane(session: BrowserSession, tenantId: string): Promise<void> {
  if (!session.threadId) return;
  try {
    const { requestIntervention } = await import('../../browser-sessions/interventions');
    const { emitBrowserSessionEvent } = await import('../../browser-sessions/events');
    const { getById } = await import('../../browser-sessions/repository');
    const { alreadyPending } = await requestIntervention({
      tenantId, sessionId: session.id, threadId: session.threadId,
      reason: 'Two saved logins match this site. Choose one and sign in.',
      requestedByInvocationId: session.invocationId ?? null,
    });
    if (!alreadyPending) {
      const after = await getById(session.id);
      if (after) emitBrowserSessionEvent({ type: 'SESSION_UPDATED', session: after, emittedAt: new Date() });
    }
  } catch (err) {
    logger.warn({ session_id: session.id, err: (err as Error).message }, 'saved login: the request for the person could not be made');
  }
}

// ── The recorders and the hooks ─────────────────────────────────────────────

/** The pane's row when the session has a thread; the parked list for a
 *  run-owned session's next task otherwise. */
function recorderFor(session: BrowserSession, tenantId: string): LoginRecorder {
  return async (step, outcome) => {
    if (!session.threadId) {
      parkStep(session.vendorSessionId, step);
      return;
    }
    const { recordBrowserActivity } = await import('../../browser-sessions/activity-repository');
    await recordBrowserActivity({
      id: randomUUID(),
      tenantId,
      threadId: session.threadId,
      sessionId: session.id,
      tool: 'saved_login',
      instruction: step.action,
      instructionProtectedDataOmitted: true,
      outcome: SAVED_LOGIN_STEP_TYPES[outcome],
      personTookOver: false,
      steps: [step],
      captureGap: false,
      gapReason: null,
      stepsTruncated: false,
    });
  };
}

async function sessionFor(vendorSessionId: string, tenantId: string): Promise<BrowserSession | null> {
  const { getByVendorSessionId } = await import('../../browser-sessions/repository');
  const session = await getByVendorSessionId(vendorSessionId);
  if (!session || session.tenantId !== tenantId || session.closedAt) return null;
  return session;
}

/** After the vendor's own goto returned (session-vendor-proxy `gotoUrl`):
 *  the pane navigation, `start_browser_session`'s initial URL and
 *  `web_task`'s starting URL all land here. */
export async function applySavedLoginAfterNavigation(vendor: string, vendorSessionId: string, tenantId: string): Promise<LoginOutcome> {
  return guarded(tenantId, async () => {
    if (!(await isLoginSourceAvailable(tenantId))) return 'none';
    const session = await sessionFor(vendorSessionId, tenantId);
    if (!session || session.vendor !== vendor) return 'none';
    return inActionSlot(session, () => applySavedLogin(session, tenantId, recorderFor(session, tenantId)));
  });
}

/** Typing outside `actOnPage` takes the session's one-action-at-a-time
 *  slot, so the fill's keystrokes never interleave with an action's. A slot
 *  already held means an action is running on this page right now: the
 *  fill stands down rather than type over it. */
async function inActionSlot(session: BrowserSession, fn: () => Promise<LoginOutcome>): Promise<LoginOutcome> {
  const { holdPaneAction } = await import('../../browser-sessions/pane-actions');
  const release = holdPaneAction(session.id);
  if (!release) {
    logger.info({ session_id: session.id, event: 'saved_login_busy' }, 'saved login: an action is running on the session; nothing filled');
    return 'none';
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** After a pane action moved the page (pane-actions `actOnPage`), on the
 *  page the action holds. */
export async function applySavedLoginOnPane(session: BrowserSession, tenantId: string, page: Page): Promise<LoginOutcome> {
  return guarded(tenantId, async () => {
    if (!(await isLoginSourceAvailable(tenantId))) return 'none';
    return applySavedLogin(session, tenantId, recorderFor(session, tenantId), { page });
  });
}

/** On a task's own page (the Jev loop's, Stagehand's), with each step handed
 *  to the task's trail. */
export async function applySavedLoginOnTaskPage(
  input: { vendor: string; vendorSessionId: string; tenantId: string; page: Page },
  record: (step: BrowserTaskStep) => void,
): Promise<LoginOutcome> {
  return guarded(input.tenantId, async () => {
    if (!(await isLoginSourceAvailable(input.tenantId))) return 'none';
    const session = await sessionFor(input.vendorSessionId, input.tenantId);
    if (!session || session.vendor !== input.vendor) return 'none';
    return inActionSlot(session, () => applySavedLogin(session, input.tenantId, (step) => record(step), { page: input.page }));
  });
}

/** A hook never fails the navigation, action or task it rides in. */
async function guarded(tenantId: string, fn: () => Promise<LoginOutcome>): Promise<LoginOutcome> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ tenantId, err: (err as Error).message, event: 'saved_login_hook_failed' }, 'saved login: the hook did not run');
    return 'none';
  }
}

/** Whether an observation carries an authentication-class fill control, by
 *  the classifier's own rule over the control's name and the page's route:
 *  the Jev loop's snapshot lists no password box, so a sign-in page shows
 *  as a username box on a sign-in route, or a labelled one-time code box. */
export function observationHasAuthenticationFill(state: { url: string; actions: ReadonlyArray<{ kind: string; label: string; role?: string }> }): boolean {
  return state.actions.some((a) => a.kind === 'fill'
    && classifyProtectedControl({ tag: 'input', type: 'text', name: a.label.split(' → ')[0], url: state.url }) === 'authentication');
}

/** For the tests: the outcome memo of one session. */
export function _attemptedOriginsForTesting(sessionId: string): ReadonlyMap<string, LoginOutcome> {
  return attempted.get(sessionId) ?? new Map();
}
