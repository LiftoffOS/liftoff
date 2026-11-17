// Domain types for the BrowserSessionsService surface — mirrors the
// liftoff/platform/v1/browser_sessions.proto messages and is mapped into
// proto wire types inside service.ts's `toProto` helper.

// Enum mirror of the web_sessions.closed_reason CHECK constraint added in
// migration 280. NULL while the session is open. `closeSession` accepts the
// same union as its `reason` parameter.
export type BrowserSessionClosedReason =
  | 'completed'
  | 'failed'
  | 'idle_timeout'
  | 'user_ended'
  /** A run-owned session, closed because the run that opened it ended. */
  | 'run_ended'
  | 'migration_cleanup';

/** The `agent_id` a session carries when no agent owns it.
 *
 *  `web_sessions.agent_id` is `UUID NOT NULL` and carries a UNIQUE constraint
 *  with `caller_session_id`, so "no agent" cannot be spelled as NULL without
 *  losing that uniqueness (Postgres treats NULLs as distinct) and rewriting
 *  every `agent_id = $n` lookup, the takeover gate included. The nil UUID keeps
 *  equality semantics intact and is how this codebase already spells an absent
 *  agent elsewhere — see `GLOBAL_TENANT_SENTINEL` in
 *  integrations/web-fetch/global-flags.ts and the agentId fallback in
 *  memory/embedding.ts.
 *
 *  It means the session belongs to a PLATFORM ASSISTANT — Liftoff, the Insights
 *  Manager, the Chief AI Officer — which runs in another service and has no
 *  agent row anywhere to name. It is never a real agent, and a lookup of it
 *  correctly matches none.
 *
 *  Vendor selection must read it as "no opinion about connectors", not as
 *  "bound to nothing": the second would skip a workspace's own browser key and
 *  bill it a second time for a browser it already funds. selectSessionVendor is
 *  passed undefined rather than this value for exactly that reason. */
export const NO_AGENT_SENTINEL = '00000000-0000-0000-0000-000000000000';

/** Longest page title kept anywhere a title lands: the navigation helper's
 *  result, the cached title beside current_url, a snapshot's title. */
export const PAGE_TITLE_CAP = 400;

export interface BrowserSession {
  id: string;
  tenantId: string;
  agentId: string;
  threadId: string | null;
  /** The run that opened this session, when a run rather than a thread did.
   *  Null for a pane session. Exactly one of threadId / invocationId is set. */
  invocationId: string | null;
  vendor: string;                  // 'anchor' | 'browserbase' | 'steel' | 'browser_use'
  vendorSessionId: string;
  liveViewUrl: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  closedAt: Date | null;
  closedReason: BrowserSessionClosedReason | null;
  takeoverState: 'none' | 'taken_over';
  takenOverAt: Date | null;
  ownerAccountId: string | null;
  callerSessionId: string | null;
  currentUrl: string | null;
  // GCS object path of the most recently captured screenshot for this session.
  // Written by read_active_browser_session (every agent turn that inspects the
  // browser) and by a best-effort capture in the anchor session-end webhook.
  // The proto mapper re-signs this on every read into last_screenshot_signed_url
  // (10 min TTL) so consumers always get a fresh signed URL.
  lastScreenshotObjectPath: string | null;
  lastScreenshotAt: Date | null;
  /** The viewport the pane last reported (SetViewport), from
   *  vendor_metadata.viewport; absent or null means the pane default. */
  viewport?: { width: number; height: number } | null;
  /** When the cached current_url was written, from
   *  vendor_metadata.current_url_at; null on a row from before it was stamped. */
  currentUrlAt?: Date | null;
  /** The page's title beside current_url, bounded and redacted. */
  currentTitle?: string | null;
  /** The last reading of the page's controls (pane-actions.ts), from
   *  vendor_metadata.page_snapshot; what an action's snapshot id is checked
   *  against. */
  pageSnapshot?: StoredPageSnapshot | null;
  /** The task that stopped on this session without finishing, if one did. */
  parkedTask?: ParkedBrowserTask | null;
  /** The task that outlived the call that started it, once it has finished. */
  carriedOnTask?: CarriedOnTask | null;
  /** Where to report when a carried-on task finishes. */
  reportFinishTo?: ReportFinishTo | null;
}

/** The identity of one listed control, as the snapshot keeps it: recomputed
 *  from the DOM on every use, never a node handle. */
export interface StoredSnapshotControl {
  ref: string;
  role: string;
  name: string;
  nth: number;
  /** What the control is and what it currently holds, as the reading showed
   *  it. Kept so a later act can put the page in front of a model the way
   *  the reference loop's element table does: a control's current value is
   *  what tells "the destination field" from "the origin field" when both
   *  are named the same. Optional: a reading taken before these were kept
   *  has none, and resolves on role and name alone.
   *
   *  `valueState` is the projection a person may see, not the raw value:
   *  the same redaction the reading itself publishes, so a password's
   *  contents cannot reach a request from here. */
  inputType?: string;
  valueState?: string;
  disabled?: boolean;
  /** The CDP frame the control was found in; null for the main document
   *  space (the main frame and its same-origin frames). */
  frameId: string | null;
}

/**
 * A browser task that stopped without finishing, kept so the next run of the
 * same task starts from where it got to.
 *
 * A stopped task used to leave nothing behind but the page. The session and
 * the page persisted, so the browser still sat on the half-filled form, and
 * the next task started with no idea which of those fields it had filled --
 * which is how a task repeats an action it already took. On anything that
 * submits, orders or pays, repeating an action is not a wasted step.
 *
 * Bytes are not kept and neither is anything typed: the actions are what the
 * trail already records, and `typed` says a literal went in without saying
 * what it was.
 */
/**
 * A browser task that stopped without finishing, kept so the next run of the
 * same task starts from where it got to.
 *
 * A stopped task used to leave nothing behind but the page. The session and
 * the page persisted, so the browser still sat on the half-filled form, and
 * the next task started with no idea which of those fields it had filled --
 * which is how a task repeats an action it already took. On anything that
 * submits, orders or pays, a repeated action is not a wasted step.
 *
 * Nothing typed is kept: the actions are what the trail already records, and
 * `typed` says a literal went in without saying what it was.
 */
export interface ParkedBrowserTask {
  /** The objective the stopped run was given. A later run resumes from this
   *  only when it is working on the same thing. */
  objective: string;
  constraints: string[];
  /** What the stopped run did, oldest first, bounded. */
  actions: Array<{
    step: number;
    action: string;
    kind: string;
    url: string;
    pageChanged: boolean | null;
    typed: boolean;
  }>;
  /** Why it stopped, for the record. */
  reason: string;
  /** ISO 8601. A park older than the window is not resumed. */
  parkedAt: string;
  /** Where the work IS: the page the task was on when it stopped. For a job a
   *  site runs on its own, this address is the durable handle — a generator
   *  puts the job's id in it, so the job can be found again from nothing but
   *  this, long after the page state is gone. A stopped task used to leave
   *  only what it had done, which cannot be gone back to. */
  pageUrl?: string;
  /** The files that were on that page, by address. What the task produced, as
   *  far as it got. */
  files?: string[];
}

/** The result of a browser task that outlived the call that started it.
 *
 *  On the session's row rather than in a process, because there is more than
 *  one instance and the turn that comes back for it lands on whichever
 *  answers. Held in a process, it would have told that turn the task was
 *  still running forever — the exact failure the carrying-on removes. */
export interface CarriedOnTask {
  taskId: string;
  status: string;
  /** The task's own closing words, as the model reads them. */
  message: string;
  reason: string;
  /** ISO 8601. Past the keeping window it reads as absent. */
  finishedAt: string;
}

/**
 * Where a carried-on task reports when it finishes.
 *
 * A task finishing is an EVENT. Parking the result until somebody next
 * speaks made the person the delivery mechanism: they were told to send a
 * message so the work could be picked up.
 *
 * It is kept on the session's row rather than passed down with the task
 * because the layer that knows all of this — which thread, which agent or
 * which assistant, who was speaking — is the one that dispatches the task,
 * several layers above the one that watches it finish, and each vendor's
 * client sits in between. The row is already how the RESULT crosses that
 * distance, and it survives the instance either way.
 */
export interface ReportFinishTo {
  threadId: string;
  /** The agent whose thread it is, or NO_AGENT_SENTINEL for one of the
   *  three assistants — whose threads live in the control plane, and wake by
   *  its rails rather than this service's. */
  agentId: string;
  /** Which assistant, when no agent owns it: 'liftoff', 'insights',
   *  'team_plan'. Absent for an agent. */
  assistant?: string;
  /** The public-facing id of the agent, which its wake needs and its
   *  runtime id is not. */
  internalAgentId?: string;
  /** The turn that set the task going. */
  invocationId?: string;
  /** Who was speaking, so the woken turn is attributed to them. */
  senderAccountId?: string;
  senderUserId?: string;
}

export interface StoredPageSnapshot {
  id: string;
  /** The safe projection of the page's address when the reading was taken. */
  url: string;
  /** The page's title when the reading was taken. Optional: a reading taken
   *  before it was kept has none. What a page calls itself is often the only
   *  thing that separates two controls named the same. */
  title?: string;
  takenAt: string;
  controls: StoredSnapshotControl[];
}

export type BrowserSessionEventType =
  | 'SESSION_CREATED'
  | 'SESSION_UPDATED'
  | 'SESSION_CLOSED';

export interface BrowserSessionEvent {
  type: BrowserSessionEventType;
  session: BrowserSession;
  emittedAt: Date;
}

/** One takeover of a session by a person (browser_takeover_holds, migration
 *  418): opened on the none -> taken_over transition, ended by the release,
 *  the control plane's absent-driver sweep, the runtime's gate expiry or the
 *  session closing. The capture columns say which process is recording it. */
export interface TakeoverHold {
  id: string;
  tenantId: string;
  sessionId: string;
  threadId: string | null;
  /** 'takeover' for a hold the person drove; 'point' for a zero-length hold
   *  recording one control they pointed at without taking over (432). */
  kind: 'takeover' | 'point';
  startedAt: Date;
  endedAt: Date | null;
  endReason: 'released' | 'absent_driver' | 'expired' | 'session_closed' | null;
  captureOwner: string | null;
  captureGeneration: number;
  captureLeaseUntil: Date | null;
  /** A KNOWN interruption of observation, and only that. */
  captureGap: boolean;
  gapReason: 'lost_owner' | 'cap' | 'disabled' | 'never_attached' | 'frame_unavailable' | null;
}
