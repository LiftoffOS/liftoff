/**
 * run_browser_task / read_active_browser_session handlers.
 *
 * Verifies:
 *  - the takeover gate blocks run_browser_task when the thread's session is
 *    under user control
 *  - an Anchor "session gone" (404 / "session not found") during the in-flight
 *    task is classified as `session_expired_idle` (not a generic failure)
 *  - run_browser_task with no session + no human context refuses to spawn
 */

class FakeAnchorError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message); this.name = 'AnchorError';
  }
}

const mockRunAgentTask = jest.fn();
const mockGetActivePage = jest.fn();
const mockCreateAnchorSession = jest.fn();
// Browser Use runs its own in-session agent, so the vendor proxy can dispatch
// here. Mocked separately from Anchor's so a test can prove WHICH client got
// the task rather than only that some client did.
const mockBrowserUseRunAgentTask = jest.fn();
const mockBrowserUseGetActivePage = jest.fn();
const mockCreateBrowserUseSession = jest.fn();

jest.mock('../../integrations/web-fetch/anchor-client', () => ({
  AnchorClient: jest.fn().mockImplementation(() => ({
    runAgentTask: mockRunAgentTask,
    getActivePage: mockGetActivePage,
    fetchScreenshotPng: jest.fn(),
  })),
  AnchorError: FakeAnchorError,
  createAnchorSessionForThread: (...a: unknown[]) => mockCreateAnchorSession(...a),
}));

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
  getPoolForService: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));

// The downloads body is covered on its own (browser-sessions/downloads.test.ts);
// here it is a seam, so these tests are about what the TOOL does with what it
// answers.
const mockListDownloadsForSession = jest.fn();
const mockFetchFileForSession = jest.fn();
jest.mock('../../browser-sessions/downloads', () => ({
  ...jest.requireActual('../../browser-sessions/downloads'),
  listDownloadsForSession: (...a: unknown[]) => mockListDownloadsForSession(...a),
  fetchFileForSession: (...a: unknown[]) => mockFetchFileForSession(...a),
}));
const mockUploadGeneratedFile = jest.fn();
jest.mock('../../clients/generated-files-client', () => ({
  uploadGeneratedFile: (...a: unknown[]) => mockUploadGeneratedFile(...a),
}));
jest.mock('../../integrations/web-fetch/browser-use-client', () => ({
  BrowserUseClient: jest.fn().mockImplementation(() => ({
    runAgentTask: mockBrowserUseRunAgentTask,
    getActivePage: mockBrowserUseGetActivePage,
    fetchScreenshotPng: jest.fn(),
  })),
  // The classifier's instanceof needs the real class to exist in the mock.
  PlatformBrowserUnavailable: class PlatformBrowserUnavailable extends Error { retryable = false; },
  createBrowserUseSessionForThread: (...a: unknown[]) => mockCreateBrowserUseSession(...a),
}));
jest.mock('../../integrations/web-fetch/browserbase-client', () => ({
  BrowserbaseClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../integrations/web-fetch/webclaw-client', () => ({ WebClawClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../integrations/web-fetch/firecrawl-client', () => ({ FirecrawlClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../integrations/web-fetch/perplexity-client', () => ({ PerplexityClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../integrations/web-fetch/router', () => ({
  WebFetchRouter: jest.fn().mockImplementation(() => ({})),
  admitSingleVendor: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../usage-ledger/service', () => ({ usageLedgerService: { recordUsage: jest.fn() } }));
jest.mock('../../memory/service', () => ({ memoryService: {} }));
jest.mock('../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn() }));
jest.mock('../../browser-sessions/screenshot-storage', () => ({ uploadScreenshotAndSign: jest.fn() }));

const mockGetActiveForThread = jest.fn();
const mockGetActiveForCallerSession = jest.fn();
const mockEndTakeover = jest.fn();
const mockGetActiveForInvocation = jest.fn();
jest.mock('../../browser-sessions/repository', () => ({
  getActiveForThread: (...a: unknown[]) => mockGetActiveForThread(...a),
  getActiveForInvocation: (...a: unknown[]) => mockGetActiveForInvocation(...a),
  getActiveForCallerSession: (...a: unknown[]) => mockGetActiveForCallerSession(...a),
  endTakeover: (...a: unknown[]) => mockEndTakeover(...a),
}));
jest.mock('../../browser-sessions/current-url', () => ({ persistCurrentUrl: jest.fn() }));

// The ONE recorder (423) and the call-scoped observation. The capture is a
// seam: what it observed is what a test says it observed, and attach never
// touches a browser here.
const mockRecordBrowserActivity = jest.fn(async (input: { id: string }) => input.id);
jest.mock('../../browser-sessions/activity-repository', () => ({
  ...jest.requireActual('../../browser-sessions/activity-repository'),
  recordBrowserActivity: (...a: unknown[]) => mockRecordBrowserActivity(...(a as [{ id: string }])),
}));
const mockListHoldsOverlapping = jest.fn(async () => []);
jest.mock('../../browser-sessions/takeover-capture/repository', () => ({
  listHoldsOverlapping: (...a: unknown[]) => mockListHoldsOverlapping(...(a as [])),
}));
const captureState: { actions: Array<{ row: Record<string, unknown>; at: Date }>; gap: string | null; attachCalls: number } = {
  actions: [], gap: null, attachCalls: 0,
};
jest.mock('../../browser-sessions/takeover-capture', () => ({
  ...jest.requireActual('../../browser-sessions/takeover-capture'),
  TaskCapture: {
    attach: async () => {
      captureState.attachCalls++;
      const startedAt = new Date(Date.now() - 1000);
      return {
        startedAt,
        finish: async () => ({
          actions: captureState.actions, captureGap: captureState.gap !== null, gapReason: captureState.gap,
          stepsTruncated: false, startedAt, endedAt: new Date(),
        }),
      };
    },
  },
}));
const mockNavigateAndRecord = jest.fn();
jest.mock('../../browser-sessions/navigate-and-record', () => ({
  navigateAndRecord: (...a: unknown[]) => mockNavigateAndRecord(...a),
}));
// The run-owned spawn is the proxy's; everything else in the proxy stays real
// so the dispatch assertions above keep testing the vendor routing.
const mockCreateSessionForRun = jest.fn();
jest.mock('../../browser-sessions/session-vendor-proxy', () => ({
  ...jest.requireActual('../../browser-sessions/session-vendor-proxy'),
  createSessionForRun: (...a: unknown[]) => mockCreateSessionForRun(...a),
}));

import { executeStandardTool, runBrowserTaskCore, _BROWSER_TOOL_RECORDING, PROTECTED_PROMPT_REFUSAL, browserWorkRecord } from '../standard-tool-handler';
import { STANDARD_TOOLS } from '../standard-tools';
import { RECORDED_BROWSER_TOOLS } from '../../browser-sessions/activity-repository';
import { NO_AGENT_SENTINEL } from '../../browser-sessions/types';

const ctx = {
  tenantId: 'tenant-1', agentId: 'agent-1',
  memoryScope: { writableLayers: ['individual'], readableLayers: ['individual'] },
  threadId: 'thread-1',
  messageSenderAccountId: 'acc-1',
};

// `vendor` is NOT NULL in web_sessions, so a real row always carries one. The
// fixture omitted it, which stopped mattering only because every session used
// to be Anchor's.
const liveSession = {
  id: 'sid', tenantId: 'tenant-1', vendorSessionId: 'vsid', vendor: 'anchor',
  callerSessionId: 'ui:abc', takeoverState: 'none',
};

beforeEach(() => {
  jest.clearAllMocks();
  captureState.actions = [];
  captureState.gap = null;
  captureState.attachCalls = 0;
  mockRecordBrowserActivity.mockImplementation(async (input: { id: string }) => input.id);
  mockListHoldsOverlapping.mockResolvedValue([]);
});

describe('run_browser_task', () => {
  it('blocks when the thread session is under user takeover', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(liveSession);
    mockGetActiveForCallerSession.mockResolvedValueOnce({
      ...liveSession, takeoverState: 'taken_over', takenOverAt: new Date(),
    });
    const result = await executeStandardTool('run_browser_task', { prompt: 'do a thing' }, ctx as never);
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toMatch(/holds the wheel/i);
    expect(mockRunAgentTask).not.toHaveBeenCalled();
  });

  // The agent is the DEFAULT driver, not a guest. A human who wandered off must
  // never outrank it, and nothing else is guaranteed to be watching: an
  // autonomous run can be the only thing awake.
  it('takes the browser back when the takeover has gone stale', async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    mockGetActiveForCallerSession.mockResolvedValue({
      ...liveSession,
      takeoverState: 'taken_over',
      takenOverAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    mockRunAgentTask.mockResolvedValueOnce({ result: 'done' });

    const result = await executeStandardTool('run_browser_task', { prompt: 'do a thing' }, ctx as never);

    expect(String(result!.error ?? '')).not.toMatch(/taken over/i);
    expect(mockRunAgentTask).toHaveBeenCalled();
    // Cleared, not merely ignored, so the UI agrees with the decision made here.
    // The hold ends with the state, as `expired`, in the repository's one
    // transaction.
    expect(mockEndTakeover).toHaveBeenCalledWith('sid', 'expired');
  });

  it('keeps blocking while the takeover is being refreshed by a live driver', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(liveSession);
    mockGetActiveForCallerSession.mockResolvedValueOnce({
      ...liveSession,
      takeoverState: 'taken_over',
      takenOverAt: new Date(Date.now() - 30 * 1000),
    });
    const result = await executeStandardTool('run_browser_task', { prompt: 'do a thing' }, ctx as never);
    expect(result!.success).toBe(false);
    expect(mockEndTakeover).not.toHaveBeenCalled();
  });

  it('classifies an Anchor "session gone" mid-task as session_expired_idle', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(liveSession);
    mockGetActiveForCallerSession.mockResolvedValueOnce(null); // not taken over
    mockRunAgentTask.mockRejectedValueOnce(new FakeAnchorError('session not found', 404));
    const result = await executeStandardTool('run_browser_task', { prompt: 'do a thing' }, ctx as never);
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toMatch(/session_expired_idle/);
  });

  it('runs the task and reports success when the session is healthy', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(liveSession);
    mockGetActiveForCallerSession.mockResolvedValueOnce(null);
    mockRunAgentTask.mockResolvedValueOnce({ status: 'completed', result: 'done' });
    mockGetActivePage.mockResolvedValueOnce({ url: 'https://x.com', status: 'ok' });
    const result = await executeStandardTool('run_browser_task', { prompt: 'do a thing' }, ctx as never);
    expect(result!.success).toBe(true);
    // The task's own model calls are billed to the team: the agent id rides
    // along so the loop's tokens are attributed rather than falling to the
    // managed key with no usage row.
    expect(mockRunAgentTask).toHaveBeenCalledWith('vsid', 'tenant-1', 'do a thing', { runtimeAgentId: 'agent-1', background: true });
  });

  it('refuses to spawn a session when there is no session and no human context', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(null);
    const result = await executeStandardTool(
      'run_browser_task', { prompt: 'do a thing' },
      { ...ctx, messageSenderAccountId: undefined } as never,
    );
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toMatch(/no active browser session/i);
    expect(mockCreateAnchorSession).not.toHaveBeenCalled();
  });

  it('runs the task on a non-anchor session instead of refusing it', async () => {
    // This refused for as long as the code believed only Anchor had an
    // in-session agent. Browser Use runs one too (POST /tasks against an
    // existing sessionId), and the refusal was the whole reason a Browser Use
    // thread could never be driven the way an Anchor thread was: the agent was
    // told its own browser did not support the tool.
    mockGetActiveForThread.mockResolvedValue({ ...liveSession, vendor: 'browser_use' });
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({ status: 'finished', result: 'done' });
    const result = await executeStandardTool('run_browser_task', { prompt: 'do a thing' }, ctx as never);
    expect(result!.success).toBe(true);
    // The session's OWN vendor ran it. Asserting only that "a task ran" would
    // pass if the proxy sent a Browser Use session to the Anchor client, which
    // is a 404 against a session that vendor has never heard of.
    expect(mockBrowserUseRunAgentTask).toHaveBeenCalledWith('vsid', 'tenant-1', 'do a thing', { runtimeAgentId: 'agent-1', background: true });
    expect(mockRunAgentTask).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt', async () => {
    const result = await executeStandardTool('run_browser_task', { prompt: '   ' }, ctx as never);
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toMatch(/prompt is required/i);
  });
});

/** One action the task capture observed, as the mocked capture hands it
 *  back. */
const observed = (kind: string, over: Record<string, unknown> = {}) => ({
  row: {
    nonce: 'n', seq: 0, kind, url: 'https://a.example/issues?q=browser', urlTruncated: false, urlProtectedDataOmitted: false,
    tag: 'input', role: 'textbox', name: 'Search all issues', nameTruncated: false, nameProtectedDataOmitted: false, inputType: 'text',
    value: null, valueTruncated: false, valueDisposition: 'none', detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
    ...over,
  },
  at: new Date(),
});

/** The transport contract for the loop's trail: it rides BESIDE the vendor
 *  result through the core, and the vendor result the tool caller and the RPC
 *  serialise is byte-identical to what it was before the trail existed. */
describe('runBrowserTaskCore — the trail beside the legacy result', () => {
  const legacy = {
    status: 'finished',
    result: { success: true, completed: true, message: 'done', steps: 2, lastActions: [{ type: 'act', action: 'click', reasoning: 'r' }] },
    data: 'done',
  };
  const trail = { message: 'done', steps: [
    { type: 'goto', action: 'https://a.test/', pageUrl: '' },
    { type: 'act', action: 'click', pageUrl: 'https://a.test/' },
  ] };

  it('pins the exact legacy bytes for a Stagehand-backed vendor and returns every projected step separately', async () => {
    mockGetActiveForThread.mockResolvedValue({ ...liveSession, vendor: 'browser_use' });
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({ ...legacy, trail });
    // The observer saw both of the loop's DOM actions, so the trail is
    // exact: the observed steps stand in for the native ones.
    captureState.actions = [
      observed('navigate', { url: 'https://a.test/', tag: null, role: null, name: null, inputType: null }),
      observed('click', { url: 'https://a.test/', tag: 'button', role: 'button', name: 'Go' }),
    ];

    const outcome = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'do a thing', ownerAccountId: 'acc-1', agentId: 'agent-1',
    });

    expect(outcome.success).toBe(true);
    // Exactly the vendor object: no `trail` key inside, nothing reshaped.
    expect(JSON.stringify(outcome.result)).toBe(JSON.stringify(legacy));
    expect(outcome.trail).toMatchObject({ message: 'done', captureGap: false, gapReason: null, stepsTruncated: false });
    expect(outcome.trail!.steps.map((s) => [s.type, s.action])).toEqual([
      ['navigate', 'opened https://a.test/'],
      ['click', 'clicked button "Go"'],
    ]);
  });

  it('a loop that reports DOM actions of which the observer saw nothing fails closed as a gap, keeping the native fallback', async () => {
    mockGetActiveForThread.mockResolvedValue({ ...liveSession, vendor: 'browser_use' });
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({ ...legacy, trail });

    const outcome = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'do a thing', ownerAccountId: 'acc-1', agentId: 'agent-1',
    });

    expect(outcome.trail).toEqual({ ...trail, captureGap: true, gapReason: 'reconciliation_uncertain', stepsTruncated: false });
  });

  it("pins the exact legacy bytes for Anchor's shape; its trail is the call-scoped observation, never parsed from the result", async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    const anchor = { status: 'completed', result: { answer: 'x' }, data: { steps: 3 } };
    mockRunAgentTask.mockResolvedValueOnce(anchor);

    const outcome = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'do a thing', ownerAccountId: 'acc-1', agentId: 'agent-1',
    });

    expect(JSON.stringify(outcome.result)).toBe(JSON.stringify(anchor));
    // Anchor reports no steps; the observation stands in, with nothing seen
    // and no known gap it is a present-but-empty trail.
    expect(outcome.trail).toEqual({ message: '', steps: [], captureGap: false, gapReason: null, stepsTruncated: false });
  });

  it('the tool caller sees only result, never the trail', async () => {
    mockGetActiveForThread.mockResolvedValue({ ...liveSession, vendor: 'browser_use' });
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({ ...legacy, trail });
    const result = await executeStandardTool('run_browser_task', { prompt: 'do a thing' }, ctx as never);
    expect(JSON.stringify(result!.result)).toBe(JSON.stringify(legacy));
  });
});

/** The platform assistants — Liftoff, the Insights Manager, the Chief AI
 *  Officer — run outside this process and have no agent row anywhere, so they
 *  reach a browser through runBrowserTaskCore with no agent id at all.
 *
 *  These pin the properties that a SECOND implementation of browser-task logic
 *  would quietly drop. The takeover case is the one that matters most: a
 *  person who has taken the keyboard must stop a platform assistant exactly as
 *  they stop an agent, and an agent-keyed gate is the obvious thing to skip
 *  when the caller has no agent. */
describe('runBrowserTaskCore — a caller with no agent', () => {
  it('runs the task on an existing session without being given an agent id', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(liveSession);
    mockGetActiveForCallerSession.mockResolvedValueOnce(null);
    mockRunAgentTask.mockResolvedValueOnce({ status: 'completed', result: 'done' });
    mockGetActivePage.mockResolvedValueOnce({ url: 'https://x.com', status: 'ok' });

    const result = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'do a thing',
      ownerAccountId: 'acc-1',
    });

    expect(result.success).toBe(true);
    // No agent and no run: nothing to attribute the task's model calls to.
    // The core was called directly, declaring no way to collect a result, so
    // the task is run to the end rather than handed back.
    expect(mockRunAgentTask).toHaveBeenCalledWith('vsid', 'tenant-1', 'do a thing', {});
    // The session is handed back so the RPC can return it without re-reading.
    expect(result.session).toMatchObject({ id: 'sid' });
  });

  it('still applies the takeover gate, keyed on the no-agent sentinel', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(liveSession);
    mockGetActiveForCallerSession.mockResolvedValueOnce({
      id: 'sid', takeoverState: 'taken_over', takenOverAt: new Date(),
    });

    const result = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'do a thing',
      ownerAccountId: 'acc-1',
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/holds the wheel/i);
    // Keyed on the sentinel, not on undefined: the lookup filters `agent_id = $2`
    // against a NOT NULL column, so an undefined here would match no row and the
    // gate would silently pass.
    expect(mockGetActiveForCallerSession).toHaveBeenCalledWith(
      'tenant-1', NO_AGENT_SENTINEL, 'ui:abc',
    );
    expect(mockRunAgentTask).not.toHaveBeenCalled();
  });

  it('refuses to spawn with no human behind it, exactly as an agent is refused', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(null);

    const result = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'do a thing',
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/no active browser session/i);
    expect(mockCreateAnchorSession).not.toHaveBeenCalled();
  });

  it('rejects a blank prompt through the same validation the tool uses', async () => {
    const result = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', prompt: '   ',
      ownerAccountId: 'acc-1',
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/prompt is required/i);
  });
});

// ── A run with no thread owns a browser of its own ──────────────────────────
//
// A scheduled or delegated run has no thread and no person. It may open one
// session for its lifetime, keyed by the invocation, under the team's own
// profile — which is where the logins a person put in through the team's pane
// live. The same call on a thread with nobody on it still refuses.
describe('run_browser_task on a run with no thread', () => {
  const runCtx = {
    tenantId: 'tenant-1', agentId: 'agent-1',
    memoryScope: { writableLayers: ['individual'], readableLayers: ['individual'] },
    threadId: undefined,
    messageSenderAccountId: undefined,
    invocationId: '22222222-2222-4222-8222-222222222222',
  };

  it("opens the team's browser for the run when none is open, and runs the task in it", async () => {
    mockGetActiveForInvocation.mockResolvedValueOnce(null);
    const spawned = { ...liveSession, vendor: 'browser_use', threadId: null, invocationId: runCtx.invocationId };
    mockCreateSessionForRun.mockResolvedValueOnce(spawned);
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({ status: 'finished', result: 'done' });

    const result = await executeStandardTool('run_browser_task', { prompt: 'read the page' }, runCtx as never);

    expect(result!.success).toBe(true);
    expect(mockCreateSessionForRun).toHaveBeenCalledWith({
      tenantId: 'tenant-1', agentId: 'agent-1', invocationId: runCtx.invocationId, idleTimeoutMinutes: 10,
    });
    expect(mockGetActiveForThread).not.toHaveBeenCalled();
    // A run's task is attributed to the run and the team.
    expect(mockBrowserUseRunAgentTask).toHaveBeenCalledWith('vsid', 'tenant-1', 'read the page', {
      invocationId: runCtx.invocationId, runtimeAgentId: 'agent-1',
    });
  });

  it("reuses the run's open session on a later step", async () => {
    mockGetActiveForInvocation.mockResolvedValueOnce({ ...liveSession, vendor: 'browser_use', threadId: null });
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({ status: 'finished', result: 'ok' });
    const result = await executeStandardTool('run_browser_task', { prompt: 'next' }, runCtx as never);
    expect(result!.success).toBe(true);
    expect(mockCreateSessionForRun).not.toHaveBeenCalled();
  });

  it('a call from nowhere — no thread and no run — is refused', async () => {
    const result = await executeStandardTool(
      'run_browser_task', { prompt: 'x' },
      { ...runCtx, invocationId: undefined } as never,
    );
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toMatch(/thread or run context required/);
  });
});

// ── Recording: the ONE terminal path, every branch, exactly once ────────────

describe('runBrowserTaskCore records once, whatever happened', () => {
  const recorded = () => mockRecordBrowserActivity.mock.calls.map((c) => c[0] as Record<string, unknown>);

  it('a thread-scoped Stagehand task records one row under the caller\'s id with the trail\'s message and steps, and echoes the id', async () => {
    mockGetActiveForThread.mockResolvedValue({ ...liveSession, vendor: 'browser_use' });
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({
      status: 'finished', result: { message: 'Found 18' }, data: 'Found 18',
      trail: { message: 'Found 18', steps: [{ type: 'goto', action: 'https://a.example/', pageUrl: '' }], captureGap: false, gapReason: null, stepsTruncated: false },
    });
    captureState.actions = [observed('navigate', { url: 'https://a.example/', tag: null, role: null, name: null, inputType: null })];
    const outcome = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'count the pull requests', ownerAccountId: 'acc-1', activityId: 'act-1',
    });
    expect(outcome.activityId).toBe('act-1');
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]).toMatchObject({
      id: 'act-1', tenantId: 'tenant-1', threadId: 'thread-1', sessionId: 'sid', tool: 'run_browser_task',
      instruction: 'count the pull requests', outcome: 'Found 18', personTookOver: false, captureGap: false, stepsTruncated: false,
    });
    expect((recorded()[0].steps as unknown[]).length).toBe(1);
    expect(outcome.safeInstruction).toBe('count the pull requests');
  });

  it('a takeover refusal records person_took_over under the id, before any vendor call', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(liveSession);
    mockGetActiveForCallerSession.mockResolvedValueOnce({ ...liveSession, takeoverState: 'taken_over', takenOverAt: new Date() });
    const outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'do a thing', ownerAccountId: 'acc-1', activityId: 'act-2' });
    expect(outcome.success).toBe(false);
    expect(outcome.activityId).toBe('act-2');
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]).toMatchObject({ id: 'act-2', personTookOver: true, steps: null });
    expect(mockRunAgentTask).not.toHaveBeenCalled();
  });

  it("an Anchor-shaped task's steps are supplied by the call-scoped observation, and a human intervention marks person_took_over", async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    captureState.actions = [observed('navigate', { tag: null, role: null, name: null, inputType: null }), observed('change', { value: 'browser', valueDisposition: 'recorded' })];
    mockRunAgentTask.mockResolvedValueOnce({ status: 'human_intervention_requested', result: { answer: 'x' } });
    // The intervention poll is the mocked anchor client's; it has no such
    // method here, so the backstop logs and the success path records.
    const outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'find it', ownerAccountId: 'acc-1', activityId: 'act-3' });
    expect(outcome.success).toBe(true);
    expect(outcome.trail!.steps.map((s) => s.action)).toEqual([
      'opened https://a.example/issues?q=browser',
      'entered "browser" in textbox "Search all issues"',
    ]);
    expect(recorded()).toHaveLength(1);
    expect((recorded()[0].steps as Array<{ action: string }>).map((s) => s.action)).toEqual(outcome.trail!.steps.map((s) => s.action));
  });

  it('observed actions inside an overlapping takeover hold belong to the person and are left out of the trail', async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    const early = { ...observed('click'), at: new Date(Date.now() - 900) };
    const during = { ...observed('change', { value: 'mine', valueDisposition: 'recorded' }), at: new Date(Date.now() - 500) };
    captureState.actions = [early, during];
    mockListHoldsOverlapping.mockResolvedValueOnce([{ startedAt: new Date(Date.now() - 600), endedAt: null }]);
    mockRunAgentTask.mockResolvedValueOnce({ status: 'completed', result: 'done' });
    const outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'x', ownerAccountId: 'acc-1' });
    expect(outcome.trail!.steps).toHaveLength(1);
    expect(outcome.trail!.steps[0].type).toBe('click');
    expect(mockListHoldsOverlapping).toHaveBeenCalledWith('tenant-1', 'sid', expect.any(Date), expect.any(Date));
  });

  it('a capture gap and a reconciliation gap are carried into the trail and the row, never a silently complete trail', async () => {
    mockGetActiveForThread.mockResolvedValue({ ...liveSession, vendor: 'browser_use' });
    captureState.gap = 'frame_unavailable';
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({
      status: 'finished', result: {}, data: '',
      trail: { message: 'done', steps: [{ type: 'act', action: 'click · Go', pageUrl: '' }], captureGap: false, gapReason: null, stepsTruncated: false },
    });
    const outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'x', ownerAccountId: 'acc-1' });
    expect(outcome.trail).toMatchObject({ captureGap: true, gapReason: 'frame_unavailable' });
    expect(recorded()[0]).toMatchObject({ captureGap: true, gapReason: 'frame_unavailable' });
  });

  it('a vendor failure, an idle timeout and a classified error each record exactly once with the error as the outcome', async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    mockGetActiveForCallerSession.mockResolvedValue(null);
    mockRunAgentTask.mockRejectedValueOnce(new Error('vendor exploded'));
    let outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'x', ownerAccountId: 'acc-1', activityId: 'act-4' });
    expect(outcome.success).toBe(false);
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]).toMatchObject({ id: 'act-4', outcome: 'vendor exploded' });

    mockRunAgentTask.mockRejectedValueOnce(new FakeAnchorError('session not found', 404));
    outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'x', ownerAccountId: 'acc-1', activityId: 'act-5' });
    expect(String(outcome.error)).toMatch(/session_expired_idle/);
    expect(recorded()).toHaveLength(2);
    expect(recorded()[1]).toMatchObject({ id: 'act-5' });
    expect(String(recorded()[1].outcome)).toMatch(/session_expired_idle/);
  });

  it('a failed insert does not fail the task: the outcome stands and carries no id', async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    mockRecordBrowserActivity.mockResolvedValueOnce(null);
    mockRunAgentTask.mockResolvedValueOnce({ status: 'completed', result: 'done' });
    const outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'x', ownerAccountId: 'acc-1', activityId: 'act-6' });
    expect(outcome.success).toBe(true);
    expect(outcome.activityId).toBeUndefined();
  });

  it('a run-scoped task records nothing and attaches no observation', async () => {
    mockGetActiveForInvocation.mockResolvedValueOnce({ ...liveSession, vendor: 'browser_use', threadId: null });
    mockBrowserUseRunAgentTask.mockResolvedValueOnce({ status: 'finished', result: 'ok' });
    const outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: undefined, invocationId: '22222222-2222-4222-8222-222222222222', prompt: 'x', agentId: 'agent-1' });
    expect(outcome.success).toBe(true);
    expect(mockRecordBrowserActivity).not.toHaveBeenCalled();
    expect(captureState.attachCalls).toBe(0);
  });

  it('mints its own id when the caller has none, as the team\'s tool path does', async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    mockRunAgentTask.mockResolvedValueOnce({ status: 'completed', result: 'done' });
    const outcome = await runBrowserTaskCore({ tenantId: 'tenant-1', threadId: 'thread-1', prompt: 'x', ownerAccountId: 'acc-1' });
    expect(outcome.activityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded()[0].id).toBe(outcome.activityId);
  });
});

// ── The handler boundary: protected data never reaches the browser ─────────

describe('a task prompt that carries protected data', () => {
  it('is refused before any session lookup, activity write or vendor call, and only the sanitized instruction is retained', async () => {
    const outcome = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', ownerAccountId: 'acc-1',
      prompt: 'sign in with password=hunter2-synthetic and read the dashboard',
    });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe(PROTECTED_PROMPT_REFUSAL);
    expect(outcome.safeInstruction).toBe('sign in with password=[redacted] and read the dashboard');
    expect(outcome.instructionProtectedDataOmitted).toBe(true);
    expect(mockGetActiveForThread).not.toHaveBeenCalled();
    expect(mockRunAgentTask).not.toHaveBeenCalled();
    expect(mockRecordBrowserActivity).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain('hunter2-synthetic');
    // Nor the captured logs: the refusal is logged by event name, never by
    // payload.
     
    const { logger } = require('../../infrastructure/logging') as { logger: Record<string, jest.Mock> };
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls, logger.debug.mock.calls]);
    expect(logged).not.toContain('hunter2-synthetic');
    expect(logged).toContain('run_browser_task_refused_protected_prompt');
  });

  it('an ordinary business email in the prompt is dispatched unchanged', async () => {
    mockGetActiveForThread.mockResolvedValueOnce(liveSession);
    mockGetActiveForCallerSession.mockResolvedValueOnce(null);
    mockRunAgentTask.mockResolvedValueOnce({ status: 'completed', result: 'done' });
    const outcome = await runBrowserTaskCore({
      tenantId: 'tenant-1', threadId: 'thread-1', ownerAccountId: 'acc-1',
      prompt: 'email jane.doe@acme.example the Q3 report from the reports page',
    });
    expect(outcome.success).toBe(true);
    expect(mockRunAgentTask).toHaveBeenCalledWith('vsid', 'tenant-1', 'email jane.doe@acme.example the Q3 report from the reports page', {});
    expect(outcome.instructionProtectedDataOmitted).toBe(false);
  });
});

// ── Every thread-scoped browser tool is classified ──────────────────────────

describe('the browser tool allow-list', () => {
  const catalogBrowserTools = STANDARD_TOOLS
    .map((t) => t.name)
    .filter((n) => /browser/.test(n) && !/^browser_/.test(n) && !/^web_/.test(n));

  it('every browser tool in the catalog is recorded work, an operational probe, or the session start, and nothing else', () => {
    expect(catalogBrowserTools.sort()).toEqual(Object.keys(_BROWSER_TOOL_RECORDING).sort());
    for (const name of Object.keys(_BROWSER_TOOL_RECORDING)) {
      expect(['work', 'probe', 'start']).toContain(_BROWSER_TOOL_RECORDING[name as keyof typeof _BROWSER_TOOL_RECORDING]);
    }
    // The repository's own list of recorded tools is the `work` set exactly,
    // plus the runtime's own saved-login fill, which is not a tool the model
    // calls and so is not in the catalog.
    const work = Object.entries(_BROWSER_TOOL_RECORDING).filter(([, v]) => v === 'work').map(([k]) => k).sort();
    expect(work).toEqual([...RECORDED_BROWSER_TOOLS].filter((t) => t !== 'saved_login').sort());
  });

  it('a wrapped work tool records a bounded semantic outcome once a session was resolved, and never page body or a signed URL', async () => {
    mockGetActiveForThread.mockResolvedValue({ ...liveSession, vendor: 'anchor' });
    mockGetActivePage.mockResolvedValue({ url: 'https://a.example/orders/3f2a91b8c07d4e65?token=abc', title: 'Order' });
    const result = await executeStandardTool('read_active_browser_session', { mode: 'text' }, ctx as never);
    expect(result!.success).toBe(true);
    expect(mockRecordBrowserActivity).toHaveBeenCalledTimes(1);
    const row = mockRecordBrowserActivity.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({
      tool: 'read_active_browser_session', threadId: 'thread-1', sessionId: 'sid', steps: null,
      instruction: 'read the active page as text',
      outcome: 'read https://a.example/orders/3f2a91b8c07d4e65?token=[redacted]; title: Order',
    });
    expect(JSON.stringify(row)).not.toContain('token=abc');
    // The model's own result is the safe projection with its flag.
    expect((result!.result as { url: string; urlProtectedDataOmitted?: boolean }).url).toBe('https://a.example/orders/3f2a91b8c07d4e65?token=[redacted]');
    expect((result!.result as { urlProtectedDataOmitted?: boolean }).urlProtectedDataOmitted).toBe(true);
  });

  it('a wrapped work tool with no session resolved records nothing', async () => {
    mockGetActiveForThread.mockResolvedValue(null);
    const result = await executeStandardTool('read_active_browser_session', {}, ctx as never);
    expect(result!.success).toBe(false);
    expect(mockRecordBrowserActivity).not.toHaveBeenCalled();
  });

  it('an operational probe records nothing', async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    await executeStandardTool('get_browser_session_stats', {}, ctx as never);
    await executeStandardTool('check_browser_intervention_pending', {}, ctx as never);
    expect(mockRecordBrowserActivity).not.toHaveBeenCalled();
  });

  it('a navigation goes through the one helper, and its result is the safe destination', async () => {
    mockGetActiveForThread.mockResolvedValue(liveSession);
    mockGetActiveForCallerSession.mockResolvedValue(null);
    mockNavigateAndRecord.mockResolvedValueOnce({
      finalUrl: 'https://a.example/landed', finalUrlTruncated: false, finalUrlProtectedDataOmitted: false,
      title: 'Landed', titleTruncated: false, titleProtectedDataOmitted: false,
      requestedUrl: 'https://a.example/', requestedUrlProtectedDataOmitted: false, activityId: 'nav-1', session: null,
    });
    const result = await executeStandardTool('navigate_browser_session', { url: 'https://a.example/' }, ctx as never);
    expect(mockNavigateAndRecord).toHaveBeenCalledWith({ tenantId: 'tenant-1', session: liveSession, url: 'https://a.example/' });
    expect(result!.result).toEqual({ url: 'https://a.example/landed', title: 'Landed', requested: 'https://a.example/' });
  });

  it('the semantic record of each wrapped tool names what was asked and what came of it, artifact names included', () => {
    expect(browserWorkRecord('save_active_browser_page_as_pdf', { filename: 'invoice' }, { success: true, result: { filename: 'invoice_v2.pdf' } }))
      .toEqual({ instruction: 'save the active page as PDF named "invoice"', outcome: 'saved the page as "invoice_v2.pdf"' });
    expect(browserWorkRecord('screenshot_browser_session', { full_page: true, show_to_user: true }, { success: true, result: { shown_to_user: true, filename: 'shot_v1.png', screenshot_url: 'https://signed/x' } }))
      .toEqual({ instruction: 'take a screenshot of the full page and show it to the user', outcome: 'took a screenshot; shared as "shot_v1.png"' });
    expect(browserWorkRecord('list_browser_downloads', {}, { success: true, result: { downloads: [{ suggestedFileName: 'a.pdf' }, { originalFileName: 'b.csv' }], count: 2 } }))
      .toEqual({ instruction: 'list the browser downloads', outcome: 'listed 2 downloads: a.pdf, b.csv' });
    expect(browserWorkRecord('fetch_browser_download', { id: 'd1' }, { success: true, result: { filename: 'a.pdf', sizeBytes: 120, downloadUrl: 'https://signed/y' } }))
      .toEqual({ instruction: 'fetch browser download "d1"', outcome: 'fetched "a.pdf" (120 bytes)' });
    expect(browserWorkRecord('read_active_browser_session', {}, { success: false, error: 'boom' }))
      .toEqual({ instruction: 'read the active page as text', outcome: 'could not read the page: boom' });
    expect(JSON.stringify(browserWorkRecord('screenshot_browser_session', {}, { success: true, result: { screenshot_url: 'https://signed/x' } }))).not.toContain('signed');
  });
});

// The file a page produced reaches the person, on every browser
//
// The two download tools called the one vendor with a download API and
// refused on the other three, while the pane runs a different one by default.
// And a file the page only POINTS at, which is what a generator produces, had
// no route into the conversation at all: a person who watched a page render a
// video would be handed a screenshot of the page.
describe('the files a browser produced', () => {
  const steelSession = { ...liveSession, vendor: 'steel' };

  beforeEach(() => {
    mockGetActiveForThread.mockResolvedValue(steelSession);
    mockGetActiveForCallerSession.mockResolvedValue(steelSession);
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockUploadGeneratedFile.mockResolvedValue({
      generatedFileId: 'gf-1', filename: 'clip.mp4', version: 1, downloadUrl: 'https://files/1',
    });
  });

  it('are listed on a browser that is not the one with a download API', async () => {
    mockListDownloadsForSession.mockResolvedValue([
      { id: 'd-1', url: 'https://cdn/clip.mp4', suggestedFileName: 'clip.mp4', originUrl: 'https://maker/', downloadedAt: '2026-09-25T10:00:00.000Z' },
    ]);
    const r = await executeStandardTool('list_browser_downloads', {}, ctx as never);
    expect(r!.success).toBe(true);
    expect((r!.result as { count: number }).count).toBe(1);
    expect(mockListDownloadsForSession).toHaveBeenCalledWith('tenant-1', steelSession);
  });

  it('come back from an address the page points at, and a video is put where the person can watch it', async () => {
    mockFetchFileForSession.mockResolvedValue({
      bytes: Buffer.from('mp4'), filename: 'clip.mp4', contentType: 'video/mp4', sourceUrl: 'https://maker/studio',
    });
    const r = await executeStandardTool('fetch_browser_download', { url: 'https://cdn/clip.mp4' }, ctx as never);
    expect(r!.success).toBe(true);
    expect(mockFetchFileForSession).toHaveBeenCalledWith('tenant-1', steelSession, { downloadId: '', url: 'https://cdn/clip.mp4' });
    const uploaded = mockUploadGeneratedFile.mock.calls[0][0] as { outputType: string; baseName: string; filename: string };
    // 'media' is what puts it in the conversation itself rather than behind a
    // card; the base name carries no extension so the version suffix lands
    // before it.
    expect(uploaded.outputType).toBe('media');
    expect(uploaded.baseName).toBe('clip');
    expect(uploaded.filename).toBe('clip.mp4');
    expect((r!.result as { shownInConversation: boolean }).shownInConversation).toBe(true);
  });

  it('arrive as a file to open when they are not something to look at', async () => {
    mockUploadGeneratedFile.mockResolvedValue({
      generatedFileId: 'gf-2', filename: 'invoice_v1.pdf', version: 1, downloadUrl: 'https://files/2',
    });
    mockFetchFileForSession.mockResolvedValue({
      bytes: Buffer.from('%PDF'), filename: 'invoice.pdf', contentType: 'application/pdf', sourceUrl: 'https://billing/',
    });
    const r = await executeStandardTool('fetch_browser_download', { id: 'd-9' }, ctx as never);
    expect(r!.success).toBe(true);
    expect((mockUploadGeneratedFile.mock.calls[0][0] as { outputType: string }).outputType).toBe('binary');
    expect((r!.result as { shownInConversation: boolean }).shownInConversation).toBe(false);
  });

  it('report the reason when the file cannot be fetched, rather than a failure nobody can act on', async () => {
    const tooLarge = new Error('the file is 120 MB, over the 40 MB a file card takes');
    tooLarge.name = 'FileTooLarge';
    mockFetchFileForSession.mockRejectedValue(tooLarge);
    const r = await executeStandardTool('fetch_browser_download', { url: 'https://cdn/huge.mp4' }, ctx as never);
    expect(r!.success).toBe(false);
    expect(r!.error).toMatch(/over the 40 MB/);
    expect(mockUploadGeneratedFile).not.toHaveBeenCalled();
  });
});
