// The agent layer that gives every CDP vendor a "do this" verb.
//
// What it replaces: Browser Use's own /tasks endpoint, which answered
// "Session not found" for the session the pane was showing. Its agent runs on
// API-V4 runs, and a run gets its own browser — their docs state no V4 endpoint
// accepts or exposes a cdpUrl for a run's session — so a task there acts on a
// browser nobody is watching, while every CDP tool on the same session id
// succeeds.

const mockExecute = jest.fn();
const mockInit = jest.fn();
const mockClose = jest.fn();
const mockStagehandCtor = jest.fn();
/** The AI SDK model Stagehand was handed: the middleware-wrapped one on the
 *  managed path. The mocked agent drives it directly, one `doGenerate` per
 *  step, the way Stagehand's handler calls `generateText`. */
let handedModel: LanguageModelV1 | null = null;

/** The page Stagehand drives, as the saved-login hook sees it: a load
 *  listener that a test can fire. */
const pageListeners = new Map<string, Set<() => void>>();
const stagehandPage = {
  on: (event: string, fn: () => void) => { (pageListeners.get(event) ?? pageListeners.set(event, new Set()).get(event)!).add(fn); },
  off: (event: string, fn: () => void) => { pageListeners.get(event)?.delete(fn); },
  url: () => 'https://a.test/',
};
const mockApplySavedLoginOnTaskPage = jest.fn();
jest.mock('../../onepassword/autofill', () => ({
  applySavedLoginOnTaskPage: (...a: unknown[]) => mockApplySavedLoginOnTaskPage(...a),
}));

jest.mock('@browserbasehq/stagehand', () => ({
  Stagehand: class {
    page = stagehandPage;
    constructor(opts: unknown) { mockStagehandCtor(opts); }
    init() { return mockInit(); }
    close() { return mockClose(); }
    agent() { return { execute: (...a: unknown[]) => mockExecute(...a) }; }
  },
  AISdkClient: class {
    constructor(opts: { model: LanguageModelV1 }) { handedModel = opts.model; }
  },
}));

/** Each provider's factory, mocked to a fake model that remembers the
 *  options it was built with (the credential) and answers `doGenerate` from a
 *  per-test script. */
type Reply = { promptTokens: number; completionTokens: number } | Error;
const factoryCalls: Array<{ provider: string; modelId: string; options: Record<string, unknown> }> = [];
const replies: Reply[] = [];
const doGenerateCalls: string[] = [];
function fakeModel(provider: string, modelId: string, options: Record<string, unknown>): LanguageModelV1 {
  factoryCalls.push({ provider, modelId, options });
  return {
    specificationVersion: 'v1',
    provider,
    modelId,
    defaultObjectGenerationMode: 'json',
    doGenerate: async () => {
      doGenerateCalls.push(provider);
      const reply = replies.shift() ?? { promptTokens: 10, completionTokens: 3 };
      if (reply instanceof Error) throw reply;
      return { text: 'ok', finishReason: 'stop', usage: reply, rawCall: { rawPrompt: null, rawSettings: {} } };
    },
    doStream: async () => { throw new Error('not used'); },
  } as unknown as LanguageModelV1;
}
jest.mock('@ai-sdk/anthropic', () => ({ createAnthropic: (o: Record<string, unknown>) => (id: string) => fakeModel('anthropic', id, o) }));
jest.mock('@ai-sdk/openai', () => ({ createOpenAI: (o: Record<string, unknown>) => (id: string) => fakeModel('openai', id, o) }));
jest.mock('@ai-sdk/xai', () => ({ createXai: (o: Record<string, unknown>) => (id: string) => fakeModel('xai', id, o) }));

const mockOpenByokSession = jest.fn();
jest.mock('../../../byok/session', () => ({
  openByokSession: (...a: unknown[]) => mockOpenByokSession(...a),
}));
const MANAGED: Record<string, string> = { ANTHROPIC_API_KEY: 'anthropic-key', OPENAI_API_KEY: 'openai-key', XAI_API_KEY: 'xai-key' };
jest.mock('../../../infrastructure/secret-store', () => ({
  getManagedSecret: (name: string) => MANAGED[name],
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockResolveForTier = jest.fn();
// `init` is part of this mock because the module depends on it: the client
// initializes on its first completion, and this is the one caller that
// resolves a model without making one.
const mockLlmInit = jest.fn();
jest.mock('../../../llm/client', () => ({
  llmClient: {
    init: (...a: unknown[]) => mockLlmInit(...a),
    resolveForTier: (...a: unknown[]) => mockResolveForTier(...a),
  },
}));
jest.mock('../../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: jest.fn().mockResolvedValue('internal-agent-1'),
}));
jest.mock('../../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn() }));

import { generateText, type LanguageModelV1 } from 'ai';
import { APICallError } from '@ai-sdk/provider';
import { runStagehandTask, _setStagehandUsagePosterForTesting, type UsageRecord } from '../stagehand-agent';

const base = { cdpUrl: 'https://abc.cdp.browser-use.com', prompt: 'Click Accept All', tenantId: 't1' };

const posted: UsageRecord[] = [];
let acknowledge = true;

/** An agent whose steps are model calls: `n` calls of `generateText` over the
 *  handed model, the AI SDK's own retry above each. */
function agentOfSteps(n: number, outcome: Record<string, unknown> = { success: true, completed: true, message: 'clicked', actions: [{ type: 'act', action: 'click Accept All', pageUrl: 'https://a.test/' }] }) {
  mockExecute.mockImplementation(async () => {
    for (let i = 0; i < n; i++) await generateText({ model: handedModel!, prompt: `step ${i}` });
    return outcome;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  pageListeners.clear();
  mockApplySavedLoginOnTaskPage.mockResolvedValue('none');
  handedModel = null;
  factoryCalls.length = 0;
  replies.length = 0;
  doGenerateCalls.length = 0;
  posted.length = 0;
  acknowledge = true;
  _setStagehandUsagePosterForTesting(async (r) => { posted.push(r); return acknowledge; });
  mockInit.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockExecute.mockResolvedValue({ success: true, completed: true, message: 'clicked', actions: [{ type: 'act', action: 'click Accept All', pageUrl: 'https://a.test/' }] });
  mockOpenByokSession.mockResolvedValue(null);
  mockLlmInit.mockReset().mockResolvedValue(undefined);
  mockResolveForTier.mockImplementation((selection?: { provider: string; model?: string }) => ({
    provider: selection?.provider ?? 'anthropic',
    modelId: selection?.model ?? `${selection?.provider ?? 'anthropic'}-medium`,
  }));
});
afterAll(() => _setStagehandUsagePosterForTesting(null));

describe('the saved login on the tail', () => {
  const step = {
    type: 'saved_login_confirmed', action: 'Password · j…@a.test', pageUrl: 'https://a.test/login',
    actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: true, protectedKind: 'authentication',
    pageUrlProtectedDataOmitted: false, at: new Date('2026-09-21T00:00:00Z'),
  };

  it('applies the saved login on the attached page before the agent looks, and its step leads the trail', async () => {
    mockApplySavedLoginOnTaskPage.mockImplementationOnce(async (_input: unknown, record: (s: unknown) => void) => { record(step); return 'confirmed'; });
    const out = await runStagehandTask({ ...base, vendor: 'steel', vendorSessionId: 'vs-1' });
    expect(mockApplySavedLoginOnTaskPage).toHaveBeenCalledTimes(1);
    expect(mockApplySavedLoginOnTaskPage.mock.calls[0][0]).toMatchObject({ vendor: 'steel', vendorSessionId: 'vs-1', tenantId: 't1', page: stagehandPage });
    // The fill ran before the agent: the call is recorded before execute.
    expect(mockApplySavedLoginOnTaskPage.mock.invocationCallOrder[0]).toBeLessThan(mockExecute.mock.invocationCallOrder[0]);
    expect(out.trail.steps[0]).toMatchObject({ type: 'saved_login_confirmed', protectedDataOmitted: true, protectedKind: 'authentication' });
    expect(out.trail.steps[1]).toMatchObject({ type: 'act' });
  });

  it('applies the saved login again on each load inside the loop, and those steps follow the agent\'s', async () => {
    mockApplySavedLoginOnTaskPage
      .mockResolvedValueOnce('none')
      .mockImplementationOnce(async (_input: unknown, record: (s: unknown) => void) => { record({ ...step, type: 'saved_login_submitted' }); return 'submitted'; });
    mockExecute.mockImplementation(async () => {
      for (const fn of pageListeners.get('load') ?? []) fn();
      await new Promise((r) => setTimeout(r, 10));
      return { success: true, completed: true, message: 'clicked', actions: [{ type: 'act', action: 'click Accept All', pageUrl: 'https://a.test/' }] };
    });
    const out = await runStagehandTask({ ...base, vendor: 'steel', vendorSessionId: 'vs-1' });
    expect(mockApplySavedLoginOnTaskPage).toHaveBeenCalledTimes(2);
    expect(out.trail.steps.map((s) => s.type)).toEqual(['act', 'saved_login_submitted']);
    // The listener is removed with the task.
    expect(pageListeners.get('load')?.size ?? 0).toBe(0);
  });

  it('applies no login when the task names no session', async () => {
    await runStagehandTask(base);
    expect(mockApplySavedLoginOnTaskPage).not.toHaveBeenCalled();
  });
});

describe('which browser the task acts on', () => {
  it('attaches to the cdpUrl it was given, not a browser of its own', () => {
    // The whole defect this replaces: acting on a browser the person is not
    // watching. `env: LOCAL` here means "one I already have", not "one on this
    // machine" — the url is remote.
    return runStagehandTask(base).then(() => {
      const opts = mockStagehandCtor.mock.calls[0][0] as Record<string, unknown>;
      expect(opts.env).toBe('LOCAL');
      expect(opts.localBrowserLaunchOptions).toEqual({ cdpUrl: base.cdpUrl });
    });
  });

  it('hands the instruction to the agent as a job of bounded steps, verbatim', async () => {
    // A task is several steps — open the page, fill, submit, read — not one
    // act; a scheduled run has nobody beside it to take them one at a time.
    await runStagehandTask(base);
    // The task's own words are untouched; the navigation rule follows them.
    expect(mockExecute).toHaveBeenCalledWith({ instruction: expect.stringContaining('Click Accept All'), maxSteps: 20 });
    const instruction = (mockExecute.mock.calls[0][0] as { instruction: string }).instruction;
    expect(instruction.startsWith('Click Accept All')).toBe(true);
  });

  it('returns Anchor\'s shape so no caller branches on vendor', async () => {
    const r = await runStagehandTask(base);
    expect(r.status).toBe('finished');
    expect(r.result).toEqual({
      success: true,
      completed: true,
      message: 'clicked',
      steps: 1,
      lastActions: [{ type: 'act', action: 'click Accept All', pageUrl: 'https://a.test/' }],
    });
    expect(r.data).toBe('clicked');
  });

  it('carries the trail BESIDE the result, never inside it', async () => {
    // The model's result has the same keys it always had; the record reads
    // the separate field, which now carries its completeness fields too.
    const r = await runStagehandTask(base);
    expect(Object.keys(r.result as object).sort()).toEqual(['completed', 'lastActions', 'message', 'steps', 'success']);
    expect(r.trail).toMatchObject({
      message: 'clicked',
      steps: [expect.objectContaining({ type: 'act', action: 'click Accept All', pageUrl: 'https://a.test/' })],
      captureGap: false, gapReason: null, stepsTruncated: false,
    });
  });

  it('contract: the result is a view of the SAME safe projection as the trail: no raw reasoning, no raw action, the safe page URL, the last eight', async () => {
    // This is the deliberate privacy correction to the result shape: before,
    // lastActions carried the raw `action` phrase and `reasoning`, which is
    // where a value the policy omitted from the record could still reach the
    // model's result bytes.
    const actions = Array.from({ length: 12 }, (_, i) => ({
      type: i % 3 === 0 ? 'goto' : 'act',
      ...(i % 3 === 0 ? { url: `https://a.test/p/${i}` } : { action: `step ${i}` }),
      reasoning: `why ${i}`,
      pageUrl: `https://a.test/p/${i}?q=1`,
    }));
    mockExecute.mockResolvedValue({ success: true, completed: true, message: 'done', actions });

    const r = await runStagehandTask(base);

    const result = r.result as { success: boolean; completed: boolean; message: string; steps: number; lastActions: Array<Record<string, unknown>> };
    expect(result).toMatchObject({ success: true, completed: true, message: 'done', steps: 12 });
    expect(result.lastActions).toHaveLength(8);
    expect(result.lastActions).toEqual(r.trail.steps.slice(-8).map((s) => ({ type: s.type, action: s.action, pageUrl: s.pageUrl })));
    expect(JSON.stringify(result)).not.toContain('reasoning');
    expect(JSON.stringify(result)).not.toContain('why ');
    expect(r.trail.steps).toHaveLength(12);
    expect(r.trail.steps.map((s) => s.type)).toEqual(actions.map((a) => a.type));
    // Projected: the goto keeps its destination, the act its phrase, every
    // step its SAFE page (the query survives), and no reasoning anywhere.
    expect(r.trail.steps[0]).toMatchObject({ type: 'goto', action: 'https://a.test/p/0', pageUrl: 'https://a.test/p/0?q=1' });
    expect(r.trail.steps[1]).toMatchObject({ type: 'act', action: 'step 1', pageUrl: 'https://a.test/p/1?q=1' });
    expect(JSON.stringify(r.trail)).not.toContain('why ');
  });
});

/** The projection, per tool. What the record keeps of a step depends on the
 *  tool, because Stagehand spreads each tool's own arguments into the action. */
describe('what the trail keeps of each step', () => {
  async function trailFor(actions: Array<Record<string, unknown>>) {
    mockExecute.mockResolvedValue({ success: true, completed: true, message: 'ok', actions });
    return (await runStagehandTask(base)).trail;
  }

  it('act: by shape from playwrightArguments — a protected value is omitted with its class, and never reaches the trail, the result or the message', async () => {
    mockExecute.mockResolvedValue({
      success: true, completed: true, message: 'typed hunter2 and signed in',
      actions: [{
        type: 'act',
        action: 'type hunter2 into the password field',
        reasoning: 'the form needs it',
        pageUrl: 'https://a.test/login?next=/home',
        playwrightArguments: { method: 'fill', description: 'the password field', arguments: ['hunter2'], selector: 'xpath=//input' },
      }],
    });
    const r = await runStagehandTask(base);
    expect(r.trail.steps).toEqual([expect.objectContaining({
      type: 'act', action: 'fill \u00b7 the password field \u00b7 (authentication value not recorded)',
      pageUrl: 'https://a.test/login?next=/home', protectedDataOmitted: true, protectedKind: 'authentication',
    })]);
    expect(r.trail.message).toBe('typed [redacted] and signed in');
    expect((r.result as { message: string }).message).toBe('typed [redacted] and signed in');
    expect(r.data).toBe('typed [redacted] and signed in');
    expect(JSON.stringify(r)).not.toContain('reasoning');
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('act: an ordinary value on an ordinary page is kept beside its action', async () => {
    const trail = await trailFor([{
      type: 'act', action: 'type browser into the search box', pageUrl: 'https://a.test/issues',
      playwrightArguments: { method: 'fill', description: 'the search box', arguments: ['browser'], selector: 'xpath=//input' },
    }]);
    expect(trail.steps[0]).toMatchObject({ action: 'fill \u00b7 the search box \u00b7 "browser"', protectedDataOmitted: false });
  });

  it('act: a failed act (no playwrightArguments) keeps the phrase; a literal the policy named earlier is removed from it', async () => {
    const trail = await trailFor([
      {
        type: 'act', action: 'x', pageUrl: 'https://a.test/account',
        playwrightArguments: { method: 'fill', description: 'the password field', arguments: ['hunter2'] },
      },
      { type: 'act', action: 'type "hunter2" into the password field', reasoning: 'the form needs it', pageUrl: 'https://a.test/account' },
    ]);
    expect(trail.steps[1]).toMatchObject({ type: 'act', action: 'type "[redacted]" into the password field', pageUrl: 'https://a.test/account', protectedDataOmitted: true });
    expect(JSON.stringify(trail)).not.toContain('hunter2');
  });

  it('fillForm: each field action with its value; on a sign-in page every value is omitted', async () => {
    const ordinary = await trailFor([{
      type: 'fillForm', pageUrl: 'https://a.test/new-issue',
      fields: [
        { action: 'fill the title field', value: 'Search misses archived issues' },
        { action: 'fill the labels field', value: 'bug' },
      ],
    }]);
    expect(ordinary.steps[0]).toMatchObject({
      type: 'fillForm', action: 'fill the title field "Search misses archived issues"; fill the labels field "bug"', pageUrl: 'https://a.test/new-issue',
    });
    const signin = await trailFor([{
      type: 'fillForm', pageUrl: 'https://a.test/signup',
      fields: [
        { action: 'fill the email field', value: 'jane@example.com' },
        { action: 'fill the password field', value: 'hunter2' },
      ],
    }]);
    expect(signin.steps[0]).toMatchObject({
      type: 'fillForm', action: 'fill the email field (authentication value not recorded); fill the password field (authentication value not recorded)',
      protectedDataOmitted: true, protectedKind: 'authentication',
    });
    expect(JSON.stringify(signin)).not.toMatch(/jane@example.com|hunter2/);
  });

  it('goto: the safe destination, its resource id and query kept', async () => {
    const trail = await trailFor([{ type: 'goto', url: 'https://a.test/orders/3f2a91b8c07d4e65/edit?tab=1#x', pageUrl: 'https://a.test/' }]);
    expect(trail.steps[0]).toMatchObject({ type: 'goto', action: 'https://a.test/orders/3f2a91b8c07d4e65/edit?tab=1#x', pageUrl: 'https://a.test/' });
  });

  it('extract: the bounded instruction', async () => {
    const trail = await trailFor([{ type: 'extract', instruction: 'x'.repeat(3000), schema: { type: 'object' }, pageUrl: 'https://a.test/' }]);
    expect(trail.steps[0].action).toHaveLength(2000);
    expect(trail.steps[0].actionTruncated).toBe(true);
    expect(JSON.stringify(trail)).not.toContain('schema');
  });

  it('scroll / wait / navback / screenshot / ariaTree / close: the operation and a short non-content status', async () => {
    const trail = await trailFor([
      { type: 'scroll', pixels: 400, direction: 'down' },
      { type: 'wait', timeMs: 1500 },
      { type: 'navback', reasoning: 'wrong page' },
      { type: 'screenshot' },
      { type: 'ariaTree' },
      { type: 'close', reasoning: 'done', success: true },
    ]);
    expect(trail.steps.map((s) => s.action)).toEqual(['scroll down', 'wait 1500ms', 'navback', 'screenshot', 'ariaTree', 'close']);
    expect(JSON.stringify(trail)).not.toContain('wrong page');
  });

  it('an unknown future tool: the bounded type and an empty action', async () => {
    const trail = await trailFor([{ type: 'upload' + 'x'.repeat(100), path: '/tmp/secret.pdf', pageUrl: 'https://a.test/' }]);
    expect(trail.steps[0].type).toHaveLength(64);
    expect(trail.steps[0].action).toBe('');
    expect(JSON.stringify(trail)).not.toContain('secret.pdf');
  });

  it('keeps every step, not just the tail the model sees', async () => {
    const r = await (async () => {
      mockExecute.mockResolvedValue({
        success: true, completed: true, message: 'ok',
        actions: Array.from({ length: 20 }, (_, i) => ({ type: 'act', action: `step ${i}` })),
      });
      return runStagehandTask(base);
    })();
    expect((r.result as { lastActions: unknown[] }).lastActions).toHaveLength(8);
    expect(r.trail.steps).toHaveLength(20);
    expect(r.trail.steps[0].action).toBe('step 0');
  });

  it('reports a job the agent did not finish as incomplete, with the tail of what it did', async () => {
    mockExecute.mockResolvedValue({
      success: false,
      completed: false,
      message: 'Reached the step limit before the confirmation appeared',
      actions: Array.from({ length: 20 }, (_, i) => ({ type: 'act', action: `step ${i}`, reasoning: 'r' })),
    });
    const r = await runStagehandTask(base);
    expect(r.status).toBe('incomplete');
    const result = r.result as { steps: number; lastActions: Array<{ action: string }> };
    expect(result.steps).toBe(20);
    expect(result.lastActions).toHaveLength(8);
    expect(result.lastActions[7].action).toBe('step 19');
  });
});

describe('the model and the credential follow the run', () => {
  it('the model name is the resolution\'s provider and tier-medium id for two different selections, never a constant', async () => {
    await runStagehandTask({ ...base, modelSelection: { provider: 'anthropic', model: 'claude-x' } });
    await runStagehandTask({ ...base, modelSelection: { provider: 'openai' } });
    expect(mockResolveForTier).toHaveBeenNthCalledWith(1, { provider: 'anthropic', model: 'claude-x' }, 'medium');
    expect(mockResolveForTier).toHaveBeenNthCalledWith(2, { provider: 'openai' }, 'medium');
    expect(factoryCalls.map((f) => [f.provider, f.modelId])).toEqual([['anthropic', 'claude-x'], ['openai', 'openai-medium']]);
    expect(posted.map((p) => p.model)).toEqual([]);
    // The AI SDK model, never Stagehand's modelName string.
    const opts = mockStagehandCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.modelName).toBeUndefined();
    expect(opts.modelClientOptions).toBeUndefined();
    expect(opts.llmClient).toBeDefined();
  });

  // The defect this pins: the client initializes on its first COMPLETION, and
  // this path resolves a model without making one. A task from a platform
  // assistant carries no provider of its own, so it would resolve the platform
  // default against an empty provider map on every instance that had served no
  // other model call, and every browser task on the pane would come back
  // "Browser task stopped" with nothing done.
  it('initializes the client before resolving, so the platform default is readable', async () => {
    const order: string[] = [];
    mockLlmInit.mockImplementation(async () => { order.push('init'); });
    mockResolveForTier.mockImplementation(() => { order.push('resolve'); return { provider: 'anthropic', modelId: 'claude-x' }; });
    await runStagehandTask({ ...base });
    expect(order).toEqual(['init', 'resolve']);
  });

  // The pane is a browser a person is watching. Asked for a video's address,
  // the tail could open view-source: and go back through about:blank, showing
  // them a blank window and spending its steps there.
  it('tells the tail to stay on http and https, with the task still verbatim', async () => {
    await runStagehandTask({ ...base, prompt: 'Find the address of the video' });
    const instruction = (mockExecute.mock.calls[0][0] as { instruction: string }).instruction;
    expect(instruction).toContain('Find the address of the video');
    expect(instruction).toContain('http and https');
    expect(instruction).toContain('view-source:');
  });

  it('a client that cannot resolve a model stops the task with a sentence that says what to do', async () => {
    mockResolveForTier.mockImplementation(() => { throw new Error('No LLM providers available'); });
    const out = await runStagehandTask({ ...base });
    const message = (out.result as { message: string }).message;
    expect(message).toContain('could not start');
    expect(message).toContain('nothing was done in the browser');
    expect(message).not.toBe('Browser task stopped');
    expect(out.reason).toBe('unavailable');
  });

  it('an Anthropic selection builds an Anthropic model with the Anthropic credential', async () => {
    await runStagehandTask({ ...base, modelSelection: { provider: 'anthropic' } });
    expect(factoryCalls).toEqual([expect.objectContaining({ provider: 'anthropic', options: expect.objectContaining({ apiKey: 'anthropic-key' }) })]);
  });

  it('an xai selection builds an xAI model with the xAI credential, and no Anthropic credential appears in it', async () => {
    const r = await runStagehandTask({ ...base, modelSelection: { provider: 'xai' } });
    expect(r.status).toBe('finished');
    expect(factoryCalls).toEqual([expect.objectContaining({ provider: 'xai', options: expect.objectContaining({ apiKey: 'xai-key' }) })]);
    expect(JSON.stringify(factoryCalls[0].options)).not.toContain('anthropic-key');
  });

  it('an openai selection builds an OpenAI model with the OpenAI credential', async () => {
    await runStagehandTask({ ...base, modelSelection: { provider: 'openai' } });
    expect(factoryCalls).toEqual([expect.objectContaining({ provider: 'openai', options: expect.objectContaining({ apiKey: 'openai-key' }) })]);
    expect(JSON.stringify(factoryCalls[0].options)).not.toContain('anthropic-key');
  });

  it('a Google selection is unavailable until the Vertex factory exists, and sends nothing with an Anthropic credential', async () => {
    const r = await runStagehandTask({ ...base, modelSelection: { provider: 'google' } });
    expect(r).toMatchObject({ status: 'incomplete', reason: 'unavailable' });
    expect(factoryCalls).toEqual([]);
    expect(mockStagehandCtor).not.toHaveBeenCalled();
  });

  it('an anthropic selection keeps its pinned model id and uses the Anthropic credential', async () => {
    // This used to assert a collapse: an 'anthropic-vertex' selection was
    // rewritten to 'anthropic' here, because Vertex served the same vendor on
    // the same model ids. That provider is retired and a selection can no
    // longer name it — the resolver translates a stored value long before it
    // reaches this function — so what is left to hold is the property that
    // survived: a pinned model id reaches the factory unchanged, with that
    // provider's own key.
    const r = await runStagehandTask({ ...base, modelSelection: { provider: 'anthropic', model: 'claude-sonnet-4-6' } });
    expect(r.status).toBe('finished');
    expect(mockResolveForTier).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, 'medium');
    expect(factoryCalls).toEqual([expect.objectContaining({ provider: 'anthropic', modelId: 'claude-sonnet-4-6', options: expect.objectContaining({ apiKey: 'anthropic-key' }) })]);
    // And without a pinned model, the tier-medium id.
    await runStagehandTask({ ...base, modelSelection: { provider: 'anthropic' } });
    expect(mockResolveForTier).toHaveBeenLastCalledWith({ provider: 'anthropic' }, 'medium');
  });

  it('a provider with no managed secret and no BYOK session is unavailable rather than served with another provider\'s key', async () => {
    mockResolveForTier.mockReturnValue({ provider: 'openai', modelId: 'gpt-x' });
    delete MANAGED.OPENAI_API_KEY;
    try {
      const r = await runStagehandTask({ ...base, modelSelection: { provider: 'openai' } });
      expect(r).toMatchObject({ status: 'incomplete', reason: 'unavailable' });
      expect(factoryCalls).toEqual([]);
    } finally {
      MANAGED.OPENAI_API_KEY = 'openai-key';
    }
  });
});

describe('where the agent loop\'s own tokens are billed', () => {
  it('routes through the BYOK gateway for the run\'s OWN provider when the run has one, and records nothing itself', async () => {
    // The gateway writes the usage row per request; recording here too
    // would double count.
    mockOpenByokSession.mockResolvedValue({ token: 'gw-token', baseUrl: 'https://gw.example' });
    agentOfSteps(2);
    await runStagehandTask({ ...base, invocationId: 'inv-1', runtimeAgentId: 'agent-1', modelSelection: { provider: 'xai' } });
    expect(mockOpenByokSession).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', invocationId: 'inv-1', runtimeAgentId: 'agent-1', resolvedProvider: 'xai', resolvedModelId: 'xai-medium',
    }));
    expect(factoryCalls[0]).toMatchObject({ provider: 'xai', options: expect.objectContaining({ apiKey: 'gw-token', baseURL: 'https://gw.example' }) });
    expect(doGenerateCalls).toEqual(['xai', 'xai']);
    expect(posted).toEqual([]);
  });

  it('managed path: one record per doGenerate — a two-step fixture produces two rows, acknowledged before the response is used', async () => {
    replies.push({ promptTokens: 120, completionTokens: 7 }, { promptTokens: 250, completionTokens: 9 });
    agentOfSteps(2);
    const r = await runStagehandTask({ ...base, invocationId: 'inv-1', runtimeAgentId: 'agent-1', modelSelection: { provider: 'openai' } });
    expect(r.status).toBe('finished');
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({ provider: 'openai', model: 'openai-medium', inputTokens: 120, outputTokens: 7, tenantId: 't1', invocationId: 'inv-1', agentId: 'internal-agent-1', attempts: 1, success: true });
    expect(posted[1]).toMatchObject({ inputTokens: 250, outputTokens: 9, success: true });
    expect(posted[0].callId).not.toBe(posted[1].callId);
  });

  it('managed path: a first attempt on a retryable status and the SDK\'s retry succeeding produce two rows with distinct callIds', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      replies.push(
        new APICallError({ message: 'overloaded', url: 'https://api.openai.test', requestBodyValues: {}, statusCode: 529, isRetryable: true }),
        { promptTokens: 40, completionTokens: 2 },
      );
      agentOfSteps(1);
      const run = runStagehandTask({ ...base, modelSelection: { provider: 'openai' } });
      // The SDK waits its backoff before the retry; the first row is already
      // posted by then.
      await jest.advanceTimersByTimeAsync(2_500);
      const r = await run;
      expect(r.status).toBe('finished');
      expect(doGenerateCalls).toEqual(['openai', 'openai']);
      expect(posted).toHaveLength(2);
      expect(posted[0]).toMatchObject({ success: false, inputTokens: 0, outputTokens: 0, error: expect.stringContaining('overloaded') });
      expect(posted[1]).toMatchObject({ success: true, inputTokens: 40, outputTokens: 2 });
      expect(posted[0].callId).not.toBe(posted[1].callId);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a request that throws still records its attempt, and the task surfaces the failure', async () => {
    replies.push(new Error('connection reset'));
    agentOfSteps(1);
    await expect(runStagehandTask({ ...base, modelSelection: { provider: 'anthropic' } })).rejects.toThrow('connection reset');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ provider: 'anthropic', success: false, inputTokens: 0, outputTokens: 0, error: 'connection reset' });
    expect(mockClose).toHaveBeenCalled();
  });

  it('a thrown execution leaves the rows already written and no further ones', async () => {
    mockExecute.mockImplementation(async () => {
      await generateText({ model: handedModel!, prompt: 'step 0' });
      throw new Error('element not found');
    });
    await expect(runStagehandTask({ ...base, modelSelection: { provider: 'anthropic' } })).rejects.toThrow('element not found');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ success: true });
  });

  it('a timeout leaves the rows already written and no further ones, and closes the session', async () => {
    let release: () => void = () => undefined;
    mockExecute.mockImplementation(async () => {
      await generateText({ model: handedModel!, prompt: 'step 0' });
      await new Promise<void>((r) => { release = r; });
      await generateText({ model: handedModel!, prompt: 'step 1' });
      return { success: true, completed: true, message: 'late', actions: [] };
    });
    const r = await runStagehandTask({ ...base, modelSelection: { provider: 'anthropic' }, clock: { deadlineAt: Date.now() + 50 } });
    expect(r).toMatchObject({ status: 'incomplete', reason: 'timeout' });
    expect(mockClose).toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    release();
    await new Promise((res) => setTimeout(res, 20));
    // The raced execution's later call is after close: it is not a further
    // row of this task's outcome, which already returned.
    expect(r.reason).toBe('timeout');
  });

  it('a usage post that fails after its retries stops the task with reason usage_unrecorded', async () => {
    acknowledge = false;
    agentOfSteps(1);
    const r = await runStagehandTask({ ...base, modelSelection: { provider: 'anthropic' } });
    expect(r).toMatchObject({ status: 'incomplete', reason: 'usage_unrecorded' });
    expect(posted).toHaveLength(1);
    expect(mockClose).toHaveBeenCalled();
  });

  it('falls back to the managed key when there is no invocation to attribute to', async () => {
    await runStagehandTask({ ...base, modelSelection: { provider: 'anthropic' } });
    expect(factoryCalls[0].options).toMatchObject({ apiKey: 'anthropic-key' });
    expect(mockOpenByokSession).not.toHaveBeenCalled();
  });

  it('falls back rather than failing the click when routing throws', async () => {
    // A control-plane problem must not stop a person's click; the cost of
    // getting it wrong is one call.
    mockOpenByokSession.mockRejectedValue(new Error('control plane down'));
    const r = await runStagehandTask({ ...base, invocationId: 'inv-1', modelSelection: { provider: 'anthropic' } });
    expect(r.status).toBe('finished');
    expect(factoryCalls[0].options).toMatchObject({ apiKey: 'anthropic-key' });
  });
});

describe('it never takes down the pane', () => {
  it('detaches after a successful task', async () => {
    // close() detaches the CDP client; verified against a live Browser Use
    // browser, which stays `active` afterwards.
    await runStagehandTask(base);
    expect(mockClose).toHaveBeenCalled();
  });

  it('detaches after a failed one, and surfaces the failure', async () => {
    mockExecute.mockRejectedValue(new Error('element not found'));
    await expect(runStagehandTask(base)).rejects.toThrow('element not found');
    expect(mockClose).toHaveBeenCalled();
  });

  it('does not let a close failure mask the result', async () => {
    mockClose.mockRejectedValue(new Error('socket already gone'));
    await expect(runStagehandTask(base)).resolves.toMatchObject({ status: 'finished' });
  });
});
