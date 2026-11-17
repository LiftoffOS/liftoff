import { useEffect, useRef, useState } from 'react'
import { Tooltip, UserAvatar } from '../index'
import Button from '../Button'
import XIcon from '../../assets/icons/x.svg?react'
import { getDisplayName } from '../../utils/avatar'
import type { BrowserSessionOwner, BrowserSessionDriver } from '../../types/browserSession'
import { isDrivingSession } from '../../types/browserSession'

interface BrowserPaneProps {
  // Visual state — only what's needed to render.
  session: {
    id: string
    liveViewUrl: string
    ownerAccountId: string | null
    // Resolved by the backend. Null on legacy/web_task sessions, which have no
    // human owner, so the pane renders without an avatar rather than a blank one.
    owner?: BrowserSessionOwner | null
    takeoverState?: 'none' | 'taken_over'
    driver?: BrowserSessionDriver | null
  } | null

  // Account viewing the pane. The avatar answers "who else is driving this",
  // so it is hidden when the viewer is the driver — you do not need to be told
  // that you are yourself. Always set in the app: /dashboard sits behind
  // ProtectedRoute, which holds a loader until the account resolves.
  viewerAccountId: string
  // True for ANY ensure failure — classified envelope OR unclassified HTTP
  // 5xx. The pane intentionally does NOT differentiate by kind; a single
  // "Unable to start the browser" copy serves every error branch.
  ensureError: boolean
  wasNewlyCreated: boolean

  // Restore key — null when threadId is missing.
  lastUrlKey: string | null

  // Paused-frame freeze: signed-URL PNG of the prior session's last
  // screenshot, set ONLY when the prior session ended via idle_timeout and
  // we have a cached frame. Takes precedence over ensureError when set —
  // an idle reap is the expected end state, not a failure to surface, and
  // a cached frame plus "click to resume" is a better UX than error copy.
  pausedFrameUrl: string | null

  // Callbacks — the page wires real mutations; tests pass spies.
  onClose: () => void
  onResizeStart: (e: React.MouseEvent) => void
  /** The drag that began on the resizer ended: the pane's size has settled,
   *  so the page's browser can be resized to it once rather than on every
   *  frame of the drag. */
  onResizeEnd?: () => void
  onRetryEnsure: () => void
  onRestoreFromLastUrl: (sessionId: string, url: string) => void
  /** Take the wheel from whoever has it, or hand it back to the agent. */
  onTakeControl?: () => void
  onReleaseControl?: () => void
  controlPending?: boolean
  /** The live view's box changed. Reported from a ResizeObserver on the
   *  iframe wrap: the hook clamps it and sends it as the page's size. */
  onViewportChange?: (size: { width: number; height: number }) => void
  /** Named in the hand-back affordance so it reads as an action, not a setting. */
  agentName?: string
}


/**
 * Presenter for the Anchor browser pane. Stateless: every visual state
 * (live / starting / paused-frame / error / ended) is a pure function of its
 * props, so it can be unit-tested in isolation with no contexts or query
 * client. Wired by AgentChatPage via useBrowserSessionForThread.
 */
export default function BrowserPane(p: BrowserPaneProps) {
  // Iframe load gating: when `session` flips from null → set, the iframe
  // element mounts immediately with Anchor's liveViewUrl but its UI takes
  // time to render — first the HTML doc fetch (~200-400ms), then Anchor's
  // VNC WebSocket handshake (~500-1500ms more). Without gating, the user
  // sees a grey flash between our spinner and the actual browser stream.
  //
  // We can't reliably observe "VNC connected" from outside Anchor's iframe
  // (cross-origin, no public postMessage event documented), so we use a
  // two-stage heuristic: hide the overlay (a) after the iframe's onLoad
  // fires AND (b) after a post-load grace period long enough to mask the
  // VNC handshake. 1200ms covers a typical end-to-end ready time —
  // undershooting flashes grey, overshooting just delays a working
  // browser by a fraction of a second.
  //
  // Reset whenever session.id changes — switching threads or re-minting
  // after a Resume needs a fresh load gap, not a skip.
  // Control model: the agent drives unless a human has taken over, and only
  // that human may click. Everyone else observes. Anchor's documented way to
  // make the live view non-interactive is pointer-events: none on the iframe,
  // so observer mode uses the vendor's own mechanism rather than an overlay.
  const driver = p.session?.takeoverState === 'taken_over' ? p.session?.driver ?? null : null
  const isDriving = isDrivingSession(p.session, p.viewerAccountId)
  const attributedPerson = driver ?? p.session?.owner ?? null
  const attributionLabel = attributedPerson
    ? driver
      ? `${getDisplayName(driver)} is driving`
      : getDisplayName(attributedPerson)
    : ''

  const VNC_HANDSHAKE_GRACE_MS = 1200
  const [iframeReady, setIframeReady] = useState(false)
  const sessionId = p.session?.id ?? null
  // A new session has not handshaked yet. Compared during render so the frame
  // that switches session does not paint the previous one as ready.
  const [readySessionId, setReadySessionId] = useState(sessionId)
  if (sessionId !== readySessionId) {
    setReadySessionId(sessionId)
    setIframeReady(false)
  }

  // The live view's box, reported as it changes so the page's size follows
  // the pane. Observed on the wrap rather than the iframe: the wrap is what
  // the pane sizes, and the iframe fills it.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const onViewportChange = p.onViewportChange
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !onViewportChange || typeof ResizeObserver === 'undefined') return
    const report = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) onViewportChange({ width: rect.width, height: rect.height })
    }
    report()
    const observer = new ResizeObserver(() => report())
    observer.observe(el)
    return () => observer.disconnect()
  }, [onViewportChange, sessionId])

  return (
    <aside className="chat-page__right-pane" aria-label="Browser">
      {/* A drag handle, not a control: dragging is a pointer enhancement over
          a pane that has a working default width, and there is no keyboard
          gesture behind it to announce. */}
      <div
        className="chat-page__right-pane-resizer"
        role="presentation"
        onMouseDown={(e) => {
          p.onResizeStart(e)
          // The drag ends on the window, wherever the pointer is by then; the
          // iframe would swallow a mouseup that landed on it.
          if (p.onResizeEnd) window.addEventListener('mouseup', () => p.onResizeEnd?.(), { once: true })
        }}
      />
      {/* Whoever has the wheel, centred above the live view: the driver when a
          human holds control, otherwise whoever started the session. Hidden
          when that is you — being told you are yourself is noise. */}
      {attributedPerson && attributedPerson.accountId !== p.viewerAccountId && (
        <div className="chat-page__browser-pane-owner">
          <Tooltip text={attributionLabel} position="bottom">
            <UserAvatar
              person={attributedPerson}
              className="chat-page__browser-pane-owner-avatar"
              iconSize={14}
            />
          </Tooltip>
        </div>
      )}

      <div className="chat-page__right-pane-close">
        <Tooltip text="Close" position="bottom">

          <button
            type="button"
            className="chat-page__icon-btn"
            aria-label="Close browser"
            onClick={p.onClose}
          >
            <XIcon width="20" height="20" />
          </button>
        </Tooltip>
      </div>

      {/* Branch precedence (mutually exclusive):
            1. pausedFrameUrl — prior session idle-reaped + cached frame
               present. Wins over everything except a live session.
            2. session — live; render the iframe.
            3. ensureError — terminal failure; "Unable to start" + Try Again.
            4. default — anything else (mid-ensure, query loading, between
               states, no-session-yet): spinner only. No misleading text or
               action buttons. */}
      {!p.session && p.pausedFrameUrl && (
        <div className="chat-page__browser-pane-paused">
          <img
            className="chat-page__browser-pane-paused-frame"
            src={p.pausedFrameUrl}
            alt="Last view of the paused browser session"
          />
          <div className="chat-page__browser-pane-paused-overlay" role="status">
            <div className="chat-page__browser-pane-paused-text">
              <p className="chat-page__browser-pane-paused-title">Session paused</p>
              <p className="chat-page__browser-pane-paused-subtitle">
                Your browser session ended after a period of inactivity.
              </p>
            </div>
            <Button variant="primary" onClick={p.onRetryEnsure}>
              Resume browsing
            </Button>
          </div>
        </div>
      )}

      {p.session && (
        // Wrapper exists so the 12px horizontal inset + the 1px hairline
        // border live OUTSIDE the iframe element rather than on it. A
        // border on the iframe itself would draw at the pane's full
        // 100% width (because the iframe used box-sizing: border-box +
        // padding to inset its content), which is not what we want — the
        // border has to sit tight against the visible browser content.
        // Wrapper also hosts the load-overlay so the overlay no longer
        // needs to know about the inset.
        <div className="chat-page__browser-pane-iframe-wrap" ref={wrapRef}>
          <iframe
            className={`chat-page__browser-pane-iframe${isDriving ? '' : ' chat-page__browser-pane-iframe--observing'}`}
            src={p.session.liveViewUrl}
            title="Browser"
            onLoad={() => {
              window.setTimeout(() => setIframeReady(true), VNC_HANDSHAKE_GRACE_MS)
              if (p.wasNewlyCreated && p.lastUrlKey) {
                const lastUrl = window.localStorage.getItem(p.lastUrlKey)
                if (lastUrl) p.onRestoreFromLastUrl(p.session!.id, lastUrl)
              }
            }}
          />
          {/* Taking over is clicking into the browser. This transparent layer
              sits over the live view for observers and swallows that first
              click, turning it into the takeover; once you hold the wheel it
              is gone and your clicks reach the page directly. Anchor's iframe
              is cross-origin, so a capture layer is the only way to see the
              click at all. */}
          {!isDriving && p.onTakeControl && (
            <button
              type="button"
              className="chat-page__browser-pane-capture"
              aria-label="Take control of the browser"
              aria-busy={p.controlPending || undefined}
              onClick={() => p.onTakeControl?.()}
              disabled={p.controlPending}
            />
          )}
          {/* Nothing here says the assistant asked the person to take over.
              It used to: a status pill on the pane reading "<name> asked you
              to take over. Click into the browser, then hand it back." The
              ask belongs in the conversation, where the assistant says what
              it needs done and where, and where the person can reply. A
              second copy on the pane restates it in fewer words than the
              real one, and puts the product's own chrome between the person
              and what they were asked. */}
          {/* The takeover is in flight: the runtime opens the hold and
              attaches its recorder before it answers, which takes a second
              or two, and the capture layer above swallows every click until
              then. Silence there read as "nothing happened" and drew second
              and third clicks that could not do anything; this says the
              first one was taken. */}
          {!isDriving && p.onTakeControl && p.controlPending && (
            <div className="chat-page__browser-pane-control" role="status" aria-live="polite">
              <span className="chat-page__browser-pane-status">
                <span className="loading-spinner loading-spinner--sm" aria-hidden="true" />
                Taking control…
              </span>
            </div>
          )}
          {isDriving && p.onReleaseControl && (
            <div className="chat-page__browser-pane-control">
              <Button
                variant="outline"
                size="sm"
                onClick={p.onReleaseControl}
                disabled={p.controlPending}
              >
                Hand back to {p.agentName ?? 'the agent'}
              </Button>
            </div>
          )}
          {/* Spinner cover for the iframe HTML-fetch + VNC-handshake gap.
              Same chrome as the no-session loading branch so the visual
              reads as one continuous "starting" state from click → live
              browser — no spinner → grey → browser handoff. */}
          {!iframeReady && (
            <div className="chat-page__browser-pane-iframe-overlay" aria-hidden="true">
              <div className="loading-spinner" />
            </div>
          )}
          {/* The hint sits just under the live view rather than in the pane's
              header: it teaches a gesture you make ON the browser, so it
              belongs against the thing you make it on. Absolute inside the
              wrap, which is what centres it on the pane — the wrap is the
              pane's own centred box — and keeps it out of the measured
              viewport the ResizeObserver reports. */}
        </div>
      )}

      {!p.session && !p.pausedFrameUrl && p.ensureError && (
        <div className="chat-page__browser-pane-empty">
          <p>Unable to start the browser</p>
          <Button variant="outline" size="sm" onClick={p.onRetryEnsure}>Try Again</Button>
        </div>
      )}

      {/* Default loading state. Covers: ensure mutation in flight, initial
          active-session query in flight, the brief render between the pane
          mounting and ensure firing, and the "session just closed, waiting
          for re-ensure" gap. Showing a spinner here is honest — something
          IS happening or about to. Showing "Browser session ended" text or
          a "Start a new browser session" button in this state was wrong:
          most of the time the user never closed anything, they just opened
          the pane. */}
      {!p.session && !p.pausedFrameUrl && !p.ensureError && (
        <div className="chat-page__browser-pane-empty">
          <div className="loading-spinner" />
        </div>
      )}
    </aside>
  )
}
