// Waiting for a page, rather than polling it with a model.
//
// A WAIT slept 100 ms and returned, and every one of them cost a full
// decision round trip. On a page that takes minutes to render (a video
// generator, say) the loop chooses WAIT dozens of times, waits a few seconds
// in total, spends minutes deciding, hits the action ceiling and reports "ran
// as far as it could and then stopped without finishing" while the video sits
// finished on the page. The person sees minutes of nothing.
//
// Two rules now. A wait waits for the page to CHANGE, up to a budget that
// climbs as waits stack up, so one decision covers the whole wait. And a run
// of waits is capped: a page that will not settle ends the task with a
// sentence that says so, instead of spending dozens of actions to say nothing.

jest.mock('../../../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockObserve = jest.fn();
jest.mock('../observe', () => ({
  StalePage: class extends Error {},
  observe: (...a: unknown[]) => mockObserve(...a),
  finalObservation: (state: { url: string }) => ({ url: state.url, title: '', text: '' }),
}));
const mockAct = jest.fn();
jest.mock('../act', () => ({
  SelectNotConfirmed: class extends Error {},
  act: (...a: unknown[]) => mockAct(...a),
  fresh: jest.fn().mockResolvedValue(true),
}));
jest.mock('../goal-check', () => ({ checkGoal: jest.fn().mockResolvedValue({ met: true, probability: 0.95 }) }));
const decisions: Array<{ choice: string; operation: string }> = [];
jest.mock('../decide', () => ({
  buildStepRequest: (state: unknown) => ({ set: { id: 'set' }, state }),
  chooseFromAnswers: () => {
    const next = decisions.shift() ?? { choice: 'DONE', operation: 'DONE' };
    return { choice: next.choice, operation: next.operation, target: null, textId: null, confidence: 1, probability: 1, latencyMs: 1, model: 'm', usage: { inputTokens: 1, outputTokens: 1 } };
  },
}));
jest.mock('../client', () => ({ askForLoop: jest.fn().mockResolvedValue({ answers: {}, model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }) }));
jest.mock('../literals', () => ({ extractLiterals: () => ({ byId: new Map(), list: [] }), firstUrlIn: () => null }));
jest.mock('../../../onepassword/autofill', () => ({
  applySavedLoginOnTaskPage: jest.fn().mockResolvedValue('none'),
  takePendingLoginSteps: () => [],
  observationHasAuthenticationFill: () => false,
}));

import { runJevLoop, _setPageOpenerForTesting } from '../loop';
import { MAX_CONSECUTIVE_WAITS, WAIT_LADDER_MS } from '../types';

const URL = 'https://a.example/generator';
const WAIT_ACTION = { id: 'w1', kind: 'wait', label: 'wait · Wait for the page to update' };

const state = (actions: unknown[]) => ({
  url: URL, title: '', w: 1280, h: 800, text: '', scroll: { y: 0, height: 800 },
  actions, marker: null, page_key: null, guards: {}, omitted_actions: 0, fingerprint: 'f' + Math.random(),
});

function page() {
  const p = { url: () => URL, goto: jest.fn() };
  const context = { pages: () => [p], on: jest.fn(), off: jest.fn() };
  _setPageOpenerForTesting(async () => ({ page: p, context, cdp: { detach: jest.fn().mockResolvedValue(undefined) }, close: jest.fn().mockResolvedValue(undefined) } as never));
}

const run = () => runJevLoop(
  { cdpUrl: 'ws://cdp', prompt: 'wait for the video', tenantId: 't1', vendor: 'steel', vendorSessionId: 'vs' },
  { deadlineAt: Date.now() + 600_000 },
);

beforeEach(() => {
  jest.clearAllMocks();
  decisions.length = 0;
  mockObserve.mockImplementation(async () => state([WAIT_ACTION]));
  mockAct.mockResolvedValue(undefined);
  page();
});
afterAll(() => _setPageOpenerForTesting(null));

describe('waiting', () => {
  it('gives each wait a budget from the ladder, climbing as they stack up', async () => {
    for (let i = 0; i < 3; i++) decisions.push({ choice: 'w1', operation: 'WAIT' });
    decisions.push({ choice: 'DONE', operation: 'DONE' });
    await run();
    const budgets = mockAct.mock.calls.map((c) => (c[3] as { waitMs?: number }).waitMs);
    expect(budgets).toEqual([WAIT_LADDER_MS[0], WAIT_LADDER_MS[1], WAIT_LADDER_MS[2]]);
    // Not a hundred milliseconds.
    expect(budgets.every((b) => (b ?? 0) >= 1_000)).toBe(true);
  });

  it('stops after a run of waits, with a sentence rather than the action ceiling', async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_WAITS + 2; i++) decisions.push({ choice: 'w1', operation: 'WAIT' });
    const out = await run();
    if ('outcome' in out) throw new Error('expected a handoff');
    expect(out.handoff.reason).toBe('still_loading');
    // The ceiling is sixty actions; this ended long before it.
    expect(mockAct).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WAITS);
  });

  it('an action that is not a wait resets the run, so a page that keeps moving is never cut off', async () => {
    const CLICK = { id: 'c1', kind: 'click', label: 'button · Next', node: 1 };
    mockObserve.mockImplementation(async () => state([WAIT_ACTION, CLICK]));
    for (let i = 0; i < MAX_CONSECUTIVE_WAITS - 1; i++) decisions.push({ choice: 'w1', operation: 'WAIT' });
    decisions.push({ choice: 'c1', operation: 'CLICK' });
    for (let i = 0; i < MAX_CONSECUTIVE_WAITS - 1; i++) decisions.push({ choice: 'w1', operation: 'WAIT' });
    decisions.push({ choice: 'DONE', operation: 'DONE' });
    const out = await run();
    expect('outcome' in out).toBe(true);
    expect(mockAct.mock.calls.length).toBe((MAX_CONSECUTIVE_WAITS - 1) * 2 + 1);
  });
});

// Stopping short of a constraint
//
// CONSTRAINED is offered only when the task carries constraints, and it is a
// real exit rather than advice: the loop ends the task itself. It must not
// hand off, because the tail is another model driving the same page from the
// same objective and was never told what the loop was told.
describe('a constraint the task may not break', () => {
  const CONSTRAINT = 'Ask the user before any payment, purchase, or money movement.';

  it('ends the task itself, saying nothing was submitted, bought or sent', async () => {
    decisions.push({ choice: 'CONSTRAINED', operation: 'CONSTRAINED' });
    const out = await runJevLoop(
      { cdpUrl: 'ws://cdp', prompt: 'buy the ticket', tenantId: 't1', vendor: 'steel', vendorSessionId: 'vs', constraints: [CONSTRAINT] },
      { deadlineAt: Date.now() + 600_000 },
    );
    if (!('outcome' in out)) throw new Error('a constraint stop must not hand off');
    expect(out.outcome.result.reason).toBe('constrained');
    expect(out.outcome.result.completed).toBe(false);
    expect(out.outcome.result.message).toMatch(/Nothing was submitted, bought or sent/);
    expect(mockAct).not.toHaveBeenCalled();
  });
});
