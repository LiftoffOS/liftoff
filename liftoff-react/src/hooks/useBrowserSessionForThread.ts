import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTenant } from './useTenant';
import {
  ensureSession, getActiveSession, endSession, goto, takeControl, releaseControl, setViewport,
} from '../services/browserSessions';
import type { BrowserThreadSurface } from '../services/browserSessions';
import { auth } from '../config/firebase';
import {
  isDrivingSession,
  type BrowserViewport,
  type GetActiveSessionResponse,
} from '../types/browserSession';

/** The bounds the runtime accepts for the page's size, in CSS pixels. The
 *  pane's measurement is clamped to them and rounded to an even number, so a
 *  vendor that halves for device scale gets whole pixels. */
export const VIEWPORT_MIN: BrowserViewport = { width: 640, height: 480 };
export const VIEWPORT_MAX: BrowserViewport = { width: 1920, height: 1200 };
/** How long after the last size change the viewport is sent: a drag reports
 *  a size on every frame, and the page is resized once, at the end. */
export const VIEWPORT_SEND_DEBOUNCE_MS = 300;

function even(n: number): number {
  return Math.floor(n / 2) * 2;
}

/** A measured size brought inside the runtime's bounds WITHOUT changing its
 *  shape, and rounded to 2.
 *
 *  The shape is the whole point. The runtime lays the page out at the pane's
 *  aspect ratio so the live view fills the pane and a point needs no
 *  letterbox, and it maps a point through `paneToViewport` on that
 *  assumption. Clamping the two axes independently — which is what this did —
 *  breaks it: the pane's live view is 1439/986, and at the 480px default the
 *  wrap measures 455x312, which both floors bind, so the pane asked for
 *  640x480 and the runtime scaled that to 1280x960. Every pane narrower than
 *  ~725px reported 4:3 whatever its real shape.
 *
 *  So a size is scaled by ONE factor, the tightest any bound demands, and
 *  only then rounded. Rounding to 2 can still move the ratio by a pixel; that
 *  is a sub-pixel of live view, not a collapsed aspect. */
export function clampViewport(size: { width: number; height: number }): BrowserViewport {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  // Grow to clear both minimums, then shrink to clear both maximums. The
  // second undoes part of the first only for a shape no size inside these
  // bounds can have (wider than 4:1, or taller than 1:1.875), and there the
  // maximum wins and one axis lands under its floor — a shape the pane
  // cannot take, since the live view's box is fixed at 1439/986, and the
  // runtime clamps what it is sent regardless.
  const grow = Math.max(1, VIEWPORT_MIN.width / width, VIEWPORT_MIN.height / height);
  const shrink = Math.min(1, VIEWPORT_MAX.width / (width * grow), VIEWPORT_MAX.height / (height * grow));
  const scale = grow * shrink;
  return {
    width: even(Math.round(width * scale)),
    height: even(Math.round(height * scale)),
  };
}

export interface UseBrowserSessionForThreadOptions {
  /**
   * Fired exactly once when a session APPEARS for this thread where there
   * wasn't one before. Sources:
   *   1. SSE `SESSION_CREATED` event from the backend (preferred path when
   *      cross-instance event delivery works).
   *   2. The active-session query refetching and finding a session — covers
   *      the case where the SSE event was lost (e.g. tenant-runtime has no
   *      session affinity, so the chat-turn-handler and SSE listener can
   *      land on different Cloud Run instances and the in-process
   *      EventEmitter doesn't broadcast across them).
   *
   * Used by AgentChatPage to auto-open the browser pane when the AGENT
   * spawns a session via `run_browser_task` (the user didn't click the
   * toggle; the session just appeared). Without this hook, the user gets
   * "Done — the browser is now on nytimes.com" but no visible pane.
   */
  onSessionCreated?: () => void;
  /** Which surface's thread this is. Defaults to agent chat, the only surface
   *  that had a pane before the platform assistants got one. */
  surface?: BrowserThreadSurface;
}

export function useBrowserSessionForThread(
  threadId: string | null,
  agentId: string | null,
  options: UseBrowserSessionForThreadOptions = {},
) {
  const { currentTenant } = useTenant();
  const tenantId = currentTenant?.id;
  const queryClient = useQueryClient();

  // The surface is part of the identity of the thread, not a detail of how it
  // is fetched: the same UUID can name a different thread on another surface,
  // and a shared key would serve one surface's session to another.
  const surface = options.surface ?? 'agent';
  const queryKey = useMemo(
    () => ['browser-session-for-thread', tenantId, surface, threadId],
    [tenantId, surface, threadId],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => getActiveSession(tenantId!, threadId!, surface),
    enabled: !!tenantId && !!threadId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
    refetchInterval: 90 * 1000, // belt-and-suspenders backstop to SSE
  });

  // Taking or releasing the wheel. Both write the returned session straight
  // into the cache so the pane flips out of observer mode on the same tick
  // rather than waiting for the next poll. Taking names the thread, so the
  // backend can read the runtime's state before it claims: another person
  // who is present and still holds the wheel answers 409 `held_by_other`,
  // and the avatar above the live view already says who. Releasing answers
  // the hold that ended and whether this viewer was its driver.
  const controlMutation = useMutation({
    mutationFn: ({ sessionId, take }: { sessionId: string; take: boolean }) =>
      take
        ? takeControl(tenantId!, sessionId, threadId ? { threadId, surface } : undefined)
          .then((res) => ({ session: res.session, holdId: null as string | null, releasedByDriver: false }))
        : releaseControl(tenantId!, sessionId),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, (prev: GetActiveSessionResponse | undefined) => ({
        session: data.session,
        lastClosedSession: prev?.lastClosedSession ?? null,
      }));
    },
  });

  // The pane's size, as the pane last measured it: sent with ensure so a
  // session is the pane's size from its first frame, and to the session after
  // a resize, debounced so a drag sends once. No sequencing and no lock: the
  // debounce and the runtime's restore on the next screenshot are the net.
  const viewportRef = useRef<BrowserViewport | null>(null);
  const sentViewportRef = useRef<BrowserViewport | null>(null);
  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdForViewport = query.data?.session?.id ?? null;
  const sendViewport = useCallback(() => {
    const size = viewportRef.current;
    if (!size || !tenantId || !threadId || !sessionIdForViewport) return;
    const sent = sentViewportRef.current;
    if (sent && sent.width === size.width && sent.height === size.height) return;
    sentViewportRef.current = size;
    setViewport(tenantId, threadId, sessionIdForViewport, size, surface).catch(() => {
      // The next resize, or the runtime's restore, is the net.
      sentViewportRef.current = null;
    });
  }, [tenantId, threadId, sessionIdForViewport, surface]);
  const scheduleViewport = useCallback(() => {
    if (viewportTimerRef.current) clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = setTimeout(() => {
      viewportTimerRef.current = null;
      sendViewport();
    }, VIEWPORT_SEND_DEBOUNCE_MS);
  }, [sendViewport]);
  useEffect(() => () => { if (viewportTimerRef.current) clearTimeout(viewportTimerRef.current); }, []);
  /** The pane measured itself. Kept for the next ensure; sent to the session
   *  when the size settles. */
  const reportViewport = useCallback((size: { width: number; height: number }) => {
    const clamped = clampViewport(size);
    const prev = viewportRef.current;
    if (prev && prev.width === clamped.width && prev.height === clamped.height) return;
    viewportRef.current = clamped;
    scheduleViewport();
  }, [scheduleViewport]);
  /** The person let go of the resize handle. */
  const onResizeEnd = useCallback(() => { scheduleViewport(); }, [scheduleViewport]);
  // A new session has the constant's size until told: send the pane's.
  useEffect(() => {
    sentViewportRef.current = null;
    if (sessionIdForViewport && viewportRef.current) scheduleViewport();
  }, [sessionIdForViewport, scheduleViewport]);

  const ensureMutation = useMutation({
    mutationFn: () => ensureSession(tenantId!, threadId!, agentId, surface, viewportRef.current),
    onSuccess: (data) => {
      // Cache mirror: write through both `session` and `lastClosedSession` so
      // /active and /ensure stay observationally consistent. On the typed-error
      // path data.session is null but data.lastClosedSession may still be set
      // — the paused-frame UX needs that to keep rendering.
      queryClient.setQueryData(queryKey, {
        session: data.session,
        lastClosedSession: data.lastClosedSession,
      });
    },
  });

  const endMutation = useMutation({
    mutationFn: (sessionId: string) => endSession(tenantId!, sessionId),
    onSuccess: () => {
      queryClient.setQueryData(queryKey, { session: null, lastClosedSession: null });
    },
  });

  const gotoMutation = useMutation({
    mutationFn: ({ sessionId, url }: { sessionId: string; url: string }) =>
      goto(tenantId!, sessionId, url),
  });


  // Mirror the session's last-known URL to localStorage so a freshly-minted
  // session restores to it. Anchor has no per-navigation webhook, so the URL is
  // captured server-side (goto / run_browser_task / read_active_browser_session
  // / page-state) and arrives here via the active-session query + SSE-triggered
  // refetches.
  const currentUrl = query.data?.session?.currentUrl ?? null;
  useEffect(() => {
    if (!threadId || !currentUrl) return;
    window.localStorage.setItem(`browser-pane-last-url-${threadId}`, currentUrl);
  }, [threadId, currentUrl]);

  // Tracks the last (thread, session) pair we observed plus an
  // `awaitingBaseline` flag set after a thread switch. The flag silences
  // the FIRST sessionId resolution on the new thread — that resolution
  // is the new thread's pre-existing state (the user switched here, the
  // session was already there), not a fresh-creation event.
  const lastSeenRef = useRef<{ threadId: string | null; sessionId: string | null; awaitingBaseline: boolean }>({
    threadId: null,
    sessionId: null,
    awaitingBaseline: false,
  });
  const onSessionCreated = options.onSessionCreated;

  // Fire onSessionCreated when a new session id appears WHILE the user
  // stays on the same thread. That covers:
  //   - SSE SESSION_CREATED event from the agent's run_browser_task call
  //   - the active-session query refetching mid-conversation and finding
  //     a session the SSE event lost (tenant-runtime has no Cloud Run
  //     session affinity; in-process EventEmitter doesn't broadcast)
  //   - an explicit ensureMutation success
  //
  // Critically, it does NOT fire when the user switches threads and the
  // new thread happens to already have a session. Without the baseline
  // gate, a thread switch produced two effect runs — one with the stale
  // sessionId (silenced as "thread switch"), then a second with the new
  // thread's sessionId loading in (which looked like a fresh appearance
  // on the now-current thread and re-fired). The baseline flag absorbs
  // that first resolution; subsequent transitions on the new thread
  // (e.g. agent calling run_browser_task while we're there) fire normally.
  const sessionId = query.data?.session?.id ?? null;
  useEffect(() => {
    const prev = lastSeenRef.current;
    const isThreadSwitch = prev.threadId !== null && prev.threadId !== threadId;

    if (isThreadSwitch) {
      // The user just navigated to a different thread. Whatever the
      // active-session query lands next IS the baseline for this thread
      // — record without firing. If sessionId is already set at the
      // moment of switch (rare: keepPreviousData / cache hit), that
      // counts as the baseline too.
      lastSeenRef.current = { threadId, sessionId, awaitingBaseline: !sessionId };
      return;
    }

    if (prev.awaitingBaseline) {
      // First sessionId resolution after a switch — adopt as baseline.
      if (sessionId) {
        lastSeenRef.current = { threadId, sessionId, awaitingBaseline: false };
      }
      return;
    }

    if (prev.sessionId === sessionId) return;
    lastSeenRef.current = { threadId, sessionId, awaitingBaseline: false };
    if (!sessionId) return;
    onSessionCreated?.();
  }, [threadId, sessionId, onSessionCreated]);

  // SSE — mirrors agentChat.ts pattern, manually-read ReadableStream over
  // the platform-backend's existing stream router. Active only while
  // the consumer (the pane) is mounted.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!tenantId || !threadId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    (async () => {
      const token = await auth.currentUser?.getIdToken();
      // The surface travels with the stream as it does with every other call
      // for the thread: the backend picks the thread's table from it, and
      // without it an assistant's thread is looked up on agent chat and 404s.
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/api/threads/${threadId}/browser-sessions/stream?tenantId=${tenantId}&surface=${surface}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
      );
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '', currentEvent = '';
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '');
          if (line === '') { currentEvent = ''; continue; }
          if (line.startsWith(':')) continue;
          if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
          if (line.startsWith('data: ') && currentEvent) {
            if (
              currentEvent === 'SESSION_CLOSED' ||
              currentEvent === 'SESSION_UPDATED' ||
              currentEvent === 'SESSION_CREATED'
            ) {
              void queryClient.invalidateQueries({ queryKey });
            }
            // SESSION_CREATED is the legacy event the backend emits when
            // either the user OR the agent spawns a session. We only need
            // to invalidate here (already done above) — the actual
            // onSessionCreated callback fires from the query-effect below
            // off the session id transition, which gives us one source of
            // truth that works whether the signal came from SSE OR a query
            // refetch (the cross-instance backstop).
          }
        }
      }
    })().catch(() => {}); // silently swallow abort
    return () => controller.abort();
  }, [tenantId, threadId, surface, queryClient, queryKey]);

  // Derived state for the BrowserPane's paused-frame UX:
  //   pausedFrameUrl — set only when (a) no live session, (b) the last closed
  //     session ended via idle_timeout, and (c) we have a cached screenshot
  //     URL on the row. The component renders that image with a "Session
  //     paused — Resume browsing" overlay that calls onRetryEnsure.
  const pausedFrameUrl = useMemo<string | null>(() => {
    if (query.data?.session) return null;
    const closed = query.data?.lastClosedSession;
    if (!closed) return null;
    if (closed.closedReason !== 'idle_timeout') return null;
    if (!closed.lastScreenshotSignedUrl) return null;
    return closed.lastScreenshotSignedUrl;
  }, [query.data]);

  // Single "did ensure fail" boolean for the pane. We deliberately collapse
  // the typed EnsureSessionError envelope (HTTP 200 + structured failure) and
  // the unclassified mutation rejection (HTTP 5xx) into ONE branch — the user
  // sees a single "Unable to start the browser" message regardless of kind.
  // The kind distinction stays load-bearing on the backend for logs/metrics
  // (and powers lastClosedSession ride-along on the success-with-error path),
  // but per-kind user-facing copy was scope creep — the user explicitly does
  // NOT want different copies for different vendor failures.
  const isEnsureError =
    ensureMutation.isError || !!ensureMutation.data?.error;

  // Hand the browser back if this viewer is driving it. Speaking to the AI
  // team or the assistant in the chat while holding its browser is an
  // instruction to act, and nothing can act in the browser while a person
  // holds the wheel: the runtime refuses every browser tool and the reply
  // says so. Otherwise pressing "Hand back" first, every time, would be the
  // only way to be heard ("Click on Sports for me" would be answered with "you
  // have taken over the browser"). So the send hands back first. Resolves
  // with the hold the release ended when this viewer was its driver, so the
  // send can name the hand-back in the turn; null when nothing was held,
  // when the release failed, or when another person was the driver. A
  // failed release is not a failed send, and the runtime's refusal will
  // say so.
  const handBackIfDriving = useCallback(async (viewerAccountId: string | null | undefined): Promise<string | null> => {
    const session = query.data?.session;
    if (!session || !isDrivingSession(session, viewerAccountId)) return null;
    try {
      const released = await controlMutation.mutateAsync({ sessionId: session.id, take: false });
      return released.releasedByDriver ? released.holdId : null;
    } catch {
      // Left to the turn: the assistant's refusal names the takeover.
      return null;
    }
  }, [query.data?.session, controlMutation]);

  return {
    query,
    ensureMutation,
    endMutation,
    gotoMutation,
    controlMutation,
    pausedFrameUrl,
    isEnsureError,
    handBackIfDriving,
    reportViewport,
    onResizeEnd,
  };
}
