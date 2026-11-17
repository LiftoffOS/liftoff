// A task that names a page, on a browser that is still on a blank one.
//
// The loop acts on the page it is given and navigates nowhere of its own
// accord, which is the right rule for every step after the first and was the
// wrong one for the first: "Go to <url> and type ..." on a pane session one
// second old observes `about:blank`, finds no candidates, and stops before it
// begins, telling the person the browser task "stopped before taking any
// steps".
//
// So the first address the task carries opens first, and only from a blank
// page: a browser already on a page was put there by the person or by an
// earlier step, and the task continues from what is in front of it.

jest.mock('../../../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockObserve = jest.fn();
jest.mock('../observe', () => ({
  StalePage: class extends Error {},
  observe: (...a: unknown[]) => mockObserve(...a),
  finalObservation: (state: { url: string }) => ({ url: state.url, title: '', text: '' }),
}));
jest.mock('../act', () => ({
  SelectNotConfirmed: class extends Error {},
  act: jest.fn().mockResolvedValue(undefined),
  fresh: jest.fn().mockResolvedValue(true),
}));
jest.mock('../goal-check', () => ({ checkGoal: jest.fn().mockResolvedValue({ met: true, probability: 0.95 }) }));
jest.mock('../decide', () => ({
  buildStepRequest: (state: unknown) => ({ set: { id: 'set' }, state }),
  chooseFromAnswers: () => ({ choice: 'DONE', operation: 'DONE', target: null, textId: null, confidence: 1, probability: 1, latencyMs: 1, model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }),
}));
jest.mock('../client', () => ({ askForLoop: jest.fn().mockResolvedValue({ answers: {}, model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }) }));
jest.mock('../../../onepassword/autofill', () => ({
  applySavedLoginOnTaskPage: jest.fn().mockResolvedValue('none'),
  takePendingLoginSteps: () => [],
}));

import { runJevLoop, _setPageOpenerForTesting } from '../loop';

const TASK_URL = 'https://www.example.com/video-generator/';

const state = (url: string) => ({
  url, title: '', w: 1280, h: 800, text: '', scroll: { y: 0, height: 800 },
  actions: [], marker: null, page_key: null, guards: {}, omitted_actions: 0, fingerprint: url,
});

function pageOn(startUrl: string) {
  let current = startUrl;
  const goto = jest.fn(async (url: string) => { current = url; });
  const page = { url: () => current, goto };
  const context = { pages: () => [page], on: jest.fn(), off: jest.fn() };
  const cdp = { detach: jest.fn().mockResolvedValue(undefined) };
  const close = jest.fn().mockResolvedValue(undefined);
  _setPageOpenerForTesting(async () => ({ page, context, cdp, close } as never));
  return { goto, page };
}

const run = (prompt: string, parameters?: Record<string, unknown>) => runJevLoop(
  { cdpUrl: 'ws://cdp', prompt, tenantId: 't1', vendor: 'steel', vendorSessionId: 'vs', ...(parameters ? { parameters } : {}) },
  { deadlineAt: Date.now() + 60_000 },
);

beforeEach(() => {
  jest.clearAllMocks();
  mockObserve.mockImplementation(async () => state(TASK_URL));
});
afterAll(() => _setPageOpenerForTesting(null));

describe('the first navigation', () => {
  it('opens the address the task names when the browser is on a blank page, and records it as a step', async () => {
    const { goto } = pageOn('about:blank');
    const out = await run(`Go to ${TASK_URL} and type "Friendly hand wave" into the prompt box.`);
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0][0]).toBe(TASK_URL);
    const trail = 'outcome' in out ? out.outcome.trail : out.handoff.trail;
    expect(trail.steps[0]).toMatchObject({ type: 'goto', action: TASK_URL });
  });

  it('leaves a browser that is already on a page where it is', async () => {
    const { goto } = pageOn('https://www.example.com/already-here');
    await run(`Go to ${TASK_URL} and type "Friendly hand wave".`);
    expect(goto).not.toHaveBeenCalled();
  });

  it('opens an address the assistant passed as a parameter, not only one in the words', async () => {
    const { goto } = pageOn('about:blank');
    await run('Open the generator and type "Friendly hand wave".', { url: TASK_URL });
    expect(goto).toHaveBeenCalledWith(TASK_URL, expect.objectContaining({ waitUntil: 'domcontentloaded' }));
  });

  it('navigates nowhere when the task names no address', async () => {
    const { goto } = pageOn('about:blank');
    await run('Type "Friendly hand wave" into the box and submit it.');
    expect(goto).not.toHaveBeenCalled();
  });

  it('takes only http and https, so a task naming another scheme opens nothing', async () => {
    const { goto } = pageOn('about:blank');
    await run('Open file:///etc/passwd and read it.');
    expect(goto).not.toHaveBeenCalled();
  });

  it('carries on with whatever is there when the address does not open', async () => {
    const { goto } = pageOn('about:blank');
    goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const out = await run(`Go to ${TASK_URL} and type "Friendly hand wave".`);
    // The task is answered on its own terms rather than thrown away.
    expect(out).toBeDefined();
    expect(mockObserve).toHaveBeenCalled();
  });
});
