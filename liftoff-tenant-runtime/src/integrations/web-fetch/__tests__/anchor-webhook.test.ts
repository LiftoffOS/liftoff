/**
 * Anchor webhook receiver — HMAC verification + envelope dispatch.
 *
 * Covers the security boundary (signature mismatch, length mismatch,
 * missing/invalid headers) plus the dispatch table:
 *   - intervention.requested → insertClarificationRow with anchor_intervention source
 *   - intervention.resolved → UPDATE agent_scheduled_invocations status='fired'
 *   - session.completed / session.failed → repo.closeSession + emit SESSION_CLOSED
 *   - duplicate envelope id → no-op
 *   - missing thread / missing invocation → log + no surface, no throw
 */
import crypto from 'node:crypto';

const recordWebhookEventMock = jest.fn();
const getByVendorSessionIdMock = jest.fn();
const closeSessionMock = jest.fn();
const setLastScreenshotMock = jest.fn();
const insertClarificationRowMock = jest.fn();
const emitBrowserSessionEventMock = jest.fn();
const poolQueryMock = jest.fn();
const poolConnectMock = jest.fn();

// Stubs for the dynamically-imported modules inside the idle_timeout final-
// frame capture branch. They have to be jest.mock'd at the file level (not
// re-required per test) so the runtime `await import(...)` inside the handler
// hits these instead of real Anchor/GCS clients.
const fetchScreenshotPngMock = jest.fn();
const uploadScreenshotMock = jest.fn();

jest.mock('../../../browser-sessions/repository', () => ({
  recordWebhookEvent: (...args: unknown[]) => recordWebhookEventMock(...args),
  getByVendorSessionId: (...args: unknown[]) => getByVendorSessionIdMock(...args),
  closeSession: (...args: unknown[]) => closeSessionMock(...args),
  setLastScreenshot: (...args: unknown[]) => setLastScreenshotMock(...args),
}));

jest.mock('../anchor-client', () => ({
  AnchorClient: jest.fn().mockImplementation(() => ({
    fetchScreenshotPng: (...args: unknown[]) => fetchScreenshotPngMock(...args),
  })),
}));

jest.mock('../../../browser-sessions/screenshot-storage', () => ({
  uploadScreenshot: (...args: unknown[]) => uploadScreenshotMock(...args),
}));

jest.mock('../../../browser-sessions/events', () => ({
  emitBrowserSessionEvent: (...args: unknown[]) => emitBrowserSessionEventMock(...args),
}));

jest.mock('../../../agent-execution/clarification-storage', () => ({
  insertClarificationRow: (...args: unknown[]) => insertClarificationRowMock(...args),
}));

jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({
    query: (...args: unknown[]) => poolQueryMock(...args),
    connect: () => poolConnectMock(),
  }),
}));

jest.mock('../../../infrastructure/logging', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { verifyAnchorSignature, handleAnchorEvent } from '../anchor-webhook';

const SECRET = 'test-secret-32-bytes-long-blah-blah';

function sign(body: string, timestamp: string, secret = SECRET): string {
  const expected = crypto.createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  return `v1=${expected}`;
}

describe('verifyAnchorSignature', () => {
  const body = Buffer.from('{"hello":"world"}', 'utf8');
  const ts = '1717977600';

  it('accepts a valid signature', () => {
    expect(verifyAnchorSignature(body, sign(body.toString('utf8'), ts), ts, SECRET)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const valid = sign(body.toString('utf8'), ts);
    const bad = valid.replace(/.$/, valid.endsWith('a') ? 'b' : 'a');
    expect(verifyAnchorSignature(body, bad, ts, SECRET)).toBe(false);
  });

  it('rejects when timestamp differs (HMAC envelope mismatch)', () => {
    const valid = sign(body.toString('utf8'), ts);
    expect(verifyAnchorSignature(body, valid, '1717977700', SECRET)).toBe(false);
  });

  it('rejects when body differs', () => {
    const valid = sign(body.toString('utf8'), ts);
    expect(verifyAnchorSignature(Buffer.from('{"hello":"galaxy"}'), valid, ts, SECRET)).toBe(false);
  });

  it('rejects malformed signature header (no v1= prefix)', () => {
    expect(verifyAnchorSignature(body, 'deadbeef', ts, SECRET)).toBe(false);
  });

  it('rejects when hex length differs (timingSafeEqual would throw)', () => {
    expect(verifyAnchorSignature(body, 'v1=abcd', ts, SECRET)).toBe(false);
  });
});

describe('handleAnchorEvent dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordWebhookEventMock.mockResolvedValue({ inserted: true });
  });

  it('drops duplicate envelopes (recordWebhookEvent returns inserted=false)', async () => {
    recordWebhookEventMock.mockResolvedValueOnce({ inserted: false });
    await handleAnchorEvent({
      id: 'evt-1',
      type: 'session.completed',
      created: '2026-06-10T00:00:00Z',
      project_id: 'p',
      data: { session_id: 's-1' },
    });
    expect(closeSessionMock).not.toHaveBeenCalled();
    expect(insertClarificationRowMock).not.toHaveBeenCalled();
  });

  describe('intervention.requested', () => {
    it('skips when no session row exists', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce(null);
      await handleAnchorEvent({
        id: 'evt-2',
        type: 'intervention.requested',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 's-2', request_id: 'req-2', message: 'q?' },
      });
      expect(insertClarificationRowMock).not.toHaveBeenCalled();
    });

    it('skips when session has no thread_id (unbound session)', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        tenantId: 't', agentId: 'a', threadId: null,
      });
      await handleAnchorEvent({
        id: 'evt-3',
        type: 'intervention.requested',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 's-3', request_id: 'req-3', message: 'q?' },
      });
      expect(insertClarificationRowMock).not.toHaveBeenCalled();
    });

    it('skips when no active invocation exists', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        tenantId: 't', agentId: 'a', threadId: 'th',
      });
      poolQueryMock.mockResolvedValueOnce({ rows: [] });
      await handleAnchorEvent({
        id: 'evt-4',
        type: 'intervention.requested',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 's-4', request_id: 'req-4', message: 'q?' },
      });
      expect(insertClarificationRowMock).not.toHaveBeenCalled();
    });

    it('inserts a clarification row with anchor_intervention source', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        tenantId: 't', agentId: 'a', threadId: 'th',
      });
      poolQueryMock.mockResolvedValueOnce({ rows: [{ id: 'inv-1' }] }); // active invocation
      const clientMock = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };
      poolConnectMock.mockResolvedValueOnce(clientMock);

      await handleAnchorEvent({
        id: 'evt-5',
        type: 'intervention.requested',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: {
          session_id: 's-5', request_id: 'req-5',
          message: 'Should I click the button?',
        },
      });

      expect(insertClarificationRowMock).toHaveBeenCalledTimes(1);
      const args = insertClarificationRowMock.mock.calls[0][0];
      expect(args.tenantId).toBe('t');
      expect(args.agentId).toBe('a');
      expect(args.invocationId).toBe('inv-1');
      expect(args.threadId).toBe('th');
      expect(args.question).toBe('Should I click the button?');
      expect(args.source).toEqual({ kind: 'anchor_intervention', vendorRequestId: 'req-5' });
      expect(args.pauseState).toBeNull();
      expect(clientMock.query).toHaveBeenCalledWith('BEGIN');
      expect(clientMock.query).toHaveBeenCalledWith('COMMIT');
      expect(clientMock.release).toHaveBeenCalled();
    });

    it('rolls back the transaction on failure', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        tenantId: 't', agentId: 'a', threadId: 'th',
      });
      poolQueryMock.mockResolvedValueOnce({ rows: [{ id: 'inv-2' }] });
      const clientMock = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };
      poolConnectMock.mockResolvedValueOnce(clientMock);
      insertClarificationRowMock.mockRejectedValueOnce(new Error('boom'));

      await expect(handleAnchorEvent({
        id: 'evt-6',
        type: 'intervention.requested',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 's-6', request_id: 'req-6', message: 'q?' },
      })).rejects.toThrow('boom');

      expect(clientMock.query).toHaveBeenCalledWith('ROLLBACK');
      expect(clientMock.release).toHaveBeenCalled();
    });
  });

  describe('intervention.resolved', () => {
    it('UPDATEs pending/resume_inflight clarifications matching the request_id', async () => {
      poolQueryMock.mockResolvedValueOnce({ rowCount: 1 });
      await handleAnchorEvent({
        id: 'evt-7',
        type: 'intervention.resolved',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 's-7', request_id: 'req-7' },
      });
      const call = poolQueryMock.mock.calls[0];
      expect(call[0]).toContain("SET status = 'fired'");
      expect(call[0]).toContain('vendor_request_id = $1');
      expect(call[0]).toContain("IN ('pending', 'resume_inflight')");
      expect(call[1]).toEqual(['req-7']);
    });
  });

  describe('session.completed / session.failed', () => {
    it('finds the row by the vendor id, closes it through the one writer, and emits SESSION_CLOSED', async () => {
      const sessionRow = {
        id: 'sid', tenantId: 't', agentId: 'a', threadId: 'th',
        vendor: 'anchor', vendorSessionId: 's-8', closedAt: null,
      };
      getByVendorSessionIdMock.mockResolvedValueOnce(sessionRow);
      closeSessionMock.mockResolvedValueOnce({ ...sessionRow, closedAt: new Date() });

      await handleAnchorEvent({
        id: 'evt-8',
        type: 'session.completed',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 's-8' },
      });

      expect(getByVendorSessionIdMock).toHaveBeenCalledWith('s-8');
      expect(closeSessionMock).toHaveBeenCalledWith('sid', 'completed');
      expect(emitBrowserSessionEventMock).toHaveBeenCalledTimes(1);
      expect(emitBrowserSessionEventMock.mock.calls[0][0].type).toBe('SESSION_CLOSED');
    });

    it('passes "failed" reason when type=session.failed', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', agentId: 'a', threadId: 'th',
        vendor: 'anchor', vendorSessionId: 's-9', closedAt: null,
      });
      closeSessionMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', agentId: 'a', threadId: 'th',
        vendor: 'anchor', vendorSessionId: 's-9',
      });
      await handleAnchorEvent({
        id: 'evt-9',
        type: 'session.failed',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 's-9' },
      });
      expect(closeSessionMock).toHaveBeenCalledWith('sid', 'failed');
    });

    it('skips emit when no matching session row found', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce(null);
      await handleAnchorEvent({
        id: 'evt-10',
        type: 'session.completed',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 'ghost' },
      });
      expect(closeSessionMock).not.toHaveBeenCalled();
      expect(emitBrowserSessionEventMock).not.toHaveBeenCalled();
    });

    it('closes nothing twice: a row already closed is left alone and emits nothing', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-again', closedAt: new Date(),
      });
      await handleAnchorEvent({
        id: 'evt-again',
        type: 'session.completed',
        created: '2026-06-10T00:00:00Z',
        project_id: 'p',
        data: { session_id: 's-again' },
      });
      expect(closeSessionMock).not.toHaveBeenCalled();
      expect(emitBrowserSessionEventMock).not.toHaveBeenCalled();
    });

    // Idle-timeout reaps are the common case for the paused-frame UX. If the
    // agent never called read_active_browser_session during the session, there
    // is no cached frame; the webhook makes one final best-effort capture
    // BEFORE closeSession so the frontend has something to render.
    it('captures a final screenshot when end_reason=idle_timeout and no prior frame exists', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-idle',
        lastScreenshotObjectPath: null,
      });
      fetchScreenshotPngMock.mockResolvedValueOnce(Buffer.from('fake-png'));
      uploadScreenshotMock.mockResolvedValueOnce({ objectPath: 'tenants/t/s-idle/final.png' });
      closeSessionMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-idle',
        closedReason: 'idle_timeout',
      });

      await handleAnchorEvent({
        id: 'evt-idle-1',
        type: 'session.completed',
        created: '2026-06-17T20:00:00Z',
        project_id: 'p',
        data: { session_id: 's-idle', end_reason: 'idle_timeout' },
      });

      expect(fetchScreenshotPngMock).toHaveBeenCalledWith('s-idle', 't');
      expect(uploadScreenshotMock).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 't', vendorSessionId: 's-idle',
      }));
      expect(setLastScreenshotMock).toHaveBeenCalledWith(
        's-idle', 'tenants/t/s-idle/final.png', expect.any(Date),
      );
      // closeSession STILL fires after the capture — the capture is a write-
      // through, not a gate.
      expect(closeSessionMock).toHaveBeenCalledWith('sid', 'idle_timeout');
    });

    it('skips the final-frame capture when the session already has a cached frame', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-cached',
        lastScreenshotObjectPath: 'tenants/t/s-cached/earlier.png',
      });
      closeSessionMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-cached',
      });

      await handleAnchorEvent({
        id: 'evt-idle-2',
        type: 'session.completed',
        created: '2026-06-17T20:00:00Z',
        project_id: 'p',
        data: { session_id: 's-cached', end_reason: 'idle_timeout' },
      });

      expect(fetchScreenshotPngMock).not.toHaveBeenCalled();
      expect(uploadScreenshotMock).not.toHaveBeenCalled();
      expect(setLastScreenshotMock).not.toHaveBeenCalled();
      expect(closeSessionMock).toHaveBeenCalledWith('sid', 'idle_timeout');
    });

    it('swallows final-frame capture failures so closeSession always fires', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-flaky',
        lastScreenshotObjectPath: null,
      });
      // Anchor session may already be unreachable when the webhook arrives;
      // simulate that here. The handler must not throw — closeSession has to
      // still record the close.
      fetchScreenshotPngMock.mockRejectedValueOnce(new Error('anchor 404 session gone'));
      closeSessionMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-flaky',
      });

      await expect(handleAnchorEvent({
        id: 'evt-idle-3',
        type: 'session.completed',
        created: '2026-06-17T20:00:00Z',
        project_id: 'p',
        data: { session_id: 's-flaky', end_reason: 'idle_timeout' },
      })).resolves.toBeUndefined();
      expect(setLastScreenshotMock).not.toHaveBeenCalled();
      expect(closeSessionMock).toHaveBeenCalledWith('sid', 'idle_timeout');
    });

    it('does not attempt a final capture when end_reason is NOT idle_timeout', async () => {
      getByVendorSessionIdMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-normal', lastScreenshotObjectPath: null, closedAt: null,
      });
      closeSessionMock.mockResolvedValueOnce({
        id: 'sid', tenantId: 't', vendorSessionId: 's-normal',
      });
      await handleAnchorEvent({
        id: 'evt-normal',
        type: 'session.completed',
        created: '2026-06-17T20:00:00Z',
        project_id: 'p',
        data: { session_id: 's-normal' }, // no end_reason
      });
      // The row is read once, to close it; no frame is fetched.
      expect(getByVendorSessionIdMock).toHaveBeenCalledTimes(1);
      expect(fetchScreenshotPngMock).not.toHaveBeenCalled();
      expect(uploadScreenshotMock).not.toHaveBeenCalled();
    });
  });

  it('records but otherwise ignores unknown event types (no throw)', async () => {
    await expect(handleAnchorEvent({
      id: 'evt-11',
      type: 'identity.authenticated',
      created: '2026-06-10T00:00:00Z',
      project_id: 'p',
      data: {},
    })).resolves.toBeUndefined();
  });
});
