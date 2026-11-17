import { http, HttpResponse } from 'msw';
import type { BrowserSession } from '../../types/browserSession';

let mockSession: BrowserSession | null = null;

export const browserSessionsHandlers = [
  http.get('*/api/threads/:threadId/browser-sessions/active', () => {
    return HttpResponse.json({ session: mockSession, lastClosedSession: null });
  }),
  http.post('*/api/threads/:threadId/browser-sessions/ensure', ({ params }) => {
    if (mockSession) {
      return HttpResponse.json({
        session: mockSession, wasNewlyCreated: false,
        error: null, lastClosedSession: null,
      });
    }
    mockSession = {
      id: 'mock-session-id',
      tenantId: 'mock-tenant',
      agentId: 'mock-agent',
      threadId: params.threadId as string,
      ownerAccountId: null,
      owner: null,
      driver: null,
      vendor: 'anchor',
      vendorSessionId: 'mock-vendor-id',
      liveViewUrl: 'about:blank',
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      closedAt: null,
      closedReason: null,
      takeoverState: 'none',
      takenOverAt: null,
      currentUrl: null,
      lastScreenshotSignedUrl: '',
      lastScreenshotAt: null,
    };
    return HttpResponse.json({
      session: mockSession, wasNewlyCreated: true,
      error: null, lastClosedSession: null,
    });
  }),
  http.post('*/api/browser-sessions/:sessionId/goto', () => {
    return HttpResponse.json({ session: mockSession });
  }),
  http.post('*/api/browser-sessions/:sessionId/end', () => {
    const closed = mockSession
      ? { ...mockSession, closedAt: new Date().toISOString() }
      : null;
    mockSession = null;
    return HttpResponse.json({ session: closed });
  }),
  // SSE stub — frontend just relies on the polling backstop when SSE returns nothing.
  http.get('*/api/threads/:threadId/browser-sessions/stream', () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
