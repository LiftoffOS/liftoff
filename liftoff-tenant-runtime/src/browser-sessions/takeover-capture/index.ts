// Takeover capture: one process attaches to the browser a person is driving
// and records what they do, for the record of the conversation. And task
// capture: the same recorder attached for the length of one in-session agent
// task, so the assistant's own steps are observed from the DOM rather than
// inferred from vendor prose.
//
// A hold (browser_takeover_holds) opens when a person takes control of a
// thread's browser. While it is open, exactly ONE process holds its capture
// lease, connects to the session over CDP, installs the recorder in an
// isolated world of every frame (recorder.ts, A.3 of the plan), and writes
// each action through the hold under its generation. The lease is renewed
// only while the connection is attached with the recorder installed; attach
// failure, a disconnect, or the last page going away releases it and records
// the gap, and the next heartbeat on any instance claims the next generation.
//
// Best-effort throughout, by design. Recording must never stop a person
// taking control: the pause response waits for the hold to open AND for a
// BOUNDED attach attempt, and on failure or timeout marks the hold incomplete,
// releases the lease and still returns the successful takeover. On timeout
// the pending attach is aborted; a connection it opens later is closed, and
// nothing it would have installed can revive a capture that was released
// after the pane became interactive.
//
// Everything here is keyed by hold and generation, never by session alone: a
// stale generation's writes find no row (repository.ts), so a process that
// lost its lease without noticing cannot write over the one that took it.
//
// A KNOWN partial attachment marks the capture, for a person's takeover as
// for a task. A page whose CDP session was refused, an out-of-process frame
// (a payment or sign-in frame) whose install failed, or a target whose OWN
// main-frame world could not be created is a piece of the segment nobody
// observed, and the record must say so: each of those marks the hold (or the
// task) `frame_unavailable` (the first reason wins) while the capture stays
// live for the targets that did attach. A sub-frame world failure inside an
// attached target stays silent: an out-of-process frame is reached through
// its own session, and a same-process frame's next document is covered by
// the init script. That is the reviewed boundary.
//
// Three sinks over one CDP capture: `HoldCapture` writes to the database
// under the hold's lease on a connection of its own; `SessionCapture`
// (session-capture.ts) is the same recorder attached for the session's
// lifetime on the pooled connection, writing under a hold's lease only while
// one is claimed, so a `/pause` on an instance that warmed the session takes
// the fast path below instead of a fresh connect and install; `TaskCapture`
// buffers in memory for the length of one task and hands its safe actions
// back as timestamped steps. All three sanitize every row the same way
// before it lands anywhere: the URL through `recordedUrl`, the name and
// detail through the browser text sanitizer, and an entered value that
// itself matches the credential redactor is dropped as
// `sensitive_text_omitted`. Nothing raw is persisted in the hope that a
// reader removes it later.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Frame, type Page } from 'playwright-core';
import { redactSensitiveText, sanitizeBrowserText } from '@liftoffos/redact';
import { logger } from '../../infrastructure/logging';
import type { BrowserSession, TakeoverHold } from '../types';
import { cdpEndpointFor } from '../session-vendor-proxy';
import {
  ACTION_FIELD_CAPS, parseTakeoverActionPayload,
  type TakeoverActionPayload, type TakeoverActionRow, type ValueDisposition,
} from './action';
import { recordedUrl } from './route-template';
import { TAKEOVER_BINDING, takeoverRecorderSource, takeoverWorldNameFor, taskWorldNameFor } from './recorder';
import * as captureRepo from './repository';

/** This process, as the lease names it. One per process for its lifetime. */
export const CAPTURE_OWNER = `${hostname()}:${process.pid}:${randomUUID()}`;

/** Renewal cadence, a third of the 60 s lease so two missed renewals still
 *  keep the lease alive and a dead process loses it within 90 s. */
export const CAPTURE_RENEW_INTERVAL_MS = 20_000;

/** How long the pause response waits for the recorder to attach. The pane
 *  stays non-interactive until the response updates its driver state, which
 *  is what rules out an unobserved startup window — and also why this is
 *  short: a person waiting on a spinner for a recorder is the wrong trade. */
export const CAPTURE_ATTACH_TIMEOUT_MS = 5_000;

/** Observed steps kept per task. The 61st sets `stepsTruncated` and a `cap`
 *  gap on the task's trail. */
export const TASK_OBSERVED_STEPS_CAP = 60;

/** `TR_TAKEOVER_CAPTURE_ENABLED`, default on everywhere. `0` skips the claim:
 *  holds still open and close, marked `disabled`. A kill for a code defect
 *  that disturbs a person's session, not an accounting outcome. */
export function takeoverCaptureEnabled(): boolean {
  return (process.env.TR_TAKEOVER_CAPTURE_ENABLED ?? '1').trim() !== '0';
}

type Connect = (endpoint: string) => Promise<Browser>;

/** Seams for the browser test and the unit tests; production uses the
 *  defaults. */
export interface CaptureDeps {
  connect: Connect;
  endpointFor: (session: BrowserSession, tenantId: string) => Promise<string>;
  renewIntervalMs: number;
}

export const DEFAULT_CAPTURE_DEPS: CaptureDeps = {
  connect: (endpoint) => chromium.connectOverCDP(endpoint),
  endpointFor: (session, tenantId) => cdpEndpointFor(session.vendor, session.vendorSessionId, tenantId),
  renewIntervalMs: CAPTURE_RENEW_INTERVAL_MS,
};
const defaultDeps = DEFAULT_CAPTURE_DEPS;

interface FrameSession {
  cdp: CDPSession;
  /** Execution context ids of OUR world in this target, live right now. */
  contexts: Set<number>;
  /** The same contexts by the frame they belong to, so a caller can
   *  evaluate in ONE frame's world (the page readers of the pane actions). */
  frameContexts: Map<string, number>;
  /** This target's own main frame. */
  mainFrameId: string | null;
  /** A page target, as opposed to an out-of-process frame's. */
  isPage: boolean;
}

/** The persistence-boundary pass every row gets, whichever sink it goes to.
 *  The recorder already applied the same policy in the page; this is the
 *  Node-side guarantee that nothing raw lands, and the flags are upgraded
 *  rather than the strings silently changed. */
export function toSafeActionRow(parsed: Omit<TakeoverActionPayload, 'kind'> & { kind: TakeoverActionRow['kind'] }): TakeoverActionRow {
  const url = recordedUrl(parsed.url);
  const name = sanitizeBrowserText(parsed.name, ACTION_FIELD_CAPS.name);
  const detail = sanitizeBrowserText(parsed.detail, ACTION_FIELD_CAPS.detail);
  let value: string | null = parsed.value || null;
  let valueDisposition: ValueDisposition = parsed.valueDisposition;
  let valueTruncated = parsed.valueTruncated;
  if (
    valueDisposition === 'recorded' && value !== null
    && (redactSensitiveText(value) !== value || sanitizeBrowserText(value).protectedDataOmitted)
  ) {
    // The control was not classified as protected but what was typed into it
    // is credential-shaped, a card or identity number, a labelled secret or
    // a tokenized address: the whole value goes, and the row says why.
    // Never an altered value presented as what was entered.
    value = null;
    valueDisposition = 'sensitive_text_omitted';
    valueTruncated = false;
  }
  if (valueDisposition !== 'recorded') value = null;
  return {
    nonce: parsed.nonce,
    seq: parsed.seq,
    kind: parsed.kind,
    url: url.text,
    urlTruncated: parsed.urlTruncated || url.truncated,
    urlProtectedDataOmitted: parsed.urlProtectedDataOmitted || url.protectedDataOmitted,
    tag: parsed.tag || null,
    role: parsed.role || null,
    name: name.text || null,
    nameTruncated: parsed.nameTruncated || name.truncated,
    nameProtectedDataOmitted: name.protectedDataOmitted,
    inputType: parsed.inputType || null,
    value,
    valueTruncated,
    valueDisposition,
    detail: detail.text || null,
    detailTruncated: detail.truncated,
    detailProtectedDataOmitted: detail.protectedDataOmitted,
  };
}

/** A Node-made navigation row: the safe projection of Playwright's URL. */
function navigateRow(nonce: string, seq: number, rawUrl: string): TakeoverActionRow {
  const url = recordedUrl(rawUrl);
  return {
    nonce, seq, kind: 'navigate',
    url: url.text, urlTruncated: url.truncated, urlProtectedDataOmitted: url.protectedDataOmitted,
    tag: null, role: null, name: null, nameTruncated: false, nameProtectedDataOmitted: false,
    inputType: null, value: null, valueTruncated: false, valueDisposition: 'none',
    detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
  };
}

/** One CDP capture: connect, install the recorder in every target, turn
 *  binding payloads and frame navigations into safe rows, and hand each row
 *  to the sink. Lifecycle and the sink are the subclass's. Exported for the
 *  session capture, which lives in its own module. */
export abstract class CdpCapture {
  protected browser: Browser | null = null;
  protected readonly pages = new Map<Page, { nonce: string; seq: number }>();
  protected readonly frameSessions = new Set<FrameSession>();
  /** Listener removals, run when the connection is let go, so a capture on
   *  a SHARED connection leaves nothing behind on its pages. */
  private readonly cleanups: Array<() => void> = [];
  protected aborted = false;
  protected detaching = false;
  /** The last row handed to the sink, so a redirect or reload chain that
   *  fires the frame event several times for one destination is recorded
   *  once. */
  private lastQueued: TakeoverActionRow | null = null;

  protected constructor(
    protected readonly tenantId: string,
    protected readonly world: string,
    protected readonly deps: CaptureDeps,
  ) {}

  protected get source(): string {
    return takeoverRecorderSource();
  }

  /** Targets in which the recorder's world is live right now: a context of
   *  the capture's world was created (by the attach pass or by the init
   *  script on a new document) and has not been destroyed. This is what
   *  "installed" means, and nothing is counted on the strength of a
   *  registration alone. */
  protected get installedTargets(): number {
    let n = 0;
    for (const fs of this.frameSessions) if (fs.contexts.size > 0) n++;
    return n;
  }

  /** Recorder installed in at least one target and the connection alive. */
  get attached(): boolean {
    return this.browser !== null && this.installedTargets > 0 && !this.detaching && !this.aborted;
  }

  /** Whether this capture is still a candidate to record. */
  abstract get live(): boolean;

  /** Where a safe row goes. */
  protected abstract sink(row: TakeoverActionRow, at: Date): void;

  /** A page, frame or main-frame world this capture could not observe. */
  protected abstract onPartialAttach(what: 'page' | 'frame' | 'main_frame_world', err: string): void;

  protected abstract onDisconnected(): void;
  protected abstract onLastPageClosed(): void;

  /** Abort a pending attach. Anything it completes afterwards is undone. */
  abort(): void {
    this.aborted = true;
  }

  /** The world's context in ONE frame, wherever that frame's target is:
   *  the CDP session to evaluate through and the context id. Null when the
   *  frame has no world of ours (a frame nobody attached). */
  worldFor(frameId: string): { cdp: CDPSession; contextId: number } | null {
    for (const fs of this.frameSessions) {
      const contextId = fs.frameContexts.get(frameId);
      if (contextId !== undefined) return { cdp: fs.cdp, contextId };
    }
    return null;
  }

  /** The main page target's own main frame world: the first attached PAGE
   *  target whose main frame has a live world. */
  mainWorld(): { cdp: CDPSession; contextId: number; frameId: string } | null {
    for (const fs of this.frameSessions) {
      if (!fs.isPage || !fs.mainFrameId) continue;
      const contextId = fs.frameContexts.get(fs.mainFrameId);
      if (contextId !== undefined) return { cdp: fs.cdp, contextId, frameId: fs.mainFrameId };
    }
    return null;
  }

  protected async connectTo(session: BrowserSession): Promise<Browser | null> {
    const endpoint = await this.deps.endpointFor(session, this.tenantId);
    if (this.aborted) return null;
    const browser = await this.deps.connect(endpoint);
    if (this.aborted) {
      await browser.close().catch(() => undefined);
      return null;
    }
    return browser;
  }

  /** Install into every page of the connected browser. Throws when no target
   *  took the recorder at all. */
  protected async installEverywhere(browser: Browser): Promise<void> {
    this.browser = browser;
    const onDisconnected = () => this.onDisconnected();
    browser.on('disconnected', onDisconnected);
    this.cleanups.push(() => browser.off('disconnected', onDisconnected));
    const context = browser.contexts()[0];
    if (!context) throw new Error('connected browser has no context');
    const onPage = (page: Page) => { void this.attachPage(context, page); };
    context.on('page', onPage);
    this.cleanups.push(() => context.off('page', onPage));
    await Promise.all(context.pages().map((page) => this.attachPage(context, page)));
    if (this.aborted) {
      await this.closeBrowser();
      return;
    }
    if (this.installedTargets === 0) {
      throw new Error('recorder installed in no page');
    }
  }

  private async attachPage(context: BrowserContext, page: Page): Promise<void> {
    if (!this.live) return;
    try {
      const cdp = await context.newCDPSession(page);
      await this.installInTarget(cdp, true);
      this.pages.set(page, { nonce: randomUUID(), seq: 0 });
      const onNavigated = (frame: Frame) => {
        if (frame === page.mainFrame()) this.recordNavigate(page, frame.url());
      };
      const onFrameAttached = (frame: Frame) => { void this.attachOutOfProcessFrame(context, frame); };
      const onClose = () => this.onPageClosed(page);
      page.on('framenavigated', onNavigated);
      page.on('frameattached', onFrameAttached);
      page.on('close', onClose);
      this.cleanups.push(() => {
        page.off('framenavigated', onNavigated);
        page.off('frameattached', onFrameAttached);
        page.off('close', onClose);
      });
      // Concurrently, as the frames inside the target are installed: each
      // out-of-process frame is its own session and its own round trips,
      // and a page with many of them must not cost their sum.
      await Promise.all(page.frames()
        .filter((frame) => frame !== page.mainFrame())
        .map((frame) => this.attachOutOfProcessFrame(context, frame)));
    } catch (err) {
      logger.warn(
        { world: this.world, err: (err as Error).message, event: 'takeover_capture_page_attach_failed' },
        'takeover capture: could not attach to a page',
      );
      // A page the person can use that nobody observes: the segment is
      // partial, and the record says so.
      this.onPartialAttach('page', (err as Error).message);
    }
  }

  /** An out-of-process iframe has its own target and its own session. A frame
   *  in the parent's process is covered by the parent's Page.getFrameTree, and
   *  Playwright refuses a CDP session for it — that refusal is the normal case
   *  here and is ignored. */
  private async attachOutOfProcessFrame(context: BrowserContext, frame: Frame): Promise<void> {
    if (!this.live) return;
    let cdp: CDPSession;
    try {
      cdp = await context.newCDPSession(frame);
    } catch {
      return;
    }
    try {
      await this.installInTarget(cdp, false);
    } catch (err) {
      logger.warn(
        { world: this.world, err: (err as Error).message, event: 'takeover_capture_frame_attach_failed' },
        'takeover capture: could not attach to an out-of-process frame',
      );
      // A sign-in or payment frame with its own process that the recorder
      // could not enter: what happens in it is not observed.
      this.onPartialAttach('frame', (err as Error).message);
    }
  }

  /** A.3, in order: subscribe, bind, init script for future documents, then
   *  the isolated world plus evaluation for every frame already loaded. */
  private async installInTarget(cdp: CDPSession, isPage: boolean): Promise<void> {
    const fs: FrameSession = { cdp, contexts: new Set(), frameContexts: new Map(), mainFrameId: null, isPage };
    this.frameSessions.add(fs);
    cdp.on('Runtime.executionContextCreated', ({ context }) => {
      const aux = (context.auxData ?? {}) as unknown as { isDefault?: boolean; frameId?: string };
      if (context.name === this.world && aux.isDefault === false) {
        fs.contexts.add(context.id);
        if (aux.frameId) fs.frameContexts.set(aux.frameId, context.id);
      }
    });
    cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      fs.contexts.delete(executionContextId);
      for (const [frameId, id] of fs.frameContexts) {
        if (id === executionContextId) fs.frameContexts.delete(frameId);
      }
    });
    cdp.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
      if (name !== TAKEOVER_BINDING || !fs.contexts.has(executionContextId)) return;
      this.onPayload(payload);
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: TAKEOVER_BINDING, executionContextName: this.world });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: this.source, worldName: this.world });
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const frames: string[] = [];
    interface FrameTreeLike { frame: { id: string }; childFrames?: FrameTreeLike[] }
    const walk = (node: FrameTreeLike) => {
      frames.push(node.frame.id);
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(frameTree as unknown as FrameTreeLike);
    const mainFrameId = (frameTree as unknown as FrameTreeLike).frame.id;
    fs.mainFrameId = mainFrameId;
    // Every frame at once. The attach is awaited by the pause response and
    // by the task start, under one short budget, and a news page carries
    // dozens of same-process frames: two round trips per frame in sequence
    // to a remote endpoint spend the whole budget on the walk (the attach
    // times out, and the person's first minute of driving goes
    // unrecorded). Issued together, the walk
    // costs two round trips whatever the frame count.
    await Promise.all(frames.map(async (frameId) => {
      let contextId: number | null = null;
      try {
        ({ executionContextId: contextId } = await cdp.send('Page.createIsolatedWorld', {
          frameId, worldName: this.world,
        }));
        await cdp.send('Runtime.evaluate', { expression: this.source, contextId });
        fs.contexts.add(contextId);
        fs.frameContexts.set(frameId, contextId);
      } catch (err) {
        // A world whose evaluation failed is not counted as installed: the
        // init script covers that frame's NEXT document. For the target's
        // OWN main frame that is a document the person is using right now
        // with nothing observing it, so the record is marked partial. A
        // sub-frame failure inside this target stays silent: an
        // out-of-process frame is reached through its own session, and a
        // same-process frame's next document is covered by the init script.
        if (contextId !== null) fs.contexts.delete(contextId);
        if (frameId === mainFrameId) this.onPartialAttach('main_frame_world', (err as Error).message);
      }
    }));
  }

  private onPayload(payload: string): void {
    if (!this.live) return;
    const parsed = parseTakeoverActionPayload(payload);
    if (!parsed) {
      logger.warn({ world: this.world, event: 'takeover_capture_payload_rejected' },
        'takeover capture: a binding payload did not match the schema and was dropped');
      return;
    }
    this.queue(toSafeActionRow(parsed), new Date());
  }

  private recordNavigate(page: Page, url: string): void {
    if (!this.live) return;
    const counter = this.pages.get(page);
    if (!counter) return;
    if (this.queue(navigateRow(counter.nonce, counter.seq, url), new Date())) counter.seq++;
  }

  /** A navigation identical to the one queued just before it, on the same
   *  page, with nothing recorded in between, is one navigation: an
   *  http -> https redirect, a consent bounce or a client-side reload fires
   *  `framenavigated` several times for a single destination, and six rows
   *  of the same URL tell the reader nothing the first did not. A navigation
   *  that follows any other recorded action is kept, so a reload the person
   *  caused still shows. */
  private queue(row: TakeoverActionRow, at: Date): boolean {
    const last = this.lastQueued;
    if (
      row.kind === 'navigate' && last?.kind === 'navigate'
      && last.nonce === row.nonce && last.url === row.url
    ) {
      return false;
    }
    this.lastQueued = row;
    this.sink(row, at);
    return true;
  }

  private onPageClosed(page: Page): void {
    this.pages.delete(page);
    if (this.pages.size === 0 && this.browser && !this.detaching && !this.aborted) {
      this.onLastPageClosed();
    }
  }

  protected async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    const sessions = [...this.frameSessions];
    this.frameSessions.clear();
    this.pages.clear();
    for (const cleanup of this.cleanups.splice(0)) {
      try { cleanup(); } catch { /* a listener already gone */ }
    }
    if (browser) await this.releaseBrowser(browser, sessions);
  }

  /** Let the connection go. A capture that owns it closes it, which
   *  disconnects our client only: the vendor's session, and the pane the
   *  person is watching, stay up. A capture on a SHARED connection overrides
   *  this to detach its own CDP sessions and leave the connection alone. */
  protected async releaseBrowser(browser: Browser, _sessions: FrameSession[]): Promise<void> {
    await browser.close().catch(() => undefined);
  }
}

/** The CDP session and the world contexts a capture holds in one target;
 *  exported for the session capture's release. */
export type { FrameSession };

/** One hold's capture, owned by this process under one generation. */
class HoldCapture extends CdpCapture {
  readonly holdId: string;
  readonly generation: number;
  private renewTimer: NodeJS.Timeout | null = null;
  private released = false;
  private writes: Promise<unknown> = Promise.resolve();
  private capReported = false;
  private partialReported = false;

  constructor(hold: TakeoverHold, generation: number, deps: CaptureDeps) {
    super(hold.tenantId, takeoverWorldNameFor(hold.id), deps);
    this.holdId = hold.id;
    this.generation = generation;
  }

  /** Whether this capture is still a candidate to record: not aborted, not
   *  detaching, not released. */
  get live(): boolean {
    return !this.aborted && !this.detaching && !this.released;
  }

  async attach(session: BrowserSession): Promise<void> {
    const browser = await this.connectTo(session);
    if (!browser) return;
    // The lease is re-checked against the database before anything is
    // installed: the hold may have ended, or another generation taken over,
    // while the connection was being made. A renewal is the check — it
    // extends nothing that is not still ours and answers false otherwise.
    let stillOwner = false;
    try {
      stillOwner = await captureRepo.renewCapture(this.tenantId, this.holdId, CAPTURE_OWNER, this.generation);
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw err;
    }
    if (!stillOwner || this.aborted) {
      await browser.close().catch(() => undefined);
      if (!stillOwner) await this.detach();
      return;
    }
    await this.installEverywhere(browser);
    if (this.aborted) return;
    this.startRenewing();
  }

  /** The first partial attachment marks the hold `frame_unavailable`; the
   *  capture stays live for the targets that did attach. */
  protected onPartialAttach(what: 'page' | 'frame' | 'main_frame_world', err: string): void {
    if (this.partialReported) return;
    this.partialReported = true;
    logger.info({ hold_id: this.holdId, what, err, event: 'takeover_capture_partial' },
      'takeover capture: part of the session is not observed; the hold is marked frame_unavailable');
    this.writes = this.writes.then(async () => {
      try {
        await captureRepo.markCaptureGap(this.tenantId, this.holdId, 'frame_unavailable');
      } catch (e) {
        logger.warn({ hold_id: this.holdId, err: (e as Error).message, event: 'takeover_capture_gap_mark_failed' },
          'takeover capture: could not mark the hold frame_unavailable');
      }
    });
  }

  /** Writes are serialised per capture so `at` follows arrival order. */
  protected sink(row: TakeoverActionRow): void {
    this.writes = this.writes.then(async () => {
      if (!this.live) return;
      try {
        const outcome = await captureRepo.insertAction(
          this.tenantId, this.holdId, CAPTURE_OWNER, this.generation, row,
        );
        if (outcome === 'stale') {
          // The hold ended or another generation owns it now. Detach locally,
          // never close the hold: that is state-driven, from any instance.
          await this.detach();
        } else if (outcome === 'capped' && !this.capReported) {
          this.capReported = true;
          logger.info({ hold_id: this.holdId, event: 'takeover_capture_capped' },
            'takeover capture: the hold reached its action cap; further actions are not recorded');
        }
      } catch (err) {
        logger.warn({ hold_id: this.holdId, err: (err as Error).message, event: 'takeover_capture_write_failed' },
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
    if (!this.attached) return;
    let kept = false;
    try {
      kept = await captureRepo.renewCapture(this.tenantId, this.holdId, CAPTURE_OWNER, this.generation);
    } catch (err) {
      logger.warn({ hold_id: this.holdId, err: (err as Error).message, event: 'takeover_capture_renew_failed' },
        'takeover capture: lease renewal failed; retrying on the next tick');
      return;
    }
    if (!kept) await this.detach();
  }

  protected onDisconnected(): void {
    if (this.detaching || this.aborted) return;
    void this.release(this.installedTargets > 0 ? 'lost_owner' : 'never_attached');
  }

  protected onLastPageClosed(): void {
    void this.release(this.installedTargets > 0 ? 'lost_owner' : 'never_attached');
  }

  /** Give the lease up and record the gap, then let the connection go. */
  async release(reason: 'never_attached' | 'lost_owner'): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await captureRepo.releaseCapture(this.tenantId, this.holdId, CAPTURE_OWNER, this.generation, reason);
    } catch (err) {
      logger.warn({ hold_id: this.holdId, err: (err as Error).message, event: 'takeover_capture_release_failed' },
        'takeover capture: lease release failed; the lease will lapse on its own');
    }
    logger.info({ hold_id: this.holdId, generation: this.generation, reason, event: 'takeover_capture_released' },
      'takeover capture: lease released');
    await this.detach();
  }

  /** Drop the connection without touching the hold. Our own close is not a
   *  disconnect the release path should see. */
  async detach(): Promise<void> {
    if (this.detaching) return;
    this.detaching = true;
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    await this.closeBrowser();
    active.delete(this.holdId);
  }
}

/** Captures this process owns, by hold id. */
const active = new Map<string, HoldCapture>();

export interface EnsureCaptureInput {
  tenantId: string;
  hold: TakeoverHold;
  session: BrowserSession;
}

/**
 * Make sure this hold is being recorded, by this process if nobody else is.
 *
 * Called on every pause — the opening one and each heartbeat renewal. A
 * capture already owned here is left alone; a live lease elsewhere is left
 * alone (no gap); an unclaimed or lapsed lease is claimed and attached to
 * within `timeoutMs`. Never throws, and never blocks the takeover: whatever
 * goes wrong is recorded on the hold as a gap.
 */
export async function ensureTakeoverCapture(
  input: EnsureCaptureInput,
  opts: { timeoutMs?: number; deps?: Partial<CaptureDeps> } = {},
): Promise<void> {
  const { tenantId, hold, session } = input;
  const timeoutMs = opts.timeoutMs ?? CAPTURE_ATTACH_TIMEOUT_MS;
  const deps: CaptureDeps = { ...defaultDeps, ...(opts.deps ?? {}) };

  if (!takeoverCaptureEnabled()) {
    if (!hold.captureGap) {
      await captureRepo.markCaptureGap(tenantId, hold.id, 'disabled').catch((err: Error) =>
        logger.warn({ hold_id: hold.id, err: err.message }, 'takeover capture: could not mark the hold disabled'));
    }
    return;
  }

  const existing = active.get(hold.id);
  if (existing && existing.live) return;

  // The fast path: a recorder already attached for the session's lifetime on
  // this instance (session-capture.ts) claims the lease and records under
  // it, with no connect and no install on the pause. The lease does not
  // move: the claim is the same one UPDATE, and the capture writes exactly
  // what a HoldCapture writes. Reached dynamically for the import order's
  // sake (that module extends CdpCapture from here).
  let warm: import('./session-capture').SessionCapture | null = null;
  try {
    const { warmCaptureFor } = await import('./session-capture');
    warm = warmCaptureFor(session.id);
  } catch (err) {
    logger.warn({ hold_id: hold.id, err: (err as Error).message }, 'takeover capture: the session capture module could not be loaded');
  }
  if (warm && warm.attached && warm.live) {
    if (warm.recording?.holdId === hold.id) return;
    let generation: number | null;
    try {
      generation = await captureRepo.claimCapture(tenantId, hold.id, CAPTURE_OWNER);
    } catch (err) {
      logger.warn({ hold_id: hold.id, err: (err as Error).message, event: 'takeover_capture_claim_failed' },
        'takeover capture: claim failed; the next heartbeat retries');
      return;
    }
    if (generation === null) return;
    warm.startRecording(hold, generation);
    logger.info({ hold_id: hold.id, generation, session_id: session.id, event: 'takeover_capture_claimed_warm' },
      'takeover capture: the warm session capture claimed the lease');
    return;
  }

  let generation: number | null;
  try {
    generation = await captureRepo.claimCapture(tenantId, hold.id, CAPTURE_OWNER);
  } catch (err) {
    logger.warn({ hold_id: hold.id, err: (err as Error).message, event: 'takeover_capture_claim_failed' },
      'takeover capture: claim failed; the next heartbeat retries');
    return;
  }
  if (generation === null) return;

  const capture = new HoldCapture(hold, generation, deps);
  active.set(hold.id, capture);
  logger.info({ hold_id: hold.id, generation, event: 'takeover_capture_claimed' }, 'takeover capture: lease claimed');

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
      logger.warn({ hold_id: hold.id, generation, timeout_ms: timeoutMs, event: 'takeover_capture_attach_timeout' },
        'takeover capture: attach did not complete in time; the hold is marked incomplete');
      await capture.release('never_attached');
      return;
    }
    logger.info({ hold_id: hold.id, generation, event: 'takeover_capture_attached' }, 'takeover capture: recorder attached');
  } catch (err) {
    logger.warn({ hold_id: hold.id, generation, err: (err as Error).message, event: 'takeover_capture_attach_failed' },
      'takeover capture: attach failed; the hold is marked incomplete');
    await capture.release('never_attached');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Call-scoped task capture ─────────────────────────────────────────────────

/** The closed, product-safe vocabulary of a task's capture gap. Never raw
 *  exception, vendor or session text. */
export type TaskGapReason = 'attach_failed' | 'frame_unavailable' | 'disconnected' | 'cap' | 'reconciliation_uncertain';

/** One action the task capture observed, with the time it arrived. */
export interface ObservedAction {
  row: TakeoverActionRow;
  at: Date;
}

export interface TaskCaptureResult {
  actions: ObservedAction[];
  captureGap: boolean;
  gapReason: TaskGapReason | null;
  stepsTruncated: boolean;
  startedAt: Date;
  endedAt: Date;
}

/** The recorder attached for the length of one in-session agent task.
 *
 *  Buffers the same safe actions in memory that a hold writes to the
 *  database, up to `TASK_OBSERVED_STEPS_CAP`, and reports the same partial
 *  attachment, disconnect and cap as a gap. `attach` never throws and never
 *  blocks the task: a capture that could not attach answers with an
 *  `attach_failed` gap and the task runs regardless. `finish` detaches and
 *  hands the buffer back; call it in `finally`. */
export class TaskCapture extends CdpCapture {
  readonly startedAt = new Date();
  private readonly buffer: ObservedAction[] = [];
  private gap: TaskGapReason | null = null;
  private truncated = false;
  private finished = false;

  private constructor(tenantId: string, deps: CaptureDeps) {
    super(tenantId, taskWorldNameFor(randomUUID()), deps);
  }

  static async attach(
    session: BrowserSession,
    tenantId: string,
    opts: { timeoutMs?: number; deps?: Partial<CaptureDeps> } = {},
  ): Promise<TaskCapture> {
    const deps: CaptureDeps = { ...defaultDeps, ...(opts.deps ?? {}) };
    const capture = new TaskCapture(tenantId, deps);
    const timeoutMs = opts.timeoutMs ?? CAPTURE_ATTACH_TIMEOUT_MS;
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        capture.connectAndInstall(session).then(() => 'attached' as const),
        timeout,
      ]);
      if (outcome === 'timeout') {
        capture.abort();
        capture.markGap('attach_failed');
        logger.warn({ world: capture.world, timeout_ms: timeoutMs, event: 'task_capture_attach_timeout' },
          'task capture: attach did not complete in time; the task runs unobserved');
      }
    } catch (err) {
      capture.markGap('attach_failed');
      logger.warn({ world: capture.world, err: (err as Error).message, event: 'task_capture_attach_failed' },
        'task capture: attach failed; the task runs unobserved');
    } finally {
      if (timer) clearTimeout(timer);
    }
    return capture;
  }

  private async connectAndInstall(session: BrowserSession): Promise<void> {
    const browser = await this.connectTo(session);
    if (!browser) return;
    await this.installEverywhere(browser);
  }

  get live(): boolean {
    return !this.aborted && !this.detaching && !this.finished;
  }

  private markGap(reason: TaskGapReason): void {
    if (this.gap === null) this.gap = reason;
  }

  protected sink(row: TakeoverActionRow, at: Date): void {
    if (this.buffer.length >= TASK_OBSERVED_STEPS_CAP) {
      this.truncated = true;
      this.markGap('cap');
      return;
    }
    this.buffer.push({ row, at });
  }

  protected onPartialAttach(what: 'page' | 'frame' | 'main_frame_world'): void {
    logger.info({ world: this.world, what, event: 'task_capture_partial' },
      'task capture: part of the session is not observed; the trail is marked frame_unavailable');
    this.markGap('frame_unavailable');
  }

  protected onDisconnected(): void {
    if (this.detaching || this.aborted || this.finished) return;
    this.markGap('disconnected');
  }

  protected onLastPageClosed(): void {
    if (this.finished) return;
    this.markGap('disconnected');
  }

  /** Detach and hand back what was observed. Idempotent. */
  async finish(): Promise<TaskCaptureResult> {
    const endedAt = new Date();
    if (!this.finished) {
      this.finished = true;
      this.detaching = true;
      await this.closeBrowser();
    }
    return {
      actions: this.buffer.slice(),
      captureGap: this.gap !== null,
      gapReason: this.gap,
      stepsTruncated: this.truncated,
      startedAt: this.startedAt,
      endedAt,
    };
  }
}

/** Drop observed actions that fall inside a person's takeover hold: they are
 *  the person's `person_takeover` segment and would otherwise be attributed
 *  to the assistant twice. An open hold is bounded by the task's finish. */
export function withoutTakeoverIntervals(
  actions: ObservedAction[],
  holds: ReadonlyArray<{ startedAt: Date; endedAt: Date | null }>,
  endedAt: Date,
): ObservedAction[] {
  if (holds.length === 0) return actions;
  return actions.filter(({ at }) => !holds.some((h) => {
    const end = h.endedAt ?? endedAt;
    return at.getTime() >= h.startedAt.getTime() && at.getTime() <= end.getTime();
  }));
}

/** For tests: the captures this process currently owns, by hold id: the
 *  hold captures, and every warm session capture recording a hold. */
export function _activeTakeoverCaptures(): ReadonlyMap<string, { holdId: string; generation: number; attached: boolean }> {
  const out = new Map([...active.entries()].map(([id, c]) => [id, { holdId: c.holdId, generation: c.generation, attached: c.attached }]));
  try {
     
    const { _recordingSessionCaptures } = require('./session-capture') as typeof import('./session-capture');
    for (const [holdId, facts] of _recordingSessionCaptures()) out.set(holdId, facts);
  } catch { /* the session capture module is not loaded */ }
  return out;
}

/** For tests: drop every capture this process owns without touching the
 *  holds, the warm session captures included. */
export async function _detachAllTakeoverCaptures(): Promise<void> {
  await Promise.all([...active.values()].map((c) => c.detach()));
  active.clear();
  try {
    const { _endAllSessionCaptures } = await import('./session-capture');
    await _endAllSessionCaptures();
  } catch { /* the session capture module is not loaded */ }
}
