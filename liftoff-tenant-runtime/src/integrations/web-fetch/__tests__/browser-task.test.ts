// The one entry for a browser task: admission once per task (denied → no
// vendor call, no handoff), the loop first, the handoff target per vendor
// (Stagehand on the same page; Anchor's agent on the same session), the
// merged trail, and the kill routing straight to today's path per vendor.

jest.mock('../../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../admission/service', () => ({ AdmissionService: jest.fn() }));
// The workspace's oversight settings, as sentences. The loader is the Anchor
// client's; here it is a seam, because what matters is that EVERY path gets
// what it returns rather than one of them.
const loadOversightTriggers = jest.fn(async () => [] as string[]);
jest.mock('../anchor-client', () => ({
  loadOversightTriggers: (...a: unknown[]) => loadOversightTriggers(...(a as [])),
}));
// The session row, where a stopped task is kept for the next run.
const getByVendorSessionId = jest.fn();
const setParkedTask = jest.fn(async () => null);
const setCarriedOnTask = jest.fn(async () => null);
const keepSessionAliveFor = jest.fn(async () => undefined);
jest.mock('../../../browser-sessions/repository', () => ({
  getByVendorSessionId: (...a: unknown[]) => getByVendorSessionId(...(a as [])),
  setParkedTask: (...a: unknown[]) => setParkedTask(...(a as [])),
  setCarriedOnTask: (...a: unknown[]) => setCarriedOnTask(...(a as [])),
  keepSessionAliveFor: (...a: unknown[]) => keepSessionAliveFor(...(a as [])),
}));
// The two rails a finished task reports on: an agent's thread is this
// service's own, the three assistants' are the control plane's.
const scheduleBackgroundWork = jest.fn(async () => 'work-1');
jest.mock('../../../interactive-chat/chat-continuation', () => ({
  scheduleBackgroundWork: (...a: unknown[]) => scheduleBackgroundWork(...(a as [])),
}));
const announceBrowserTaskToAssistant = jest.fn(async () => undefined);
jest.mock('../../../platform-callback/client', () => ({
  announceBrowserTaskToAssistant: (...a: unknown[]) => announceBrowserTaskToAssistant(...(a as [])),
}));

import {
  runBrowserTask,
  _setAdmissionCheckForTesting,
  _setRunnersForTesting,
  finishedTask,
  TASK_TIMEOUT_MS,
  PARK_TTL_MS,
  HAND_BACK_AFTER_MS,
  BACKGROUND_TASK_TIMEOUT_MS,
  FINISHED_TASK_TTL_MS,
} from '../browser-task';
import { trailOf, STOPPED_MESSAGE, COMPLETED_MESSAGE, handoffStep } from '../jev-loop/trail';

const loop = jest.fn();
const stagehand = jest.fn();
const anchorAgent = jest.fn();

const base = { vendorSessionId: 'vs', cdpUrl: 'ws://cdp', prompt: 'do it', tenantId: 't1', runtimeAgentId: 'a1', invocationId: 'inv' };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TR_JEV_BROWSER_LOOP_ENABLED;
  _setAdmissionCheckForTesting(async () => true);
  _setRunnersForTesting({ loop: loop as never, stagehand: stagehand as never });
  getByVendorSessionId.mockResolvedValue({ id: 'sid', parkedTask: null });
  setParkedTask.mockResolvedValue(null);
  stagehand.mockResolvedValue({ status: 'finished', result: { ok: 1 }, data: 'tail', trail: trailOf([], 'tail') });
  anchorAgent.mockResolvedValue({ status: 'finished', result: { anchor: 1 }, data: 'anchor' });
});
afterAll(() => { _setAdmissionCheckForTesting(null); _setRunnersForTesting({}); });

describe('a task that did not finish says what stopped it and what to do next', () => {
  // The defect this pins: every stop reported the same four words. Handed only
  // "Browser task stopped", the Chief AI Officer can tell the person no more
  // than that the reason is "not fully clear" and ask them to type it
  // themselves, even when the stop has a plain cause and a remedy.
  it('a blank page names the remedy: open the page first', async () => {
    const head = trailOf([handoffStep('no_candidates', 'about:blank', new Date())], STOPPED_MESSAGE);
    loop.mockResolvedValue({ handoff: { reason: 'no_candidates', trail: head } });
    stagehand.mockResolvedValue({ status: 'incomplete', result: { success: false, completed: false, message: 'x' }, data: 'x', trail: trailOf([], 'x'), reason: 'unavailable' });
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    const message = (out.result as { message: string }).message;
    expect(message).toContain('blank page');
    expect(message).toContain('navigate');
    // The reason a caller keys on is still the loop's own word.
    expect(out.reason).toBe('no_candidates');
    expect(out.data).toBe(message);
    expect(out.trail.message).toBe(message);
  });

  it('text the task never carried names the remedy: quote it', async () => {
    const head = trailOf([handoffStep('text_not_in_task', 'https://p', new Date())], STOPPED_MESSAGE);
    loop.mockResolvedValue({ handoff: { reason: 'text_not_in_task', trail: head } });
    stagehand.mockResolvedValue({ status: 'incomplete', result: { success: false, completed: false, message: 'x' }, data: 'x', trail: trailOf([], 'x'), reason: 'unavailable' });
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect((out.result as { message: string }).message).toContain('quotation marks');
  });

  it('a tail that could not start says the rest was not attempted', async () => {
    const head = trailOf([handoffStep('file_input', 'https://p', new Date())], STOPPED_MESSAGE);
    loop.mockResolvedValue({ handoff: { reason: 'file_input', trail: head } });
    stagehand.mockResolvedValue({ status: 'incomplete', result: { success: false, completed: false, message: 'x' }, data: 'x', trail: trailOf([], 'x'), reason: 'unavailable' });
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect((out.result as { message: string }).message).toContain('was not attempted');
  });

  it('a tail that FINISHED the task speaks for the whole task', async () => {
    const head = trailOf([handoffStep('text_not_in_task', 'https://p', new Date())], STOPPED_MESSAGE);
    loop.mockResolvedValue({ handoff: { reason: 'text_not_in_task', trail: head } });
    stagehand.mockResolvedValue({ status: 'finished', result: { success: true, completed: true, message: 'Browser task completed' }, data: 'done', trail: trailOf([], 'done') });
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect(out.status).toBe('finished');
    expect((out.result as { message: string }).message).toBe('Browser task completed');
  });

  it('a denied tenant is told work is not permitted, not that the browser stopped', async () => {
    _setAdmissionCheckForTesting(async () => false);
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect((out.result as { message: string }).message).toContain('not permitted');
    expect(out.reason).toBe('execution_denied');
  });
});

describe('runBrowserTask', () => {
  it('a denied tenant makes no vendor call and no handoff', async () => {
    _setAdmissionCheckForTesting(async () => false);
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect(out.reason).toBe('execution_denied');
    expect(loop).not.toHaveBeenCalled();
    expect(stagehand).not.toHaveBeenCalled();
  });

  it('checks admission once per task, then runs the loop; an outcome ends the task', async () => {
    const admission = jest.fn(async () => true);
    _setAdmissionCheckForTesting(admission);
    loop.mockResolvedValue({ outcome: { status: 'finished', result: { success: true, completed: true, message: COMPLETED_MESSAGE, final: { url: 'u', title: 't', text: 'x' }, steps: 3, lastActions: [] }, data: COMPLETED_MESSAGE, trail: trailOf([], COMPLETED_MESSAGE) } });
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledWith('t1', 'a1');
    expect(loop).toHaveBeenCalledTimes(1);
    expect(loop.mock.calls[0][1].deadlineAt).toBeGreaterThan(Date.now() + TASK_TIMEOUT_MS - 5_000);
    expect(stagehand).not.toHaveBeenCalled();
    expect(out.status).toBe('finished');
  });

  it('a handoff on Steel / Browser Use / Browserbase runs Stagehand on the same page with the shared clock, and merges the trails', async () => {
    const head = trailOf([handoffStep('text_not_in_task', 'https://p', new Date())], STOPPED_MESSAGE);
    loop.mockResolvedValue({ handoff: { reason: 'text_not_in_task', trail: head } });
    for (const vendor of ['steel', 'browser_use', 'browserbase'] as const) {
      stagehand.mockClear();
      const out = await runBrowserTask({ ...base, vendor, modelSelection: { provider: 'anthropic' } });
      expect(stagehand).toHaveBeenCalledTimes(1);
      const arg = stagehand.mock.calls[0][0];
      expect(arg).toMatchObject({ cdpUrl: 'ws://cdp', prompt: 'do it', tenantId: 't1', invocationId: 'inv', runtimeAgentId: 'a1', modelSelection: { provider: 'anthropic' } });
      expect(arg.clock.deadlineAt).toBeGreaterThan(Date.now());
      expect(out.trail.steps.map((s) => s.type)).toEqual(['handoff']);
      expect(out.trail.message).toBe('tail');
      expect(out.result).toEqual({ ok: 1 });
    }
  });

  it('a handoff on Anchor runs the in-session agent, never Stagehand', async () => {
    loop.mockResolvedValue({ handoff: { reason: 'blocked', trail: trailOf([handoffStep('blocked', 'https://p', new Date())], STOPPED_MESSAGE) } });
    const out = await runBrowserTask({ ...base, vendor: 'anchor', runAnchorAgent: anchorAgent });
    expect(anchorAgent).toHaveBeenCalledTimes(1);
    expect(stagehand).not.toHaveBeenCalled();
    expect(out.result).toEqual({ anchor: 1 });
    expect(out.trail.steps[0].type).toBe('handoff');
  });

  it('the kill routes straight to today\'s path per vendor', async () => {
    process.env.TR_JEV_BROWSER_LOOP_ENABLED = '0';
    await runBrowserTask({ ...base, vendor: 'browser_use' });
    expect(loop).not.toHaveBeenCalled();
    expect(stagehand).toHaveBeenCalledTimes(1);
    await runBrowserTask({ ...base, vendor: 'anchor', runAnchorAgent: anchorAgent });
    expect(anchorAgent).toHaveBeenCalledTimes(1);
    expect(loop).not.toHaveBeenCalled();
  });

  it('a session with no cdp url goes straight to the tail', async () => {
    await runBrowserTask({ ...base, cdpUrl: undefined, vendor: 'anchor', runAnchorAgent: anchorAgent });
    expect(loop).not.toHaveBeenCalled();
    expect(anchorAgent).toHaveBeenCalledTimes(1);
  });
});

// The brief: what to do, and what may not be done whatever the task says
//
// The workspace's financial-actions setting became the sentence "Ask the
// user before any payment, purchase, or money movement" in exactly one
// place: Anchor's headless task entry. The Jev loop, the Stagehand tail and
// Anchor's own in-session tail never saw it — so on the browser the pane
// actually runs, a task carried no such constraint at all, and nothing in
// the loop tells a Place Order button from any other.
describe('the constraints a task runs under', () => {
  const MONEY = 'Ask the user before any payment, purchase, or money movement.';

  beforeEach(() => {
    process.env.TR_JEV_BROWSER_LOOP_ENABLED = '1';
    loadOversightTriggers.mockResolvedValue([MONEY]);
    loop.mockResolvedValue({ handoff: { reason: 'blocked', trail: trailOf([], 'loop') } });
  });

  it('gives the loop the workspace settings as constraints, on every vendor', async () => {
    for (const vendor of ['steel', 'browser_use', 'browserbase', 'anchor'] as const) {
      loop.mockClear();
      await runBrowserTask({ ...base, vendor, runAnchorAgent: anchorAgent as never });
      expect(loop.mock.calls[0][0].constraints).toEqual([MONEY]);
    }
  });

  // Held apart from the objective rather than glued to the front of it: the
  // objective is what DONE is judged against, and a constraint is not a
  // requirement to satisfy.
  it('leaves the objective alone', async () => {
    await runBrowserTask({ ...base, vendor: 'steel' });
    expect(loop.mock.calls[0][0].prompt).toBe('do it');
  });

  it('gives the Stagehand tail the constraints composed into its brief', async () => {
    await runBrowserTask({ ...base, vendor: 'steel' });
    const brief = stagehand.mock.calls[0][0].prompt as string;
    expect(brief).toContain(MONEY);
    expect(brief).toContain('do it');
    expect(brief).toMatch(/must not break/);
  });

  it("gives Anchor's own tail the same brief, not the bare objective", async () => {
    await runBrowserTask({ ...base, vendor: 'anchor', runAnchorAgent: anchorAgent as never });
    expect(anchorAgent.mock.calls[0][1]).toContain(MONEY);
  });

  it('adds what the caller stated to what the workspace requires', async () => {
    await runBrowserTask({ ...base, vendor: 'steel', constraints: ['Stop at the review page.', '  '] });
    expect(loop.mock.calls[0][0].constraints).toEqual([MONEY, 'Stop at the review page.']);
  });

  it('runs with what it was given when the settings cannot be read, rather than not at all', async () => {
    loadOversightTriggers.mockRejectedValueOnce(new Error('settings unavailable'));
    const out = await runBrowserTask({ ...base, vendor: 'steel', constraints: ['Stop at the review page.'] });
    expect(loop.mock.calls[0][0].constraints).toEqual(['Stop at the review page.']);
    expect(out.status).toBeDefined();
  });

  it('asks for no settings when there is no team to ask about, and passes none', async () => {
    const { runtimeAgentId: _drop, ...noAgent } = base;
    await runBrowserTask({ ...noAgent, vendor: 'steel' });
    expect(loadOversightTriggers).not.toHaveBeenCalled();
    expect(loop.mock.calls[0][0].constraints).toBeUndefined();
  });

  // THE POINT. A tail is another model driving the same page from the same
  // objective. Handing it a task that stopped because the next click would
  // spend money is handing the forbidden click to something that was never
  // told not to make it.
  it('a task that stopped on a constraint hands nothing to the tail', async () => {
    const message = 'stopped at the constraint';
    loop.mockResolvedValue({
      outcome: {
        status: 'incomplete',
        result: { success: true, completed: false, message, reason: 'constrained', steps: 3, lastActions: [] },
        data: message,
        trail: trailOf([], message),
      },
    });
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect(stagehand).not.toHaveBeenCalled();
    expect(out.reason).toBe('constrained');
    expect(out.data).toBe(message);
  });
});

// A task that stopped is continued, not started again
//
// A stopped task used to leave nothing behind but the page. The session and
// the page persisted, so the browser still sat on the half-filled form, and
// the next run had no idea which of those fields it had filled — which is
// how a task repeats an action it already took. On anything that submits,
// orders or pays, a repeated action is not a wasted step.
describe('a task that stopped on this session', () => {
  const action = { step: 1, action: 'button · Continue', kind: 'click', url: 'https://shop.example/cart', pageChanged: true, typed: false };

  beforeEach(() => {
    process.env.TR_JEV_BROWSER_LOOP_ENABLED = '1';
    loop.mockResolvedValue({
      handoff: { reason: 'blocked', trail: trailOf([], 'loop'), actions: [{ ...action, operation: 'CLICK', probability: 1, confidence: 1, latencyMs: 1 }] },
    });
    // The tail does not finish it either, so the whole task stopped: a task
    // the tail carried over the line has nothing left to continue.
    stagehand.mockResolvedValue({ status: 'incomplete', result: { completed: false }, data: 'tail stopped', trail: trailOf([], 'tail stopped') });
  });

  it('keeps what it did, under the objective it was given', async () => {
    await runBrowserTask({ ...base, vendor: 'steel' });
    const parked = setParkedTask.mock.calls[0][1] as { objective: string; reason: string; actions: unknown[] };
    expect(parked.objective).toBe('do it');
    expect(parked.reason).toBe('blocked');
    expect(parked.actions).toHaveLength(1);
  });

  it('hands what it did to the next run of the same task, without counting it against that run', async () => {
    getByVendorSessionId.mockResolvedValue({
      id: 'sid',
      parkedTask: { objective: 'do it', constraints: [], actions: [action], reason: 'blocked', parkedAt: new Date().toISOString() },
    });
    await runBrowserTask({ ...base, vendor: 'steel' });
    const priorActions = loop.mock.calls[0][0].priorActions as Array<{ action: string }>;
    expect(priorActions).toHaveLength(1);
    expect(priorActions[0].action).toBe('button · Continue');
  });

  // Carrying one task's actions into a different task would tell the model
  // it had already done things it has not, which is worse than telling it
  // nothing.
  it('carries nothing into a different task on the same session', async () => {
    getByVendorSessionId.mockResolvedValue({
      id: 'sid',
      parkedTask: { objective: 'something else entirely', constraints: [], actions: [action], reason: 'blocked', parkedAt: new Date().toISOString() },
    });
    await runBrowserTask({ ...base, vendor: 'steel' });
    expect(loop.mock.calls[0][0].priorActions).toBeUndefined();
  });

  it('carries nothing from a run too old to still be about this page', async () => {
    getByVendorSessionId.mockResolvedValue({
      id: 'sid',
      parkedTask: {
        objective: 'do it', constraints: [], actions: [action], reason: 'blocked',
        parkedAt: new Date(Date.now() - PARK_TTL_MS - 1000).toISOString(),
      },
    });
    await runBrowserTask({ ...base, vendor: 'steel' });
    expect(loop.mock.calls[0][0].priorActions).toBeUndefined();
  });

  // A task that finished has nothing left to continue, and leaving its
  // actions behind would make the next task of the same name believe it had
  // already been done.
  it('clears what it kept once the task finishes', async () => {
    getByVendorSessionId.mockResolvedValue({
      id: 'sid',
      parkedTask: { objective: 'do it', constraints: [], actions: [action], reason: 'blocked', parkedAt: new Date().toISOString() },
    });
    loop.mockResolvedValue({
      outcome: {
        status: 'finished',
        result: { success: true, completed: true, message: 'done', steps: 1, lastActions: [] },
        data: 'done',
        trail: trailOf([], 'done'),
      },
    });
    await runBrowserTask({ ...base, vendor: 'steel' });
    expect(setParkedTask).toHaveBeenCalledWith('sid', null);
  });

  it('runs the task anyway when the row cannot be read or written', async () => {
    getByVendorSessionId.mockRejectedValue(new Error('row unavailable'));
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect(out.status).toBeDefined();
    expect(loop).toHaveBeenCalled();
  });
});

// A long task hands the turn back and carries on
//
// A browser task used to hold a chat turn open for as long as it ran, which
// is why it had a three-minute bound and why anything genuinely slow failed.
// A page asked to generate a few seconds of video takes minutes: a
// comparable system's run of exactly that job took 229 seconds, which our
// 180-second bound would have killed about fifty seconds from the finish.
// The bound was never a judgement about browser work; it was a consequence
// of making the caller wait.
describe('a task that outlives the call that started it', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.TR_JEV_BROWSER_LOOP_ENABLED = '1';
  });
  afterEach(() => jest.useRealTimers());

  /** A loop that finishes only when the test lets it. */
  function loopThatFinishesOnDemand() {
    let release: (v: unknown) => void = () => undefined;
    loop.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    return () => release({
      outcome: {
        status: 'finished',
        result: { success: true, completed: true, message: 'the video downloaded', steps: 30, lastActions: [] },
        data: 'the video downloaded',
        trail: trailOf([], 'the video downloaded'),
      },
    });
  }

  it('answers in the same turn when the work is short, which is most of it', async () => {
    loop.mockResolvedValue({
      outcome: {
        status: 'finished',
        result: { success: true, completed: true, message: 'done', steps: 2, lastActions: [] },
        data: 'done',
        trail: trailOf([], 'done'),
      },
    });
    const out = await runBrowserTask({ ...base, vendor: 'steel', background: true });
    expect(out.status).toBe('finished');
    expect(out.taskId).toBeUndefined();
  });

  it('hands the turn back with an id once waiting stops being the better answer', async () => {
    const finish = loopThatFinishesOnDemand();
    const pending = runBrowserTask({ ...base, vendor: 'steel', background: true });
    await jest.advanceTimersByTimeAsync(HAND_BACK_AFTER_MS + 10);
    const out = await pending;

    expect(out.status).toBe('running');
    expect(out.reason).toBe('carrying_on');
    expect(out.taskId).toEqual(expect.any(String));
    // What the model is told to do with it.
    expect(out.data).toMatch(/still running/);
    expect(out.data).toMatch(/check_browser_task/);
    expect(out.data).toMatch(/Do not start the task again/);

    // Its result is kept on the SESSION's row rather than in this process,
    // so the turn that comes back for it finds it on any instance.
    expect(setCarriedOnTask).not.toHaveBeenCalled();
    finish();
    // The task's own tail — parking what it did, then recording the result —
    // is several awaits past the loop returning.
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(10);
    expect(setCarriedOnTask).toHaveBeenCalledWith('sid', expect.objectContaining({
      taskId: out.taskId, status: 'finished',
    }));
  });

  // The whole point: the long clock is the one the task gets.
  it('gives the task that carries on minutes rather than the turn\'s three', async () => {
    loopThatFinishesOnDemand();
    const pending = runBrowserTask({ ...base, vendor: 'steel', background: true });
    await jest.advanceTimersByTimeAsync(HAND_BACK_AFTER_MS + 10);
    await pending;
    const deadline = loop.mock.calls[0][1].deadlineAt as number;
    expect(deadline - Date.now()).toBeGreaterThan(TASK_TIMEOUT_MS);
    expect(BACKGROUND_TASK_TIMEOUT_MS).toBeGreaterThan(TASK_TIMEOUT_MS);
  });

  // A run has no conversation to come back to, so there is nothing to hand
  // the turn back TO and the task is run to the end as it always was.
  it('never hands back for a caller that has nowhere to report', async () => {
    loop.mockResolvedValue({
      outcome: {
        status: 'finished',
        result: { success: true, completed: true, message: 'done', steps: 1, lastActions: [] },
        data: 'done',
        trail: trailOf([], 'done'),
      },
    });
    const out = await runBrowserTask({ ...base, vendor: 'steel' });
    expect(out.taskId).toBeUndefined();
    expect(loop.mock.calls[0][1].deadlineAt - Date.now()).toBeLessThanOrEqual(TASK_TIMEOUT_MS);
  });

  it('answers nothing for an id the session does not hold', async () => {
    getByVendorSessionId.mockResolvedValue({ id: 'sid', parkedTask: null, carriedOnTask: null });
    expect(await finishedTask('t1', 'vs', 'never-seen')).toBeNull();
  });

  // The bug this replaced: the result lived in one process, so a later turn
  // on another instance was told the task was still running forever.
  it('reads a finished result off the session, whichever instance asks', async () => {
    getByVendorSessionId.mockResolvedValue({
      id: 'sid',
      parkedTask: null,
      carriedOnTask: { taskId: 'task-1', status: 'finished', message: 'the video downloaded', reason: '', finishedAt: new Date().toISOString() },
    });
    expect(await finishedTask('t1', 'vs', 'task-1')).toEqual({ status: 'finished', message: 'the video downloaded', reason: '' });
  });

  it('answers nothing for a result too old to still be wanted', async () => {
    getByVendorSessionId.mockResolvedValue({
      id: 'sid',
      parkedTask: null,
      carriedOnTask: {
        taskId: 'task-1', status: 'finished', message: 'x', reason: '',
        finishedAt: new Date(Date.now() - FINISHED_TASK_TTL_MS - 1000).toISOString(),
      },
    });
    expect(await finishedTask('t1', 'vs', 'task-1')).toBeNull();
  });

  // A caller with no way to collect must WAIT instead: telling it work is
  // coming when it can never report the result is worse than the bound.
  it('never hands back to a caller that cannot come back for it', async () => {
    loopThatFinishesOnDemand();
    const pending = runBrowserTask({ ...base, vendor: 'steel' });
    await jest.advanceTimersByTimeAsync(HAND_BACK_AFTER_MS + 10);
    // Nothing resolved: it is still running to the end rather than handing
    // back an id nobody could use.
    let settled = false;
    void pending.then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
  });
});

// A task finishing is an EVENT. Parking the result until somebody next spoke
// made the person the delivery mechanism: they were told to send a message so
// the work could be picked up, and a file they never came back for was never
// delivered at all.
describe('a finished task reports where the row says to report', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.TR_JEV_BROWSER_LOOP_ENABLED = '1';
  });
  afterEach(() => jest.useRealTimers());

  function loopThatFinishesOnDemand() {
    let release: (v: unknown) => void = () => undefined;
    loop.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    return () => release({
      outcome: {
        status: 'finished',
        result: { success: true, completed: true, message: 'the video downloaded', steps: 3, lastActions: [] },
        data: 'the video downloaded',
        trail: trailOf([], 'the video downloaded'),
      },
    });
  }

  /** Carry a task on, let it finish, and settle every queued microtask. */
  async function carryOnThenFinish(reportFinishTo: unknown) {
    getByVendorSessionId.mockResolvedValue({ id: 'sid', tenantId: 't1', parkedTask: null, reportFinishTo });
    const finish = loopThatFinishesOnDemand();
    const pending = runBrowserTask({ ...base, vendor: 'steel', background: true });
    await jest.advanceTimersByTimeAsync(HAND_BACK_AFTER_MS + 10);
    await pending;
    finish();
    await jest.advanceTimersByTimeAsync(10);
  }

  it('wakes an agent on this service own rails', async () => {
    await carryOnThenFinish({ threadId: 'th-1', agentId: 'a1', internalAgentId: 'ia-1', invocationId: 'inv', senderAccountId: 'acc-1' });
    expect(scheduleBackgroundWork).toHaveBeenCalledTimes(1);
    expect(announceBrowserTaskToAssistant).not.toHaveBeenCalled();
    const arg = scheduleBackgroundWork.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.threadId).toBe('th-1');
    expect(arg.runtimeAgentId).toBe('a1');
    expect(arg.internalAgentId).toBe('ia-1');
    // The brief has to name the task, or the woken turn cannot collect it.
    expect(String(arg.brief)).toContain('browser task id');
  });

  it('calls the control plane for one of the three assistants, which has no agent', async () => {
    await carryOnThenFinish({ threadId: 'th-2', agentId: '00000000-0000-0000-0000-000000000000', assistant: 'liftoff' });
    expect(announceBrowserTaskToAssistant).toHaveBeenCalledTimes(1);
    expect(scheduleBackgroundWork).not.toHaveBeenCalled();
    const arg = announceBrowserTaskToAssistant.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.threadId).toBe('th-2');
    expect(arg.assistant).toBe('liftoff');
  });

  // The result is on the row either way, and the collect tool is the fallback:
  // a task whose dispatcher never said where to report is the state every task
  // was in before the push existed.
  it('reports nowhere when the row names no target, and still keeps the result', async () => {
    await carryOnThenFinish(null);
    expect(scheduleBackgroundWork).not.toHaveBeenCalled();
    expect(announceBrowserTaskToAssistant).not.toHaveBeenCalled();
    expect(setCarriedOnTask).toHaveBeenCalled();
  });

  // The push is the delivery and the row is the record. A push that throws
  // must not cost the record, or the fallback has nothing to find.
  it('keeps the result when the wake fails', async () => {
    scheduleBackgroundWork.mockRejectedValueOnce(new Error('queue down') as never);
    await carryOnThenFinish({ threadId: 'th-3', agentId: 'a1' });
    expect(setCarriedOnTask).toHaveBeenCalled();
  });
});
