// Fine-grained pane actions with control references: one read of the page's
// controls, one action on one control, for the team's tools
// (`read_browser_session_controls`, `act_in_browser_session`) and the
// platform assistants' RPCs (SnapshotPage, ActOnPage) alike.
//
// The design, in the order the code follows it:
//
//   ENUMERATE AND CLASSIFY IN THE ISOLATED WORLD, FIRST. The walker embedded
//   in the recorder (takeover-capture/page-controls.ts) lists every visible
//   interactive control, describes each with the recorder's own
//   `describeTarget` and classifies it with `classifyProtectedControl`
//   BEFORE anything else is read; a protected control contributes its role,
//   name and kind and nothing else. Controls inside the viewport come first,
//   the rest after, `start_at` skipped, PAGE_CONTROLS_CAP kept, `total`
//   saying how many there are. Same-origin child frames are walked through
//   contentDocument with the frame's box added; a cross-origin frame with an
//   attached world is walked in its own world; a frame with no world is not
//   listed and `framesNotListed` says so.
//
//   NAME A CONTROL BY WHAT IT IS. Each control is `(role, name, nth)`,
//   recomputed from the DOM on every use, so a reference survives a change
//   of instance and of connection. The reading's identity is a snapshot id
//   stored on the session row; an action names it, and a stale one is
//   refused rather than acted on.
//
//   ACT WITH TRUSTED INPUT AT THE CONTROL'S BOX, AFTER A HIT-TARGET CHECK.
//   The matched element is scrolled into view in the world, its box re-read,
//   and the world is asked what a pointer at the centre, then the four
//   quadrant centres, would hit; when none reaches the control the action is
//   refused `obscured` and the covering element is named, so the model acts
//   on the cover first. Then `page.mouse.click` at the point that hit,
//   `page.mouse.move`, `page.keyboard.insertText`; a native select is set in
//   the world; a custom combobox is driven by click and type.
//
//   RE-CHECK AT ACTION TIME. Re-walk, re-match, re-classify, re-read the
//   box: a stale snapshot, a missing control or a now-protected control is
//   refused.
//
// Every action is recorded as browser activity (migration 423) under the
// caller's id, the instruction phrased by the record's one prose renderer
// (`describeAction`), the value under the takeover-action disposition rules;
// a read is recorded only when the caller says it is work.

import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { redactSensitiveText, sanitizeBrowserText, type SanitizedText } from '@liftoffos/redact';
import { quoted } from '@liftoffos/browser-record';
import { logger } from '../infrastructure/logging';
import * as repo from './repository';
import { withPage } from './cdp-page';
import { persistCurrentUrl } from './current-url';
import { recordBrowserActivity } from './activity-repository';
import { recordedUrl } from './takeover-capture/route-template';
import { PAGE_READERS } from './takeover-capture/recorder';
import type { ControlIdentity, WalkResult, WalkedControl, HitResult } from './takeover-capture/page-controls';
import type { SessionCapture } from './takeover-capture/session-capture';
import { PAGE_TITLE_CAP, type BrowserSession, type StoredPageSnapshot, type StoredSnapshotControl } from './types';

export const PAGE_CONTROLS_CAP = 120;
export const PAGE_TEXT_CAP = 12_000;
export const SNAPSHOT_TTL_MS = 10 * 60_000;
export const PRESS_KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'] as const;
export type PressKey = (typeof PRESS_KEYS)[number];

/** Each Playwright call's budget, and the settle after an action. */
const ACTION_STEP_TIMEOUT_MS = 4_000;
/** A pointer step's own bound. `page.mouse.click` resolves when the browser
 *  acknowledges the input, which queues behind the page's main thread: an
 *  ad-heavy page can take past four seconds while ordinary pages take
 *  tens to two thousand milliseconds. The step is the only thing the person
 *  waits on, and a bound that fires early costs more than the wait, because
 *  the click has usually been delivered by then and nobody can say so. */
export const POINTER_STEP_TIMEOUT_MS = 8_000;
const SETTLE_TIMEOUT_MS = 1_500;
/** Scroll defaults and cap, in pixels. */
const SCROLL_DEFAULT_PX = 600;
const SCROLL_MAX_PX = 4_000;
/** Controls the walker keeps per document space before it counts the rest;
 *  well above the listing cap so paging reaches deep into a long page. */
const WALK_HARD_CAP = 2_000;
/** Longest control name kept. */
const CONTROL_NAME_CAP = 200;

export const PANE_ACTION_KINDS = ['click', 'hover', 'type', 'select', 'press', 'scroll'] as const;
export type PaneActionKind = (typeof PANE_ACTION_KINDS)[number];

export interface PaneAction {
  action: PaneActionKind;
  /** The control, in the caller's own words ("the Download JPG button").
   *  How a caller names a control now: the runtime reads the page and a
   *  model that does nothing else picks it out. `ref` overrides this. */
  what?: string;
  /** A control's exact reference from a reading of the page. The override:
   *  a caller that already holds one is taken at its word and nothing is
   *  resolved. */
  ref?: string;
  text?: string;
  submit?: boolean;
  value?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
}

export type PaneRefusalKind =
  /** The words did not name one control clearly enough to act on. */
  | 'target_unclear'
  | 'person_driving' | 'intervention_pending' | 'stale_snapshot' | 'control_not_found' | 'option_not_found'
  | 'protected_control' | 'protected_text' | 'key_not_allowed' | 'focus_failed' | 'obscured' | 'busy' | 'invalid_action'
  /** The step did not finish inside its bound, or the browser dropped it
   *  mid-way: what the page did with it cannot be known from here. */
  | 'did_not_finish';

export interface PageControlOut {
  ref: string;
  role: string;
  name: string;
  inputType: string;
  valueState: string;
  disabled: boolean;
  protectedKind: string;
  offscreen: boolean;
  nameTruncated: boolean;
  nameProtectedDataOmitted: boolean;
}

export interface PageSnapshot {
  id: string;
  url: SanitizedText;
  title: SanitizedText;
  controls: PageControlOut[];
  controlsTruncated: boolean;
  total: number;
  startAt: number;
  framesNotListed: boolean;
  text: SanitizedText | null;
  /** The id the read was recorded under, or null when not recorded. */
  activityId: string | null;
}

export interface PaneActionOutcome {
  acted: boolean;
  refusalKind: PaneRefusalKind | '';
  /** The refusal explained, model-facing; empty when acted. */
  message: string;
  coveredBy: string;
  personTookOverDuring: boolean;
  url: SanitizedText;
  title: SanitizedText;
  /** The id the action was recorded under, or null when the row could not
   *  be written. */
  activityId: string | null;
}

/** A read or an action could not reach the page at all. */
export class PaneUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaneUnavailable';
  }
}

/** The refusal, in the words the model reads. One spelling per kind. */
export function refusalMessage(kind: PaneRefusalKind, extra: { coveredBy?: string; reason?: string; gate?: string } = {}): string {
  switch (kind) {
    case 'target_unclear':
      return extra.reason ?? 'It is not clear which control you meant. Read the controls and act on one by its reference.';
    case 'person_driving':
      return extra.gate ?? 'The person holds the wheel. Wait for them to hand the browser back; you will get the next turn when they do.';
    case 'intervention_pending':
      return extra.gate ?? 'You asked the person to take over the browser. Until they do, or you withdraw the request with ask_person_to_take_over_browser_session, you can read the browser but not act in it.';
    case 'stale_snapshot':
      return 'That reading of the page is stale: the page changed, a newer reading was taken, or the reading is too old. Read the controls again and act on the new references.';
    case 'control_not_found':
      return 'That control is no longer on the page, or the reference is not from the current reading. Read the controls again.';
    case 'option_not_found':
      return 'That option is not in the menu. Pass the option label exactly as the menu shows it, or its value.';
    case 'protected_control':
      return 'That control takes a password, a payment detail, an identity number or a file, and you cannot type into it. Ask the person to take over for this step with ask_person_to_take_over_browser_session.';
    case 'protected_text':
      return 'That text looks like a password, a code, a card or an identity number, and it was not typed. Ask the person to take over for this step with ask_person_to_take_over_browser_session.';
    case 'key_not_allowed':
      return `Only these keys can be pressed: ${PRESS_KEYS.join(', ')}.`;
    case 'focus_failed':
      return 'The text box did not take focus, so nothing was typed. Read the controls again and try once more.';
    case 'obscured':
      return `Something covers that control: ${extra.coveredBy || 'another element'}. Act on the cover first (it is in the listing), then read the controls again.`;
    case 'busy':
      return 'Another action is running in this browser. Wait for it to finish, then try again.';
    case 'did_not_finish':
      return 'That action did not finish in time. The page may have taken it and may have changed, so read the controls again and look before you act; do not simply repeat it.';
    case 'invalid_action':
      return extra.reason ?? 'That action is not one the browser takes.';
  }
}

// ── The recorder's world, warmed on demand ───────────────────────────────────

/** The session's warm capture, warmed now when this instance has none. The
 *  page readers live in its world. Exported for the saved-login fill
 *  (integrations/onepassword/autofill.ts), which walks the same world. */
export async function paneCaptureFor(session: BrowserSession, tenantId: string): Promise<SessionCapture> {
  const { warmCaptureFor, warmSessionCapture } = await import('./takeover-capture/session-capture');
  let capture = warmCaptureFor(session.id);
  if (!capture || !capture.attached) {
    await warmSessionCapture({ tenantId, session });
    capture = warmCaptureFor(session.id);
  }
  if (!capture || !capture.attached || !capture.mainFrameId) {
    throw new PaneUnavailable('The page could not be read right now: the browser did not take the reader.');
  }
  return capture;
}

/** One document space's walk, merged into the page's: the main document
 *  (with its same-origin frames) and each cross-origin frame with a world. */
interface SpaceWalk {
  frameId: string | null;
  offset: { x: number; y: number };
  /** The frame's position in the main walk's document order; -1 for main. */
  docIndex: number;
  result: WalkResult;
}

async function walkSpaces(
  capture: SessionCapture,
  includeText: boolean,
): Promise<{ spaces: SpaceWalk[]; framesNotListed: boolean }> {
  const opts = { includeText, hardCap: WALK_HARD_CAP, textCap: PAGE_TEXT_CAP };
  const main = await capture.evaluate<WalkResult>(`${PAGE_READERS}.controls(${JSON.stringify(opts)})`);
  const spaces: SpaceWalk[] = [{ frameId: null, offset: { x: 0, y: 0 }, docIndex: -1, result: main }];
  let framesNotListed = main.partial;
  for (const frame of main.frames) {
    const frameId = await capture.frameIdOf(frame.index);
    if (!frameId || !capture.hasWorld(frameId)) {
      framesNotListed = true;
      continue;
    }
    try {
      const result = await capture.evaluate<WalkResult>(`${PAGE_READERS}.controls(${JSON.stringify(opts)})`, frameId);
      spaces.push({ frameId, offset: { x: frame.box.x, y: frame.box.y }, docIndex: frame.docIndex, result });
      // A frame inside a cross-origin frame is one level deeper than this
      // walk goes: said so rather than listed as complete.
      if (result.frames.length > 0 || result.partial) framesNotListed = true;
    } catch (err) {
      logger.warn({ err: (err as Error).message, frame_id: frameId }, 'pane actions: a frame with a world could not be walked');
      framesNotListed = true;
    }
  }
  return { spaces, framesNotListed };
}

interface MergedControl extends WalkedControl {
  frameId: string | null;
  /** Document order across spaces. */
  order: number;
}

/** Every space's controls in document order, a frame's in the frame's
 *  place; a control inside a frame carries the frame's offset on its box. */
function mergeControls(spaces: SpaceWalk[]): MergedControl[] {
  const out: MergedControl[] = [];
  const main = spaces[0];
  const frameSpaces = spaces.slice(1).sort((a, b) => a.docIndex - b.docIndex);
  let order = 0;
  let fi = 0;
  for (const c of main.result.controls) {
    while (fi < frameSpaces.length && frameSpaces[fi].docIndex < c.docIndex) {
      for (const fc of frameSpaces[fi].result.controls) {
        out.push({ ...fc, box: { ...fc.box, x: fc.box.x + frameSpaces[fi].offset.x, y: fc.box.y + frameSpaces[fi].offset.y }, frameId: frameSpaces[fi].frameId, order: order++ });
      }
      fi++;
    }
    out.push({ ...c, frameId: null, order: order++ });
  }
  while (fi < frameSpaces.length) {
    for (const fc of frameSpaces[fi].result.controls) {
      out.push({ ...fc, box: { ...fc.box, x: fc.box.x + frameSpaces[fi].offset.x, y: fc.box.y + frameSpaces[fi].offset.y }, frameId: frameSpaces[fi].frameId, order: order++ });
    }
    fi++;
  }
  return out;
}

/** One sign-in control as the saved-login fill sees it: the identity the
 *  action readers take, plus what tells a password box, a one-time-code box
 *  and a username box apart. Never model-facing. */
export interface LoginControl extends ControlIdentity {
  frameId: string | null;
  tag: string;
  inputType: string;
  autocomplete: string;
  /** The containing form, qualified by the frame it was walked in so two
   *  document spaces cannot share a key; '' when the control is in none. */
  formKey: string;
  protectedKind: string;
  offscreen: boolean;
  /** Where the control sat in the page's own order, so a caller can say
   *  which of two controls is nearer another. */
  order: number;
}

/** A control that sends a sign-in form. Not an editable control and never
 *  authentication-class (the classifier only classes what takes a value),
 *  so it is collected separately from the boxes. */
export interface SubmitControl extends ControlIdentity {
  frameId: string | null;
  formKey: string;
  offscreen: boolean;
  order: number;
}

/** A control whose name says it sends the form. Narrow on purpose: a page
 *  is full of buttons, and clicking the wrong one on a sign-in page is a
 *  worse outcome than not clicking at all. */
const SUBMIT_LABEL = /\b(sign ?in|log ?in|login|submit|continue|next|verify|confirm|send code|enter)\b/;

/** The page's authentication-class editable controls and the controls that
 *  could send them, both in document order, with the page's raw URL: the
 *  same walk the listing makes, so the fill and the pane cannot disagree
 *  about what a sign-in control is. */
export async function loginControlsOf(
  capture: SessionCapture,
): Promise<{ url: string; controls: LoginControl[]; submits: SubmitControl[] }> {
  const { spaces } = await walkSpaces(capture, false);
  const merged = mergeControls(spaces);
  const editable = (c: MergedControl): boolean => {
    if (c.tag === 'textarea') return true;
    if (c.tag === 'input') {
      return c.inputType !== 'submit' && c.inputType !== 'button' && c.inputType !== 'reset' && c.inputType !== 'image'
        && c.inputType !== 'checkbox' && c.inputType !== 'radio' && c.inputType !== 'file' && c.inputType !== 'hidden';
    }
    return c.role === 'textbox';
  };
  const sends = (c: MergedControl): boolean => {
    if (c.disabled) return false;
    const isButton = c.role === 'button' || c.tag === 'button'
      || (c.tag === 'input' && (c.inputType === 'submit' || c.inputType === 'button' || c.inputType === 'image'));
    if (!isButton) return false;
    // An input[type=submit] with no label of its own still sends the form.
    return SUBMIT_LABEL.test(normalizeName(c.name)) || (c.tag === 'input' && c.inputType === 'submit');
  };
  const formKeyOf = (c: MergedControl): string => (c.formKey ? `${c.frameId ?? ''}#${c.formKey}` : '');
  const controls: LoginControl[] = [];
  const submits: SubmitControl[] = [];
  merged.forEach((c, order) => {
    if (c.protectedKind === 'authentication' && !c.disabled && editable(c)) {
      controls.push({
        role: c.role, name: c.name, nth: c.nth, frameId: c.frameId, tag: c.tag,
        inputType: c.inputType, autocomplete: c.autocomplete, formKey: formKeyOf(c),
        protectedKind: c.protectedKind, offscreen: c.offscreen, order,
      });
    } else if (sends(c)) {
      submits.push({ role: c.role, name: c.name, nth: c.nth, frameId: c.frameId, formKey: formKeyOf(c), offscreen: c.offscreen, order });
    }
  });
  return { url: spaces[0].result.url, controls, submits };
}

/** A control's name as the label rules read it: hyphens and camelCase
 *  opened out, lowercased. The same shape `protected-control.ts` uses, kept
 *  here because that one is embedded in the page and takes no import. */
function normalizeName(text: string): string {
  return (text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Click one control, the way `typeIntoControl` types into one: the hit
 * target at its box, the click at the point that hit, and a retry against a
 * freshly measured box when the first point missed. Used by the saved-login
 * fill to send a form whose fields have no form element to submit.
 */
export async function clickControl(
  capture: SessionCapture,
  page: Page,
  target: { role: string; name: string; nth: number; frameId: string | null },
  opts: { armNavigation?: (page: Page) => void } = {},
): Promise<{ outcome: 'clicked' } | { outcome: 'control_not_found' } | { outcome: 'obscured'; coveredBy: string }> {
  let offset = { x: 0, y: 0 };
  if (target.frameId) {
    if (!capture.hasWorld(target.frameId)) return { outcome: 'control_not_found' };
    const frameOffset = await frameOffsetNow(capture, target.frameId);
    if (!frameOffset) return { outcome: 'control_not_found' };
    offset = frameOffset;
  }
  const id = { role: target.role, name: target.name, nth: target.nth };
  const world = target.frameId ?? undefined;
  const hitNow = async (): Promise<HitResult> => capture.evaluate<HitResult>(
    `${PAGE_READERS}.hit(${JSON.stringify(id)}, ${JSON.stringify({ scroll: true })})`, world,
  );
  const hit = await hitNow();
  if (!hit.found) return { outcome: 'control_not_found' };
  if (!hit.hit) return { outcome: 'obscured', coveredBy: hit.coveredBy };
  // Measured again immediately before the click for the same reason the
  // typing path re-measures: the page may have moved since the walk.
  const fresh = await hitNow();
  const point = fresh.found && fresh.hit ? fresh.hit : hit.hit;
  opts.armNavigation?.(page);
  await withTimeout(page.mouse.click(point.x + offset.x, point.y + offset.y), 'the click to submit');
  return { outcome: 'clicked' };
}

/** The text projection with each frame's text in its place, then through
 *  the sanitizer at the cap. */
function mergeText(spaces: SpaceWalk[]): SanitizedText | null {
  const main = spaces[0].result.text;
  if (!main) return null;
  const byIndex = new Map<number, string>();
  for (const space of spaces.slice(1)) {
    const frame = spaces[0].result.frames.find((f) => f.docIndex === space.docIndex);
    if (frame && space.result.text) {
      byIndex.set(frame.index, space.result.text.map((seg) => (typeof seg === 'string' ? seg : '')).join(''));
    }
  }
  const joined = main.map((seg) => {
    if (typeof seg === 'string') return seg;
    return byIndex.has(seg.frame) ? `\n${byIndex.get(seg.frame)}\n` : '\n[an embedded frame could not be read]\n';
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  return sanitizeBrowserText(joined, PAGE_TEXT_CAP);
}

function controlOut(ref: string, c: MergedControl): PageControlOut {
  const name = sanitizeBrowserText(c.name, CONTROL_NAME_CAP);
  let valueState = c.valueState;
  let protectedKind = c.protectedKind;
  if (valueState && valueState !== 'protected' && valueState !== 'checked' && valueState !== 'unchecked' && valueState !== 'selected') {
    // The Node-side guarantee, as every row gets: a value the world read as
    // recordable that is itself credential-shaped is not shown.
    if (redactSensitiveText(valueState) !== valueState || sanitizeBrowserText(valueState).protectedDataOmitted) {
      valueState = 'protected';
      protectedKind = protectedKind || 'sensitive_text';
    }
  }
  return {
    ref,
    role: c.role,
    name: name.text,
    inputType: c.inputType,
    valueState,
    disabled: c.disabled,
    protectedKind,
    offscreen: c.offscreen,
    nameTruncated: c.nameTruncated || name.truncated,
    nameProtectedDataOmitted: name.protectedDataOmitted,
  };
}

// ── The read ────────────────────────────────────────────────────────────────

export async function snapshotPage(
  session: BrowserSession,
  tenantId: string,
  opts: { includeText?: boolean; recordActivity?: boolean; activityId?: string; startAt?: number } = {},
): Promise<PageSnapshot> {
  const includeText = opts.includeText === true;
  const startAt = Math.max(0, Math.floor(opts.startAt ?? 0));
  // A page read from `start_at` continues the reading in hand when there is
  // one of this page, young enough: same id, same clock, the earlier pages'
  // references kept beside the new ones. A reference from page one stays
  // valid after page two is read, which is what paging is for; a reading of
  // another page, or an expired one, starts afresh.
  const prior = startAt > 0 ? (await repo.getById(session.id))?.pageSnapshot ?? null : null;
  const capture = await paneCaptureFor(session, tenantId);
  const { spaces, framesNotListed } = await walkSpaces(capture, includeText);
  const merged = mergeControls(spaces);
  // Controls in the viewport first, document order within; the rest after,
  // document order.
  const ordered = [...merged.filter((c) => !c.offscreen), ...merged.filter((c) => c.offscreen)];
  const total = spaces.reduce((n, s) => n + s.result.total, 0);
  const page = ordered.slice(startAt, startAt + PAGE_CONTROLS_CAP);
  const controlsTruncated = ordered.length > startAt + PAGE_CONTROLS_CAP || spaces.some((s) => s.result.hardCapped);
  const rawUrl = spaces[0].result.url;
  const url = recordedUrl(rawUrl);
  const title = sanitizeBrowserText(spaces[0].result.title, PAGE_TITLE_CAP);
  const continues = prior !== null && prior.url === url.text
    && Date.now() - new Date(prior.takenAt).getTime() <= SNAPSHOT_TTL_MS;
  const id = continues ? prior.id : randomUUID();
  const pageControls: StoredSnapshotControl[] = page.map((c, i) => {
    // The projection the reading publishes, so the redaction that keeps a
    // password's contents out of a listing keeps them out of the stored
    // reading too, and out of anything later built from it.
    const shown = controlOut(`c${startAt + i}`, c);
    return {
      ref: shown.ref,
      role: c.role,
      name: c.name,
      nth: c.nth,
      frameId: c.frameId,
      inputType: shown.inputType,
      valueState: shown.valueState,
      disabled: shown.disabled,
    };
  });
  const kept = continues ? prior.controls.filter((c) => !pageControls.some((n) => n.ref === c.ref)) : [];
  const stored: StoredPageSnapshot = {
    id,
    url: url.text,
    title: title.text,
    takenAt: continues ? prior.takenAt : new Date().toISOString(),
    controls: [...kept, ...pageControls],
  };
  await repo.setPageSnapshot(session.id, stored);
  await persistCurrentUrl(session.vendorSessionId, rawUrl, spaces[0].result.title).catch(() => null);
  const controls = page.map((c, i) => controlOut(`c${startAt + i}`, c));
  const text = includeText ? mergeText(spaces) : null;
  let activityId: string | null = null;
  if (opts.recordActivity && session.threadId) {
    const outcome = `read ${controls.length} of ${total} control${total === 1 ? '' : 's'} on ${url.text}${title.text ? `; title: ${title.text}` : ''}${includeText ? '; and the page text' : ''}`;
    activityId = await recordBrowserActivity({
      id: opts.activityId || randomUUID(),
      tenantId,
      threadId: session.threadId,
      sessionId: session.id,
      tool: 'read_browser_session_controls',
      instruction: `read the page's controls${includeText ? ' and text' : ''}${startAt > 0 ? ` from ${startAt}` : ''}`,
      outcome,
      outcomeTruncated: url.truncated || title.truncated,
      outcomeProtectedDataOmitted: url.protectedDataOmitted || title.protectedDataOmitted,
      personTookOver: false,
      steps: null,
      captureGap: false,
      gapReason: null,
      stepsTruncated: false,
    });
  }
  return { id, url, title, controls, controlsTruncated, total, startAt, framesNotListed, text, activityId };
}

// ── The action ──────────────────────────────────────────────────────────────

/** One action at a time per session on this instance: a second arriving
 *  while one runs is `busy`. */
const inFlight = new Set<string>();

/** Take the session's one-action-at-a-time slot for typing that happens
 *  outside `actOnPage`: the saved-login fill after a navigation, or on a
 *  task's own page. Null when an action is running, so the fill does not
 *  interleave its keystrokes with the action's; the caller lets the page be.
 *  `actOnPage`'s own fill runs inside the slot it already holds and does
 *  not take it. Returns the release. */
export function holdPaneAction(sessionId: string): (() => void) | null {
  if (inFlight.has(sessionId)) return null;
  inFlight.add(sessionId);
  return () => { inFlight.delete(sessionId); };
}

async function withTimeout<T>(p: Promise<T>, what: string, ms = ACTION_STEP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The current box offset of a cross-origin frame, re-resolved from a fresh
 *  main walk, or null when the frame is gone. */
async function frameOffsetNow(capture: SessionCapture, frameId: string): Promise<{ x: number; y: number } | null> {
  const main = await capture.evaluate<WalkResult>(`${PAGE_READERS}.controls(${JSON.stringify({ includeText: false, hardCap: 1, textCap: 0 })})`);
  for (const frame of main.frames) {
    const id = await capture.frameIdOf(frame.index);
    if (id === frameId) return { x: frame.box.x, y: frame.box.y };
  }
  return null;
}

/** The request as the record's instruction column keeps it, in the imperative
 *  and whatever came of it: `click link "Sports"` beside an outcome that says
 *  the page it landed on, or one that says what covered the control. The
 *  person's own actions are phrased in the past by `describeAction` because
 *  they happened; an assistant's request is what it asked for, and reading
 *  `clicked` above a refusal would say the click happened. The control is
 *  phrased as `describeAction` phrases one (role, else tag, else "control",
 *  the name quoted) so the two read alike. A request refused before the
 *  control was matched names the reference. A value appears only when the
 *  caller recorded one, so a refused text never reaches the row. */
function describeRequest(
  action: PaneAction,
  control: { role: string; name: string; tag: string; inputType: string } | null,
  extra: { value: string; detail: string },
): string {
  const target = control
    ? `${control.role || control.tag || 'control'} ${control.name ? quoted(control.name) : 'without a name'}`
    : action.ref ? `reference ${quoted(action.ref)}` : 'a control';
  switch (action.action) {
    case 'click': return `click ${target}`;
    case 'hover': return `hover over ${target}`;
    case 'type': return `type ${extra.value ? quoted(extra.value) : 'text'} into ${target}${action.submit ? ' and press Enter' : ''}`;
    case 'select': return `choose ${extra.value ? quoted(extra.value) : 'an option'} in ${target}`;
    case 'press': return `press ${extra.detail || (typeof action.key === 'string' && action.key ? action.key : 'a key')}`;
    case 'scroll': return extra.detail || `scroll ${action.direction === 'up' ? 'up' : 'down'}`;
    default: return `${String(action.action)} ${target}`;
  }
}

/** A control to type into: its identity, and the frame it is in. */
export interface TypeTarget extends ControlIdentity {
  frameId: string | null;
}

export type TypeOutcome =
  | { outcome: 'typed' }
  | { outcome: 'control_not_found' }
  | { outcome: 'obscured'; coveredBy: string }
  | { outcome: 'focus_failed' };

/**
 * Type trusted text into one control, the one way text reaches a page here:
 * the hit-target check at the control's box (refused `obscured` when
 * covered), the click at the point that hit, the active-element check, the
 * whole value selected and replaced, and Enter with the navigation armed
 * when the caller submits. Two callers: `actOnPage`'s `type`, which reaches
 * this only after its `protected_control` and `protected_text` refusals, and
 * the saved-login fill (integrations/onepassword/autofill.ts), the one caller
 * that types into an authentication control and never takes model text.
 *
 * `hit` and `offset` are accepted from a caller that already resolved them
 * for the same control; otherwise both are resolved here.
 */
export async function typeIntoControl(
  capture: SessionCapture,
  page: Page,
  target: TypeTarget,
  text: string,
  opts: { submit: boolean; armNavigation?: (page: Page) => void; hit?: HitResult; offset?: { x: number; y: number } },
): Promise<TypeOutcome> {
  let offset = opts.offset ?? { x: 0, y: 0 };
  if (!opts.offset && target.frameId) {
    if (!capture.hasWorld(target.frameId)) return { outcome: 'control_not_found' };
    const frameOffset = await frameOffsetNow(capture, target.frameId);
    if (!frameOffset) return { outcome: 'control_not_found' };
    offset = frameOffset;
  }
  const id = { role: target.role, name: target.name, nth: target.nth };
  const world = target.frameId ?? undefined;
  const hitNow = async (): Promise<HitResult> => capture.evaluate<HitResult>(
    `${PAGE_READERS}.hit(${JSON.stringify(id)}, ${JSON.stringify({ scroll: true })})`, world,
  );
  const focused = async (): Promise<boolean> => (await capture.evaluate<{ isTarget: boolean; protectedKind: string }>(
    `${PAGE_READERS}.active(${JSON.stringify(id)})`, world,
  )).isTarget;
  let hit = opts.hit ?? await hitNow();
  if (!hit.found) return { outcome: 'control_not_found' };
  if (!hit.hit) return { outcome: 'obscured', coveredBy: hit.coveredBy };
  const clickAt = async (h: HitResult): Promise<void> => {
    const point = { x: h.hit!.x + offset.x, y: h.hit!.y + offset.y };
    await withTimeout(page.mouse.click(point.x, point.y), 'the click to focus');
  };
  await clickAt(hit);
  // A click names a PLACE, and the place is computed a moment before the
  // click lands: an ad slot filling, a banner resolving or a font settling
  // moves the control out from under it, and the page a person is looking
  // at does that routinely. So a miss is retried against a freshly measured
  // box, and if that misses too the control is focused by NAME, which no
  // layout can move. The click stays the first move because it is the
  // gesture a page expects, and some pages only reveal a field once it is
  // clicked.
  if (!(await focused())) {
    const again = await hitNow();
    if (again.found && again.hit) {
      hit = again;
      await clickAt(again);
    }
    if (!(await focused())) {
      const put = await capture.evaluate<{ focused: boolean }>(`${PAGE_READERS}.focus(${JSON.stringify(id)})`, world);
      if (!put.focused || !(await focused())) return { outcome: 'focus_failed' };
    }
  }
  await withTimeout(page.keyboard.press('ControlOrMeta+a'), 'selecting the text');
  await withTimeout(page.keyboard.insertText(text), 'typing');
  if (opts.submit) {
    opts.armNavigation?.(page);
    await withTimeout(page.keyboard.press('Enter'), 'pressing Enter');
  }
  return { outcome: 'typed' };
}

export async function actOnPage(
  session: BrowserSession,
  tenantId: string,
  snapshotId: string,
  action: PaneAction,
  activityId?: string,
): Promise<PaneActionOutcome> {
  const recordId = activityId || randomUUID();
  const empty: SanitizedText = { text: '', truncated: false, protectedDataOmitted: false };
  const record = async (
    outcome: Omit<PaneActionOutcome, 'activityId'>,
    control: { role: string; name: string; tag: string; inputType: string } | null,
    extra: { valueDisposition: string; value: string; detail: string },
  ): Promise<PaneActionOutcome> => {
    if (!session.threadId) return { ...outcome, activityId: null };
    const instruction = describeRequest(action, control, extra);
    const tail = outcome.personTookOverDuring ? ' [the person took over while this action ran]' : '';
    const text = outcome.acted
      ? `${outcome.url.text ? `now on ${outcome.url.text}` : 'acted'}${outcome.title.text ? `; title: ${outcome.title.text}` : ''}${tail}`
      : `${outcome.message}${tail}`;
    const id = await recordBrowserActivity({
      id: recordId,
      tenantId,
      threadId: session.threadId,
      sessionId: session.id,
      tool: 'act_in_browser_session',
      instruction,
      outcome: text,
      outcomeTruncated: outcome.url.truncated || outcome.title.truncated,
      outcomeProtectedDataOmitted: outcome.url.protectedDataOmitted || outcome.title.protectedDataOmitted,
      personTookOver: outcome.personTookOverDuring || outcome.refusalKind === 'person_driving',
      steps: null,
      captureGap: false,
      gapReason: null,
      stepsTruncated: false,
    });
    return { ...outcome, activityId: id };
  };
  const refuse = (kind: PaneRefusalKind, extra: { coveredBy?: string; gate?: string; reason?: string } = {}, control: { role: string; name: string; tag: string; inputType: string } | null = null) =>
    record({
      acted: false, refusalKind: kind, message: refusalMessage(kind, extra), coveredBy: extra.coveredBy ?? '',
      personTookOverDuring: false, url: empty, title: empty,
    }, control, { valueDisposition: 'none', value: '', detail: '' });

  // 1. The gates: a person at the wheel, a pending request for them.
  const { checkBrowserSessionTakeoverFor } = await import('../tools/standard-tool-handler');
  const gate = await checkBrowserSessionTakeoverFor(tenantId, session.agentId, session.callerSessionId ?? undefined);
  if (gate) {
    const pending = /withdraw the request/.test(gate.error ?? '');
    return refuse(pending ? 'intervention_pending' : 'person_driving', { gate: gate.error ?? undefined });
  }
  if (inFlight.has(session.id)) return refuse('busy');
  inFlight.add(session.id);
  try {
    return await performAction(session, tenantId, snapshotId, action, record, refuse);
  } catch (err) {
    // An action that THREW is an action nobody can account for: a step that
    // outran its bound, a connection the vendor dropped mid-click, a CDP
    // error. The browser may well have taken it. Before this, the throw left
    // the recorder untouched and crossed the wire as an internal error, so
    // the person was told the browser was unavailable while the record held
    // no trace of the attempt -- and the next turn, reading that record, said
    // the action had never been attempted.
    //
    // A session that cannot be reached at all is still that, and is reported
    // as such by its own error.
    if (err instanceof PaneUnavailable) throw err;
    logger.warn(
      { session_id: session.id, action: action.action, err: (err as Error).message, event: 'pane_action_did_not_finish' },
      'pane action did not finish; recorded as unaccounted for',
    );
    return record({
      acted: false, refusalKind: 'did_not_finish', message: refusalMessage('did_not_finish'), coveredBy: '',
      personTookOverDuring: false, url: empty, title: empty,
    }, null, { valueDisposition: 'none', value: '', detail: '' });
  } finally {
    inFlight.delete(session.id);
  }
}

/** Which control the caller meant, when they named it in words.
 *
 *  Kept to the act's own bound: a resolution that outruns it answers a
 *  refusal rather than a guess, and the action is never taken on one. */
async function resolveTargetFor(
  session: BrowserSession,
  tenantId: string,
  action: PaneAction,
  stored: { url: string; title?: string; controls: StoredSnapshotControl[] },
): Promise<{ ref: string; refusal: string }> {
  const { resolveTarget } = await import('./pane-target');
  return resolveTarget({
    what: action.what ?? '',
    action: action.action,
    page: { url: stored.url, ...(stored.title ? { title: stored.title } : {}) },
    controls: stored.controls.map((c) => ({
      ref: c.ref,
      role: c.role,
      name: c.name,
      ...(c.inputType ? { inputType: c.inputType } : {}),
      ...(c.valueState ? { valueState: c.valueState } : {}),
      ...(c.disabled ? { disabled: c.disabled } : {}),
    })),
    tenantId,
    ...(session.agentId ? { runtimeAgentId: session.agentId } : {}),
    deadlineMs: TARGET_RESOLUTION_MS,
  });
}

/** How long naming a control may take before the act refuses instead. */
const TARGET_RESOLUTION_MS = 8_000;

type Recorder = (
  outcome: Omit<PaneActionOutcome, 'activityId'>,
  control: { role: string; name: string; tag: string; inputType: string } | null,
  extra: { valueDisposition: string; value: string; detail: string },
) => Promise<PaneActionOutcome>;
type Refuser = (kind: PaneRefusalKind, extra?: { coveredBy?: string; gate?: string; reason?: string }, control?: { role: string; name: string; tag: string; inputType: string } | null) => Promise<PaneActionOutcome>;

async function performAction(
  session: BrowserSession,
  tenantId: string,
  snapshotId: string,
  action: PaneAction,
  record: Recorder,
  refuse: Refuser,
): Promise<PaneActionOutcome> {
  if (!(PANE_ACTION_KINDS as readonly string[]).includes(action.action)) {
    return refuse('invalid_action', { reason: `"${String(action.action)}" is not an action the browser takes: click, hover, type, select, press or scroll.` });
  }
  const capture = await paneCaptureFor(session, tenantId);

  // 2. The reading must be the current one, young enough, and of this page.
  const fresh = await repo.getById(session.id);
  const stored = fresh?.pageSnapshot ?? null;
  if (!stored || stored.id !== snapshotId) return refuse('stale_snapshot');
  if (Date.now() - new Date(stored.takenAt).getTime() > SNAPSHOT_TTL_MS) return refuse('stale_snapshot');
  const href = await capture.evaluate<string>('String(location.href)');
  if (recordedUrl(href).text !== stored.url) return refuse('stale_snapshot');

  const needsRef = action.action === 'click' || action.action === 'hover' || action.action === 'type' || action.action === 'select';
  let target: StoredSnapshotControl | null = null;
  if (needsRef) {
    // The reference is the override. A caller that holds one is taken at its
    // word; a caller that named the control in words has it picked out here,
    // which is one fast request instead of a reading and a second call from
    // whoever is driving.
    let ref = action.ref ?? '';
    if (!ref) {
      const resolution = await resolveTargetFor(session, tenantId, action, stored);
      if (!resolution.ref) return refuse('target_unclear', { reason: resolution.refusal });
      ref = resolution.ref;
    }
    target = stored.controls.find((c) => c.ref === ref) ?? null;
    if (!target) return refuse('control_not_found');
  }

  // 3. Re-walk, re-match, re-classify, re-read the box, and ask what a
  //    pointer would hit.
  let hit: HitResult | null = null;
  let offset = { x: 0, y: 0 };
  let controlOutcome: { role: string; name: string; tag: string; inputType: string } | null = null;
  if (target) {
    if (target.frameId) {
      if (!capture.hasWorld(target.frameId)) return refuse('control_not_found');
      const frameOffset = await frameOffsetNow(capture, target.frameId);
      if (!frameOffset) return refuse('control_not_found');
      offset = frameOffset;
    }
    const id = { role: target.role, name: target.name, nth: target.nth };
    hit = await capture.evaluate<HitResult>(
      `${PAGE_READERS}.hit(${JSON.stringify(id)}, ${JSON.stringify({ scroll: true })})`,
      target.frameId ?? undefined,
    );
    if (!hit.found) return refuse('control_not_found');
    controlOutcome = { role: hit.role, name: hit.name, tag: hit.tag, inputType: hit.inputType };
  }

  // A navigation the action starts is only visible if it is waited for from
  // BEFORE the action: `waitForLoadState` on the document that is still
  // there answers at once. So a navigation is armed before an action that
  // can start one, and the settle waits on it (best effort, the same budget)
  // before the load state.
  let armedNavigation: Promise<unknown> | null = null;
  const armNavigation = (page: Page): void => {
    armedNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
  };
  const settle = async (page: Page): Promise<{ url: SanitizedText; title: SanitizedText; rawUrl: string; rawTitle: string }> => {
    if (armedNavigation) await armedNavigation;
    await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
    const rawUrl = page.url();
    const rawTitle = await withTimeout(page.title(), 'reading the title').catch(() => '');
    await persistCurrentUrl(session.vendorSessionId, rawUrl, rawTitle).catch(() => null);
    return { url: recordedUrl(rawUrl), title: sanitizeBrowserText(rawTitle, PAGE_TITLE_CAP), rawUrl, rawTitle };
  };

  const finish = async (page: Page, extra: { valueDisposition: string; value: string; detail: string }): Promise<PaneActionOutcome> => {
    let after = await settle(page);
    // An action that moved the page to another URL may have landed on a
    // sign-in page: the saved-login fill runs here, awaited, so the next
    // reading sees the signed-in page. Its record is its own row; a fill
    // that acted moves the page again, so the landing is read back.
    if (after.rawUrl !== href) {
      const { applySavedLoginOnPane } = await import('../integrations/onepassword/autofill');
      const login = await applySavedLoginOnPane(session, tenantId, page);
      if (login === 'confirmed' || login === 'submitted') after = await settle(page);
    }
    // 4. The person may have taken the wheel while the action ran.
    const now = await repo.getById(session.id);
    const personTookOverDuring = now?.takeoverState === 'taken_over';
    return record({
      acted: true, refusalKind: '', message: '', coveredBy: '', personTookOverDuring, url: after.url, title: after.title,
    }, controlOutcome, extra);
  };

  return withPage(session.vendor, session.vendorSessionId, tenantId, async (page) => {
    switch (action.action) {
      case 'click':
      case 'hover': {
        if (!hit!.hit) return refuse('obscured', { coveredBy: hit!.coveredBy }, controlOutcome);
        const point = { x: hit!.hit.x + offset.x, y: hit!.hit.y + offset.y };
        if (action.action === 'click') {
          armNavigation(page);
          await withTimeout(page.mouse.click(point.x, point.y), 'the click', POINTER_STEP_TIMEOUT_MS);
        } else {
          await withTimeout(page.mouse.move(point.x, point.y), 'the hover', POINTER_STEP_TIMEOUT_MS);
        }
        return finish(page, { valueDisposition: 'none', value: '', detail: '' });
      }
      case 'type': {
        const text = typeof action.text === 'string' ? action.text : '';
        if (hit!.protectedKind) return refuse('protected_control', {}, controlOutcome);
        if (redactSensitiveText(text) !== text || sanitizeBrowserText(text).protectedDataOmitted) {
          return refuse('protected_text', {}, controlOutcome);
        }
        const typed = await typeIntoControl(capture, page, target!, text, { submit: action.submit === true, armNavigation, hit: hit!, offset });
        if (typed.outcome === 'obscured') return refuse('obscured', { coveredBy: typed.coveredBy }, controlOutcome);
        if (typed.outcome === 'focus_failed') return refuse('focus_failed', {}, controlOutcome);
        if (typed.outcome === 'control_not_found') return refuse('control_not_found', {}, controlOutcome);
        return finish(page, { valueDisposition: 'recorded', value: text, detail: action.submit ? 'Enter' : '' });
      }
      case 'select': {
        const value = typeof action.value === 'string' ? action.value : '';
        if (hit!.protectedKind) return refuse('protected_control', {}, controlOutcome);
        if (redactSensitiveText(value) !== value || sanitizeBrowserText(value).protectedDataOmitted) {
          return refuse('protected_text', {}, controlOutcome);
        }
        const id = { role: target!.role, name: target!.name, nth: target!.nth };
        const chosen = await capture.evaluate<{ outcome: string; label: string }>(
          `${PAGE_READERS}.select(${JSON.stringify(id)}, ${JSON.stringify(value)})`, target!.frameId ?? undefined,
        );
        if (chosen.outcome === 'option_not_found') return refuse('option_not_found', {}, controlOutcome);
        if (chosen.outcome !== 'selected') return refuse('control_not_found', {}, controlOutcome);
        return finish(page, { valueDisposition: 'recorded', value: chosen.label, detail: '' });
      }
      case 'press': {
        const key = typeof action.key === 'string' ? action.key : '';
        if (!(PRESS_KEYS as readonly string[]).includes(key)) return refuse('key_not_allowed');
        const active = await capture.evaluate<{ isTarget: boolean; protectedKind: string; role: string; name: string }>(
          `${PAGE_READERS}.active(null)`,
        );
        const focused = { role: active.role, name: active.name, tag: '', inputType: '' };
        if (active.protectedKind) return refuse('protected_control', {}, focused);
        if (key === 'Enter') armNavigation(page);
        await withTimeout(page.keyboard.press(key === 'Space' ? ' ' : key), `pressing ${key}`);
        return finish(page, { valueDisposition: 'none', value: '', detail: key });
      }
      case 'scroll': {
        const amount = Math.min(SCROLL_MAX_PX, Math.max(1, Math.floor(action.amount ?? SCROLL_DEFAULT_PX)));
        const dy = action.direction === 'up' ? -amount : amount;
        await withTimeout(page.mouse.wheel(0, dy), 'scrolling');
        return finish(page, { valueDisposition: 'none', value: '', detail: `scroll ${action.direction === 'up' ? 'up' : 'down'} ${amount}px` });
      }
      default:
        return refuse('invalid_action');
    }
  }, `act:${action.action}`);
}
