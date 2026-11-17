// The one entry for a browser task, on every browser this runtime holds a CDP
// endpoint to: `run_browser_task` on the pane (Steel, Browser Use,
// Browserbase, Anchor) and the headless `web_task`. Every vendor client calls
// this and nothing else drives a task.
//
//   const clock = { deadlineAt: now + TASK_TIMEOUT_MS };            // shared
//   admission once per task                                          // execution_denied
//   Jev loop (TR_JEV_BROWSER_LOOP_ENABLED)  → outcome | handoff
//   handoff → the tail on the same session: Anchor's in-session agent for
//             Anchor, change 3's budgeted Stagehand for the rest
//   kill off → today's path per vendor
//
// Admission is checked ONCE per task, not per step, from the same signal
// every run consumes off the entitlement snapshot (admission/service.ts,
// agentExecutionAllowed): denied → the task stops with `execution_denied`, no
// vendor call, no handoff. A handoff carries the remaining clock and the trail
// so far, and its reason is the closed enum; the tail's trail is appended.

import { randomUUID } from 'node:crypto';
import { logger } from '../../infrastructure/logging';
import { AdmissionService } from '../../admission/service';
import { isJevBrowserLoopEnabled } from '../../typesafe/flags';
import { runJevLoop, type JevOutcome, type JevHandoff } from './jev-loop/loop';
import type { HistoryEntry } from './jev-loop/types';
import { mergeTrails, trailOf } from './jev-loop/trail';
import { isBlankPage, taskStopMessage, type TaskStopReason } from './task-stop-message';
import { runStagehandTask, STAGEHAND_TIMEOUT_MS, type TaskClock } from './stagehand-agent';
import type { BrowserTaskTrail } from './step-policy';
import type { ModelSelection } from '../../llm/types';
import { NO_AGENT_SENTINEL, type ReportFinishTo } from '../../browser-sessions/types';

export type BrowserTaskVendor = 'steel' | 'browser_use' | 'browserbase' | 'anchor';

/** The shared task wall clock for a task the caller waits on: 180 s, the
 *  same bound Stagehand had. A caller holding a chat turn open cannot wait
 *  longer than this, which is exactly why a task that needs longer must not
 *  be one the caller waits on. */
export const TASK_TIMEOUT_MS = STAGEHAND_TIMEOUT_MS;

/** The wall clock for a task that outlived the call that started it.
 *
 *  Ten minutes, because the work takes it. A page asked to generate a few
 *  seconds of video takes minutes: a comparable system's run of exactly that
 *  job took 229 seconds end to end, which our own 180-second bound would have
 *  killed about fifty seconds from the finish. The bound was never a judgement
 *  about browser work; it was a consequence of making the caller wait. */
export const BACKGROUND_TASK_TIMEOUT_MS = 10 * 60_000;

/** How long a caller waits before a task becomes a background one.
 *
 *  Most browser work is short, and answering in the same turn is better than
 *  a receipt and a second question. This is the point past which waiting
 *  stops being better: the turn is held open, the person is watching a pane
 *  where nothing is being reported, and the task has plainly not got a quick
 *  answer. */
export const HAND_BACK_AFTER_MS = 25_000;

export interface BrowserTaskInput {
  vendor: BrowserTaskVendor;
  vendorSessionId: string;
  /** The session's own CDP endpoint, resolved by the vendor client. Absent
   *  when the vendor recorded none: the loop cannot run and the task goes
   *  straight to the tail. */
  cdpUrl?: string;
  prompt: string;
  /** Values the assistant passed as parameters: literals the loop may type. */
  parameters?: Record<string, unknown>;
  tenantId: string;
  invocationId?: string;
  runtimeAgentId?: string;
  modelSelection?: ModelSelection;
  /** Let the task outlive the call that started it when it turns out to be
   *  a long one. For a caller with a conversation to come back to; a headless
   *  task with nowhere to report has nothing to come back for. */
  background?: boolean;
  /** What finishing looks like, stated by the caller: how the task can tell
   *  it worked. Judged by the completion check, and offered to the operation
   *  head so choosing DONE and confirming it read the same sentence. */
  success?: string;
  /** What this task may not do, stated by the caller. The workspace's own
   *  oversight settings are added to these here, so a caller never has to
   *  restate them and cannot leave them out. */
  constraints?: string[];
  /** Anchor's own in-session agent, supplied by the Anchor client: the tail
   *  on Anchor, and today's path there. It is handed the composed brief
   *  rather than the bare objective, because a tail that never heard the
   *  constraints is a tail that will break them. */
  runAnchorAgent?: (clock: TaskClock, brief: string) => Promise<{ status: string; result?: unknown; data?: unknown; trail?: BrowserTaskTrail }>;
}

/** The outcome shape the vendor proxy already dispatches on, with `reason`
 *  for a stop of the loop's own. */
export interface BrowserTaskOutcome {
  status: string;
  result?: unknown;
  data?: unknown;
  trail: BrowserTaskTrail;
  reason?: string;
  /** The task that carries on, for a later turn to come back to. */
  taskId?: string;
}

/** Test seam: the admission signal. */
let admissionCheck: (tenantId: string, agentId?: string) => Promise<boolean> = async (tenantId, agentId) => {
  const admission = await new AdmissionService().checkAdmission({ tenantId, agentId, checkType: 'action' });
  return admission.allowed;
};
export function _setAdmissionCheckForTesting(fn: ((tenantId: string, agentId?: string) => Promise<boolean>) | null): void {
  admissionCheck = fn ?? (async (tenantId, agentId) => {
    const admission = await new AdmissionService().checkAdmission({ tenantId, agentId, checkType: 'action' });
    return admission.allowed;
  });
}

/** Test seams: the loop and the Stagehand tail. */
type LoopRunner = typeof runJevLoop;
type StagehandRunner = typeof runStagehandTask;
let loopRunner: LoopRunner = runJevLoop;
let stagehandRunner: StagehandRunner = runStagehandTask;
export function _setRunnersForTesting(runners: { loop?: LoopRunner | null; stagehand?: StagehandRunner | null }): void {
  loopRunner = runners.loop ?? runJevLoop;
  stagehandRunner = runners.stagehand ?? runStagehandTask;
}

function stopped(reason: TaskStopReason): BrowserTaskOutcome {
  const message = taskStopMessage(reason);
  const trail = trailOf([], message);
  return {
    status: 'incomplete',
    result: { success: false, completed: false, message, reason, steps: 0, lastActions: [] },
    data: message,
    trail,
    reason,
  };
}

async function runTail(input: BrowserTaskInput, clock: TaskClock, brief: string): Promise<BrowserTaskOutcome> {
  if (input.vendor === 'anchor') {
    if (!input.runAnchorAgent) return stopped('unavailable');
    const out = await input.runAnchorAgent(clock, brief);
    return { ...out, trail: out.trail ?? trailOf([], typeof out.data === 'string' ? out.data : '') };
  }
  if (!input.cdpUrl) return stopped('unavailable');
  const out = await stagehandRunner({
    cdpUrl: input.cdpUrl,
    prompt: brief,
    tenantId: input.tenantId,
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    ...(input.runtimeAgentId ? { runtimeAgentId: input.runtimeAgentId } : {}),
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    clock,
    vendor: input.vendor,
    vendorSessionId: input.vendorSessionId,
  });
  return out;
}

/**
 * Start a task, and hand the turn back when it turns out to be a long one.
 *
 * A browser task used to hold a chat turn open for as long as it ran, which
 * is why it had a three-minute bound and why anything genuinely slow failed.
 * A page asked to generate a few seconds of video takes minutes: the bound
 * was never a judgement about browser work, it was a consequence of making
 * the caller wait.
 *
 * So the caller waits only while waiting is the better answer. Most browser
 * work is short and answering in the same turn beats a receipt and a second
 * question. Past HAND_BACK_AFTER_MS the task keeps going on a clock of its
 * own and the caller is given what to say and how to come back for it: the
 * person watches the pane in the meantime, which is where the work is
 * visible anyway.
 *
 * The task that carries on is the SAME task, not a second one. Nothing is
 * restarted, and the work already done is never repeated.
 */
export async function runBrowserTask(input: BrowserTaskInput): Promise<BrowserTaskOutcome> {
  if (input.background !== true) return runToEnd(input, { deadlineAt: Date.now() + TASK_TIMEOUT_MS });

  const clock: TaskClock = { deadlineAt: Date.now() + BACKGROUND_TASK_TIMEOUT_MS };
  const running = runToEnd(input, clock);
  // Whichever comes first: the task, or the point past which waiting stops
  // being the better answer.
  const handBack = new Promise<'hand_back'>((resolve) => {
    const t = setTimeout(() => resolve('hand_back'), HAND_BACK_AFTER_MS);
    t.unref?.();
  });
  const first = await Promise.race([running.then(() => 'finished' as const), handBack]);
  if (first === 'finished') return running;

  // It carries on. Its result is written where a later turn will look for
  // it, and nothing here awaits that.
  const taskId = randomUUID();
  void holdTheSessionOpenUntil(input, clock.deadlineAt);
  void running
    .then((outcome) => recordFinishedTask(input, taskId, outcome))
    .catch((err) => {
      logger.warn({ err: (err as Error).message, tenantId: input.tenantId, taskId }, 'a browser task that carried on ended in an error');
      return recordFinishedTask(input, taskId, stopped('unavailable'));
    });
  // Whether this conversation will be woken when the job finishes, which
  // decides what the assistant is told to say. Read from the row the
  // dispatcher wrote, so the words and the mechanism cannot disagree.
  let pushed = false;
  try {
    const repo = await import('../../browser-sessions/repository');
    const session = await repo.getByVendorSessionId(input.vendorSessionId);
    pushed = Boolean(session?.reportFinishTo);
  } catch {
    // Unknown reads as not pushed: asking the person to come back is wrong
    // when a push is armed, and merely old when one is not.
  }
  logger.info(
    { tenantId: input.tenantId, vendor: input.vendor, taskId, pushed, event: 'browser_task_carrying_on' },
    'a browser task outlived the call that started it and carries on',
  );
  return carryingOn(taskId, pushed);
}

/** How long a finished result is worth keeping for somebody to collect. */
export const FINISHED_TASK_TTL_MS = 60 * 60_000;

/** Grace past the task's own deadline, so the session is not reaped in the
 *  seconds between the work finishing and the result being written. */
const KEEP_ALIVE_GRACE_MS = 60_000;

/**
 * Hold the session open for as long as the task still has to run.
 *
 * A session expires about ten minutes after it is created and the reaper
 * closes it then, which is right for one nobody is using. A task that
 * carries on can run for as long as its own clock allows, and that clock
 * routinely outlives the session's: the browser can be closed under a video
 * that is still rendering, and the person told the work produced nothing.
 *
 * The session is in use exactly while its task is running, so this says so.
 * Failing to extend is not worth failing the task over: the work is already
 * under way and the worst case is the reaping that used to happen anyway.
 */
async function holdTheSessionOpenUntil(input: BrowserTaskInput, deadlineAt: number): Promise<void> {
  try {
    const repo = await import('../../browser-sessions/repository');
    const session = await repo.getByVendorSessionId(input.vendorSessionId);
    if (!session) return;
    await repo.keepSessionAliveFor(session.id, deadlineAt - Date.now() + KEEP_ALIVE_GRACE_MS);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: input.tenantId },
      'a browser task carried on and its session could not be held open; the reaper may close it first',
    );
  }
}

/**
 * Where a task that carried on leaves its result: on the SESSION's row.
 *
 * It was a map in this process, which is a result that dies with the
 * instance. There is more than one instance, and a later turn lands on
 * whichever answers: it would have been told the task was still running
 * forever, which is the failure the carrying-on was supposed to remove.
 *
 * The session's row is the right home because the task belongs to the
 * session: it is reaped with it, it is readable from every instance, and it
 * is the same place the parked task and the page reading already live.
 */
async function recordFinishedTask(input: BrowserTaskInput, taskId: string, outcome: BrowserTaskOutcome): Promise<void> {
  try {
    const repo = await import('../../browser-sessions/repository');
    const session = await repo.getByVendorSessionId(input.vendorSessionId);
    if (!session) return;
    // Where the work IS, beside what happened. A task that ran out of clock
    // used to report only that it was incomplete, which cannot be gone back
    // to; a site running a job of its own puts the job's id in the page's
    // address, so this one line is the difference between work that can be
    // picked up and work that is lost.
    const parked = session.parkedTask;
    const handle = parked && parked.objective.trim() === input.prompt.trim() && parked.pageUrl
      ? `\n\nThe work was left on this page: ${parked.pageUrl}`
        + (parked.files && parked.files.length > 0
          ? `\nFiles that were on it: ${parked.files.join(', ')}`
          : '')
        + '\nGo back to that page to carry on or to collect what it produced.'
      : '';
    await repo.setCarriedOnTask(session.id, {
      taskId,
      status: outcome.status,
      message: (typeof outcome.data === 'string' ? outcome.data : '') + handle,
      reason: outcome.reason ?? '',
      finishedAt: new Date().toISOString(),
    });
    logger.info(
      {
        tenantId: input.tenantId, vendor: input.vendor, taskId, status: outcome.status,
        event: 'browser_task_carried_on_finished',
        // What it was doing when it ended. A task that ran to its ceiling and
        // ended `incomplete` said only that, which is not something anybody
        // can act on: the question is always whether it was working or stuck,
        // and the last few steps answer it. Types and page addresses only —
        // both already bounded and redacted by the step policy.
        ...lastStepsFor(outcome),
      },
      'a browser task that carried on has finished',
    );
    // After the row, never instead of it: the push is the delivery and the
    // row is the record, and a push that fails must still leave something
    // for the collect tool to find.
    if (session.reportFinishTo) await announceFinish(session, session.reportFinishTo, taskId, outcome);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: input.tenantId, taskId },
      'a task that carried on finished and its result could not be kept; the caller will be told it is still running',
    );
  }
}

/** How many closing steps a finished task's log line carries. Enough to see
 *  whether it was progressing or going round, short enough to read. */
const LOG_STEP_TAIL = 5;

/** The closing steps of a task, for the line that records how it ended. Empty
 *  when the loop reported no trail, which is itself worth seeing. */
function lastStepsFor(outcome: BrowserTaskOutcome): { lastSteps?: string[]; stepCount?: number } {
  const steps = outcome.trail?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return {};
  return {
    stepCount: steps.length,
    lastSteps: steps.slice(-LOG_STEP_TAIL).map((st) => `${st.type}${st.pageUrl ? ` @ ${st.pageUrl}` : ''}`),
  };
}

/**
 * Wake the thread and say the task has finished.
 *
 * A task finishing is an event. Parking the result until somebody next
 * speaks made the person the delivery mechanism: they were told to send a
 * message so the work could be picked up, which reads as a system that has
 * lost track of its own job — and if they never send one, the file the task
 * produced is never delivered at all.
 *
 * The two surfaces wake by different rails because their threads live in
 * different databases: an agent's thread is this service's, the three
 * assistants' are the control plane's. Both end in the same place — a turn
 * that collects the task and hands the person what it produced.
 *
 * Never throws. The collect tool is the fallback, and a push that failed
 * leaves the person exactly where they were before this existed.
 */
async function announceFinish(
  session: { id: string; tenantId: string },
  to: ReportFinishTo,
  taskId: string,
  outcome: BrowserTaskOutcome,
): Promise<void> {
  const brief = 'The browser task you set going has finished'
    + (outcome.status === 'completed' ? '.' : ` (${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ''}).`)
    + ` Collect it with the browser task id ${taskId} to see what it produced, then tell the person in this conversation`
    + ' what happened. If it left a file they asked for, fetch it and attach it to your message rather than describing it.';
  try {
    if (to.agentId !== NO_AGENT_SENTINEL) {
      const { scheduleBackgroundWork } = await import('../../interactive-chat/chat-continuation');
      await scheduleBackgroundWork({
        tenantId: session.tenantId,
        runtimeAgentId: to.agentId,
        internalAgentId: to.internalAgentId ?? to.agentId,
        threadId: to.threadId,
        brief,
        senderAccountId: to.senderAccountId ?? null,
        senderUserId: to.senderUserId ?? null,
        scheduledByInvocationId: to.invocationId ?? taskId,
      });
    } else {
      const { announceBrowserTaskToAssistant } = await import('../../platform-callback/client');
      await announceBrowserTaskToAssistant({
        tenantId: session.tenantId,
        threadId: to.threadId,
        assistant: to.assistant ?? 'liftoff',
        brief,
        ...(to.senderAccountId ? { senderAccountId: to.senderAccountId } : {}),
      });
    }
    logger.info(
      { tenantId: session.tenantId, taskId, event: 'browser_task_finish_announced' },
      'the thread was woken to deliver what the task produced',
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: session.tenantId, taskId, event: 'browser_task_finish_not_announced' },
      'a carried-on task finished and its thread could not be woken; the person will be told when they next speak',
    );
  }
}

/** The result of a task that carried on, or null while it is still running.
 *  Read from the session's row, so it answers on any instance. */
export async function finishedTask(
  tenantId: string,
  vendorSessionId: string,
  taskId: string,
): Promise<{ status: string; message: string; reason: string } | null> {
  const repo = await import('../../browser-sessions/repository');
  const session = await repo.getByVendorSessionId(vendorSessionId);
  const held = session?.carriedOnTask ?? null;
  if (!held || held.taskId !== taskId) return null;
  if (Date.now() - new Date(held.finishedAt).getTime() > FINISHED_TASK_TTL_MS) return null;
  void tenantId;
  return { status: held.status, message: held.message, reason: held.reason };
}

/** What the caller is told when the task outlives the call. */
export function carryingOn(taskId: string, pushed = true): BrowserTaskOutcome {
  // What the assistant is told to SAY, and the two cases differ. A task that
  // will wake the conversation itself must not ask the person to come back:
  // being asked to send a message so the work can be picked up is what made
  // the person the delivery mechanism, and saying it while the push is armed
  // is worse than saying it before the push existed, because it is not even
  // true.
  const message = 'This is a long job and it is still running in the browser. '
    + (pushed
      ? 'Tell the person in one line what it is doing and that you will come back to them with it when it is done — '
        + 'say nothing about them needing to message you, because they do not: this conversation is woken when the job '
        + 'finishes and you will be asked then to deliver what it produced. Then end your turn. '
      : 'Tell the person what it is doing and that you will come back with the result, then end your turn. '
        + 'Look for the result with check_browser_task when they next speak, or when the browser panel shows it has moved on. ')
    + 'Do not start the task again: it is still going, and starting a second one would redo work this one has already done.';
  return {
    status: 'running',
    result: { success: true, completed: false, message, reason: 'carrying_on', taskId, steps: 0, lastActions: [] },
    data: message,
    trail: trailOf([], message),
    reason: 'carrying_on',
    taskId,
  };
}

async function runToEnd(input: BrowserTaskInput, clock: TaskClock): Promise<BrowserTaskOutcome> {
  if (!(await admissionCheck(input.tenantId, input.runtimeAgentId))) {
    logger.info({ tenantId: input.tenantId, vendor: input.vendor }, 'browser task refused by admission');
    return stopped('execution_denied');
  }
  // A saved login the runtime applied on this session's navigation before
  // the task began (a run-owned session's starting URL) parked its step for
  // this trail; it leads the trail.
  const { takePendingLoginSteps } = await import('../onepassword/autofill');
  const parked = takePendingLoginSteps(input.vendorSessionId);
  const withParked = (out: BrowserTaskOutcome): BrowserTaskOutcome =>
    parked.length === 0 ? out : { ...out, trail: { ...out.trail, steps: [...parked, ...out.trail.steps] } };

  // The brief: the objective, and what the task may not do whatever the
  // objective says. Assembled HERE, at the one entry, because every path
  // below needs it and only one of them used to have it -- the workspace's
  // financial-actions setting reached Anchor's headless task entry and
  // nothing else, so on the browser the pane actually runs a task carried no
  // such constraint at all.
  //
  // The loop is given them as their own field; the tails are driven by free
  // text and are given them composed into the prompt.
  const constraints = await taskConstraints(input);
  const brief = composeBrief(input.prompt, constraints, input.success ?? '');

  // What an earlier run of this same task already did on this session. A
  // stopped task used to leave nothing behind but the page: the browser
  // still sat on the half-filled form and the next run had no idea which of
  // those fields it had filled, which is how a task repeats an action it
  // already took. On anything that submits, orders or pays, a repeated
  // action is not a wasted step.
  const prior = await priorActionsFor(input);

  if (isJevBrowserLoopEnabled() && input.cdpUrl) {
    const jev = await loopRunner({
      cdpUrl: input.cdpUrl,
      prompt: input.prompt,
      ...(constraints.length > 0 ? { constraints } : {}),
      ...(input.success ? { success: input.success } : {}),
      ...(prior.length > 0 ? { priorActions: prior } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {}),
      tenantId: input.tenantId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      ...(input.runtimeAgentId ? { runtimeAgentId: input.runtimeAgentId } : {}),
      vendor: input.vendor,
      vendorSessionId: input.vendorSessionId,
    }, clock);
    if ('outcome' in jev) {
      await parkOrClear(
        input, constraints, jev.outcome.result.reason ?? '', jev.outcome.result.completed === true, prior,
        whereItGotTo(jev.outcome.result.final),
      );
      return withParked(outcomeOf(jev.outcome));
    }
    const tail = await runTail(input, clock, brief);
    const merged = withHandoff(jev.handoff, tail);
    await parkOrClear(
      input, constraints, jev.handoff.reason, merged.status === 'finished', jev.handoff.actions ?? prior,
      whereItGotTo(jev.handoff.final),
    );
    return withParked(merged);
  }
  return withParked(await runTail(input, clock, brief));
}

/**
 * Where a run had got to, off its own closing observation.
 *
 * The page's address is the part that outlives everything else. A site running
 * a job of its own puts the job's id in it, so the job can be found again from
 * this alone — which is what a task that ran out of clock has to leave behind
 * if the work is not simply to be lost. Its files come too: as far as it got
 * is still something.
 */
function whereItGotTo(final?: { url?: string; text?: string }): { pageUrl?: string; files?: string[] } {
  if (!final?.url) return {};
  const files: string[] = [];
  for (const line of (final.text ?? '').split('\n')) {
    const at = line.indexOf(': ');
    if (at > 0 && /^(video|audio)\b/.test(line)) files.push(line.slice(at + 2).trim());
  }
  return { pageUrl: final.url, ...(files.length > 0 ? { files } : {}) };
}

/** How long a stopped task is worth resuming from. Past this the page has
 *  almost certainly moved on, a session has been reaped, or the person has
 *  done the thing themselves. */
export const PARK_TTL_MS = 3 * 60 * 60 * 1000;

/** The most actions carried into a later run. Enough for the model to see
 *  what was done, bounded so a long task does not grow a request without
 *  end. */
export const PARKED_ACTIONS_CAP = 30;

/**
 * What an earlier run of THIS task did.
 *
 * Resumed only when the objective is the same. Matching on the objective is
 * deliberately strict: carrying one task's actions into a different task
 * would tell the model it had already done things it has not, which is worse
 * than telling it nothing. A caller that wants to continue says the same
 * thing it said before, which is also how it reaches the same page.
 */
async function priorActionsFor(input: BrowserTaskInput): Promise<HistoryEntry[]> {
  try {
    const repo = await import('../../browser-sessions/repository');
    const session = await repo.getByVendorSessionId(input.vendorSessionId);
    const parked = session?.parkedTask;
    if (!parked) return [];
    if (parked.objective.trim() !== input.prompt.trim()) return [];
    if (Date.now() - new Date(parked.parkedAt).getTime() > PARK_TTL_MS) return [];
    logger.info(
      { tenantId: input.tenantId, vendor: input.vendor, actions: parked.actions.length, event: 'browser_task_resumed' },
      'a task that stopped on this session is continued from what it already did',
    );
    return parked.actions.map((a) => ({
      step: a.step,
      action: a.action,
      kind: a.kind as HistoryEntry['kind'],
      operation: 'CLICK' as HistoryEntry['operation'],
      probability: 0,
      confidence: 0,
      latencyMs: 0,
      url: a.url,
      pageChanged: a.pageChanged,
      typed: a.typed,
    }));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: input.tenantId },
      'browser task: an earlier run could not be read; this one starts afresh',
    );
    return [];
  }
}

/** Keep what this run did for the next one, or clear it when the task is
 *  done. A task that finished has nothing left to continue, and leaving its
 *  actions behind would make the next task of the same name think it had
 *  already been done. */
async function parkOrClear(
  input: BrowserTaskInput,
  constraints: string[],
  reason: string,
  finished: boolean,
  actions: HistoryEntry[],
  /** Where the task had got to: the page it was on, and the files that were on
   *  it. For a job a site runs on its own this address is the durable handle —
   *  a generator puts the job's id in it — so a task that ran out of clock
   *  leaves something that can be gone back to rather than only a list of what
   *  it did. */
  where?: { pageUrl?: string; files?: string[] },
): Promise<void> {
  try {
    const repo = await import('../../browser-sessions/repository');
    const session = await repo.getByVendorSessionId(input.vendorSessionId);
    if (!session) return;
    if (finished || actions.length === 0) {
      if (session.parkedTask) await repo.setParkedTask(session.id, null);
      return;
    }
    await repo.setParkedTask(session.id, {
      objective: input.prompt,
      constraints,
      reason,
      parkedAt: new Date().toISOString(),
      ...(where?.pageUrl ? { pageUrl: where.pageUrl } : {}),
      ...(where?.files && where.files.length > 0 ? { files: where.files } : {}),
      actions: actions.slice(-PARKED_ACTIONS_CAP).map((a) => ({
        step: a.step, action: a.action, kind: a.kind, url: a.url, pageChanged: a.pageChanged, typed: a.typed,
      })),
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: input.tenantId },
      'browser task: what this run did could not be kept for the next one',
    );
  }
}

/**
 * What this task may not do: the caller's own constraints, and the
 * workspace's oversight settings.
 *
 * Never fails the task. A settings read that does not answer leaves the task
 * with the caller's constraints alone, which is what it would have had
 * before this existed; refusing to run rather than run unconstrained would
 * stop ordinary work over a settings lookup.
 */
async function taskConstraints(input: BrowserTaskInput): Promise<string[]> {
  const stated = (input.constraints ?? []).map((c) => c.trim()).filter(Boolean);
  if (!input.runtimeAgentId) return stated;
  try {
    const { loadOversightTriggers } = await import('./anchor-client');
    const triggers = await loadOversightTriggers(input.tenantId, input.runtimeAgentId);
    return [...triggers, ...stated];
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: input.tenantId },
      'browser task: the workspace oversight settings could not be read; the task runs with the constraints it was given',
    );
    return stated;
  }
}

/** The brief as a tail reads it: what to do, under what it may not do. */
export function composeBrief(objective: string, constraints: readonly string[], success = ''): string {
  if (constraints.length === 0 && !success) return objective;
  return [
    ...(constraints.length > 0
      ? [
        'You must not break any of these, whatever the task says:',
        ...constraints.map((c) => `- ${c}`),
        'If the next step would break one, stop and report where you got to. Do not do it.',
        '',
      ]
      : []),
    ...(success ? [`This is finished when: ${success}`, ''] : []),
    'Task:',
    objective,
  ].join('\n');
}

function outcomeOf(o: JevOutcome): BrowserTaskOutcome {
  return { status: o.status, result: o.result, data: o.data, trail: o.trail, ...(o.result.reason ? { reason: o.result.reason } : {}) };
}

/** The Jev trail so far, then the tail's.
 *
 *  A tail that finished the task speaks for the whole task. A tail that did
 *  not is the wrong half to quote: what the model can act on is why the LOOP
 *  stopped (a blank page, text the task never carried, a file to choose),
 *  and whether the tail that would have taken those over ran at all. The
 *  reason field keeps the loop's own word, as the record and its tests
 *  expect. */
function withHandoff(handoff: JevHandoff, tail: BrowserTaskOutcome): BrowserTaskOutcome {
  const trail = mergeTrails(handoff.trail, tail.trail);
  // Finished, by either tail's way of saying so: Stagehand sets `status` from
  // its own `completed`, and Anchor's in-session agent returns its vendor's
  // result shape, which carries no `completed` at all. Reading only the field
  // would have rewritten every successful Anchor task's message.
  const finished = tail.status === 'finished'
    || (tail.result as { completed?: boolean } | undefined)?.completed === true;
  if (finished) return { ...tail, trail };
  const lastStep = handoff.trail.steps[handoff.trail.steps.length - 1];
  const message = taskStopMessage(handoff.reason, {
    blankPage: isBlankPage(lastStep?.pageUrl),
    tailUnavailable: tail.reason === 'unavailable' || tail.reason === 'usage_unrecorded',
  });
  const result = tail.result as Record<string, unknown> | undefined;
  return {
    ...tail,
    result: { ...(result ?? {}), success: false, completed: false, message, reason: handoff.reason },
    data: message,
    trail: { ...trail, message },
    reason: handoff.reason,
  };
}
