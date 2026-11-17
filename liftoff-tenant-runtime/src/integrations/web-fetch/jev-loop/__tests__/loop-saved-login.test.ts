// The saved-login fill inside the loop, with the page, the observation, the
// decision and the resolver all stubbed: the fill runs on the loop's own
// page before the FIRST observation, and at a step boundary whose
// observation reached another origin or carries an authentication-class
// fill control the sequence is observe → fill → observe, so the next
// decision sees the signed-in page. Its steps join the trail. A loop that
// names no session applies no login.

jest.mock('../../../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const observations: Array<{ url: string; actions: Array<{ id: string; kind: string; label: string; role?: string }> }> = [];
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
jest.mock('../literals', () => ({ extractLiterals: () => ({ byId: new Map(), list: [] }), firstUrlIn: () => null }));
jest.mock('../goal-check', () => ({ checkGoal: jest.fn().mockResolvedValue({ met: true, probability: 0.95 }) }));
const decisions: Array<{ choice: string; operation: string }> = [];
jest.mock('../decide', () => ({
  buildStepRequest: (state: unknown) => ({ set: { id: 'set' }, state }),
  chooseFromAnswers: () => {
    const next = decisions.shift()!;
    return { choice: next.choice, operation: next.operation, target: null, textId: null, confidence: 1, probability: 1, latencyMs: 1, model: 'm', usage: { inputTokens: 1, outputTokens: 1 } };
  },
}));
jest.mock('../client', () => ({ askForLoop: jest.fn().mockResolvedValue({ answers: {}, model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }) }));

const mockApply = jest.fn();
jest.mock('../../../onepassword/autofill', () => ({
  ...jest.requireActual('../../../onepassword/autofill'),
  applySavedLoginOnTaskPage: (...a: unknown[]) => mockApply(...a),
}));

import { runJevLoop, _setPageOpenerForTesting } from '../loop';

const page = { url: () => observations[0]?.url ?? 'about:blank' };
const context = { pages: () => [page], on: jest.fn(), off: jest.fn() };
const cdp = { detach: jest.fn().mockResolvedValue(undefined) };

const LOGIN_STEP = {
  type: 'saved_login_confirmed', action: 'Password · j…@a.test', pageUrl: 'https://a.test/login',
  actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: true, protectedKind: 'authentication',
  pageUrlProtectedDataOmitted: false, at: new Date('2026-09-21T00:00:00Z'),
};

const state = (url: string, actions: Array<{ id: string; kind: string; label: string; role?: string }>) =>
  ({ url, title: '', w: 1280, h: 800, text: '', scroll: { y: 0, height: 800 }, actions, marker: null, page_key: null, guards: {}, omitted_actions: 0, fingerprint: url + actions.length });

beforeEach(() => {
  jest.clearAllMocks();
  observations.length = 0;
  decisions.length = 0;
  mockApply.mockResolvedValue('none');
  _setPageOpenerForTesting(async () => ({ page, context, cdp, close: async () => undefined } as never));
});
afterAll(() => _setPageOpenerForTesting(null));

const input = { cdpUrl: 'test', prompt: 'open the orders page', tenantId: 't1', vendor: 'steel', vendorSessionId: 'vs-1' };

describe('the saved login in the loop', () => {
  it('fills on the loop\'s own page before the first observation, and its step leads the trail', async () => {
    mockObserve.mockResolvedValueOnce(state('https://a.test/home', [{ id: 'e1', kind: 'click', label: 'Orders', role: 'link' }]));
    mockApply.mockImplementationOnce(async (_in: unknown, record: (s: unknown) => void) => { record(LOGIN_STEP); return 'confirmed'; });
    decisions.push({ choice: 'DONE', operation: 'DONE' });
    const out = await runJevLoop(input, { deadlineAt: Date.now() + 60_000 });
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][0]).toMatchObject({ vendor: 'steel', vendorSessionId: 'vs-1', tenantId: 't1', page });
    expect(mockApply.mock.invocationCallOrder[0]).toBeLessThan(mockObserve.mock.invocationCallOrder[0]);
    expect('outcome' in out).toBe(true);
    const trail = ('outcome' in out ? out.outcome : out.handoff).trail;
    expect(trail.steps[0]).toMatchObject({ type: 'saved_login_confirmed', protectedDataOmitted: true, protectedKind: 'authentication' });
    expect(trail.steps[1]).toMatchObject({ type: 'DONE' });
  });

  it('at a step boundary that reached another origin: observe → fill → observe, so the next decision sees the signed-in page', async () => {
    mockObserve
      .mockResolvedValueOnce(state('https://a.test/home', [{ id: 'e1', kind: 'click', label: 'Sign in', role: 'link' }]))
      // The click landed on another origin's sign-in page.
      .mockResolvedValueOnce(state('https://id.b.test/login', [{ id: 'e1', kind: 'fill', label: 'Email', role: 'textbox' }]))
      // After the fill: signed in.
      .mockResolvedValueOnce(state('https://id.b.test/account', [{ id: 'e1', kind: 'click', label: 'Orders', role: 'link' }]));
    mockApply
      .mockResolvedValueOnce('none')
      .mockImplementationOnce(async (_in: unknown, record: (s: unknown) => void) => { record(LOGIN_STEP); return 'confirmed'; });
    decisions.push({ choice: 'e1', operation: 'CLICK' }, { choice: 'DONE', operation: 'DONE' });
    const out = await runJevLoop(input, { deadlineAt: Date.now() + 60_000 });
    expect(mockApply).toHaveBeenCalledTimes(2);
    expect(mockObserve).toHaveBeenCalledTimes(3);
    // observe (post-action) → fill → observe: the order of the calls.
    const order = (m: jest.Mock, i: number) => m.mock.invocationCallOrder[i];
    expect(order(mockObserve, 1)).toBeLessThan(order(mockApply, 1));
    expect(order(mockApply, 1)).toBeLessThan(order(mockObserve, 2));
    const trail = ('outcome' in out ? out.outcome : out.handoff).trail;
    expect(trail.steps.map((s) => s.type)).toEqual(['CLICK', 'saved_login_confirmed', 'DONE']);
    // The DONE was decided on the observation after the fill.
    expect(trail.steps[2].pageUrl).toBe('https://id.b.test/account');
  });

  it('at a step boundary on the same origin whose observation carries an authentication-class fill control', async () => {
    mockObserve
      .mockResolvedValueOnce(state('https://a.test/home', [{ id: 'e1', kind: 'click', label: 'Sign in', role: 'link' }]))
      .mockResolvedValueOnce(state('https://a.test/home', [{ id: 'e1', kind: 'fill', label: 'One-time code', role: 'textbox' }]))
      .mockResolvedValueOnce(state('https://a.test/home', [{ id: 'e1', kind: 'click', label: 'Orders', role: 'link' }]));
    decisions.push({ choice: 'e1', operation: 'CLICK' }, { choice: 'DONE', operation: 'DONE' });
    await runJevLoop(input, { deadlineAt: Date.now() + 60_000 });
    expect(mockApply).toHaveBeenCalledTimes(2);
    expect(mockObserve).toHaveBeenCalledTimes(3);
  });

  it('a step that stayed on an ordinary page of the same origin fills nothing', async () => {
    mockObserve
      .mockResolvedValueOnce(state('https://a.test/home', [{ id: 'e1', kind: 'click', label: 'Orders', role: 'link' }]))
      .mockResolvedValueOnce(state('https://a.test/orders', [{ id: 'e1', kind: 'fill', label: 'Search orders', role: 'searchbox' }]));
    decisions.push({ choice: 'e1', operation: 'CLICK' }, { choice: 'DONE', operation: 'DONE' });
    await runJevLoop(input, { deadlineAt: Date.now() + 60_000 });
    // Only the first-observation fill.
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockObserve).toHaveBeenCalledTimes(2);
  });

  it('a loop that names no session applies no login', async () => {
    mockObserve.mockResolvedValueOnce(state('https://a.test/login', [{ id: 'e1', kind: 'fill', label: 'Email', role: 'textbox' }]));
    decisions.push({ choice: 'DONE', operation: 'DONE' });
    await runJevLoop({ cdpUrl: 'test', prompt: 'x', tenantId: 't1' }, { deadlineAt: Date.now() + 60_000 });
    expect(mockApply).not.toHaveBeenCalled();
  });
});
