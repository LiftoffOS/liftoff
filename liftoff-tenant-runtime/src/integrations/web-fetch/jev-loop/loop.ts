// The loop: the reference's `Agent.command('tick')` as a function —
// observe → decide → act → observe, `recent_actions`, the three-no-change
// rule, the budgets (60 actions, 120 decisions, and the task's shared wall
// clock) and the stop states. Ported from jev-ultrafast agent.py.
//
// A decision is consumed once, before any mutation or model call, so a retry
// can never double-click. Execution is recorded before the next observation,
// so a stale post-action observation cannot erase the action. DONE is accepted
// only on a fresh page, and then verified by the goal check. A handoff
// carries the remaining clock and the trail so far; reasons are the closed
// enum in types.ts.

import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { logger } from '../../../infrastructure/logging';
import { observe, finalObservation, StalePage } from './observe';
import { buildStepRequest, chooseFromAnswers } from './decide';
import { act, SelectNotConfirmed } from './act';
import { extractLiterals, firstUrlIn } from './literals';
import { checkGoal } from './goal-check';
import { askForLoop, type LoopCallContext } from './client';
import { screenUntrustedText } from '../../../injection-detection/finding';
import { stepFor, handoffStep, doneStep, navigateStep, trailOf, COMPLETED_MESSAGE, STOPPED_MESSAGE, type JevTrailStep } from './trail';
import { isBlankPage, taskStopMessage } from '../task-stop-message';
import {
  MAX_ACTIONS, MAX_CONSECUTIVE_WAITS, MAX_DECISIONS, WAIT_LADDER_MS,
  type Decision, type HandoffReason, type HistoryEntry, type PageState, type SelfStopReason, type SnapshotAction,
} from './types';

/** How long a DONE decided right after a click waits for the tab that click
 *  may have opened to be announced. Paid once per task, at its end. */
const NEW_PAGE_GRACE_MS = 250;
/** The one navigation the loop makes, when the task names a page and the
 *  browser is on a blank one. Shorter than a task's own clock: a page that
 *  will not open in this long is answered by observing what is there. */
const FIRST_NAVIGATION_TIMEOUT_MS = 20_000;
import type { BrowserTaskTrail } from '../step-policy';
import type { TaskClock } from '../stagehand-agent';
import { observationHasAuthenticationFill } from '../../onepassword/autofill';

export interface JevLoopInput {
  cdpUrl: string;
  prompt: string;
  /** What the task may not do, whatever the objective says.
   *
   *  The workspace's own oversight settings, and whatever the caller stated
   *  as a stopping point. Held apart from the objective rather than glued to
   *  the front of it: the objective is what DONE is judged against, and a
   *  constraint is not a requirement to satisfy. The loop offers CONSTRAINED
   *  as an operation when there are any. */
  constraints?: string[];
  /** What finishing looks like, in the caller's words.
   *
   *  DONE is judged against this when it is given, and against the objective
   *  alone when it is not. An objective says what to do; a success
   *  definition says how the task can tell it worked, which is a different
   *  sentence and the one a completion check needs. */
  success?: string;
  /** What an earlier run of this same task already did on this session.
   *
   *  Shown to the model as actions already taken, so it does not do them
   *  again; deliberately NOT counted against this run's action budget,
   *  which is a bound on what this run may do rather than a record of the
   *  page's history. */
  priorActions?: HistoryEntry[];
  /** Values the assistant passed as parameters: literals the loop may type. */
  parameters?: Record<string, unknown>;
  tenantId: string;
  invocationId?: string;
  runtimeAgentId?: string;
  /** The session the loop runs on, for the saved-login fill
   *  (integrations/onepassword): absent, no login is applied. */
  vendor?: string;
  vendorSessionId?: string;
}

/** The result the model sees. The goal and any literal never appear in
 *  `message`, `data` or the trail; `final` is the last observation, the same
 *  visible-text view read_active_browser_session gives. */
export interface JevTaskResult {
  success: boolean;
  completed: boolean;
  /** The loop's own closing words: the completion sentence, or the one
   *  the stop reports for itself. */
  message: string;
  reason?: HandoffReason | SelfStopReason | 'unverified';
  final: { url: string; title: string; text: string };
  steps: number;
  lastActions: Array<{ type: string; action: string; pageUrl: string }>;
}

export interface JevOutcome {
  status: 'finished' | 'incomplete';
  result: JevTaskResult;
  data: string;
  trail: BrowserTaskTrail;
}

export interface JevHandoff {
  reason: HandoffReason;
  trail: BrowserTaskTrail;
  /** The last observation, when there was one. */
  final?: { url: string; title: string; text: string };
  /** What this run did, for a later run of the same task to start from. */
  actions?: HistoryEntry[];
}

export type JevLoopOutcome = { outcome: JevOutcome } | { handoff: JevHandoff };

const RESULT_ACTIONS = 8;

/** Test seam: how the loop reaches the page. The browser tests hand it a
 *  page they own; production connects over the session's CDP url. */
export interface PageHandle {
  page: Page;
  context: BrowserContext;
  cdp: CDPSession;
  close: () => Promise<void>;
}
let pageOpener: (cdpUrl: string) => Promise<PageHandle> = openPage;
export function _setPageOpenerForTesting(opener: ((cdpUrl: string) => Promise<PageHandle>) | null): void {
  pageOpener = opener ?? openPage;
}

/** The Playwright page we already open per vendor (connectOverCDP, the same
 *  page the pane shows), and a CDP session on it for input. */
async function openPage(cdpUrl: string): Promise<PageHandle> {
  const { chromium } = await import('playwright-core');
  const browser: Browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] ?? await browser.newContext();
  const pages = context.pages();
  const page = pages[pages.length - 1] ?? await context.newPage();
  const cdp = await context.newCDPSession(page);
  return {
    page,
    context,
    cdp,
    close: async () => {
      await cdp.detach().catch(() => undefined);
      // Detaches the client; the session and the pane stay up.
      await browser.close().catch(() => undefined);
    },
  };
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

function lastActions(steps: JevTrailStep[]): JevTaskResult['lastActions'] {
  return steps.slice(-RESULT_ACTIONS).map((s) => ({ type: s.type, action: s.action, pageUrl: s.pageUrl }));
}

/** The reason a BLOCKED decision hands off with: the page's controls are
 *  only inside frames, a file input is the way forward, the page offers no
 *  candidate at all, or the model found nothing that progresses. The first
 *  three the snapshot cannot express; the page is asked as the reference
 *  asks it, with only the controls and DONE / BLOCKED on offer. */
/** A stop the loop makes itself, rather than handing on. Shaped like the
 *  constraint stop beside it, for the same reason: what stopped it is
 *  something the next driver must not be allowed to try. */
function selfStop(reason: SelfStopReason, state: PageState, steps: JevTrailStep[], stepCount: number): JevLoopOutcome {
  const message = taskStopMessage(reason);
  return {
    outcome: {
      status: 'incomplete',
      result: {
        success: true,
        completed: false,
        message,
        reason,
        final: finalObservation(state),
        steps: stepCount,
        lastActions: lastActions(steps),
      },
      data: message,
      trail: trailOf(steps, message),
    },
  };
}

async function blockedReason(page: Page, state: PageState): Promise<HandoffReason> {
  let frameOnly = false;
  let fileInput = false;
  try {
    fileInput = await page.evaluate(`(() => [...document.querySelectorAll('input[type="file"]')].some(e => e.checkVisibility && e.checkVisibility()))()`) as boolean;
    frameOnly = page.frames().length > 1;
  } catch {
    // The page is gone or navigating: the plain reason.
  }
  const candidates = state.actions.some((a) => a.kind !== 'wait');
  if (frameOnly && !candidates) return 'frame_only';
  if (fileInput) return 'file_input';
  if (!candidates) return 'no_candidates';
  return 'blocked';
}

export async function runJevLoop(input: JevLoopInput, clock: TaskClock): Promise<JevLoopOutcome> {
  const ctx: LoopCallContext = {
    tenantId: input.tenantId,
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    ...(input.runtimeAgentId ? { runtimeAgentId: input.runtimeAgentId } : {}),
    clock,
  };
  const literals = extractLiterals(input.prompt, input.parameters);
  const steps: JevTrailStep[] = [];
  const history: HistoryEntry[] = [];
  /** What an earlier run of this same task did. Read, never added to: this
   *  run's budget is a bound on what THIS run may do. */
  const prior: HistoryEntry[] = input.priorActions ?? [];
  let decisions = 0;
  // Waits since the last action that was not one. A page that is still
  // rendering is waited on for longer each time, and a page that never
  // settles ends the task with a sentence rather than sixty rounds of
  // polling and the action ceiling.
  let consecutiveWaits = 0;
  /** What the previous action's own wait found. `working` means the page was
   *  busy, which is the one verdict the wait ladder does not count. */
  let lastVerdict: Awaited<ReturnType<typeof act>> = null;
  let handle: PageHandle;
  try {
    handle = await pageOpener(input.cdpUrl);
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenantId: input.tenantId }, 'jev-loop: could not open the page');
    return { handoff: { reason: 'unavailable', trail: trailOf([handoffStep('unavailable', '', new Date())], STOPPED_MESSAGE) } };
  }
  const { page, context, cdp } = handle;
  const pagesAtStart = context.pages().length;
  // A new tab is a handoff. The browser announces a popup asynchronously
  // after the click that opened it, so it is listened for rather than
  // counted at one moment: a count taken before the announcement read a
  // fresh tab as no tab, and the run went on to ask about a page it had left.
  let popupSeen = false;
  const onPage = (): void => { popupSeen = true; };
  context.on('page', onPage);
  const popupOpened = (): boolean => popupSeen || context.pages().length > pagesAtStart;
  /** Screen one observation's page text, without waiting for it. */
  const screenObservation = (observed: PageState): void => {
    if (!observed.text) return;
    void screenUntrustedText('tool_result', observed.text, {
      tenantId: input.tenantId,
      ...(input.runtimeAgentId ? { agentId: input.runtimeAgentId } : {}),
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    }).catch(() => {});
  };

  /** A DONE right after a click gives the popup a moment to be announced. */
  const popupWithin = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (!popupOpened() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    return popupOpened();
  };

  const handoff = (reason: HandoffReason, state?: PageState): JevLoopOutcome => {
    steps.push(handoffStep(reason, state?.url ?? page.url(), new Date()));
    return {
      handoff: {
        reason,
        trail: trailOf(steps, STOPPED_MESSAGE),
        ...(state ? { final: finalObservation(state) } : {}),
        actions: [...prior, ...history],
      },
    };
  };

  // The saved-login fill (integrations/onepassword), on the loop's own page,
  // awaited so the next observation sees the signed-in page. The loop cannot
  // type a password of its own (`text_not_in_task`), so without this a
  // sign-in wall is always a handoff. Its steps join the trail.
  const openNamedPage = async (): Promise<void> => {
    // Nothing in here may end the task: it runs before the first observation,
    // and a task whose page did not open is still a task to be observed and
    // answered on its own terms. The whole of it sits inside the guard for
    // that reason, the address it reads included.
    try {
      if (!isBlankPage(page.url())) return;
      const target = firstUrlIn(input.prompt, input.parameters);
      if (!target) return;
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: FIRST_NAVIGATION_TIMEOUT_MS });
      steps.push(navigateStep(target, new Date()));
    } catch (err) {
      // The page did not open. The observation below sees whatever is there
      // and the task stops on its own terms rather than on this one.
      logger.warn({ err: (err as Error).message, tenantId: input.tenantId }, 'jev-loop: the address the task named did not open');
    }
  };

  const applyLogin = async (): Promise<boolean> => {
    if (!input.vendor || !input.vendorSessionId) return false;
    const { applySavedLoginOnTaskPage } = await import('../../onepassword/autofill');
    await applySavedLoginOnTaskPage(
      { vendor: input.vendor, vendorSessionId: input.vendorSessionId, tenantId: input.tenantId, page },
      (step) => { steps.push({ ...step, probability: 0, confidence: 0 }); },
    );
    return true;
  };

  try {
    let state: PageState;
    try {
      // The loop acts on the page it is given and navigates nowhere of its
      // own accord. A task that names a page while the browser is still on a
      // blank one therefore has nothing to act on: "go to <url> and type ..."
      // would observe about:blank, find no candidates and stop before it
      // began. The first address the task carries is opened
      // first, and only from a blank page: a browser already on a page was
      // put there by the person or by an earlier step, and the task continues
      // from what is in front of it.
      await openNamedPage();
      // A task started on a sign-in page that is already open signs in
      // before the first observation.
      await applyLogin();
      state = await observe(page);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'jev-loop: first observation failed');
      return handoff('unavailable');
    }

    while (true) {
      if (Date.now() >= clock.deadlineAt) return handoff('timeout', state);
      if (popupOpened()) return handoff('new_page', state);

      if (decisions >= MAX_DECISIONS) return handoff('blocked', state);
      decisions += 1;
      // The loop's own screen. Adding the pass inside `screenUntrustedText`
      // does not reach here: `observe` returns the observation and `decide`
      // sends its text straight to the vendor, with no `frameUntrusted`
      // between them — so this page's own text would be the one untrusted
      // surface in the estate nothing looked at.
      //
      // Fire-and-forget: a screen never delays or blocks a step. Once per
      // observation, not once per element, and the dedupe key inside makes a
      // re-observation of an unchanged page one screen.
      screenObservation(state);
      const built = buildStepRequest(state, input.prompt, history, literals, input.constraints ?? [], prior, input.success ?? '');
      const startedAt = Date.now();
      const asked = await askForLoop(built.set, built.state, ctx);
      if (!asked) return handoff('unavailable', state);
      let decision: Decision;
      try {
        decision = chooseFromAnswers(built, asked.answers as never, {
          latencyMs: Date.now() - startedAt, model: asked.model, usage: asked.usage,
        });
      } catch (err) {
        // An invalid answer executes nothing; observe again and decide again.
        logger.warn({ err: (err as Error).message }, 'jev-loop: invalid answer; nothing executed');
        state = await observe(page);
        continue;
      }
      // The decision is consumed here, before any mutation: `decision` is
      // never re-executed after this point.

      // A constraint stop is terminal. It does NOT hand off: the tail is
      // another model driving the same page from the same objective, and
      // handing it a task that stopped because the next click would spend
      // money is handing the forbidden click to something that was never
      // told not to make it.
      if (decision.operation === 'CONSTRAINED') {
        steps.push(doneStep(decision, 0, state.url, new Date()));
        const message = taskStopMessage('constrained');
        const result: JevTaskResult = {
          success: true,
          completed: false,
          message,
          reason: 'constrained' as const,
          final: finalObservation(state),
          steps: history.length,
          lastActions: lastActions(steps),
        };
        return {
          outcome: {
            status: 'incomplete',
            result,
            data: message,
            trail: trailOf(steps, message),
          },
        };
      }

      if (decision.operation === 'DONE' || decision.operation === 'BLOCKED') {
        const { fresh } = await import('./act');
        if (!(await fresh(page, state))) {
          state = await observe(page);
          continue;
        }
        if (history.length > 0 && history[history.length - 1].kind === 'click' && (await popupWithin(NEW_PAGE_GRACE_MS))) {
          return handoff('new_page', state);
        }
        if (decision.operation === 'BLOCKED') {
          // Before handing on: a human-verification wall is not a control the
          // next driver will find. It is the one blocked page where trying
          // harder is the wrong move, and where a person can settle it in
          // seconds if simply asked.
          const { looksLikeHumanCheck } = await import('./human-check');
          if (await looksLikeHumanCheck(page, state.text)) {
            return selfStop('needs_a_person', state, steps, history.length);
          }
          return handoff(await blockedReason(page, state), state);
        }
        const goal = await checkGoal(
          input.prompt, finalObservation(state), history, ctx,
          input.success ? { success: input.success } : {},
        );
        if (!goal) return handoff('unavailable', state);
        steps.push(doneStep(decision, goal.probability, state.url, new Date()));
        const result: JevTaskResult = {
          success: true,
          completed: goal.met,
          // A task that ran but could not be confirmed says which of the two
          // it was: "stopped" alone reads as "nothing happened", and the
          // model told the person exactly that about a task that had acted.
          message: goal.met ? COMPLETED_MESSAGE : taskStopMessage('unverified'),
          ...(goal.met ? {} : { reason: 'unverified' as const }),
          final: finalObservation(state),
          steps: history.length,
          lastActions: lastActions(steps),
        };
        return {
          outcome: {
            status: goal.met ? 'finished' : 'incomplete',
            result,
            data: result.message,
            trail: trailOf(steps, result.message),
          },
        };
      }

      const chosen = state.actions.find((a) => a.id === decision.choice) as SnapshotAction | undefined;
      if (!chosen) {
        state = await observe(page);
        continue;
      }
      if (history.length >= MAX_ACTIONS) return handoff('blocked', state);
      // A wait is given a budget from the ladder, and a run of them ends the
      // task rather than spending the action ceiling on polling.
      let action = chosen;
      if (chosen.kind === 'wait') {
        if (consecutiveWaits >= MAX_CONSECUTIVE_WAITS) return handoff('still_loading', state);
        // The ladder climbs on waits that found NOTHING. A page that was
        // visibly working through the last wait is given the same rung again
        // rather than being counted against the ladder: the ladder exists to
        // stop the loop polling a dead page, and a page rendering a video is
        // not a dead page. The task's own clock is what bounds real work.
        action = { ...chosen, waitMs: WAIT_LADDER_MS[Math.min(consecutiveWaits, WAIT_LADDER_MS.length - 1)] };
        if (lastVerdict !== 'working') consecutiveWaits += 1;
      } else {
        consecutiveWaits = 0;
      }
      let text: string | null = null;
      if (action.kind === 'fill') {
        if (decision.textId === null) return handoff('text_not_in_task', state);
        text = literals.byId.get(decision.textId) ?? null;
        if (text === null) return handoff('text_not_in_task', state);
      }

      let verdict: Awaited<ReturnType<typeof act>> = null;
      try {
        verdict = await act(page, cdp, state, action, text);
      } catch (err) {
        if (err instanceof StalePage) {
          // The decision was consumed; observe again and decide again.
          state = await observe(page);
          continue;
        }
        if (err instanceof SelectNotConfirmed) return handoff('blocked', state);
        throw err;
      }
      lastVerdict = verdict;
      // Execution recorded before the next observation.
      const before = state;
      history.push({
        step: history.length + 1,
        action: action.label,
        kind: action.kind,
        operation: decision.operation,
        probability: decision.probability,
        confidence: decision.confidence,
        latencyMs: decision.latencyMs,
        url: before.url,
        pageChanged: null,
        typed: text !== null,
      });
      steps.push(stepFor(decision, action, before.url, new Date()));
      state = await observe(page, action);
      // A step that reached another origin, or a page whose fill controls
      // are authentication-class, may be a sign-in page: fill, then observe
      // again so the next decision sees the result.
      if (originOf(state.url) !== originOf(before.url) || observationHasAuthenticationFill(state)) {
        if (await applyLogin()) state = await observe(page);
      }
      history[history.length - 1].pageChanged = state.fingerprint !== before.fingerprint;
      history[history.length - 1].url = state.url;

      // Three consecutive non-wait actions that changed nothing.
      const recent = history.slice(-3);
      if (recent.length === 3 && recent.every((h) => h.pageChanged === false && h.kind !== 'wait')) {
        return handoff('blocked', state);
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenantId: input.tenantId }, 'jev-loop: stopped on an error');
    return handoff('unavailable');
  } finally {
    context.off('page', onPage);
    await handle.close();
  }
}
