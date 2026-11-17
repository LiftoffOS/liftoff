// The recorder attached for the session's lifetime, on the pooled connection.
//
// A `/pause` used to connect afresh and install the recorder in every frame
// before it answered, several seconds on a news page, nearly
// all of it the attach. The recorder is now installed once per session on
// the ONE pooled CDP connection every pane operation shares
// (browser-sessions/cdp-page.ts), in an isolated world of its own, when the
// session is created and on the first pane operation of a session without
// one, and it stays for the session's lifetime. A pause on an instance with
// a warm capture then claims the hold's lease and starts writing; nothing
// connects and nothing installs.
//
// THE LEASE DOES NOT MOVE. Ownership of a hold is still the lease on the hold
// row (repository.ts): `claimCapture` grants it and returns the generation,
// `renewCapture` keeps it while this capture is attached, and every action
// is written through `insertAction` under the owner and generation, so a
// stale generation writes nothing. `recording` says which hold and
// generation this capture currently writes under; a row that arrives while
// it is null is dropped, because nobody holds the wheel and there is no
// segment to put it in. A disconnect releases the recorded hold as
// `lost_owner`, exactly as a HoldCapture does. An instance without a warm
// capture takes today's HoldCapture path, which stays as the fallback.
//
// The capture holds a reference on the pooled connection so the idle close
// leaves it alone; it lets go on `dropConnection`, on the session's close,
// and after SESSION_CAPTURE_IDLE_MS with no hold and no pane operation.

import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright-core';
import { logger } from '../../infrastructure/logging';
import type { BrowserSession, TakeoverHold } from '../types';
import { holdConnection, onPoolActivity, poolKeyFor, withPooledBrowser } from '../cdp-page';
import { CAPTURE_OWNER, CdpCapture, DEFAULT_CAPTURE_DEPS, type CaptureDeps, type FrameSession } from './index';
import { PAGE_READERS, sessionWorldNameFor } from './recorder';
import type { TakeoverActionRow } from './action';
import * as captureRepo from './repository';

/** A warm capture with no hold and no pane operation for this long lets
 *  the connection go. */
export const SESSION_CAPTURE_IDLE_MS = 15 * 60_000;

/** How long a warm attempt may take; the session is usable regardless. */
export const SESSION_CAPTURE_WARM_TIMEOUT_MS = 10_000;

/** How often the idle rule is checked. */
const IDLE_CHECK_INTERVAL_MS = 60_000;

/** Seams for the tests: how the pooled browser is reached. Production uses
 *  the pool. */
export interface SessionCaptureDeps extends CaptureDeps {
  /** The session's pooled browser, and the release of the reference this
   *  capture holds on it. */
  acquire: (session: BrowserSession, tenantId: string) => Promise<{ browser: Browser; release: () => void }>;
}

const defaultSessionDeps: SessionCaptureDeps = {
  ...DEFAULT_CAPTURE_DEPS,
  acquire: async (session, tenantId) => {
    const browser = await withPooledBrowser(
      session.vendor, session.vendorSessionId, tenantId, async (b) => b, 'warmSessionCapture',
    );
    return { browser, release: holdConnection(session.vendor, session.vendorSessionId) };
  },
};

/** How long the recorder needs to be installed into a document that has just
 *  replaced the one a context id named. */
export const LOST_CONTEXT_RETRY_MS = 200;

/** CDP's ways of saying the context the caller named is gone. In every one of
 *  them the expression never reached the page. */
const LOST_CONTEXT = /Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed|Target closed/i;

export function isLostContext(err: unknown): boolean {
  return LOST_CONTEXT.test(err instanceof Error ? err.message : String(err));
}

export class SessionCapture extends CdpCapture {
  readonly sessionId: string;
  readonly vendor: string;
  readonly vendorSessionId: string;
  readonly attemptId: string;
  /** The hold and generation this capture writes under, or null. */
  recording: { holdId: string; generation: number } | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private renewTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private releaseConnection: (() => void) | null = null;
  private lastActivityAt = Date.now();
  private ended = false;
  private capReported = false;
  /** A page, frame or main-frame world this capture could not observe since
   *  it attached. Every hold it later records is marked, because the segment
   *  is partial from its first action. */
  private partialSinceAttach = false;
  private partialReportedFor: string | null = null;

  constructor(
    tenantId: string,
    session: BrowserSession,
    attemptId: string,
    private readonly sessionDeps: SessionCaptureDeps,
  ) {
    super(tenantId, sessionWorldNameFor(session.id, attemptId), sessionDeps);
    this.sessionId = session.id;
    this.vendor = session.vendor;
    this.vendorSessionId = session.vendorSessionId;
    this.attemptId = attemptId;
  }

  get live(): boolean {
    return !this.aborted && !this.detaching && !this.ended;
  }

  /** Attach to the pooled browser and install everywhere, holding the
   *  connection open for as long as this capture lives. */
  async attach(session: BrowserSession): Promise<void> {
    const { browser, release } = await this.sessionDeps.acquire(session, this.tenantId);
    if (this.aborted) {
      release();
      return;
    }
    this.releaseConnection = release;
    await this.installEverywhere(browser);
    if (this.aborted) return;
    this.armIdle();
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  /** The main frame's world, for the page readers. Null when the page has
   *  no live world of ours (the install failed or the page is between
   *  documents). */
  get mainFrameId(): string | null {
    return this.mainWorld()?.frameId ?? null;
  }

  /** Whether a frame has a world of ours to evaluate in. */
  hasWorld(frameId: string): boolean {
    return this.worldFor(frameId) !== null;
  }

  /** Evaluate an expression in the world of one frame (the main frame by
   *  default) and answer its value. Throws when the frame has no world or
   *  the expression threw in the page. */
  async evaluate<T>(expression: string, frameId?: string): Promise<T> {
    this.touch();
    try {
      return await this.evaluateOnce<T>(expression, frameId);
    } catch (err) {
      if (!isLostContext(err)) throw err;
      // A context id names ONE document. A page that replaced its document
      // between the lookup and the send leaves the id pointing at nothing,
      // and CDP says so — but the expression NEVER RAN, so nothing in the
      // page happened and asking again is not asking twice. The recorder is
      // installed into each new document as it is created, so the world is
      // re-resolved (the registry is live) after a beat and the reader runs
      // in the document that is actually there.
      //
      // ONLY this error is retried. An expression that threw IN the page has
      // already run, and a reader that mutates — a focus, a select — must
      // never run a second time off the back of its own failure.
      await new Promise((r) => setTimeout(r, LOST_CONTEXT_RETRY_MS));
      return this.evaluateOnce<T>(expression, frameId);
    }
  }

  private async evaluateOnce<T>(expression: string, frameId?: string): Promise<T> {
    const world = frameId ? this.worldFor(frameId) : this.mainWorld();
    if (!world) throw new Error(frameId ? `frame ${frameId} has no recorder world` : 'the page has no recorder world');
    const result = await world.cdp.send('Runtime.evaluate', {
      expression, contextId: world.contextId, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`page reader failed: ${text}`);
    }
    return result.result.value as T;
  }

  /** The CDP frame id of a cross-origin iframe the walk met, by the index
   *  the walk gave it: the iframe element is fetched as a remote object from
   *  the world and described. Null when it cannot be resolved. */
  async frameIdOf(frameIndex: number, inFrameId?: string): Promise<string | null> {
    const world = inFrameId ? this.worldFor(inFrameId) : this.mainWorld();
    if (!world) return null;
    const handle = await world.cdp.send('Runtime.evaluate', {
      expression: `${PAGE_READERS}.frameElement(${Math.floor(frameIndex)})`,
      contextId: world.contextId, returnByValue: false,
    });
    const objectId = handle.result.objectId;
    if (!objectId) return null;
    try {
      const { node } = await world.cdp.send('DOM.describeNode', { objectId });
      return node.frameId ?? null;
    } catch {
      return null;
    } finally {
      await world.cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  /** Write under this hold from now on. The lease was claimed by the caller;
   *  a partial attachment already seen marks the hold at once. */
  startRecording(hold: TakeoverHold, generation: number): void {
    this.touch();
    this.recording = { holdId: hold.id, generation };
    this.capReported = false;
    if (this.partialSinceAttach) this.reportPartial(hold.id, 'attach', 'the recorder is partial on this session');
    this.startRenewing();
  }

  /** Stop writing: the hold ended or another generation owns it. The hold
   *  itself is never closed from here; that is state-driven. */
  stopRecording(): void {
    this.recording = null;
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    this.touch();
  }

  private reportPartial(holdId: string, what: string, err: string): void {
    if (this.partialReportedFor === holdId) return;
    this.partialReportedFor = holdId;
    logger.info({ hold_id: holdId, session_id: this.sessionId, what, err, event: 'takeover_capture_partial' },
      'takeover capture: part of the session is not observed; the hold is marked frame_unavailable');
    this.writes = this.writes.then(async () => {
      try {
        await captureRepo.markCaptureGap(this.tenantId, holdId, 'frame_unavailable');
      } catch (e) {
        logger.warn({ hold_id: holdId, err: (e as Error).message, event: 'takeover_capture_gap_mark_failed' },
          'takeover capture: could not mark the hold frame_unavailable');
      }
    });
  }

  protected onPartialAttach(what: 'page' | 'frame' | 'main_frame_world', err: string): void {
    this.partialSinceAttach = true;
    const rec = this.recording;
    if (rec) this.reportPartial(rec.holdId, what, err);
  }

  /** Exactly what a HoldCapture writes, under the hold this capture records;
   *  a row with no hold to go to is dropped. Serialised per capture so `at`
   *  follows arrival order. */
  protected sink(row: TakeoverActionRow): void {
    this.touch();
    const rec = this.recording;
    if (!rec) return;
    this.writes = this.writes.then(async () => {
      if (this.recording !== rec || !this.live) return;
      try {
        const outcome = await captureRepo.insertAction(
          this.tenantId, rec.holdId, CAPTURE_OWNER, rec.generation, row,
        );
        if (outcome === 'stale') {
          // The hold ended or another generation owns it now: stop writing,
          // keep the recorder, never close the hold from here.
          if (this.recording === rec) this.stopRecording();
        } else if (outcome === 'capped' && !this.capReported) {
          this.capReported = true;
          logger.info({ hold_id: rec.holdId, event: 'takeover_capture_capped' },
            'takeover capture: the hold reached its action cap; further actions are not recorded');
        }
      } catch (err) {
        logger.warn({ hold_id: rec.holdId, err: (err as Error).message, event: 'takeover_capture_write_failed' },
          'takeover capture: an action was not recorded');
      }
    });
  }

  private startRenewing(): void {
    if (this.renewTimer) return;
    this.renewTimer = setInterval(() => { void this.renew(); }, this.deps.renewIntervalMs);
    this.renewTimer.unref?.();
  }

  /** Renew only while attached with the recorder installed; a lease held by
   *  a process that is not observing would be a lie the next claim reads. */
  private async renew(): Promise<void> {
    const rec = this.recording;
    if (!rec || !this.attached) return;
    let kept = false;
    try {
      kept = await captureRepo.renewCapture(this.tenantId, rec.holdId, CAPTURE_OWNER, rec.generation);
    } catch (err) {
      logger.warn({ hold_id: rec.holdId, err: (err as Error).message, event: 'takeover_capture_renew_failed' },
        'takeover capture: lease renewal failed; retrying on the next tick');
      return;
    }
    if (!kept && this.recording === rec) this.stopRecording();
  }

  private armIdle(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      if (this.recording) return;
      if (Date.now() - this.lastActivityAt < SESSION_CAPTURE_IDLE_MS) return;
      void this.end('idle');
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref?.();
  }

  /** The connection went away: the hold being recorded, if any, loses its
   *  observer and says so; the capture is over. */
  protected onDisconnected(): void {
    if (this.detaching || this.aborted) return;
    void this.lostConnection('lost_owner');
  }

  protected onLastPageClosed(): void {
    void this.lostConnection('lost_owner');
  }

  private async lostConnection(reason: 'never_attached' | 'lost_owner'): Promise<void> {
    const rec = this.recording;
    if (rec) {
      this.stopRecording();
      try {
        await captureRepo.releaseCapture(this.tenantId, rec.holdId, CAPTURE_OWNER, rec.generation, reason);
      } catch (err) {
        logger.warn({ hold_id: rec.holdId, err: (err as Error).message, event: 'takeover_capture_release_failed' },
          'takeover capture: lease release failed; the lease will lapse on its own');
      }
      logger.info({ hold_id: rec.holdId, generation: rec.generation, reason, event: 'takeover_capture_released' },
        'takeover capture: lease released');
    }
    await this.end('disconnected');
  }

  /** Let the connection go and leave the registry. Idempotent. A hold being
   *  recorded keeps its lease until it lapses or the next claim: the caller
   *  that ends a live capture (a session close) has already ended the hold. */
  async end(why: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.detaching = true;
    this.stopRecording();
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    await this.closeBrowser();
    if (warm.get(this.sessionId) === this) warm.delete(this.sessionId);
    logger.info({ session_id: this.sessionId, why, event: 'session_capture_ended' }, 'session capture ended');
  }

  /** The connection is shared: detach this capture's own CDP sessions, and
   *  release the reference that kept the connection past its idle window.
   *  The browser itself stays connected for the pane operations. */
  protected async releaseBrowser(_browser: Browser, sessions: FrameSession[]): Promise<void> {
    await Promise.all(sessions.map((fs) => fs.cdp.detach().catch(() => undefined)));
    const release = this.releaseConnection;
    this.releaseConnection = null;
    release?.();
  }
}

/** Warm captures this process holds, by session id. */
const warm = new Map<string, SessionCapture>();

// A pane operation on the session counts as activity for the idle rule.
onPoolActivity((key) => {
  for (const capture of warm.values()) {
    if (poolKeyFor(capture.vendor, capture.vendorSessionId) === key) capture.touch();
  }
});

export function warmCaptureFor(sessionId: string): SessionCapture | null {
  const capture = warm.get(sessionId);
  return capture && capture.live ? capture : null;
}

export function hasWarmSessionCapture(sessionId: string): boolean {
  return warmCaptureFor(sessionId) !== null;
}

/**
 * Attach the recorder for the session's lifetime, if this process has not
 * already. Fire-and-forget by every caller: never throws, never blocks the
 * session, and a warm attempt that fails or times out leaves nothing behind
 * (the next pause takes the HoldCapture path). Bounded by `timeoutMs`.
 */
export async function warmSessionCapture(
  input: { tenantId: string; session: BrowserSession },
  opts: { timeoutMs?: number; deps?: Partial<SessionCaptureDeps> } = {},
): Promise<void> {
  const { tenantId, session } = input;
  const { takeoverCaptureEnabled } = await import('./index');
  if (!takeoverCaptureEnabled()) return;
  if (session.closedAt) return;
  const existing = warm.get(session.id);
  if (existing && existing.live) return;
  const deps: SessionCaptureDeps = { ...defaultSessionDeps, ...(opts.deps ?? {}) };
  const timeoutMs = opts.timeoutMs ?? SESSION_CAPTURE_WARM_TIMEOUT_MS;
  const capture = new SessionCapture(tenantId, session, randomUUID(), deps);
  warm.set(session.id, capture);
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      capture.attach(session).then(() => 'attached' as const),
      timeout,
    ]);
    if (outcome === 'timeout') {
      capture.abort();
      logger.warn({ session_id: session.id, timeout_ms: timeoutMs, event: 'session_capture_warm_timeout' },
        'session capture: warm attach did not complete in time');
      await capture.end('timeout');
      return;
    }
    logger.info({ session_id: session.id, vendor: session.vendor, event: 'session_capture_warm' },
      'session capture: recorder attached for the session');
  } catch (err) {
    logger.warn({ session_id: session.id, err: (err as Error).message, event: 'session_capture_warm_failed' },
      'session capture: warm attach failed');
    await capture.end('failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Let a session's warm capture go: from the session's close. */
export async function endWarmSessionCapture(sessionId: string, why = 'session_closed'): Promise<void> {
  const capture = warm.get(sessionId);
  if (!capture) return;
  await capture.end(why);
}

/** For tests: the warm captures recording a hold, by hold id. */
export function _recordingSessionCaptures(): ReadonlyMap<string, { holdId: string; generation: number; attached: boolean }> {
  const out = new Map<string, { holdId: string; generation: number; attached: boolean }>();
  for (const capture of warm.values()) {
    if (capture.recording) {
      out.set(capture.recording.holdId, { holdId: capture.recording.holdId, generation: capture.recording.generation, attached: capture.attached });
    }
  }
  return out;
}

/** For tests: every warm capture, by session id. */
export function _warmSessionCaptures(): ReadonlyMap<string, { attached: boolean; live: boolean; recording: { holdId: string; generation: number } | null; world: string }> {
  return new Map([...warm.entries()].map(([id, c]) => [id, {
    attached: c.attached, live: c.live, recording: c.recording, world: sessionWorldNameFor(c.sessionId, c.attemptId),
  }]));
}

/** For tests: end every warm capture without touching the holds. */
export async function _endAllSessionCaptures(): Promise<void> {
  await Promise.all([...warm.values()].map((c) => c.end('test')));
  warm.clear();
}
