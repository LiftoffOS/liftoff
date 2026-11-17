// The chat service verifies the person's claimed browser event (a hand-back
// or a point) against the runtime's record, through platform-backend's
// takeovers route with the hold named. The stream router calls this before
// it writes anything or flushes a header, so what is pinned here is the
// call and its three answers: the verified event, a 409 for a claim that
// does not check out, and a 503 when platform-backend cannot answer.
//
// Booting the module pulls in the rest of the turn's dependencies; they are
// mocked as the other chat-service tests mock them, and none is reached.

jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  appendMessage: jest.fn(),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
  // When the Chief AI Officer last spoke, for the Browser section: none by default.
  lastAssistantReplyAt: jest.fn().mockResolvedValue(null),
  updateThreadRollingSummary: jest.fn(),
  getThread: jest.fn(),
}));
jest.mock('../workforce-plans/tools/browser.js', () => ({
  ...jest.requireActual('../workforce-plans/tools/browser.js'),
  fetchBrowserState: jest.fn().mockResolvedValue(''),
}));
jest.mock('../workforce-plans/active-turn-repository.js', () => ({
  claimTurn: jest.fn().mockResolvedValue(undefined),
  releaseTurn: jest.fn().mockResolvedValue(undefined),
  isStopRequested: jest.fn().mockResolvedValue(false),
}));
jest.mock('../workforce-plans/turn-event-recorder.js', () => ({
  TurnEventRecorder: jest.fn().mockImplementation(() => ({
    record: jest.fn().mockResolvedValue(undefined),
    finish: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../workforce-plans/chat-media.js', () => ({
  claimInboundMedia: jest.fn().mockResolvedValue(undefined),
  loadTurnImages: jest.fn().mockResolvedValue([]),
  sendableModalities: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../workforce-plans/audit-log.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: jest.fn(),
}));
jest.mock('../workforce-plans/service.js', () => ({
  workforcePlanService: { getPlan: jest.fn() },
}));
jest.mock('../workforce-plans/tenant-connectors.js', () => ({
  workforcePlansConnectorClient: { listConnectors: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../workforce-plans/tenant-agents.js', () => ({
  listTenantAgents: jest.fn().mockResolvedValue([]),
}));
jest.mock('../workforce-plans/tools/remote-workspace-actions.js', () => ({
  ensureRemoteWorkspaceActions: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../workforce-plans/reply-notification.js', () => ({
  notifyTeamPlanReply: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../workforce-plans/thread-title.js', () => ({
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../platform-agent/execution.js', () => ({
  runPlatformAgent: jest.fn(),
}));
jest.mock('../platform-agent/config.js', () => ({
  loadPlatformAgentConfig: jest.fn().mockResolvedValue({ systemPromptTemplate: 'x', model: 'm' }),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resetConfigForTests } from '../infrastructure/config.js';
import { verifyBrowserEvent } from '../workforce-plans/chat-service.js';

const HOLD = '11111111-1111-4111-8111-111111111111';
const ctx = { tenantId: 'tenant-123', threadId: 'thread-123' };

describe('verifyBrowserEvent', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    resetConfigForTests();
    process.env['PLATFORM_BACKEND_URL'] = 'http://localhost:3000';
    process.env['GCP_PROJECT_ID'] = 'test';
    process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:test-db';
    process.env['WORKFORCE_SERVICE_TOKEN'] = 'test-service-auth';
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env['PLATFORM_BACKEND_URL'];
    delete process.env['GCP_PROJECT_ID'];
    delete process.env['DB_INSTANCE_CONNECTION_NAME'];
    delete process.env['WORKFORCE_SERVICE_TOKEN'];
    resetConfigForTests();
  });

  it('reads the takeovers route with the hold and the kind, under the service secret', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ event: { kind: 'handback', holdId: HOLD, action: null } }) } as never);
    const ok = await verifyBrowserEvent(ctx, 'handback', HOLD);
    expect(ok).toEqual({ ok: true, event: { kind: 'handback', holdId: HOLD, action: null } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/internal/assistant-browser/takeovers');
    expect((init.headers as Record<string, string>)['X-Service-Auth']).toBe('test-service-auth');
    expect(JSON.parse(init.body as string)).toEqual({ tenantId: 'tenant-123', threadId: 'thread-123', holdId: HOLD, kind: 'handback' });
  });

  it('a 409 there is a 409 here; any other failure, or no answer, is a 503', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'handback_not_pending' }) } as never);
    expect(await verifyBrowserEvent(ctx, 'point', HOLD)).toEqual({ ok: false, status: 409 });
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as never);
    expect(await verifyBrowserEvent(ctx, 'handback', HOLD)).toEqual({ ok: false, status: 503 });
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await verifyBrowserEvent(ctx, 'handback', HOLD)).toEqual({ ok: false, status: 503 });
    // An answer naming another hold, or no event, is not a verification.
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ event: { kind: 'handback', holdId: 'other', action: null } }) } as never);
    expect(await verifyBrowserEvent(ctx, 'handback', HOLD)).toEqual({ ok: false, status: 503 });
  });

  it('a point carries the pointed-at control from the read', async () => {
    const action = { kind: 'point', url: 'https://a.example/', tag: 'a', role: 'link', name: 'Sports', inputType: '', at: '', value: '', valueDisposition: 'none', detail: '',
      urlTruncated: false, nameTruncated: false, valueTruncated: false, detailTruncated: false, urlProtectedDataOmitted: false, nameProtectedDataOmitted: false, detailProtectedDataOmitted: false };
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ event: { kind: 'point', holdId: HOLD, action } }) } as never);
    expect(await verifyBrowserEvent(ctx, 'point', HOLD)).toEqual({ ok: true, event: { kind: 'point', holdId: HOLD, action } });
  });
});
