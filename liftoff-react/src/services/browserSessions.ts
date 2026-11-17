import { api } from './api';
import type {
  BrowserSession,
  BrowserViewport,
  EnsureSessionResponse,
  GetActiveSessionResponse,
  
  ReleaseControlResponse,
} from '../types/browserSession';

/** Which chat surface the thread belongs to, and so which table the backend
 *  looks it up in. Threads live in a different table per surface, and the same
 *  UUID could in principle exist on two of them, so the surface is stated
 *  rather than searched for.
 *
 *  Omitted means agent chat, which was the only surface with a pane. */
export type BrowserThreadSurface = 'agent' | 'liftoff' | 'insights' | 'team_plan';

function surfaceParam(surface?: BrowserThreadSurface): string {
  return surface && surface !== 'agent' ? `&surface=${surface}` : '';
}

export async function ensureSession(
  tenantId: string, threadId: string,
  /** Null on the platform assistants: Liftoff, the Insights Manager and the
   *  Chief AI Officer have no agent row to name. The backend requires one on
   *  agent chat and refuses it there if absent, because an agent's session must
   *  be spawned against its own connector bindings. */
  agentId: string | null,
  surface?: BrowserThreadSurface,
  /** The pane's size at the moment it asked, so a session spawned for it is
   *  the pane's size from its first frame. Absent before the pane has
   *  measured itself. */
  viewport?: BrowserViewport | null,
): Promise<EnsureSessionResponse> {
  return api.post(
    `/api/threads/${threadId}/browser-sessions/ensure?tenantId=${tenantId}${surfaceParam(surface)}`,
    { ...(agentId ? { agentId } : {}), ...(viewport ? { viewport } : {}) },
  );
}

/** The pane's size after a resize, applied to the page and kept by the
 *  runtime for the next screenshot. */
export async function setViewport(
  tenantId: string, threadId: string, sessionId: string,
  viewport: BrowserViewport, surface?: BrowserThreadSurface,
): Promise<{ applied: BrowserViewport | null }> {
  return api.post(
    `/api/threads/${threadId}/browser-sessions/${sessionId}/viewport?tenantId=${tenantId}${surfaceParam(surface)}`,
    { viewport },
  );
}

/** A point in the live view, as fractions of the observer layer the person
 *  clicked in, with that layer's size so the runtime can map it onto its
 *  viewport. A 409 carries the refusal's kind (`outside_page`,
 *  `person_driving`); the page treats it as quiet. */

export async function getActiveSession(
  tenantId: string, threadId: string, surface?: BrowserThreadSurface,
): Promise<GetActiveSessionResponse> {
  // Backend now ALWAYS returns 200 — both session and lastClosedSession are
  // optional. The old 404-on-no-session contract is gone; the frontend
  // null-checks `session`. The catch-and-normalize block was removed with it.
  return api.get(
    `/api/threads/${threadId}/browser-sessions/active?tenantId=${tenantId}${surfaceParam(surface)}`,
  );
}

export async function endSession(
  tenantId: string, sessionId: string,
): Promise<{ session: BrowserSession }> {
  return api.post(
    `/api/browser-sessions/${sessionId}/end?tenantId=${tenantId}`,
  );
}

export async function goto(
  tenantId: string, sessionId: string, url: string,
): Promise<{ session: BrowserSession }> {
  return api.post(
    `/api/browser-sessions/${sessionId}/goto?tenantId=${tenantId}`,
    { url },
  );
}

export interface PageState {
  url: string;
  screenshotSignedUrl: string;
  signedUrlExpiresAt: string | null;
}

export async function getPageState(
  tenantId: string, sessionId: string,
): Promise<PageState> {
  return api.get(
    `/api/browser-sessions/${sessionId}/page-state?tenantId=${tenantId}`,
  );
}

/**
 * Take the wheel. The backend pauses Anchor's in-session agent and sets
 * takeover_state, which blocks the agent's browser tools at dispatch, then
 * records the caller as the driver.
 */
export async function takeControl(
  tenantId: string,
  sessionId: string,
  /** The thread the session belongs to and its surface, so the backend can
   *  read the runtime's state before it claims the wheel: another person who
   *  is present and still holds it answers 409 `held_by_other`. */
  thread?: { threadId: string; surface?: BrowserThreadSurface },
): Promise<{ session: BrowserSession | null }> {
  const threadParams = thread
    ? `&threadId=${thread.threadId}${thread.surface ? `&surface=${thread.surface}` : ''}`
    : ''
  return await api.post<{ session: BrowserSession | null }>(
    `/api/browser-sessions/${sessionId}/pause?tenantId=${tenantId}${threadParams}`,
  )
}

/** Hand it back to the agent. The answer names the hold the release ended
 *  and whether this caller was the recorded driver: only then is the
 *  hand-back theirs to send into the conversation as a turn. */
export async function releaseControl(
  tenantId: string,
  sessionId: string,
): Promise<ReleaseControlResponse> {
  const res = await api.post<{ session: BrowserSession | null; holdId?: string | null; releasedByDriver?: boolean }>(
    `/api/browser-sessions/${sessionId}/resume?tenantId=${tenantId}`,
  )
  return {
    session: res.session,
    holdId: res.holdId ?? null,
    releasedByDriver: res.releasedByDriver === true,
  }
}
