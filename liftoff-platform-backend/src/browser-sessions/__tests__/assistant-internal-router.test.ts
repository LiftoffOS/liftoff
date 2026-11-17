// The browser, for the Chief AI Officer in another service: the detailed
// result's steps, completeness and safe-instruction fields pass through
// (null steps and a list alike), and the takeover read answers the person's
// segments oldest first, redacted, with the same auth and failure shape.

import express from 'express';
import { Code, ConnectError } from '@connectrpc/connect';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const executeDetailed = jest.fn();
jest.mock('../assistant-tools', () => ({
  ...jest.requireActual('../assistant-tools'),
  executeBrowserAssistantToolDetailed: (...a: unknown[]) => executeDetailed(...a),
}));
const readTakeoverActivity = jest.fn();
jest.mock('../takeover-activity', () => ({
  readTakeoverActivity: (...a: unknown[]) => readTakeoverActivity(...a),
}));
const verifyBrowserEvent = jest.fn();
jest.mock('../handback', () => ({
  ...jest.requireActual('../handback'),
  verifyBrowserEvent: (...a: unknown[]) => verifyBrowserEvent(...a),
}));
const buildAssistantBrowserState = jest.fn();
jest.mock('../browser-state', () => ({
  buildAssistantBrowserState: (...a: unknown[]) => buildAssistantBrowserState(...a),
}));

import { assistantBrowserInternalRouter } from '../assistant-internal-router';

const TOKEN = 'workforce-token-under-test';
const TENANT = '22222222-2222-2222-2222-222222222222';
const THREAD = '33333333-3333-3333-3333-333333333333';

function post(path: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use('/api/internal', express.json(), assistantBrowserInternalRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-service-auth': token } : {}) },
        body: JSON.stringify(body),
      })
        .then(async (res) => { const b = await res.json().catch(() => ({})); server.close(); resolve({ status: res.status, body: b as Record<string, unknown> }); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env['WORKFORCE_SERVICE_TOKEN'] = TOKEN;
});
afterAll(() => { delete process.env['WORKFORCE_SERVICE_TOKEN']; });

const detailed = (over: Record<string, unknown>) => ({
  content: 'The browser finished the task.',
  trail: { outcome: 'done', steps: null, stepsTruncated: false, captureGap: false, gapReason: '' },
  activityId: 'act-1', runtimeRecorded: true, legacyFallbackNeeded: false,
  safeInstruction: 'count the pull requests', instructionTruncated: false, instructionProtectedDataOmitted: false,
  ...over,
});

describe('POST /assistant-browser', () => {
  it('passes the steps, completeness and safe-instruction fields through: a list', async () => {
    const steps = [{ type: 'goto', action: 'https://a.example/', pageUrl: '', actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false, at: '2026-09-01T00:00:00.000Z' }];
    executeDetailed.mockResolvedValueOnce(detailed({
      trail: { outcome: 'done', steps, stepsTruncated: true, captureGap: true, gapReason: 'cap' },
      instructionTruncated: true, instructionProtectedDataOmitted: true, safeInstruction: 'count [redacted]',
    }));
    const res = await post('/assistant-browser', { tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task', input: { prompt: 'x' }, senderAccountId: '44444444-4444-4444-4444-444444444444' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'The browser finished the task.', steps, stepsTruncated: true, captureGap: true, gapReason: 'cap',
      safeInstruction: 'count [redacted]', instructionTruncated: true, instructionProtectedDataOmitted: true,
    });
    expect(executeDetailed).toHaveBeenCalledWith('run_browser_task', { prompt: 'x' }, {
      tenantId: TENANT, threadId: THREAD, surface: 'team_plan', senderAccountId: '44444444-4444-4444-4444-444444444444',
    });
  });

  it('passes null steps through for a tool with no observation mechanism', async () => {
    executeDetailed.mockResolvedValueOnce(detailed({}));
    const res = await post('/assistant-browser', { tenantId: TENANT, threadId: THREAD, tool: 'navigate_browser_session', input: { url: 'https://a.example' } }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body['steps']).toBeNull();
    expect(res.body['captureGap']).toBe(false);
  });

  it('refuses a bad token, a bad body and a non-browser tool', async () => {
    expect((await post('/assistant-browser', { tenantId: TENANT, threadId: THREAD, tool: 'run_browser_task' }, 'wrong')).status).toBe(401);
    expect((await post('/assistant-browser', { tenantId: 'nope', threadId: THREAD, tool: 'run_browser_task' }, TOKEN)).status).toBe(400);
    expect((await post('/assistant-browser', { tenantId: TENANT, threadId: THREAD, tool: 'get_cost_breakdown' }, TOKEN)).status).toBe(400);
    expect(executeDetailed).not.toHaveBeenCalled();
  });
});

describe('POST /assistant-browser/takeovers', () => {
  it('returns the redacted segments oldest first with the truncation flag', async () => {
    readTakeoverActivity.mockResolvedValueOnce({
      takeovers: [{ tool: 'person_takeover', startedAt: '2026-09-01T00:01:00.000Z', steps: [] }, { tool: 'person_takeover', startedAt: '2026-09-01T00:02:00.000Z', steps: [] }],
      truncated: true,
    });
    const res = await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD }, TOKEN);
    expect(res.status).toBe(200);
    expect(readTakeoverActivity).toHaveBeenCalledWith(TENANT, THREAD);
    expect((res.body['takeovers'] as Array<{ startedAt: string }>).map((t) => t.startedAt)).toEqual(['2026-09-01T00:01:00.000Z', '2026-09-01T00:02:00.000Z']);
    expect(res.body['truncated']).toBe(true);
  });

  it('an older runtime reads as no segments (the read maps Unimplemented itself)', async () => {
    readTakeoverActivity.mockResolvedValueOnce({ takeovers: [], truncated: false });
    const res = await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ takeovers: [], truncated: false });
  });

  it('any other runtime failure is 503, so the caller can say the segments were unavailable', async () => {
    readTakeoverActivity.mockRejectedValueOnce(new ConnectError('down', Code.Unavailable));
    const res = await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD }, TOKEN);
    expect(res.status).toBe(503);
    expect(res.body['error']).toMatch(/could not be read/);
  });

  it('refuses a bad token and a bad body', async () => {
    expect((await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD }, 'wrong')).status).toBe(401);
    expect((await post('/assistant-browser/takeovers', { tenantId: TENANT }, TOKEN)).status).toBe(400);
    expect(readTakeoverActivity).not.toHaveBeenCalled();
  });
});

describe('POST /assistant-browser/takeovers with holdId: the verification of a claimed event', () => {
  const HOLD = '55555555-5555-4555-8555-555555555555';

  it('answers the verified hand-back, and never reads the whole record', async () => {
    verifyBrowserEvent.mockResolvedValueOnce({ kind: 'handback', holdId: HOLD });
    const res = await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD, holdId: HOLD }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event: { kind: 'handback', holdId: HOLD } });
    expect(verifyBrowserEvent).toHaveBeenCalledWith(TENANT, THREAD, 'handback', HOLD);
    expect(readTakeoverActivity).not.toHaveBeenCalled();
  });

  // The Option-click gesture is gone from every client, and workforce-service
  // deploys on its own cadence. A build that still names 'point' gets the
  // honest answer — there is no such pending event — rather than a 400 that
  // reads like this endpoint broke.
  it('a caller still naming the retired point kind gets the 409, and the record is never read', async () => {
    const res = await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD, holdId: HOLD, kind: 'point' }, TOKEN);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'handback_not_pending' });
    expect(verifyBrowserEvent).not.toHaveBeenCalled();
    expect(readTakeoverActivity).not.toHaveBeenCalled();
  });

  it('a claim that does not check out is 409 handback_not_pending, as the stream routers answer', async () => {
    verifyBrowserEvent.mockResolvedValueOnce(null);
    const res = await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD, holdId: HOLD }, TOKEN);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'handback_not_pending' });
  });

  it('refuses a hold id that is not a UUID and a kind it does not know', async () => {
    expect((await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD, holdId: 'nope' }, TOKEN)).status).toBe(400);
    expect((await post('/assistant-browser/takeovers', { tenantId: TENANT, threadId: THREAD, holdId: HOLD, kind: 'wave' }, TOKEN)).status).toBe(400);
    expect(verifyBrowserEvent).not.toHaveBeenCalled();
  });
});

describe('POST /assistant-browser/state', () => {
  it('renders the Browser section for the thread from when the caller last spoke', async () => {
    buildAssistantBrowserState.mockResolvedValueOnce('## Browser\n\nThe browser beside this conversation is open on https://a.example/.');
    const res = await post('/assistant-browser/state', { tenantId: TENANT, threadId: THREAD, sinceLastReply: '2026-09-01T10:00:00.000Z' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ block: '## Browser\n\nThe browser beside this conversation is open on https://a.example/.' });
    expect(buildAssistantBrowserState).toHaveBeenCalledWith({ tenantId: TENANT, threadId: THREAD, sinceLastReply: '2026-09-01T10:00:00.000Z' });
  });

  it('a caller that has not spoken yet says so with null, or says nothing; the block is empty for a thread with no browser', async () => {
    buildAssistantBrowserState.mockResolvedValue('');
    let res = await post('/assistant-browser/state', { tenantId: TENANT, threadId: THREAD, sinceLastReply: null }, TOKEN);
    expect(res.body).toEqual({ block: '' });
    expect(buildAssistantBrowserState).toHaveBeenLastCalledWith({ tenantId: TENANT, threadId: THREAD, sinceLastReply: null });
    res = await post('/assistant-browser/state', { tenantId: TENANT, threadId: THREAD }, TOKEN);
    expect(buildAssistantBrowserState).toHaveBeenLastCalledWith({ tenantId: TENANT, threadId: THREAD, sinceLastReply: null });
  });

  it('refuses a bad token, a bad body and a malformed time', async () => {
    expect((await post('/assistant-browser/state', { tenantId: TENANT, threadId: THREAD }, 'wrong')).status).toBe(401);
    expect((await post('/assistant-browser/state', { tenantId: 'x', threadId: THREAD }, TOKEN)).status).toBe(400);
    expect((await post('/assistant-browser/state', { tenantId: TENANT, threadId: THREAD, sinceLastReply: 'yesterday' }, TOKEN)).status).toBe(400);
    expect(buildAssistantBrowserState).not.toHaveBeenCalled();
  });
});
