// The human driving this browser, resolved server-side from ownerAccountId.
// Null for legacy/web_task rows and when the account no longer resolves.
// Shape matches AvatarPerson so UserAvatar renders it directly.
export interface BrowserSessionOwner {
  accountId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
}

/** The human currently driving, when one has taken control. Distinct from
 *  `owner`, which is only who created the session. `present` is three-valued
 *  on the wire: true while their chat presence on this surface is fresh,
 *  false once it has gone stale (control is theirs in name only, and the
 *  server releases it), and null when presence could not be read, which
 *  nothing acts on. */
export interface BrowserSessionDriver extends BrowserSessionOwner {
  takenAt: string;
  present: boolean | null;
}

/** Whether this viewer is the one driving the session: a takeover is in
 *  force and its recorded driver is them. One definition for the pane's
 *  control model and for the presence seat that keeps the wheel. */
export function isDrivingSession(
  session: { takeoverState?: BrowserSession['takeoverState']; driver?: BrowserSessionDriver | null } | null | undefined,
  viewerAccountId: string | null | undefined,
): boolean {
  if (!session || session.takeoverState !== 'taken_over' || !session.driver) return false
  return !!viewerAccountId && session.driver.accountId === viewerAccountId
}

export interface BrowserSession {
  id: string;
  tenantId: string;
  agentId: string;
  threadId: string;
  ownerAccountId: string | null;  // null for legacy/web_task rows.
  owner: BrowserSessionOwner | null;
  driver: BrowserSessionDriver | null;
  vendor: 'anchor';
  vendorSessionId: string;
  liveViewUrl: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  closedAt: string | null;
  closedReason: BrowserSessionClosedReason | null;
  takeoverState: 'none' | 'taken_over';
  takenOverAt: string | null;
  currentUrl: string | null;  // last-known URL; mirrored to localStorage for restore.
  // Re-signed by the backend on every read (10 min TTL). Empty string when no
  // screenshot was ever captured for this session — the backend serializes
  // unset proto strings as empty, not undefined, so the consumer null-checks
  // both "missing field" and "empty string".
  lastScreenshotSignedUrl: string;
  lastScreenshotAt: string | null;
  /** The agent or assistant asked the person to take the browser over, and
   *  the request is still open: when it asked. The pane says so; the reason
   *  is the assistant's and reaches the person through its own reply. Null
   *  when nothing is asked; absent from an older backend. */
  intervention?: { requestedAt: string } | null;
}

/** The size of the page the runtime's browser renders, in CSS pixels. The
 *  pane measures itself and sends it, so the live view is the pane's size
 *  rather than a constant scaled to fit. */
export interface BrowserViewport {
  width: number;
  height: number;
}


/** What handing the browser back answers: the session, the hold the release
 *  ended (null when none was open), and whether the caller was the recorded
 *  driver, which is what makes the hand-back theirs to announce in the chat. */
export interface ReleaseControlResponse {
  session: BrowserSession | null;
  holdId: string | null;
  releasedByDriver: boolean;
}

// Mirrors the web_sessions.closed_reason CHECK constraint in tenant-runtime.
// Drives the paused-frame UX: only `idle_timeout` carries a "session paused"
// connotation that's safe to show the user.
export type BrowserSessionClosedReason =
  | 'completed'
  | 'failed'
  | 'idle_timeout'
  | 'user_ended'
  | 'migration_cleanup';

// Typed envelope for classified ensure failures, returned on HTTP 200 with
// `error.kind` set instead of an HTTP 5xx. The frontend pattern-matches on
// kind to pick the user-facing copy; message is included for log visibility,
// NOT shown verbatim to end users.
export interface EnsureSessionError {
  kind: 'anchor_unavailable' | 'quota_exceeded' | 'invalid_key' | 'unknown';
  message: string;
}

export interface EnsureSessionResponse {
  session: BrowserSession | null;
  wasNewlyCreated: boolean;
  error: EnsureSessionError | null;
  lastClosedSession: BrowserSession | null;
}

export interface GetActiveSessionResponse {
  session: BrowserSession | null;
  lastClosedSession: BrowserSession | null;
}
