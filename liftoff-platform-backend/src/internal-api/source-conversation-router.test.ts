// The source-conversation read workforce-service calls for the CAIO.
//
// What matters here: a caller without the service token gets nothing; a
// delegate thread with no pairing and a pairing into another tenant read as
// the SAME miss (a wrong-tenant probe must not learn that a pairing exists);
// the three hosts resolve in order and each reads its own transcript with
// its own speakers; only speech crosses, in reading order, with colleague
// attribution; and the browser trail rides beside the transcript — the
// runtime's activity rows with their steps, the person's takeover holds, and
// on the Liftoff host the legacy rows this service wrote before the runtime
// recorded, merged by time in a k-way merge — redacted, deduped by EXACT id
// only, and held under its budget by keeping the newest rows and, inside a
// row that will not fit, the newest steps.

import express from 'express';
import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  ListTakeoverActivityResponseSchema,
  ListBrowserActivityResponseSchema,
  BrowserActivityRowSchema,
  BrowserTaskStepSchema,
  TakeoverHoldSchema,
  TakeoverActionSchema,
  TakeoverAction_ValueDisposition,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetDelegationByDelegateThread = jest.fn();
const mockGetThread = jest.fn();
const mockGetThreadRollingSummary = jest.fn();
const mockListMessages = jest.fn();
jest.mock('../liftoff/chat-repository', () => ({
  getDelegationByDelegateThread: (...a: unknown[]) => mockGetDelegationByDelegateThread(...a),
  getThread: (...a: unknown[]) => mockGetThread(...a),
  getThreadRollingSummary: (...a: unknown[]) => mockGetThreadRollingSummary(...a),
  listMessages: (...a: unknown[]) => mockListMessages(...a),
}));

const mockGetAssistantDelegationByDelegateThread = jest.fn();
jest.mock('../agent-chat/assistant-delegations', () => ({
  getAssistantDelegationByDelegateThread: (...a: unknown[]) => mockGetAssistantDelegationByDelegateThread(...a),
}));
const mockGetTeamThreadByColleagueThread = jest.fn();
jest.mock('../agent-chat/colleague-request', () => ({
  getTeamThreadByColleagueThread: (...a: unknown[]) => mockGetTeamThreadByColleagueThread(...a),
}));

const mockInsightsGetThread = jest.fn();
const mockInsightsRollingSummary = jest.fn();
const mockInsightsListMessages = jest.fn();
jest.mock('../insights/chat-repository', () => ({
  getThread: (...a: unknown[]) => mockInsightsGetThread(...a),
  getThreadRollingSummary: (...a: unknown[]) => mockInsightsRollingSummary(...a),
  listMessages: (...a: unknown[]) => mockInsightsListMessages(...a),
}));
const mockAgentGetThread = jest.fn();
const mockAgentRollingSummary = jest.fn();
const mockAgentListMessages = jest.fn();
jest.mock('../agent-chat/chat-repository', () => ({
  getThread: (...a: unknown[]) => mockAgentGetThread(...a),
  getThreadRollingSummary: (...a: unknown[]) => mockAgentRollingSummary(...a),
  listMessages: (...a: unknown[]) => mockAgentListMessages(...a),
}));
const mockGetAgentById = jest.fn();
jest.mock('../internal-agents/service', () => ({
  internalAgentService: { getById: (...a: unknown[]) => mockGetAgentById(...a) },
}));
jest.mock('../workspace-actions/teams', () => ({
  teamDisplayName: (team: { role: string; messagingNickname: string | null }) => team.messagingNickname || team.role,
}));

const mockListBrowserActivityPage = jest.fn();
jest.mock('../liftoff/browser-activity', () => ({
  ...jest.requireActual('../liftoff/browser-activity'),
  listBrowserActivityPage: (...a: unknown[]) => mockListBrowserActivityPage(...a),
}));

const mockListTakeoverActivity = jest.fn();
const mockListBrowserActivity = jest.fn();
jest.mock('../connectors/tenant-runtime-service-client', () => ({
  getBrowserSessionsServiceClient: jest.fn(async () => ({
    listTakeoverActivity: (...a: unknown[]) => mockListTakeoverActivity(...a),
    listBrowserActivity: (...a: unknown[]) => mockListBrowserActivity(...a),
  })),
}));

import { liftoffSourceConversationRouter } from './source-conversation-router';
import { workforceServiceAuth } from './workforce-service-auth';

const TOKEN = 'workforce-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const DELEGATE_THREAD_ID = '33333333-3333-3333-3333-333333333333';
const LIFTOFF_THREAD_ID = '44444444-4444-4444-4444-444444444444';

function message(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'm-x',
    threadId: LIFTOFF_THREAD_ID,
    role: 'assistant',
    content: 'hello',
    attachments: [],
    author: null,
    authorLabel: null,
    visualizationBlocks: [],
    messageType: null,
    media: [],
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  // Mounted exactly as index.ts mounts it, auth included, so the 401 path
  // exercises the real middleware.
  app.use(
    '/api/internal/source-conversation',
    workforceServiceAuth,
    express.json({ limit: '64kb' }),
    liftoffSourceConversationRouter,
  );
  return app;
}

function post(
  app: express.Express,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/source-conversation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-service-auth': token } : {}),
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const VALID_BODY = { tenantId: TENANT_ID, delegateThreadId: DELEGATE_THREAD_ID };

beforeEach(() => {
  jest.clearAllMocks();
  process.env['WORKFORCE_SERVICE_TOKEN'] = TOKEN;
  mockGetDelegationByDelegateThread.mockResolvedValue({
    liftoffThreadId: LIFTOFF_THREAD_ID,
    targetId: null,
  });
  mockGetAssistantDelegationByDelegateThread.mockResolvedValue(null);
  mockGetTeamThreadByColleagueThread.mockResolvedValue(null);
  mockGetThread.mockResolvedValue({ id: LIFTOFF_THREAD_ID, tenantId: TENANT_ID });
  mockGetThreadRollingSummary.mockResolvedValue(null);
  mockListMessages.mockResolvedValue({ messages: [], nextCursor: null, hasMore: false });
  mockListBrowserActivityPage.mockResolvedValue({ rows: [], hasMore: false });
  mockListTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [], nextCursor: '' }));
  mockListBrowserActivity.mockResolvedValue(create(ListBrowserActivityResponseSchema, { rows: [], nextCursor: '' }));
});

/** A legacy row as this service's repository returns it (newest first per
 *  page): written before the runtime recorded, or as a fallback. */
function activityRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-0000000000e1',
    tool: 'run_browser_task',
    instruction: 'Export the overdue invoices as CSV',
    outcome: 'The browser finished the task.',
    personTookOver: false,
    steps: null,
    createdAt: '2026-09-01T00:00:01.000Z',
    ...overrides,
  };
}

/** A runtime activity row as ListBrowserActivity returns it. */
function runtimeRow(overrides: {
  id: string; createdAt: string; tool?: string; instruction?: string; outcome?: string; personTookOver?: boolean;
  steps?: Array<{ type: string; action: string; pageUrl: string; protectedDataOmitted?: boolean; protectedKind?: string; at?: string }> | null;
  captureGap?: boolean; gapReason?: string; stepsTruncated?: boolean; instructionTruncated?: boolean; outcomeProtectedDataOmitted?: boolean;
}) {
  return create(BrowserActivityRowSchema, {
    id: overrides.id,
    tool: overrides.tool ?? 'run_browser_task',
    instruction: overrides.instruction ?? 'Export the overdue invoices as CSV',
    outcome: overrides.outcome ?? 'Exported 12 invoices',
    personTookOver: overrides.personTookOver ?? false,
    hasSteps: overrides.steps !== null && overrides.steps !== undefined,
    steps: (overrides.steps ?? []).map((st) => create(BrowserTaskStepSchema, {
      type: st.type, action: st.action, pageUrl: st.pageUrl,
      protectedDataOmitted: st.protectedDataOmitted ?? false, protectedKind: st.protectedKind ?? '',
      ...(st.at ? { at: timestampFromDate(new Date(st.at)) } : {}),
    })),
    createdAt: timestampFromDate(new Date(overrides.createdAt)),
    captureGap: overrides.captureGap ?? false,
    gapReason: overrides.gapReason ?? '',
    stepsTruncated: overrides.stepsTruncated ?? false,
    instructionTruncated: overrides.instructionTruncated ?? false,
    outcomeProtectedDataOmitted: overrides.outcomeProtectedDataOmitted ?? false,
  });
}

function runtimeResponse(rows: ReturnType<typeof runtimeRow>[], nextCursor = '') {
  return create(ListBrowserActivityResponseSchema, { rows, nextCursor });
}

/** Every flag a takeover action carries, at its default. */
const actionFlags = {
  value: '', valueDisposition: 'none', detail: '',
  urlTruncated: false, nameTruncated: false, valueTruncated: false, detailTruncated: false,
  urlProtectedDataOmitted: false, nameProtectedDataOmitted: false, detailProtectedDataOmitted: false,
};
/** Every flag a runtime activity row carries, at its default. */
const rowFlags = {
  instructionTruncated: false, outcomeTruncated: false, instructionProtectedDataOmitted: false, outcomeProtectedDataOmitted: false,
  captureGap: false, gapReason: '',
};

/** A hold as the runtime returns it. */
function hold(overrides: {
  startedAt: string; endedAt?: string | null; endReason?: string; live?: boolean;
  captureGap?: boolean; gapReason?: string;
  actions?: Array<{
    kind: string; url: string; tag?: string; role?: string; name?: string; inputType?: string; at: string;
    value?: string; valueDisposition?: TakeoverAction_ValueDisposition; detail?: string;
  }>;
}) {
  return create(TakeoverHoldSchema, {
    startedAt: timestampFromDate(new Date(overrides.startedAt)),
    endedAt: overrides.endedAt ? timestampFromDate(new Date(overrides.endedAt)) : undefined,
    endReason: overrides.endReason ?? '',
    live: overrides.live ?? false,
    captureGap: overrides.captureGap ?? false,
    gapReason: overrides.gapReason ?? '',
    actions: (overrides.actions ?? []).map((a) => create(TakeoverActionSchema, {
      kind: a.kind, url: a.url, tag: a.tag ?? '', role: a.role ?? '', name: a.name ?? '', inputType: a.inputType ?? '',
      at: timestampFromDate(new Date(a.at)),
      value: a.value ?? '', valueDisposition: a.valueDisposition ?? TakeoverAction_ValueDisposition.NONE, detail: a.detail ?? '',
    })),
  });
}

function holdsResponse(holds: ReturnType<typeof hold>[], nextCursor = '') {
  return create(ListTakeoverActivityResponseSchema, { holds, nextCursor });
}

afterAll(() => {
  delete process.env['WORKFORCE_SERVICE_TOKEN'];
});

describe('auth', () => {
  it('rejects a missing token', async () => {
    const res = await post(buildApp(), VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockGetDelegationByDelegateThread).not.toHaveBeenCalled();
  });

  it('rejects a wrong token', async () => {
    const res = await post(buildApp(), VALID_BODY, 'not-the-token');
    expect(res.status).toBe(401);
  });
});

describe('resolution', () => {
  it('rejects a malformed body', async () => {
    const res = await post(buildApp(), { tenantId: 'nope' }, TOKEN);
    expect(res.status).toBe(400);
  });

  it('404s when the delegate thread has no pairing in any store', async () => {
    mockGetDelegationByDelegateThread.mockResolvedValue(null);
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(404);
  });

  it('resolves the pairing for the caio target only, and names the host', async () => {
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(mockGetDelegationByDelegateThread).toHaveBeenCalledWith(DELEGATE_THREAD_ID, 'caio');
    expect(res.body['sourceAssistant']).toBe('liftoff');
    // The Liftoff store answered, so the other two are not asked.
    expect(mockGetAssistantDelegationByDelegateThread).not.toHaveBeenCalled();
    expect(mockGetTeamThreadByColleagueThread).not.toHaveBeenCalled();
  });

  it('asks the three pairing stores in order: Liftoff, the Insights Manager, a team chat', async () => {
    mockGetDelegationByDelegateThread.mockResolvedValue(null);
    mockGetAssistantDelegationByDelegateThread.mockResolvedValue(null);
    mockGetTeamThreadByColleagueThread.mockResolvedValue({ threadId: '55555555-5555-5555-5555-555555555555' });
    mockAgentGetThread.mockResolvedValue({ id: '55555555-5555-5555-5555-555555555555', tenantId: TENANT_ID });
    mockAgentRollingSummary.mockResolvedValue(null);
    mockAgentListMessages.mockResolvedValue({ messages: [], nextCursor: null, hasMore: false });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(mockGetAssistantDelegationByDelegateThread).toHaveBeenCalledWith(TENANT_ID, 'insights', 'caio', DELEGATE_THREAD_ID);
    expect(mockGetTeamThreadByColleagueThread).toHaveBeenCalledWith(TENANT_ID, 'caio', DELEGATE_THREAD_ID);
    expect(res.status).toBe(200);
    expect(res.body['sourceAssistant']).toBe('team');
  });

  it('reads the thread under the caller tenant and 404s with the SAME body when it misses', async () => {
    mockGetThread.mockResolvedValue(null);

    const missPairing = await (async () => {
      mockGetDelegationByDelegateThread.mockResolvedValueOnce(null);
      return post(buildApp(), VALID_BODY, TOKEN);
    })();
    const missTenant = await post(buildApp(), VALID_BODY, TOKEN);

    expect(mockGetThread).toHaveBeenCalledWith(LIFTOFF_THREAD_ID, TENANT_ID);
    expect(missTenant.status).toBe(404);
    // A wrong-tenant probe must read exactly like an unpaired thread.
    expect(missTenant.body).toEqual(missPairing.body);
  });
});

describe('transcript', () => {
  it('returns speech only, oldest first, with attribution and attachment names', async () => {
    // listMessages returns newest first; the route flips to reading order.
    mockListMessages.mockResolvedValue({
      messages: [
        message({ id: 'm4', role: 'assistant', authorLabel: 'Payroll Operations', author: 'team-1', content: 'Done.' }),
        message({ id: 'm3', role: 'assistant', messageType: 'hitl_status', content: 'Waiting on approval' }),
        message({ id: 'm2', role: 'assistant', content: 'On it.' }),
        message({
          id: 'm1',
          role: 'user',
          content: 'Compile the overdue invoices',
          attachments: [
            { kind: 'upload', name: 'q3.csv' },
            {
              kind: 'connector', name: 'Vendor list', connectorType: 'google_drive',
              connectorId: 'c1', externalId: 'e1',
            },
          ],
        }),
      ],
      nextCursor: null,
      hasMore: false,
    });

    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body['truncated']).toBe(false);
    expect(res.body['messages']).toEqual([
      {
        speaker: 'Person',
        text: 'Compile the overdue invoices',
        attachments: ['q3.csv', 'Vendor list (google_drive)'],
      },
      { speaker: 'Liftoff', text: 'On it.', attachments: [] },
      { speaker: 'Payroll Operations', text: 'Done.', attachments: [] },
    ]);
  });

  it('stops at the char budget, keeps the newest, and says so', async () => {
    const long = 'x'.repeat(30_000);
    mockListMessages.mockResolvedValue({
      messages: [
        message({ id: 'm3', content: long, createdAt: '2026-09-01T00:00:03.000Z' }),
        message({ id: 'm2', content: long, createdAt: '2026-09-01T00:00:02.000Z' }),
        message({ id: 'm1', content: long, createdAt: '2026-09-01T00:00:01.000Z' }),
      ],
      nextCursor: null,
      hasMore: false,
    });

    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body['truncated']).toBe(true);
    expect((res.body['messages'] as unknown[]).length).toBe(1);
  });

  it('includes the rolling summary as stored', async () => {
    mockGetThreadRollingSummary.mockResolvedValue({ userIntent: 'weekly invoice sweep' });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.body['rollingSummary']).toEqual({ userIntent: 'weekly invoice sweep' });
  });
});

describe('browser trail', () => {
  it('rides beside the transcript with takeover marks and steps intact, oldest first', async () => {
    // The repository answers newest first; the route flips to reading order.
    mockListBrowserActivityPage.mockResolvedValue({
      rows: [
        activityRow({
          id: 'r2',
          tool: 'run_browser_task',
          instruction: 'Export the overdue invoices as CSV',
          outcome: 'The user has taken over this browser session.',
          personTookOver: true,
          steps: [{ type: 'goto', action: 'https://portal.example.com/invoices', pageUrl: '' }],
          createdAt: '2026-09-01T00:00:01.000Z',
        }),
        activityRow({
          id: 'r1',
          tool: 'navigate_browser_session',
          instruction: 'https://portal.example.com',
          outcome: 'The browser is now on https://portal.example.com and the person can see it.',
          personTookOver: false,
          steps: null,
          createdAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
      hasMore: false,
    });

    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(mockListBrowserActivityPage).toHaveBeenCalledWith(TENANT_ID, LIFTOFF_THREAD_ID, { limit: 50, before: undefined });
    expect(mockListTakeoverActivity).toHaveBeenCalledWith(expect.objectContaining({
      tenantContext: { tenantId: TENANT_ID }, threadId: LIFTOFF_THREAD_ID, limit: 5, beforeCursor: '',
    }));
    expect(res.body['browserActivityTruncated']).toBe(false);
    expect(res.body['browserActivity']).toEqual([
      {
        id: 'r1',
        tool: 'navigate_browser_session',
        instruction: 'https://portal.example.com/',
        outcome: 'The browser is now on https://portal.example.com/ and the person can see it.',
        personTookOver: false,
        steps: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        ...rowFlags,
      },
      {
        id: 'r2',
        tool: 'run_browser_task',
        instruction: 'Export the overdue invoices as CSV',
        outcome: 'The user has taken over this browser session.',
        personTookOver: true,
        steps: [{
          type: 'goto', action: 'https://portal.example.com/invoices', pageUrl: '',
          actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false, at: null,
        }],
        createdAt: '2026-09-01T00:00:01.000Z',
        ...rowFlags,
      },
    ]);
  });

  it('a legacy navigation URL with a token cannot bypass the policy: the adapter projects it with an explicit omission marker', async () => {
    mockListBrowserActivityPage.mockResolvedValue({
      rows: [activityRow({
        id: 'r1', tool: 'navigate_browser_session',
        instruction: 'https://portal.example.com/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc',
        outcome: 'The browser is now on https://portal.example.com/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc and the person can see it.',
        createdAt: '2026-09-01T00:00:00.000Z',
      })],
      hasMore: false,
    });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    const [row] = res.body['browserActivity'] as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      instruction: 'https://portal.example.com/reset-password/[redacted]?token=[redacted]', instructionProtectedDataOmitted: true,
      outcome: 'The browser is now on https://portal.example.com/reset-password/[redacted]?token=[redacted] and the person can see it.', outcomeProtectedDataOmitted: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token=abc|3f2a91b8c07d4e659a1b0d3e5f7a9b1c/);
  });

  it("a fallback row's textual markers become the structured flags, so every legacy row carries the signal a runtime row does", async () => {
    mockListBrowserActivityPage.mockResolvedValue({
      rows: [activityRow({
        id: 'r1', tool: 'run_browser_task',
        instruction: 'sign in with password=[redacted] and export the CSV [protected data omitted] [truncated]',
        outcome: 'Exported 18 rows [truncated]',
        createdAt: '2026-09-01T00:00:00.000Z',
      })],
      hasMore: false,
    });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    const [row] = res.body['browserActivity'] as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      instructionProtectedDataOmitted: true, instructionTruncated: true,
      outcomeTruncated: true, outcomeProtectedDataOmitted: false,
    });
  });

  it('a legacy row whose outcome is the not-answered marker reads as a capture gap', async () => {
    mockListBrowserActivityPage.mockResolvedValue({
      rows: [activityRow({ id: 'r1', outcome: '[not answered]', createdAt: '2026-09-01T00:00:00.000Z' })],
      hasMore: false,
    });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    const [row] = res.body['browserActivity'] as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ captureGap: true, gapReason: 'not_answered' });
  });

  it("the runtime's rows carry their steps, flags and completeness fields, redacted, and lead the merge", async () => {
    mockListBrowserActivity.mockResolvedValue(runtimeResponse([
      runtimeRow({
        id: '00000000-0000-0000-0000-0000000000a2', createdAt: '2026-09-01T00:00:02.000Z',
        steps: [{ type: 'change', action: 'entered "browser" in textbox "Search"', pageUrl: 'https://a.example/issues?q=browser', at: '2026-09-01T00:00:01.500Z' }],
        captureGap: true, gapReason: 'frame_unavailable', stepsTruncated: true, instructionTruncated: true,
      }),
      runtimeRow({ id: '00000000-0000-0000-0000-0000000000a1', createdAt: '2026-09-01T00:00:00.000Z', tool: 'navigate_browser_session', steps: null, outcome: 'opened https://a.example/' }),
    ]));
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(mockListBrowserActivity).toHaveBeenCalledWith(expect.objectContaining({
      tenantContext: { tenantId: TENANT_ID }, threadId: LIFTOFF_THREAD_ID, limit: 50, beforeCursor: '',
    }));
    const trail = res.body['browserActivity'] as Array<Record<string, unknown>>;
    expect(trail.map((r) => r['id'])).toEqual(['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2']);
    expect(trail[0]).toMatchObject({ tool: 'navigate_browser_session', steps: null, outcome: 'opened https://a.example/' });
    expect(trail[1]).toMatchObject({
      captureGap: true, gapReason: 'frame_unavailable', stepsTruncated: true, instructionTruncated: true,
      steps: [expect.objectContaining({ type: 'change', action: 'entered "browser" in textbox "Search"', at: '2026-09-01T00:00:01.500Z' })],
    });
  });

  it('dedupes by EXACT id only: a legacy row the runtime also carries is dropped, two identical calls with different ids both survive', async () => {
    const twin = '00000000-0000-0000-0000-0000000000b1';
    mockListBrowserActivity.mockResolvedValue(runtimeResponse([
      runtimeRow({ id: '00000000-0000-0000-0000-0000000000b3', createdAt: '2026-09-01T00:00:10.000Z', instruction: 'count the pull requests', outcome: '18' }),
      runtimeRow({ id: '00000000-0000-0000-0000-0000000000b2', createdAt: '2026-09-01T00:00:05.000Z', instruction: 'count the pull requests', outcome: '18' }),
      runtimeRow({ id: twin, createdAt: '2026-09-01T00:00:00.000Z', instruction: 'open the portal', outcome: 'opened' }),
    ]));
    mockListBrowserActivityPage.mockResolvedValue({
      // The fallback twin, written a moment after the runtime's row.
      rows: [activityRow({ id: twin, instruction: 'open the portal', outcome: '[not answered]', createdAt: '2026-09-01T00:00:00.400Z' })],
      hasMore: false,
    });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    const trail = res.body['browserActivity'] as Array<Record<string, unknown>>;
    expect(trail.map((r) => r['id'])).toEqual([twin, '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3']);
    // The runtime's row won: no gap marker from the fallback.
    expect(trail[0]).toMatchObject({ outcome: 'opened', captureGap: false });
    expect(trail.filter((r) => r['instruction'] === 'count the pull requests')).toHaveLength(2);
  });

  it('reads the legacy rows for the Liftoff host only', async () => {
    mockGetDelegationByDelegateThread.mockResolvedValue(null);
    mockGetAssistantDelegationByDelegateThread.mockResolvedValue({ threadId: '66666666-6666-6666-6666-666666666666' });
    mockInsightsGetThread.mockResolvedValue({ id: '66666666-6666-6666-6666-666666666666', tenantId: TENANT_ID });
    mockInsightsRollingSummary.mockResolvedValue(null);
    mockInsightsListMessages.mockResolvedValue({ messages: [], nextCursor: null, hasMore: false });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.body['sourceAssistant']).toBe('insights');
    expect(mockListBrowserActivityPage).not.toHaveBeenCalled();
    expect(mockListBrowserActivity).toHaveBeenCalledWith(expect.objectContaining({ threadId: '66666666-6666-6666-6666-666666666666' }));
    expect(mockListTakeoverActivity).toHaveBeenCalledWith(expect.objectContaining({ threadId: '66666666-6666-6666-6666-666666666666' }));
  });

  it('merges the holds by time between the assistant rows, as person_takeover rows with the actions in order', async () => {
    mockListBrowserActivityPage.mockResolvedValue({
      rows: [
        activityRow({ id: 'r2', instruction: 'Automate what I just did', createdAt: '2026-09-01T00:10:00.000Z' }),
        activityRow({ id: 'r1', instruction: 'Open the portal', outcome: 'The user has taken over this browser session.', personTookOver: true, createdAt: '2026-09-01T00:00:00.000Z' }),
      ],
      hasMore: false,
    });
    mockListTakeoverActivity.mockResolvedValue(holdsResponse([
      hold({
        startedAt: '2026-09-01T00:01:00.000Z', endedAt: '2026-09-01T00:05:00.000Z', endReason: 'released',
        actions: [
          { kind: 'navigate', url: 'https://portal.example.com/orders/:id', at: '2026-09-01T00:01:10.000Z' },
          { kind: 'click', url: 'https://portal.example.com/orders/:id', tag: 'button', role: 'button', name: 'Approve invoice', at: '2026-09-01T00:01:20.000Z' },
          { kind: 'enter', url: 'https://portal.example.com/orders/:id', tag: 'input', role: 'textbox', name: 'Password', inputType: 'password', at: '2026-09-01T00:01:30.000Z', valueDisposition: TakeoverAction_ValueDisposition.UNSPECIFIED },
        ],
      }),
    ]));

    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    const trail = res.body['browserActivity'] as Array<Record<string, unknown>>;
    expect(trail.map((r) => r['tool'])).toEqual(['run_browser_task', 'person_takeover', 'run_browser_task']);
    expect(trail[1]).toEqual({
      tool: 'person_takeover',
      instruction: '',
      outcome: '',
      personTookOver: true,
      // A hold the person drove; a control they pointed at without taking
      // over is kind "point".
      kind: 'takeover',
      steps: [
        { kind: 'navigate', url: 'https://portal.example.com/orders/:id', tag: '', role: '', name: '', inputType: '', at: '2026-09-01T00:01:10.000Z', ...actionFlags },
        { kind: 'click', url: 'https://portal.example.com/orders/:id', tag: 'button', role: 'button', name: 'Approve invoice', inputType: '', at: '2026-09-01T00:01:20.000Z', ...actionFlags },
        // An older runtime's UNSPECIFIED disposition on a value-bearing kind
        // reads as legacy_unavailable.
        { kind: 'enter', url: 'https://portal.example.com/orders/:id', tag: 'input', role: 'textbox', name: 'Password', inputType: 'password', at: '2026-09-01T00:01:30.000Z', ...actionFlags, valueDisposition: 'legacy_unavailable' },
      ],
      live: false,
      captureGap: false,
      gapReason: '',
      startedAt: '2026-09-01T00:01:00.000Z',
      endedAt: '2026-09-01T00:05:00.000Z',
    });
    // The assistant row that hit the takeover keeps its own mark.
    expect(trail[0]['personTookOver']).toBe(true);
  });

  it('a live hold has no end, and captureGap stays independent of it', async () => {
    mockListTakeoverActivity.mockResolvedValue(holdsResponse([
      hold({ startedAt: '2026-09-01T00:01:00.000Z', endedAt: null, live: true, captureGap: true, gapReason: 'lost_owner' }),
    ]));
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    const [row] = res.body['browserActivity'] as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ tool: 'person_takeover', live: true, endedAt: null, captureGap: true, gapReason: 'lost_owner' });
    expect(res.body['browserActivityTruncated']).toBe(false);
  });

  it('passes captureGap and gapReason through on an ended hold', async () => {
    mockListTakeoverActivity.mockResolvedValue(holdsResponse([
      hold({ startedAt: '2026-09-01T00:01:00.000Z', endedAt: '2026-09-01T00:02:00.000Z', endReason: 'expired', captureGap: true, gapReason: 'cap' }),
    ]));
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    const [row] = res.body['browserActivity'] as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ live: false, captureGap: true, gapReason: 'cap', endedAt: '2026-09-01T00:02:00.000Z' });
  });

  it('redacts known sensitive patterns in control names, URLs and step phrases before return', async () => {
    const key = 'sk-ant-api03-' + 'A'.repeat(40);
    mockListBrowserActivityPage.mockResolvedValue({
      rows: [activityRow({
        instruction: `use ${key}`,
        outcome: `done with ${key}`,
        steps: [{ type: 'act', action: `type "${key}" into the key field`, pageUrl: `https://a.example/?k=${key}` }],
        createdAt: '2026-09-01T00:10:00.000Z',
      })],
      hasMore: false,
    });
    mockListTakeoverActivity.mockResolvedValue(holdsResponse([
      hold({
        startedAt: '2026-09-01T00:01:00.000Z', endedAt: '2026-09-01T00:02:00.000Z',
        actions: [{ kind: 'click', url: `https://a.example/${key}`, tag: 'button', role: 'button', name: `Continue with ${key}`, at: '2026-09-01T00:01:10.000Z' }],
      }),
    ]));
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    const body = JSON.stringify(res.body['browserActivity']);
    expect(body).not.toContain(key);
    expect(body).toContain('[REDACTED');
    // The pass that changed a string upgraded its flag.
    const takeover = (res.body['browserActivity'] as Array<Record<string, unknown>>).find((r) => r['tool'] === 'person_takeover')!;
    expect((takeover['steps'] as Array<Record<string, unknown>>)[0]).toMatchObject({ nameProtectedDataOmitted: true, urlProtectedDataOmitted: true });
  });

  it('carries a recorded value, an omitted class and the flags on a takeover action, and drops a credential-shaped value', async () => {
    mockListTakeoverActivity.mockResolvedValue(holdsResponse([
      hold({
        startedAt: '2026-09-01T00:01:00.000Z', endedAt: '2026-09-01T00:02:00.000Z',
        actions: [
          { kind: 'change', url: 'https://a.example/issues', tag: 'input', role: 'textbox', name: 'Search all issues', inputType: 'text', at: '2026-09-01T00:01:10.000Z', value: 'browser', valueDisposition: TakeoverAction_ValueDisposition.RECORDED },
          { kind: 'enter', url: 'https://a.example/login', tag: 'input', role: 'textbox', name: 'Password', inputType: 'password', at: '2026-09-01T00:01:20.000Z', valueDisposition: TakeoverAction_ValueDisposition.AUTHENTICATION_OMITTED },
          { kind: 'change', url: 'https://a.example/notes', tag: 'textarea', role: 'textbox', name: 'Notes', at: '2026-09-01T00:01:30.000Z', value: 'ghp_' + 'a'.repeat(36), valueDisposition: TakeoverAction_ValueDisposition.RECORDED },
          { kind: 'key', url: 'https://a.example/notes', tag: 'textarea', role: 'textbox', name: 'Notes', at: '2026-09-01T00:01:40.000Z', detail: 'Control+Enter' },
        ],
      }),
    ]));
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    const [row] = res.body['browserActivity'] as Array<Record<string, unknown>>;
    const [recorded, omitted, dropped, key] = row['steps'] as Array<Record<string, unknown>>;
    expect(recorded).toMatchObject({ value: 'browser', valueDisposition: 'recorded' });
    expect(omitted).toMatchObject({ value: '', valueDisposition: 'authentication_omitted', inputType: 'password' });
    expect(dropped).toMatchObject({ value: '', valueDisposition: 'sensitive_text_omitted' });
    expect(key).toMatchObject({ kind: 'key', detail: 'Control+Enter', valueDisposition: 'none' });
    expect(JSON.stringify(res.body)).not.toContain('ghp_');
  });

  it('reads an older runtime without either RPC as no holds and no rows: the legacy rows cross alone', async () => {
    mockListTakeoverActivity.mockRejectedValue(new ConnectError('unimplemented', Code.Unimplemented));
    mockListBrowserActivity.mockRejectedValue(new ConnectError('unimplemented', Code.Unimplemented));
    mockListBrowserActivityPage.mockResolvedValue({ rows: [activityRow({})], hasMore: false });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body['browserActivity']).toHaveLength(1);
    expect(res.body['browserActivityTruncated']).toBe(false);
  });

  describe('the budget', () => {
    const BUDGET = 20_000;
    const manySteps = (n: number, at: string) => Array.from({ length: n }, (_, i) => ({
      kind: 'click', url: 'https://portal.example.com/orders/:id', tag: 'button', role: 'button', name: `Control ${i}`, at,
    }));

    const bigAssistant = (id: string, createdAt: string, n = 400) => activityRow({
      id,
      steps: Array.from({ length: n }, (_, i) => ({ type: 'act', action: `step ${i} ` + 'x'.repeat(40), pageUrl: 'https://portal.example.com/' })),
      createdAt,
    });
    const bigHold = (startedAt: string, n = 300) => hold({
      startedAt, endedAt: '2026-09-01T00:05:00.000Z', actions: manySteps(n, '2026-09-01T00:01:10.000Z'),
    });

    it('an oversized assistant row keeps its newest steps and is marked; the array stays within budget', async () => {
      mockListBrowserActivityPage.mockResolvedValue({
        rows: [
          bigAssistant('big', '2026-09-01T00:10:00.000Z'),
          activityRow({ id: 'older', tool: 'navigate_browser_session', createdAt: '2026-09-01T00:00:00.000Z' }),
        ],
        hasMore: false,
      });

      const res = await post(buildApp(), VALID_BODY, TOKEN);
      expect(res.status).toBe(200);
      const trail = res.body['browserActivity'] as Array<Record<string, unknown>>;
      expect(JSON.stringify(trail).length).toBeLessThanOrEqual(BUDGET);
      expect(res.body['browserActivityTruncated']).toBe(true);
      const assistant = trail.find((r) => r['tool'] === 'run_browser_task')!;
      expect(assistant['stepsTruncated']).toBe(true);
      const kept = assistant['steps'] as Array<{ action: string }>;
      expect(kept.length).toBeGreaterThan(60);
      expect(kept.length).toBeLessThan(400);
      // The NEWEST steps: the last one is the loop's last.
      expect(kept[kept.length - 1].action.startsWith('step 399')).toBe(true);
      // The older row's non-step fields no longer fit: the read stops before it.
      expect(trail.find((r) => r['tool'] === 'navigate_browser_session')).toBeUndefined();
      // Read truncation is not a capture gap.
      expect(assistant['captureGap']).toBe(false);
    });

    it('an oversized hold keeps its newest actions and is marked, with captureGap untouched', async () => {
      mockListBrowserActivityPage.mockResolvedValue({
        rows: [activityRow({ id: 'small', createdAt: '2026-09-01T00:10:00.000Z' })],
        hasMore: false,
      });
      mockListTakeoverActivity.mockResolvedValue(holdsResponse([bigHold('2026-09-01T00:01:00.000Z')]));

      const res = await post(buildApp(), VALID_BODY, TOKEN);
      const trail = res.body['browserActivity'] as Array<Record<string, unknown>>;
      expect(JSON.stringify(trail).length).toBeLessThanOrEqual(BUDGET);
      expect(res.body['browserActivityTruncated']).toBe(true);
      // The newest row (the small assistant call) rides whole; the older hold
      // gets what is left, its newest actions first.
      expect(trail.map((r) => r['tool'])).toEqual(['person_takeover', 'run_browser_task']);
      const takeover = trail[0];
      expect(takeover['stepsTruncated']).toBe(true);
      const actions = takeover['steps'] as Array<{ name: string }>;
      expect(actions.length).toBeGreaterThan(40);
      expect(actions.length).toBeLessThan(300);
      expect(actions[actions.length - 1].name).toBe('Control 299');
      expect(takeover['captureGap']).toBe(false);
      expect(trail[1]['stepsTruncated']).toBeUndefined();
    });

    it('cuts the first row too when it alone exceeds the budget', async () => {
      mockListTakeoverActivity.mockResolvedValue(holdsResponse([bigHold('2026-09-01T00:01:00.000Z', 500)]));
      const res = await post(buildApp(), VALID_BODY, TOKEN);
      const [row] = res.body['browserActivity'] as Array<Record<string, unknown>>;
      expect(row['stepsTruncated']).toBe(true);
      expect((row['steps'] as unknown[]).length).toBeLessThan(500);
      expect(JSON.stringify(res.body['browserActivity']).length).toBeLessThanOrEqual(BUDGET);
      expect(res.body['browserActivityTruncated']).toBe(true);
      expect(row['captureGap']).toBe(false);
    });

    it('fetches assistant pages only until the budget is spent, and marks truncation when older pages remain', async () => {
      const pageOf = (start: number) => ({
        rows: Array.from({ length: 50 }, (_, i) => activityRow({
          id: `r${start - i}`,
          instruction: 'i'.repeat(400),
          outcome: 'o'.repeat(400),
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, start - i)).toISOString(),
        })),
        hasMore: true,
      });
      mockListBrowserActivityPage
        .mockResolvedValueOnce(pageOf(1000))
        .mockResolvedValueOnce(pageOf(950))
        .mockResolvedValue(pageOf(900));

      const res = await post(buildApp(), VALID_BODY, TOKEN);
      expect(res.status).toBe(200);
      expect(res.body['browserActivityTruncated']).toBe(true);
      expect(JSON.stringify(res.body['browserActivity']).length).toBeLessThanOrEqual(BUDGET);
      // ~830 chars a row: the budget is spent inside the first page, so the
      // second is never asked for.
      expect(mockListBrowserActivityPage).toHaveBeenCalledTimes(1);
      const trail = res.body['browserActivity'] as Array<Record<string, unknown>>;
      // Newest kept, in reading order.
      expect((trail[trail.length - 1]['instruction'] as string).length).toBe(400);
    });

    it('the budget is one budget across all three streams', async () => {
      mockListBrowserActivity.mockResolvedValue(runtimeResponse(
        Array.from({ length: 30 }, (_, i) => runtimeRow({
          id: `00000000-0000-0000-0000-0000000000${(10 + i).toString(16).padStart(2, '0')}`,
          createdAt: new Date(Date.UTC(2026, 8, 1, 1, 0, 59 - i)).toISOString(),
          instruction: 'i'.repeat(400), outcome: 'o'.repeat(400),
        })),
      ));
      mockListBrowserActivityPage.mockResolvedValue({
        rows: Array.from({ length: 30 }, (_, i) => activityRow({
          id: `legacy-${i}`, instruction: 'l'.repeat(400), outcome: 'o'.repeat(400),
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, 30, 59 - i)).toISOString(),
        })),
        hasMore: false,
      });
      mockListTakeoverActivity.mockResolvedValue(holdsResponse([bigHold('2026-09-01T00:45:00.000Z', 100)]));
      const res = await post(buildApp(), VALID_BODY, TOKEN);
      expect(JSON.stringify(res.body['browserActivity']).length).toBeLessThanOrEqual(BUDGET);
      expect(res.body['browserActivityTruncated']).toBe(true);
      const trail = res.body['browserActivity'] as Array<Record<string, unknown>>;
      // The newest rows are the runtime's; the budget ran out before the
      // older legacy rows.
      expect(trail[trail.length - 1]['instruction']).toBe('i'.repeat(400));
      expect(trail.some((r) => typeof r['id'] === 'string' && (r['id'] as string).startsWith('legacy-'))).toBe(false);
    });

    it('marks truncation when older holds remain unread', async () => {
      mockListTakeoverActivity.mockResolvedValueOnce(holdsResponse(
        [hold({ startedAt: '2026-09-01T00:01:00.000Z', endedAt: '2026-09-01T00:02:00.000Z', actions: manySteps(240, '2026-09-01T00:01:10.000Z') })],
        'older',
      )).mockResolvedValueOnce(holdsResponse(
        [hold({ startedAt: '2026-08-31T00:01:00.000Z', endedAt: '2026-08-31T00:02:00.000Z', actions: manySteps(240, '2026-08-31T00:01:10.000Z') })],
        '',
      ));
      const res = await post(buildApp(), VALID_BODY, TOKEN);
      expect(res.body['browserActivityTruncated']).toBe(true);
      expect(JSON.stringify(res.body['browserActivity']).length).toBeLessThanOrEqual(BUDGET);
    });
  });
});

describe('the other hosts', () => {
  const INSIGHTS_THREAD = '66666666-6666-6666-6666-666666666666';
  const TEAM_THREAD = '77777777-7777-7777-7777-777777777777';

  it('an Insights Manager conversation: the person by sender, the Insights Manager, a colleague by label; status rows skipped', async () => {
    mockGetDelegationByDelegateThread.mockResolvedValue(null);
    mockGetAssistantDelegationByDelegateThread.mockResolvedValue({ threadId: INSIGHTS_THREAD });
    mockInsightsGetThread.mockResolvedValue({ id: INSIGHTS_THREAD, tenantId: TENANT_ID });
    mockInsightsRollingSummary.mockResolvedValue({ userIntent: 'x' });
    mockInsightsListMessages.mockResolvedValue({
      messages: [
        { role: 'assistant', content: 'The Chief AI Officer will post here shortly.', messageType: 'delegation_status', contributors: [], attachments: [], sender: null },
        { role: 'assistant', content: 'I can change that team.', messageType: 'colleague', contributors: [{ id: 'caio', label: 'Chief AI Officer' }], attachments: [], sender: null },
        { role: 'assistant', content: 'Background from Liftoff', messageType: 'forwarded_context', contributors: [], attachments: [], sender: null },
        { role: 'assistant', content: 'Spend was 12 OUs.', messageType: null, contributors: [], attachments: [], sender: null },
        { role: 'user', content: 'How much did we spend?', messageType: null, contributors: [], attachments: [{ name: 'q3.csv' }], sender: { accountId: 'a', firstName: 'Jane', lastName: 'Doe' } },
        { role: 'user', content: 'Earlier, without a sender', messageType: null, contributors: [], attachments: [], sender: null },
      ],
      nextCursor: null, hasMore: false,
    });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body['sourceAssistant']).toBe('insights');
    expect(mockInsightsGetThread).toHaveBeenCalledWith(INSIGHTS_THREAD, TENANT_ID);
    expect(res.body['messages']).toEqual([
      { speaker: 'Workspace member', text: 'Earlier, without a sender', attachments: [] },
      { speaker: 'Jane Doe', text: 'How much did we spend?', attachments: ['q3.csv'] },
      { speaker: 'Insights Manager', text: 'Spend was 12 OUs.', attachments: [] },
      { speaker: 'Chief AI Officer', text: 'I can change that team.', attachments: [] },
    ]);
    expect(res.body['rollingSummary']).toEqual({ userIntent: 'x' });
  });

  it("a team's chat: the person by sender, else senderLabel, else a member; each assistant row by its team's name; a colleague row by its label; no prefix parsed", async () => {
    mockGetDelegationByDelegateThread.mockResolvedValue(null);
    mockGetTeamThreadByColleagueThread.mockResolvedValue({ threadId: TEAM_THREAD });
    mockAgentGetThread.mockResolvedValue({ id: TEAM_THREAD, tenantId: TENANT_ID });
    mockAgentRollingSummary.mockResolvedValue(null);
    mockGetAgentById.mockImplementation(async (id: string) => (id === 'team-1' ? { role: 'Release Coordinator', messagingNickname: null } : { role: 'Other', messagingNickname: 'Ops' }));
    mockAgentListMessages.mockResolvedValue({
      messages: [
        { role: 'assistant', agentId: 'team-1', content: 'Chief AI Officer: I would change step 3.', messageType: 'colleague', contributors: [{ id: 'caio', label: 'Chief AI Officer' }], attachments: null, sender: null, senderLabel: null },
        { role: 'assistant', agentId: 'team-1', content: 'Working on it.', messageType: 'hitl_status', contributors: [], attachments: null, sender: null, senderLabel: null },
        { role: 'assistant', agentId: 'team-2', content: 'Here is the ops view.', messageType: null, contributors: [], attachments: null, sender: null, senderLabel: null },
        { role: 'assistant', agentId: 'team-1', content: 'Opened the page.', messageType: null, contributors: [], attachments: null, sender: null, senderLabel: null },
        { role: 'user', agentId: null, content: 'From Slack', messageType: null, contributors: [], attachments: null, sender: null, senderLabel: 'guest-42' },
        { role: 'user', agentId: null, content: 'Open the portal', messageType: null, contributors: [], attachments: null, sender: { accountId: 'a', firstName: 'Jane', lastName: null, email: 'j@x', avatarUrl: null }, senderLabel: null },
        { role: 'user', agentId: null, content: 'Nobody known', messageType: null, contributors: [], attachments: null, sender: null, senderLabel: null },
      ],
      nextCursor: null, hasMore: false,
    });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body['sourceAssistant']).toBe('team');
    expect(res.body['messages']).toEqual([
      { speaker: 'A member of the workspace', text: 'Nobody known', attachments: [] },
      { speaker: 'Jane', text: 'Open the portal', attachments: [] },
      { speaker: 'guest-42', text: 'From Slack', attachments: [] },
      { speaker: 'Release Coordinator', text: 'Opened the page.', attachments: [] },
      { speaker: 'Ops', text: 'Here is the ops view.', attachments: [] },
      { speaker: 'Chief AI Officer', text: 'Chief AI Officer: I would change step 3.', attachments: [] },
    ]);
    // No sourceTeamName: a team chat can hold more than one agent.
    expect(res.body['sourceTeamName']).toBeUndefined();
    expect(mockListBrowserActivity).toHaveBeenCalledWith(expect.objectContaining({ threadId: TEAM_THREAD }));
    expect(mockListTakeoverActivity).toHaveBeenCalledWith(expect.objectContaining({ threadId: TEAM_THREAD }));
    expect(mockListBrowserActivityPage).not.toHaveBeenCalled();
  });

  it('a team-chat pairing into another tenant reads as the same miss', async () => {
    mockGetDelegationByDelegateThread.mockResolvedValue(null);
    mockGetTeamThreadByColleagueThread.mockResolvedValue({ threadId: TEAM_THREAD });
    mockAgentGetThread.mockResolvedValue(null);
    const miss = await post(buildApp(), VALID_BODY, TOKEN);
    mockGetTeamThreadByColleagueThread.mockResolvedValue(null);
    const unpaired = await post(buildApp(), VALID_BODY, TOKEN);
    expect(miss.status).toBe(404);
    expect(miss.body).toEqual(unpaired.body);
  });
});
