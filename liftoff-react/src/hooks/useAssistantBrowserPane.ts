import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useBrowserSessionForThread } from './useBrowserSessionForThread'
import { usePlatformBrowser } from './usePlatformBrowser'
import { useConnectors } from './useConnectors'
import { isBrowserPaneAvailable } from '../pages/Dashboard/browserPaneAvailability'
import { isBrowserDrivingTool } from '../pages/Dashboard/browserDrivingTools'
import type { BrowserThreadSurface } from '../services/browserSessions'

/** The browser pane, for the PLATFORM ASSISTANTS: Liftoff, the Insights
 *  Manager and the Chief AI Officer.
 *
 *  One hook for all three, rather than the same wiring pasted onto three pages.
 *  The pane has several ways to open — the person presses the button, the
 *  assistant calls a browser tool, a session simply appears — and a page that
 *  implemented two of the three would show a person a blank panel while the
 *  assistant reported success. That is the failure this consolidates away.
 *
 *  It is deliberately NOT used by AgentChatPage, whose pane shares its slot
 *  with the More pane and carries agent-specific driver handoff. Converging
 *  that page onto this hook is worth doing separately, where the risk is only
 *  to the page being changed.
 *
 *  The difference from an agent's pane is that there is no agent: no bindings
 *  to check, and no agent id to spawn against. Availability therefore reduces
 *  to "does this workspace have a browser at all" — its own connector, or the
 *  platform's. */
export function useAssistantBrowserPane(opts: {
  surface: BrowserThreadSurface
  tenantId: string | undefined
  threadId: string | null
  /** Mints a thread when the person opens the pane before saying anything.
   *  Returns the new thread id, or null if it could not be created. */
  ensureThread: () => Promise<string | null>
  assistantName: string
}) {
  const [isOpen, setIsOpen] = useState(false)

  // Pane width, seeded from the same stored value the agent-chat pane uses so a
  // person who sized it there does not have to size it again here. Clamped at
  // drag time so the conversation column keeps at least a third of the space.
  const PANE_DEFAULT = 480
  const PANE_MIN = 360
  const [paneWidth, setPaneWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return PANE_DEFAULT
    const stored = window.localStorage.getItem('agent-chat-right-pane-width')
    const parsed = stored ? parseInt(stored, 10) : NaN
    return Number.isFinite(parsed) && parsed >= PANE_MIN ? parsed : PANE_DEFAULT
  })
  // Seeded once and thereafter written only beside its setState, in the drag
  // handler that is the sole place the width changes. It used to be re-synced
  // here on every render, which is a ref write during render and buys nothing:
  // the two can never be out of step.
  const paneWidthRef = useRef(paneWidth)
  const containerRef = useRef<HTMLDivElement>(null)
  // True only while the resizer is dragged. It puts a transparent overlay above
  // the live-view iframe, which is a separate browsing context and would
  // otherwise swallow mousemove and — worse — mouseup, leaving the drag stuck.
  const [isResizing, setIsResizing] = useState(false)

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = paneWidthRef.current
    setIsResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (mv: MouseEvent) => {
      const dx = mv.clientX - startX
      const available = containerRef.current?.getBoundingClientRect().width ?? window.innerWidth
      const max = Math.floor(available * (2 / 3))
      const clamped = Math.max(PANE_MIN, Math.min(max, startWidth - dx))
      paneWidthRef.current = clamped
      setPaneWidth(clamped)
    }
    const onUp = () => {
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.localStorage.setItem('agent-chat-right-pane-width', String(paneWidthRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // If the page unmounts mid-drag the listeners go with it, but the body styles
  // would survive and leave the whole app stuck showing a resize cursor.
  useEffect(() => () => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const platformBrowser = usePlatformBrowser(opts.tenantId)
  const connectorsQuery = useConnectors()

  // No agent bindings to weigh — a platform assistant has no agent row — so
  // this is the workspace's own session-capable connector, or the platform's
  // browser. Passing an empty binding list is the honest input rather than a
  // shortcut: it says "this caller is bound to nothing", which is true, and
  // leaves the platform arm to decide.
  const isAvailable = isBrowserPaneAvailable(
    [],
    connectorsQuery.data ?? [],
    platformBrowser.isAvailable,
  )

  const session = useBrowserSessionForThread(opts.threadId, null, {
    surface: opts.surface,
    // A session appearing mid-conversation means the assistant just opened a
    // browser. Opening the pane is idempotent, so this is safe to fire whenever
    // it happens.
    onSessionCreated: useCallback(() => setIsOpen(true), []),
  })

  // The thread a first-press ensure is waiting on. Set when the pane is
  // opened before the person has said anything and a thread had to be minted;
  // consumed by the effect below once this hook has re-rendered with that
  // thread id, because THAT is the only render whose session hook can ensure
  // against it. Calling ensure from the toggle right after minting fired it
  // on the closure built for a null thread, so the request went to
  // /threads/null/... and the pane reported it could not start a browser.
  const ensureOnThreadRef = useRef<string | null>(null)

  const toggle = useCallback(async () => {
    const opening = !isOpen
    setIsOpen(opening)
    if (!opening) return

    // A session cannot be opened without a thread to hang it on. When the
    // person presses the button before saying anything there is no thread yet,
    // so one is minted first and the ensure is deferred to the render that
    // carries it (see ensureOnThreadRef).
    if (!opts.threadId) {
      const minted = await opts.ensureThread()
      if (minted) ensureOnThreadRef.current = minted
      return
    }
    if (!session.query.data?.session && !session.ensureMutation.isPending) {
      session.ensureMutation.mutate()
    }
  }, [isOpen, opts, session])

  const { data: sessionData } = session.query
  const { mutate: ensure, isPending: ensurePending, isError: ensureFailed } = session.ensureMutation
  useEffect(() => {
    if (!opts.threadId || ensureOnThreadRef.current !== opts.threadId) return
    if (sessionData?.session || ensurePending || ensureFailed) return
    ensureOnThreadRef.current = null
    ensure()
  }, [opts.threadId, sessionData?.session, ensurePending, ensureFailed, ensure])

  const close = useCallback(() => setIsOpen(false), [])

  /** Call with each tool name the assistant invokes.
   *
   *  This is the DETERMINISTIC way the pane opens. The other two paths are
   *  weaker — an SSE event that can be lost, and a 90-second refetch that
   *  lands after the turn is over — so a browser tool firing is the signal
   *  that the pane is about to be driven. */
  const noticeToolCall = useCallback((toolName: string) => {
    if (isBrowserDrivingTool(toolName)) setIsOpen(true)
  }, [])

  return {
    isAvailable,
    /** Open AND available. A pane that is open but unavailable would render a
     *  panel over a browser that cannot exist. */
    isOpen: isOpen && isAvailable,
    toggle,
    close,
    noticeToolCall,
    session,
    assistantName: opts.assistantName,
    // Layout. The class and the CSS variable are what ChatPage.css reads, and
    // every chat page already imports it, so a page opts in by spreading these
    // rather than writing its own pane layout.
    containerRef,
    paneWidth,
    isResizing,
    onResizeStart,
  }
}
