import { useChatAttachments } from '../../hooks/useChatAttachments'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Tooltip } from '../../components'
import type { ChatSeedState } from '../../types/chatSeed'
import { isDrivingSession } from '../../types/browserSession'
import Button from '../../components/Button'
import ChatHistoryModal from '../../components/Chat/ChatHistoryModal'
import ChatMessages from '../../components/Chat/ChatMessages'
import { activityLabel } from '../../components/Chat/activityLabel'
import { BrowserHandbackRow } from '../../components/Chat/BrowserHandbackRow'
import { StatusRow } from '../../components/Chat/StatusRow'
import { isBrowserEventRow } from '../../components/Chat/browserEventRows'
import { getDisplayName } from '../../utils/avatar'
import {
  ForwardedContextRow,
  FORWARDED_CONTEXT_MESSAGE_TYPE,
} from '../../components/Chat/ForwardedContextRow'
import type { ChatMessageItem } from '../../components/Chat/ChatMessages'
import { FileOutputCard } from '../../components/Chat/FileOutputCard'
import { HitlPendingIndicator } from '../../components/Chat/HitlPendingIndicator'
import { NotificationPromptBar } from '../../components/Chat/NotificationPromptBar'
import ChatInput from '../../components/Chat/ChatInput'
import { useChatStreaming } from '../../hooks/useChatStreaming'
import { useCreateAgentChatThread, useAgentChatThreads } from '../../hooks/useAgentChatThreads'
import { useAgentChatMessages, AGENT_CHAT_MESSAGES_QUERY_KEY } from '../../hooks/useAgentChatMessages'
import { useChatUnreadCounts, useMarkThreadRead, useMarkAllThreadsRead } from '../../hooks/useChatUnread'
import { useTenant } from '../../hooks/useTenant'
import { useResumableThread, isThreadGone } from '../../hooks/useResumableThread'
import { consumeSeed } from '../../lib/chatNavState'
import { usePlatformBrowser } from '../../hooks/usePlatformBrowser'
import { useAuth } from '../../contexts/AuthContext'
import { useThreadPresence } from '../../hooks/useThreadPresence'
import { usePendingApproval, PENDING_APPROVAL_QUERY_KEY } from '../../hooks/usePendingApproval'
import { useObservedTurn } from '../../hooks/useObservedTurn'
import { agentChatPresenceTransport } from '../../hooks/chatPresenceTransports'
import { ThreadPresence, TypingIndicator } from '../../components/Chat/ThreadPresence'
import { useToast } from '../../contexts/ToastContext'
import { api } from '../../services/api'
import { getInternalAgent, type InternalAgent } from '../../services/internalAgents'
import { useUpdateInternalAgentStatus } from '../../hooks/useInternalAgents'
import { streamAgentChatMessage, createChatShare, stopAgentChatTurn } from '../../services/agentChat'
import { useVoiceChat } from '../../hooks/useVoiceChat'
import { VoiceInputButton, VoiceModeToggle } from '../../components/Chat/VoiceControls'
import { track } from '../../lib/analytics'
import { mergeAwaitingInputMessage } from '../../lib/awaitingInputMerge'
import type { AgentChatMessage } from '../../services/agentChat'
import EllipsisVerticalIcon from '../../assets/icons/ellipsis-vertical.svg?react'
import MessageCircleMoreIcon from '../../assets/icons/message-circle-more.svg?react'
import PencilIcon from '../../assets/icons/pencil.svg?react'
import ShareIcon from '../../assets/icons/share.svg?react'
import {
  isBrowserPaneAvailable as isBrowserPaneAvailableFor,
  shouldClosePaneOnThreadChange,
} from './browserPaneAvailability'
import { useConnectors } from '../../hooks/useConnectors'
import BrowserPane from '../../components/Chat/BrowserPane'
import { ChatInputActions, BrowserPaneToggleButton } from '../../components/Chat/ChatInputActions'
import MorePane from '../../components/Chat/MorePane'
import { useBrowserSessionForThread } from '../../hooks/useBrowserSessionForThread'
import { isBrowserDrivingTool } from './browserDrivingTools'
import { FileUploadButton } from '../../components/FileAttach'
import '../../components/Chat/ChatPage.css'
import './AgentBuilder/AgentBuilder.css'
import '../../components/connectionModals.css'
import './AgentChatPage.css'

const EMPTY_MESSAGES: AgentChatMessage[] = []

/** Which pane, if any, occupies the strip to the right of the conversation.
 *  One at a time: they share the same slot, the same width and the same
 *  resizer, so opening one closes the other. */
type RightPane = 'browser' | 'more'

/** Per-team record that the More pane has introduced itself once. Keyed by
 *  agent so someone who has met one team still gets the pane on their next. */
const MORE_PANE_SEEN_KEY_PREFIX = 'agent-chat-more-pane-seen-'


// A generated-file link posted into Slack/Teams arrives as ?f=<base64url token>
// carrying { t: tenantId, f: fileId, a: agentId, th: threadId, n: filename }.
function decodeFileToken(
  raw: string,
): { t: string; f: string; a: string | null; th: string; n: string } | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(b64)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    )
    const o = JSON.parse(json) as Record<string, unknown>
    if (typeof o.t === 'string' && typeof o.f === 'string' && typeof o.th === 'string') {
      return {
        t: o.t,
        f: o.f,
        a: typeof o.a === 'string' ? o.a : null,
        th: o.th,
        n: typeof o.n === 'string' ? o.n : '',
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * One mount per team. Everything below holds the open team's state (its
 * thread, its details, the thread it arrived with), and none of it resets when
 * the team changes under it. Moving from one team's chat to another's, as
 * Chat History's "All" list does, is a new session rather than a patch-up of
 * this one. Keyed on the router-state team only: a team named by ?agentId= or a
 * file token never changes while the page is open, and the resume write-back
 * spreads the state it finds, so the key holds steady across it.
 */
export default function AgentChatPage() {
  const location = useLocation()
  const stateAgentId = (location.state as { agentId?: string } | null)?.agentId ?? ''
  return <AgentChatSession key={stateAgentId} />
}

function AgentChatSession() {
  const location = useLocation()
  const navigate = useNavigate()
  const { currentTenant: tenant, switchTenant } = useTenant()
  // No `currentRole` here any more: whether a paused thread is this reader's to
  // clear is decided server-side, where the gate's level actually lives, rather
  // than re-derived from the role in the client.
  const { account } = useAuth()
  const { showToast } = useToast()

  // PR0: support deep-linking from the /review queue's "Open in chat" link by
  // accepting agentId + thread as query params as a fallback when
  // `location.state.agentId` is missing.
  // Keyed on the search string, which is the actual input: rebuilding the
  // params object every render made every value read off it look new.
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search])
  // ?f=<token> is a generated-file deep link from Slack/Teams (see the effect
  // below): it supplies the agent + thread so the session opens, and drives an
  // auto-download.
  const filePayload = useMemo(() => {
    const token = searchParams.get('f')
    return token ? decodeFileToken(token) : null
  }, [searchParams])
  const navState = location.state as {
    agentId?: string
    threadId?: string
    // Set by the Message action on the teams list, which opens the chat with
    // the messaging options showing instead of routing to its own page.
    openMorePane?: boolean
  } | null
  const stateAgentId = navState?.agentId
  const queryAgentId = searchParams.get('agentId')
  const agentId = filePayload?.a ?? stateAgentId ?? queryAgentId ?? undefined
  // A thread named by the URL itself: ?thread= from a notification, or the
  // file token's thread. Router state is the OTHER way one arrives, and it is
  // resolved below because it needs the tenant and the team to check itself
  // against.
  const deepLinkThreadId = searchParams.get('thread') ?? filePayload?.th ?? null
  const tenantId = tenant?.id

  // All hooks must be called unconditionally before any early return.
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  const [agent, setAgent] = useState<InternalAgent | null>(null)
  const startTeam = useUpdateInternalAgentStatus()
  const [awaitingInputMessage, setAwaitingInputMessage] = useState<ChatMessageItem | null>(null)
  // A tool call paused for HITL approval, as far as THIS reader is concerned.
  // Resolved from outstanding state rather than the SSE event, because the event
  // reaches only the client whose turn tripped the gate: an assignee opening the
  // thread got nothing, and a reload wiped it. Returns null unless the reader can
  // actually act, so the banner never offers a decision that would be refused.
  // Everyone else sees the status message the team posted into the thread.
  const pendingApproval = usePendingApproval(agentId ?? null, currentThreadId ?? null)

  // Unread state. The badge on the chat history button reads the same counts
  // query the teams list reads, so the two indicators cannot disagree, and
  // every path that opens a thread clears the marker behind both of them.
  const { data: unreadCounts } = useChatUnreadCounts()
  const hasUnreadThreads = (unreadCounts?.[agentId ?? ''] ?? 0) > 0
  const markThreadReadMutation = useMarkThreadRead(agentId ?? null)
  const markThreadRead = markThreadReadMutation.mutate
  const markAllThreadsRead = useMarkAllThreadsRead(agentId ?? null).mutate
  const markThreadReadIfPossible = useCallback(
    (threadId: string | null) => {
      if (!threadId || !agentId || !tenantId) return
      markThreadRead(threadId)
    },
    [agentId, tenantId, markThreadRead],
  )

  const [rightPane, setRightPane] = useState<RightPane | null>(null)
  const isBrowserPaneOpen = rightPane === 'browser'
  const isMorePaneOpen = rightPane === 'more'
  // Resizable pane width (px), shared by both panes so the strip keeps its
  // size when you switch between them. Seeded from localStorage so the user's
  // last pick survives page reloads; clamped at drag-time to [RIGHT_PANE_MIN,
  // window.innerWidth × 2/3] so the conversation column stays at least 1/3
  // of the viewport. `widthRef` tracks the live drag value so mousemove
  // doesn't depend on the React state closure.
  const RIGHT_PANE_DEFAULT = 480
  const RIGHT_PANE_MIN = 360
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return RIGHT_PANE_DEFAULT
    const stored = window.localStorage.getItem('agent-chat-right-pane-width')
      // Legacy key from when the browser live view was the only right pane.
      ?? window.localStorage.getItem('agent-chat-browser-pane-width')
    const parsed = stored ? parseInt(stored, 10) : NaN
    return Number.isFinite(parsed) && parsed >= RIGHT_PANE_MIN ? parsed : RIGHT_PANE_DEFAULT
  })
  const rightPaneWidthRef = useRef(rightPaneWidth)
  useEffect(() => { rightPaneWidthRef.current = rightPaneWidth })
  // chat-page element ref — the rect's width tells us the actual area
  // available to the conversation + browser pane (= viewport minus the
  // DashboardLayout sidebar, expanded or collapsed). Computing the resize
  // max against `window.innerWidth` would let the pane spill across the
  // sidebar and shove the conversation off-screen.
  const chatPageRef = useRef<HTMLDivElement>(null)

  // True only while the resizer is being dragged. Toggles a transparent
  // full-viewport overlay that sits above the Anchor iframe and captures
  // every mousemove/mouseup. Without it, the iframe (separate browsing
  // context) eats events the instant the cursor crosses into it — most
  // critically `mouseup`, so the cleanup below never runs and the drag
  // appears "stuck" with body cursor stuck on col-resize.
  const [isResizingRightPane, setIsResizingRightPane] = useState(false)

  const handleRightPaneResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = rightPaneWidthRef.current
    setIsResizingRightPane(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (mv: MouseEvent) => {
      // Pane is anchored at the chat-page's right; dragging right shrinks it.
      const dx = mv.clientX - startX
      const next = startWidth - dx
      const available = chatPageRef.current?.getBoundingClientRect().width
        ?? window.innerWidth
      // Keep the conversation column at >= 1/3 of the chat-page's width
      // (= 1/3 of the visible area between the sidebar and the viewport edge).
      const max = Math.floor(available * (2 / 3))
      const clamped = Math.max(RIGHT_PANE_MIN, Math.min(max, next))
      rightPaneWidthRef.current = clamped
      setRightPaneWidth(clamped)
    }
    const onUp = () => {
      setIsResizingRightPane(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.localStorage.setItem(
        'agent-chat-right-pane-width',
        String(rightPaneWidthRef.current),
      )
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Safety: if the component unmounts mid-drag (e.g. user navigates away
  // before releasing), reset the global body styles so col-resize cursor
  // and userSelect: none don't leak to the next page. Pairs with onUp's
  // happy-path cleanup.
  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  // Browser vendors are BYOK and gated PER-AGENT, mirroring the runtime: the
  // browser tools are only in an agent's palette when THIS agent is bound to a
  // session-capable connector — not merely when the tenant has connected one.
  // Showing the live-view affordance on tenant connection alone over-promised:
  // it appeared for agents that could not actually browse, so a "navigate the
  // browser" request got a persona refusal. Require BOTH the agent's binding
  // AND an active tenant connector (the credential must exist for a session to
  // start), matching the runtime's byokAgent(...) = bound ∧ connected check.
  //
  // The list mirrors SESSION_VENDOR_PREFERENCE in the tenant runtime's
  // browser-sessions/session-vendor-proxy.ts. It must stay in step with it:
  // this decides whether the affordance APPEARS, that decides whether a spawn
  // can SUCCEED, and the two disagreeing is visible either as a button that
  // does nothing or — as happened when browser_use shipped without this — a
  // bound agent with a working browser and no way to open it.
  //
  // browserbase is deliberately absent from both. It reports session support
  // but implements none of the pane operations, so it cannot drive this view.
  //
  // The Chief AI Officer chat passes leftActions too now, but only the mic: the
  // browser affordance is per-agent and there is no agent binding behind that
  // surface.
  //
  // Since the platform took a Browser Use key of its own, the connector halves
  // above are no longer the only route: a workspace that connected nothing
  // still gets a browser, so this also asks whether that tier is switched on.
  const connectorsQuery = useConnectors()
  // The second route to a browser: the platform's own Browser Use key, which
  // backs one for a workspace that connected nothing. Read from the same two
  // operator kill-switches the runtime reads, so the affordance disappears when
  // an operator switches the vendor off rather than opening a pane the backend
  // then refuses.
  const platformBrowser = usePlatformBrowser(tenant?.id)
  const isBrowserPaneAvailable = isBrowserPaneAvailableFor(
    // integrationId is optional on the integration shape, so drop the blanks
    // rather than passing undefined through as a would-be connector id.
    (agent?.integrations ?? []).flatMap((i) => (i.integrationId ? [i.integrationId] : [])),
    connectorsQuery.data ?? [],
    platformBrowser.isAvailable,
  )

  // Auto-open the browser pane when a session appears DURING THIS THREAD.
  // useBrowserSessionForThread only fires onSessionCreated for intra-thread
  // appearances — thread switches don't trigger it even if the new thread
  // already has a session — so we can wire this directly to opening the
  // pane without conflating "session is new" with "user switched here."
  //
  // Selecting 'browser' is idempotent, so calling this when the pane is
  // already open is a no-op. We don't try to remember "user explicitly
  // closed it" — they can close it again if they want. A live browser
  // outranks the More pane, which is reference material the user can bring
  // back from the header at any time.
  const browserSession = useBrowserSessionForThread(currentThreadId, agentId ?? null, {
    onSessionCreated: useCallback(() => {
      setRightPane('browser')
    }, []),
  })

  // Close the BROWSER pane on any thread switch. Per-thread sessions are
  // independent — the user navigating to a different conversation
  // shouldn't have a pane from the prior conversation lingering. If the
  // new thread is one where the agent is mid-flight on a browser task,
  // the onToolCall handler above (or onSessionCreated for intra-thread
  // appearances) will flip it back on; if the new thread is just an old
  // conversation with a stale session row, the pane stays closed and the
  // user re-opens via the toggle if they want it.
  //
  // The More pane is left alone: it is about the team, not the thread, so
  // it survives switching conversations (and the auto-open on mount, which
  // this effect also runs alongside).
  //
  // "Switch" means moving BETWEEN two real conversations. It does not mean the
  // first thread being created, which is what happens when the browser toggle
  // is pressed on a chat that has no thread yet: the handler opens the pane and
  // then creates a thread, so currentThreadId goes null -> id. Treating that as
  // a switch closed the pane a frame after the user opened it, and
  // onSessionCreated then reopened it — the open/close/open flicker. Compare
  // against the previous id and only close when both are real and different.
  const previousThreadIdRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousThreadIdRef.current
    previousThreadIdRef.current = currentThreadId ?? null
    if (!shouldClosePaneOnThreadChange(previous, currentThreadId ?? null)) return
    setRightPane(pane => (pane === 'browser' ? null : pane))
  }, [currentThreadId])

  // The More pane introduces the other ways to reach this team (Slack,
  // Microsoft Teams, an AI coding tool). It shows itself the first time this
  // reader opens this team's chat, and every time they arrive from the
  // Message action on the teams list — that action now opens the chat with
  // the options alongside it rather than routing to a page of its own.
  // Afterwards it is on the header's More button. Runs once per mount; the
  // ref keeps a re-render (or the location object changing identity) from
  // re-opening a pane the user just closed.
  const requestedMorePane = navState?.openMorePane === true
  const morePaneAutoOpenedRef = useRef(false)
  useEffect(() => {
    if (!agentId || morePaneAutoOpenedRef.current) return
    morePaneAutoOpenedRef.current = true
    const seenKey = `${MORE_PANE_SEEN_KEY_PREFIX}${agentId}`
    const seen = window.localStorage.getItem(seenKey) === 'true'
    if (seen && !requestedMorePane) return
    window.localStorage.setItem(seenKey, 'true')
    // Which pane opens depends on what localStorage says and on marking it
    // seen, so the read and the write belong in an effect together.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRightPane('more')
  }, [agentId, requestedMorePane])

  const lastUrlKey = currentThreadId ? `browser-pane-last-url-${currentThreadId}` : null

  // The thread this history entry is holding, and the write that puts it
  // there. Two ways it gets onto the entry, and the same call covers both: the
  // /share/<id> resolver, which hands it over as router state precisely so the
  // id stays out of the address bar, and this page, which stamps the open
  // conversation onto the entry so a refresh comes back to it. Scoped to the
  // team, so an entry left over from a different one is refused rather than
  // opened against the wrong transcript.
  const resumeThreadId = useResumableThread(currentThreadId, {
    tenantId,
    scopeId: agentId ?? '',
  })
  const queryThreadId = deepLinkThreadId ?? resumeThreadId

  // PR0: apply queryThreadId once on mount if currentThreadId is null.
  const [appliedQueryThread, setAppliedQueryThread] = useState<string | null>(null)
  if (queryThreadId && !appliedQueryThread && currentThreadId !== queryThreadId) {
    setAppliedQueryThread(queryThreadId)
    setCurrentThreadId(queryThreadId)
  }
  // This path bypasses handleSetCurrentThreadId, so it has to clear the marker
  // itself. Without it, arriving by deep link reads the reply and leaves all
  // three indicators still lit. A request, so it stays in an effect.
  useEffect(() => {
    if (!appliedQueryThread) return
    markThreadReadIfPossible(appliedQueryThread)
  }, [appliedQueryThread, markThreadReadIfPossible])

  // Generated-file deep link (?f=<token>): download the file, opening the
  // session in the right tenant first. The download endpoint verifies tenant
  // membership, so a non-member (or a missing/expired file) lands in the catch
  // and is routed to /dashboard/agents with a toast. Runs once.
  const fileDownloadRef = useRef(false)
  useEffect(() => {
    if (!filePayload || !tenant || fileDownloadRef.current) return
    fileDownloadRef.current = true
    const { t, f, n } = filePayload
    void (async () => {
      try {
        const { downloadUrl } = await api.get<{ downloadUrl: string }>(
          `/api/generated-files/${encodeURIComponent(f)}/download?tenantId=${encodeURIComponent(t)}`,
        )
        // Endpoint confirmed membership — show the session in the file's tenant.
        if (t && tenant && t !== tenant.id) switchTenant(t)
        const res = await fetch(downloadUrl)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = n || ''
        anchor.click()
        URL.revokeObjectURL(url)
      } catch {
        navigate('/dashboard/agents', { replace: true })
        showToast('This file is unavailable.', 'error')
      }
    })()
  }, [filePayload, tenant, switchTenant, navigate, showToast])

  const createThreadMutation = useCreateAgentChatThread(agentId ?? null)
  const threadsResult = useAgentChatThreads(agentId ?? null)

  const seedConsumedRef = useRef(false)

  const seedState = location.state as (ChatSeedState & { agentId?: string; threadId?: string }) | null
  const hasSeed = !!seedState?.seedMessage

  const { data: messagesData, error: messagesError, isLoading: messagesLoading } =
    useAgentChatMessages(agentId ?? null, currentThreadId)
  const persistedMessages: AgentChatMessage[] = useMemo(() => {
    if (!messagesData) return EMPTY_MESSAGES
    return messagesData.pages.flatMap(p => p.messages).slice().reverse()
  }, [messagesData])

  // Merge the synthetic awaiting-input message (if present) into the list
  // shown to ChatMessages. It lives only in local state and is cleared when
  // the user sends their next reply or switches threads — and now also stands
  // down once the backend's persisted copy of the same question arrives, which
  // is what stops it rendering twice. See lib/awaitingInputMerge.
  const messages = useMemo<ChatMessageItem[]>(
    () => mergeAwaitingInputMessage<ChatMessageItem>(persistedMessages, awaitingInputMessage),
    [persistedMessages, awaitingInputMessage],
  )

  // Determine if current thread is from Slack (read-only)
  const currentThread = useMemo(() => {
    const allThreads = threadsResult.data?.pages.flatMap(p => p.threads) ?? []
    return allThreads.find(t => t.id === currentThreadId)
  }, [threadsResult.data, currentThreadId])
  const isSlackThread = currentThread?.channel === 'slack'
  // mcp threads are read-only in v1 (plan v6.1) — same treatment as Slack.
  const isMcpThread = currentThread?.channel === 'mcp'
  const isReadOnlyThread = isSlackThread || isMcpThread

  const openedRef = useRef(false)

  // Fetch agent details
  useEffect(() => {
    if (!agentId || !tenantId) return
    let cancelled = false
    getInternalAgent(agentId, tenantId).then(data => {
      if (!cancelled) {
        setAgent(data)
        if (!openedRef.current) {
          openedRef.current = true
          track('agent_chat_opened', { agent_id: data.id })
        }
      }
    }).catch(() => { /* agent name falls back to 'Agent' */ })
    return () => { cancelled = true }
  }, [agentId, tenantId])

  // Redirect if agentId is absent from location state (e.g. direct URL access).
  useEffect(() => {
    if (!agentId) navigate('/dashboard/agents', { replace: true })
  }, [agentId, navigate])

  const handleSetCurrentThreadId = useCallback((id: string | null) => {
    if (id && agentId && id !== currentThreadId) {
      track('agent_chat_thread_switched', { agent_id: agentId, thread_id: id })
    }
    setCurrentThreadId(id)
    setAwaitingInputMessage(null)
    // Opening a conversation is reading it. Every selection path funnels
    // through here, including the Chat History modal. Re-selecting the thread
    // already on screen is not an open, and anything that arrived while it was
    // on screen is already handled by the reply-watcher effect below.
    if (id !== currentThreadId) markThreadReadIfPossible(id)
    // No banner reset needed: the pending-approval query is keyed by thread, so
    // switching threads re-asks rather than carrying the last one's answer over.
  }, [agentId, currentThreadId, markThreadReadIfPossible])

  // The resumed thread is gone: deleted from another tab, or no longer this
  // reader's to open. Fall back to a fresh chat rather than leaving them on a
  // blank page with no explanation. A network failure does NOT come through
  // here — see isThreadGone.
  useEffect(() => {
    if (!currentThreadId || !isThreadGone(messagesError)) return
    // Reacting to an external system telling us the thread is not there any
    // more, which is what an effect is for. There is nothing to derive this
    // from during render: the transcript query is the only thing that knows.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    handleSetCurrentThreadId(null)
    showToast('That conversation is no longer available.', 'error')
  }, [currentThreadId, messagesError, handleSetCurrentThreadId, showToast])

  const streamMessage = useCallback(
    (
      input: { tenantId: string; threadId: string; content?: string },
      callbacks: Parameters<typeof streamAgentChatMessage>[1],
      signal: AbortSignal,
    ) => streamAgentChatMessage({ ...input, agentId: agentId! }, callbacks, signal),
    [agentId],
  )

  // Same endpoint, no thread: the backend reads a request with no threadId and
  // no content as "say hello", and writes nothing down.
  const streamGreeting = useCallback(
    (
      input: { tenantId: string },
      callbacks: Parameters<typeof streamAgentChatMessage>[1],
      signal: AbortSignal,
    ) => streamAgentChatMessage({ ...input, agentId: agentId! }, callbacks, signal),
    [agentId],
  )

  const handleAwaitingInput = useCallback((event: { question: string; sessionId: string }) => {
    setAwaitingInputMessage({
      id: `awaiting-input-${event.sessionId}`,
      role: 'assistant',
      content: event.question,
      createdAt: new Date().toISOString(),
    })
    // When the tenant has Anchor connected, treat an awaiting-input event as
    // "the agent paused for a clarification — likely because the browser hit
    // a CAPTCHA / intervention" and surface the live view automatically so
    // the user can see what the agent is stuck on without hunting for the
    // toggle. The user can still close the pane manually. Follow-up: when
    // the stream event grows a `source` field we can gate on
    // `source === 'anchor_intervention'` here instead of the connector
    // presence so non-Anchor clarifications never trigger the pane.
    if (isBrowserPaneAvailable) setRightPane('browser')
  }, [isBrowserPaneAvailable])

  // Hooks shared with the cross-instance backstop effect below — declared
  // here so both `chat` (defined further down via useChatStreaming) and
  // this effect can read them.
  const queryClient = useQueryClient()

  // A tool call paused for HITL approval. The operator approves or rejects in
  // /dashboard/review and the SAME run resumes to completion. The waiting status
  // itself is a posted message now, so this handler only has to make it appear
  // promptly for the one client that received the event.
  const handleHitlRequired = useCallback(() => {
    // The event no longer drives the banner, because it only ever reached this
    // one client. It survives as an immediacy hint: refresh the outstanding-request
    // query and the message list now rather than waiting for the next poll, so the
    // person who tripped the gate sees it at once.
    void queryClient.invalidateQueries({ queryKey: PENDING_APPROVAL_QUERY_KEY })
    void queryClient.invalidateQueries({
      queryKey: [...AGENT_CHAT_MESSAGES_QUERY_KEY, agentId, tenantId, currentThreadId],
    })
  }, [queryClient, agentId, tenantId, currentThreadId])

  // A team THIS team delegated work to stopped for an approval. In-flight, not
  // terminal: the team handling this conversation keeps narrating afterwards,
  // so nothing settles. The status row naming the waiting team was persisted
  // the moment this fired, so refresh the transcript to show it now rather
  // than on the next poll. The approval belongs to the OTHER team, so the
  // pending-approval query for this one is deliberately not touched.
  const handleDelegationPaused = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [...AGENT_CHAT_MESSAGES_QUERY_KEY, agentId, tenantId, currentThreadId],
    })
  }, [queryClient, agentId, tenantId, currentThreadId])

  // The two effects that used to live here polled for the resumed turn and
  // hand-cleared the banner by watching the message list grow. Both are gone:
  // the banner now reflects whether a request is still outstanding, so it clears
  // when the request is decided rather than when a message happens to arrive,
  // and the decision itself posts a message that the normal presence poll picks
  // up for every viewer.

  // Hybrid execution engine: short indicator surfaced under the user's last
  // message when the chat-turn handler routes the message to the resume /
  // interrupt path (not a normal LLM turn).
  const [hybridIndicator, setHybridIndicator] = useState<string | null>(null)
  useEffect(() => {
    if (!hybridIndicator) return
    const t = setTimeout(() => setHybridIndicator(null), 4000)
    return () => clearTimeout(t)
  }, [hybridIndicator])

  const handleClarificationAccepted = useCallback(() => {
    setHybridIndicator('Sent. The agent is continuing')
    if (agentId)
      track('agent_chat_hybrid_event', { agent_id: agentId, hybrid_event: 'clarification_accepted' })
  }, [agentId])

  const handleStop = useCallback(() => {
    if (!agentId || !tenantId || !currentThreadId) return
    stopAgentChatTurn({ agentId, tenantId, threadId: currentThreadId })
      .then(({ deliveredAs }) => {
        setHybridIndicator(deliveredAs === 'abort' ? 'Stopping…' : null)
      })
      .catch(() => {
        // Non-fatal: the turn keeps streaming; the person can retry.
      })
  }, [agentId, tenantId, currentThreadId])

  const handleInterruptDelivered = useCallback(() => {
    setHybridIndicator("Sent. Delivered to the agent's current run")
    if (agentId)
      track('agent_chat_hybrid_event', { agent_id: agentId, hybrid_event: 'interrupt_delivered' })
  }, [agentId])

  const chat = useChatStreaming({
    streamMessage,
    streamGreeting,
    viewerDisplayName: account ? getDisplayName(account) : null,
    createThreadMutation,
    // agentId is included in the prefix so useChatStreaming builds the full key:
    // [...AGENT_CHAT_MESSAGES_QUERY_KEY, agentId, tenantId, threadId]
    // which matches the key registered by useAgentChatMessages.
    messagesQueryKeyPrefix: [...AGENT_CHAT_MESSAGES_QUERY_KEY, agentId ?? null],
    // threadsQueryKeyPrefix with agentId first so useChatStreaming builds:
    // ['agent-chat-threads', agentId, tenantId] — matching useAgentChatThreads.
    threadsQueryKeyPrefix: ['agent-chat-threads', agentId ?? null],
    currentThreadId,
    setCurrentThreadId: handleSetCurrentThreadId,
    extraStreamingCallbacks: {
      onAwaitingInput: handleAwaitingInput,
      onHitlRequired: handleHitlRequired,
      onDelegationPausedNotice: handleDelegationPaused,
      // Hybrid execution engine — the backend returns plain JSON (not SSE)
      // when the user's message either answers a pending clarification or
      // is delivered as an interrupt to an in-flight autonomous run.
      onClarificationAccepted: handleClarificationAccepted,
      onInterruptDelivered: handleInterruptDelivered,
      // Pre-open the browser pane the moment the agent commits to a
      // browser-driving tool, so the user sees the live VNC pane while
      // the Anchor session spawns (3–10s) — instead of watching a black
      // canvas slot appear AFTER the agent finishes navigating, which
      // reads as "pane only opens after the work is done".
      // useBrowserSessionForThread's onSessionCreated still fires when
      // the session id actually materializes; selecting 'browser' is
      // idempotent so the double-fire is a no-op.
      onToolCall: (tool: string) => {
        if (isBrowserDrivingTool(tool)) {
          setRightPane('browser')
        }
      },
    },
  })

  // What actually goes on screen: the greeting at the front, then the
  // transcript. Kept apart from `messages` because that list is what the
  // unread and reply-watching effects reason about, and the greeting is not a
  // reply, was not sent by anybody, and cannot be unread.
  //
  // It stays at the front once the person answers: it is what the team opened
  // with, and a conversation whose first line is a reply to nothing reads
  // oddly. Nothing persisted it, so reopening this thread from history starts
  // at the first real message.
  // The offer waits until this person has actually said something in the thread.
  //
  // Sending is the signal of intent: it is the moment they are waiting on a
  // reply, and therefore the moment being told about one is worth a permission
  // prompt. Asking on arrival, before they have typed anything, is a prompt
  // attached to a conversation that has not started.
  //
  // Their own messages, not the reply. Waiting for the answer would put the
  // offer up at the exact moment it stopped being useful.
  const hasUserMessage = useMemo(
    () => messages.some((m) => m.role === 'user'),
    [messages],
  )

  const renderedMessages = useMemo<ChatMessageItem[]>(
    () => (chat.greeting ? [chat.greeting, ...messages] : messages),
    [chat.greeting, messages],
  )

  // The team says hello, and landing here still creates no thread.
  //
  // It used to do both at once: the page mounted, made a thread and streamed
  // the greeting into it, so every visit nobody typed into left a row behind
  // that no turn ever titled — "Untitled chat", forever, one per visit. The
  // fix that followed threw out the greeting along with the thread and put the
  // sentence in the empty state, where nobody was saying it.
  //
  // So: greeting, no thread. The request carries no threadId, the backend
  // persists nothing for it, and handleSend creates the thread when there is
  // finally something to put in it — which it already did for anyone who
  // arrived mid-conversation.
  //
  // Not for a draft team: it has nothing to say yet, and its empty state is an
  // invitation to launch it rather than to talk to it.
  useEffect(() => {
    if (hasSeed) return
    // A seed already spent on this visit means the person arrived with
    // something to say, and saying hello over it is answering a question
    // nobody asked. `hasSeed` alone does not survive long enough to express
    // that: the seed effect scrubs the router state BEFORE it sends, so a
    // render later the seed looks gone while the thread it is creating does
    // not exist yet, and this effect fires into that gap. The ref is set
    // synchronously ahead of the send, so it is already true by then.
    if (seedConsumedRef.current) return
    if (currentThreadId || queryThreadId) return   // deep link (share / file / nav state) wins
    if (!tenant?.id || !agentId) return
    if (!agent || agent.status === 'draft') return
    void chat.startGreeting()
  }, [tenant?.id, agentId, agent, currentThreadId, queryThreadId, hasSeed]) // eslint-disable-line react-hooks/exhaustive-deps

  // Backstop for cross-instance SSE event loss: when the agent's chat turn
  // ends (chat.streaming transitions from non-null to null), invalidate the
  // active-session query so the frontend re-reads from the backend. This
  // catches the case where the agent's run_browser_task tool call spawned
  // a session on tenant-runtime instance B, but the SSE stream is held
  // open on instance A, and the in-process EventEmitter never broadcast
  // across them. Without this, the user would wait up to 90s (the query's
  // refetchInterval) for the auto-open to trigger. With this, the pane
  // opens within the time it takes the backend to return the active
  // session — typically <500ms after the agent's response renders.
  // Who else is on this thread, who is typing, and a nudge when somebody
  // else's message lands. Polls only while the tab is visible.
  const presenceTransport = useMemo(
    () => (agentId ? agentChatPresenceTransport(agentId) : null),
    [agentId],
  )

  const presence = useThreadPresence(presenceTransport, currentThreadId, {
    draft: chat.inputValue,
    isStreaming: chat.streaming !== null,
    // The driver's seat keeps the wheel: never released while they drive.
    holdSeat: isDrivingSession(browserSession.query.data?.session, account?.id),
  })

  // Somebody else's turn, replayed from the recorded execution events. The
  // sender is excluded — they hold the real SSE stream — so this only fires
  // for observers, and renders through the same bubble either way.
  const observedTurn = useObservedTurn(
    presenceTransport,
    currentThreadId,
    presence.liveTurnId,
    chat.streaming !== null,
  )

  const lastStreamingRef = useRef<typeof chat.streaming>(null)
  useEffect(() => {
    if (lastStreamingRef.current && !chat.streaming && currentThreadId && tenantId) {
      void queryClient.invalidateQueries({
        queryKey: ['browser-session-for-thread', tenantId, currentThreadId],
      })
    }
    lastStreamingRef.current = chat.streaming
  }, [chat.streaming, currentThreadId, tenantId, queryClient])

  // A reply that lands while the reader is looking at the thread is read.
  // Without this the reply they just watched arrive marks itself unread the
  // moment they leave, which is the most annoying possible false positive.
  //
  // Keyed on the newest persisted reply rather than on the stream ending,
  // because the stream is only one of the ways a reply appears here. It also
  // arrives through the presence poll (somebody else's turn), and through the
  // tenant-runtime settle callback landing after the stream closed. Watching
  // the transcript catches all three; watching the stream caught one, and
  // raced the third.
  const newestAssistantMessageId = useMemo(() => {
    for (let i = persistedMessages.length - 1; i >= 0; i -= 1) {
      if (persistedMessages[i].role === 'assistant') return persistedMessages[i].id
    }
    return null
  }, [persistedMessages])

  // Deliberately NOT skipping the transcript's first load. Suppressing it as
  // "history the open already covered" is only true when the thread had a reply
  // at the moment it was opened: open a brand-new thread, watch the first reply
  // arrive, and the suppressed case is the one that matters most. The marker is
  // an idempotent upsert, so the cost of getting this wrong in the safe
  // direction is one extra request per thread opened.
  const lastMarkedReplyRef = useRef<{ threadId: string; replyId: string } | null>(null)
  useEffect(() => {
    if (!currentThreadId || !newestAssistantMessageId) return
    const seen = lastMarkedReplyRef.current
    if (seen && seen.threadId === currentThreadId && seen.replyId === newestAssistantMessageId) return
    lastMarkedReplyRef.current = { threadId: currentThreadId, replyId: newestAssistantMessageId }
    markThreadReadIfPossible(currentThreadId)
  }, [currentThreadId, newestAssistantMessageId, markThreadReadIfPossible])

  // Consume the message handed over by the @mention router and send it.
  //
  // Deliberately NOT waiting on currentThreadId. handleSend creates the thread
  // when there is none, and the auto-create effect above stands down while a
  // seed is pending, so gating on a thread is a deadlock: nothing else is left
  // to create one. The team still has to be real and launched, hence the
  // remaining checks.
  useEffect(() => {
    if (hasSeed && !seedConsumedRef.current && tenant?.id && agentId && agent && agent.status !== 'draft') {
      seedConsumedRef.current = true
      // The seed ONLY. This used to null the whole state, which on this page
      // threw away `agentId` as well — it arrives as router state with no
      // query param, so the redirect below fired and an @mention from the home
      // composer bounced the person to the teams list mid-send. An open thread
      // has to survive for the same reason: consuming a message must not cost
      // them the conversation on the next refresh.
      navigate(
        `${location.pathname}${location.search}`,
        { replace: true, state: consumeSeed(location.state) },
      )
      const displayAttachments = seedState.seedAttachments?.map((a, i) => ({
        ...a,
        id: `${Date.now()}-${i}`,
      })) ?? []
      void chat.handleSend(seedState.seedMessage, displayAttachments)
    }
  }, [hasSeed, tenant?.id, currentThreadId, agentId, agent, chat, location.pathname, location.search, location.state, seedState, navigate])

  // Clear the awaiting-input message when the user sends a reply or starts fresh.
  // While a turn is streaming, sending delivers the message into that turn
  // instead of starting a second one on the same thread.
  const handleSend = useCallback(() => {
    if (agentId) track('agent_chat_message_sent', { agent_id: agentId, thread_id: currentThreadId ?? '' })
    setAwaitingInputMessage(null)
    // Delivering into a running turn needs a turn to deliver into, which means
    // a thread. Without one the only thing streaming is the greeting, and
    // typing over a greeting is not steering a reply — it is starting the
    // conversation. handleSend interrupts it and opens the thread.
    // An instruction sent while holding the browser hands it back first, so
    // the agent can act on what was just asked. When the hand-back was this
    // person's, it rides the turn beside their words, and there is no second
    // turn for it.
    void browserSession.handBackIfDriving(account?.id).then((holdId) => {
      if (chat.streaming !== null && currentThreadId) return chat.sendDuringRun()
      return chat.handleSend(undefined, undefined, holdId ? { browserHandback: { holdId } } : undefined)
    })
  }, [chat, agentId, currentThreadId, browserSession, account])

  // The person handed the browser back with the button: the turn that
  // follows has no words of theirs, and the agent continues from where
  // they left the browser. Only the driver's own hand-back is announced; a
  // hand-back the backend no longer honours is quiet.
  const handleHandBack = useCallback(() => {
    void browserSession.handBackIfDriving(account?.id).then((holdId) => {
      void chat.sendBrowserHandback(holdId)
    })
  }, [browserSession, account, chat])


  const handleNewChat = useCallback(() => {
    if (agentId) track('agent_chat_new_thread', { agent_id: agentId })
    setAwaitingInputMessage(null)
    chat.handleNewChat()
  }, [chat, agentId])

  // Attaching, written once for all five composers. See useChatAttachments:
  // media needs a tenant, a surface, a per-message cap, a paste path, a drop
  // path and errors the person can read, and five hand-rolled copies of that
  // is five chances for one page to quietly do less than its neighbours.
  const attaching = useChatAttachments({
    surface: 'agent_chat',
    tenantId: tenant?.id,
    threadId: currentThreadId,
    attachments: chat.attachments,
    setAttachments: chat.setAttachments,
  })

  // Canonical share URL per thread (backend dedupes on (tenant, thread)).
  // Cached so repeat clicks copy synchronously — no await before the
  // clipboard write, so user activation is always intact on retries.
  const shareUrlCacheRef = useRef<{ threadId: string; url: string } | null>(null)

  const handleShare = async () => {
    if (!tenantId || !agentId || !currentThreadId) return
    const threadId = currentThreadId
    try {
      const cached = shareUrlCacheRef.current
      if (cached && cached.threadId === threadId) {
        await navigator.clipboard.writeText(cached.url)
      } else {
        const urlPromise = createChatShare({
          tenantId,
          agentId,
          threadId,
          threadKind: 'agent',
        }).then(({ id }) => {
          const url = `${window.location.origin}/share/${id}`
          shareUrlCacheRef.current = { threadId, url }
          return url
        })
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
          // Promise payload keeps the write inside the click's activation
          // window; Safari rejects writeText after an awaited fetch.
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/plain': urlPromise.then((url) => new Blob([url], { type: 'text/plain' })),
            }),
          ])
        } else {
          // Pre-ClipboardItem browsers: transient activation (~5s) usually
          // survives a fast POST, but when it does not, the URL is already
          // cached and the retry click copies synchronously above.
          await navigator.clipboard.writeText(await urlPromise)
        }
      }
      track('agent_chat_share_created', { agent_id: agentId, thread_id: threadId })
      showToast(
        'Link copied to your clipboard. This link is only accessible to members of your workspace',
        'success',
      )
    } catch {
      showToast('Could not copy the share link. Please try again.', 'error')
    }
  }

  const agentName = agent?.role || 'agent'
  const isDraft = agent?.status === 'draft'

  // Stop showing someone the live view and they must stop holding the wheel.
  // Driving happens *in* the live view, so control without it is never useful
  // to the holder and blocks everyone else: the agent stays locked out at
  // tool dispatch and colleagues stay observers. Chat presence does not catch
  // this — it tracks the thread, not the pane — so every path that hides the
  // view has to say so explicitly.
  const releaseControlIfDriving = useCallback(() => {
    const session = browserSession.query.data?.session
    if (
      session &&
      session.takeoverState === 'taken_over' &&
      session.driver?.accountId === account?.id
    ) {
      browserSession.controlMutation.mutate({ sessionId: session.id, take: false })
    }
  }, [browserSession, account])

  // Leaving the thread — switching away or navigating off the page — is the
  // same as closing the pane as far as the wheel is concerned. Held in a ref so
  // the cleanup runs on thread change without re-subscribing on every render. A
  // hard tab close cannot run this at all, which is what the server-side
  // stale-driver sweep covers.
  const releaseRef = useRef(releaseControlIfDriving)
  useEffect(() => { releaseRef.current = releaseControlIfDriving })
  useEffect(() => () => { releaseRef.current() }, [currentThreadId])

  const toggleBrowserPane = useCallback(() => {
    // The two panes share one slot, so neither toggle may take it from the
    // other: the button is disabled while More is showing and this guard is
    // the same rule in code. Agent-driven opens (a browser tool call, an
    // Anchor intervention) still switch the slot over — that is the live
    // view arriving, not the user swapping panes.
    if (isMorePaneOpen) return
    if (isBrowserPaneOpen) releaseControlIfDriving()

    const opening = !isBrowserPaneOpen
    track('agent_chat_browser_pane_toggled', {
      agent_id: agentId ?? '', thread_id: currentThreadId ?? '', open: opening,
    })
    setRightPane(opening ? 'browser' : null)
    if (!opening) return
    // Opening: ensure a thread exists FIRST. Without this guard the ensure
    // mutation fires `/api/threads/null/browser-sessions/ensure` (closure-
    // captured null threadId) which the backend rightly 400s and the pane
    // surfaces as "Unable to start the browser". When no thread is set yet,
    // create one synchronously; setCurrentThreadId triggers the dedicated
    // useEffect below to call ensure with a real threadId. When a thread
    // already exists and no session is in flight, ensure can fire now.
    if (!currentThreadId) {
      createThreadMutation.mutateAsync({}).then(({ thread }) => {
        setCurrentThreadId(thread.id)
        // The effect below picks it up once the closure re-runs with the
        // fresh threadId in useBrowserSessionForThread's hook scope.
      }).catch(() => {
        // Swallowed; the createThreadMutation surfaces its own error state.
        // The user can hit "Try Again" to re-open and retry.
      })
      return
    }
    if (!browserSession.query.data?.session && !browserSession.ensureMutation.isPending) {
      browserSession.ensureMutation.mutate()
    }
  }, [agentId, currentThreadId, browserSession, createThreadMutation, isBrowserPaneOpen, isMorePaneOpen, releaseControlIfDriving])

  // Same slot, same rule in the other direction: while the live view holds the
  // pane, More stays shut until the user closes the browser themselves.
  const toggleMorePane = useCallback(() => {
    if (isBrowserPaneOpen) return
    const opening = !isMorePaneOpen
    track('agent_chat_more_pane_toggled', { agent_id: agentId ?? '', open: opening })
    setRightPane(opening ? 'more' : null)
  }, [agentId, isBrowserPaneOpen, isMorePaneOpen])

  // Auto-fire the ensure mutation when the pane is open, we have a threadId
  // (possibly freshly minted by toggleBrowserPane above), there's no active
  // session yet, and the mutation isn't already in flight. Idempotent on
  // re-renders because of the isPending / data?.session guards.
  useEffect(() => {
    if (!isBrowserPaneOpen) return
    if (!currentThreadId) return
    if (browserSession.query.data?.session) return
    if (browserSession.ensureMutation.isPending) return
    if (browserSession.ensureMutation.isError) return
    browserSession.ensureMutation.mutate()
  }, [
    isBrowserPaneOpen,
    currentThreadId,
    browserSession.query.data?.session,
    browserSession.ensureMutation,
  ])

  // Only mounted when THIS agent is bound to Anchor Browser (and the tenant
  // connector is active); TeamPlanPage never passes this, so the CAIO chat
  // input never shows the affordance.
  const browserPaneToggleButton = (
    <BrowserPaneToggleButton
      available={isBrowserPaneAvailable}
      open={isBrowserPaneOpen}
      onToggle={toggleBrowserPane}
      // One pane at a time: close More first.
      disabled={isMorePaneOpen}
    />
  )

  const voiceError = useCallback(
    (message: string) => showToast(message, 'error'),
    [showToast],
  )

  // Voice. Both controls and everything behind them come from one place, so this
  // page, the Chief AI Officer plan and workspace insights cannot drift apart.
  const voice = useVoiceChat({
    tenantId,
    surface: 'agent_chat',
    ...(agentId ? { agentId } : {}),
    composerText: chat.inputValue,
    setComposerText: chat.setInputValue,
    assistantText: chat.streaming?.assistantText ?? null,
    // The same phrase the activity line shows, said aloud. Reusing that
    // labeller rather than writing a second one keeps the spoken and the
    // written word identical, and keeps raw tool names out of both.
    activity: chat.streaming?.currentTool ? activityLabel(chat.streaming.currentTool, chat.streaming.currentToolLabel) : null,
    onSend: handleSend,
    onStopRun: handleStop,
    onError: voiceError,
  })

  // Guard render: agentId must be present (redirect is in progress if not).
  //
  // This has to sit below every hook above, not above them. agentId is derived
  // from router state and search params, so it can arrive on a later render
  // without the component unmounting. Returning early before the hooks meant
  // React saw a different number of hooks once it appeared and threw "Rendered
  // more hooks than during the previous render". Every hook above already
  // tolerates an absent agentId: it is either a dependency, an analytics field,
  // or explicitly spread away as `...(agentId ? { agentId } : {})`.
  if (!agentId) return null


  // Reserve the strip only when something will actually be drawn in it. The
  // browser pane is gated on the Anchor binding, which resolves after the
  // agent and connector queries land, so a session that appears first would
  // otherwise shove the conversation aside for an empty column.
  const isBrowserPaneVisible = isBrowserPaneOpen && isBrowserPaneAvailable
  const isRightPaneVisible = isMorePaneOpen || isBrowserPaneVisible

  return (
    <div
      ref={chatPageRef}
      className={`chat-page${isRightPaneVisible ? ' chat-page--right-pane-open' : ''}`}
      // Only the browser pane is draggable, so only it overrides the shell's
      // default width. The More pane takes that default and stays put.
      style={
        isBrowserPaneVisible
          ? ({ '--right-pane-width': `${rightPaneWidth}px` } as React.CSSProperties)
          : undefined
      }
    >
      <div className="chat-page__top">
        <div className="chat-page__header">
          <div className="chat-page__title-group">
            <h1 className="chat-page__title">{agentName}</h1>
            {/* Beside Voice Mode rather than in the action cluster on the
                right: both change what this surface does, while Share, Chat
                History and New Chat act on the conversation itself. */}
            <VoiceModeToggle enabled={voice.isVoiceMode} onToggle={voice.toggleVoiceMode} />
            <Tooltip text="More">
              <button
                type="button"
                className="chat-page__icon-btn"
                aria-label={isMorePaneOpen ? 'Hide more pane' : 'Show more pane'}
                aria-pressed={isMorePaneOpen}
                // One pane at a time: close the browser first.
                disabled={isBrowserPaneOpen}
                onClick={toggleMorePane}
              >
                <EllipsisVerticalIcon width="20" height="20" />
              </button>
            </Tooltip>
          </div>
          <div className="chat-page__header-right">
            <ThreadPresence viewers={presence.viewers} viewerAccountId={account!.id} />
            <div className="chat-page__actions">
            {tenantId && agentId && currentThreadId && (
              <Tooltip text="Share">
                <button
                  type="button"
                  className="chat-page__icon-btn"
                  aria-label="Share"
                  onClick={() => { void handleShare() }}
                >
                  <ShareIcon width="20" height="20" />
                </button>
              </Tooltip>
            )}
            <Tooltip text="Chat History">
              <span className="chat-page__icon-btn-wrap">
                <button
                  type="button"
                  className="chat-page__icon-btn"
                  // The dot is not the only signal: colour alone reaches
                  // neither a screen reader nor a colour-blind reader, so the
                  // state rides on the control's accessible name too.
                  aria-label={hasUnreadThreads ? 'Chat History, unread replies' : 'Chat History'}
                  onClick={() => {
                    if (agentId) track('agent_chat_history_opened', { agent_id: agentId })
                    setIsHistoryOpen(true)
                  }}
                >
                  <MessageCircleMoreIcon width="20" height="20" />
                </button>
                {hasUnreadThreads && (
                  <span className="chat-page__icon-btn-dot" aria-hidden="true" />
                )}
              </span>
            </Tooltip>
            <Tooltip text="New Chat">
              <button
                type="button"
                className="chat-page__icon-btn"
                aria-label="New Chat"
                onClick={handleNewChat}
              >
                <PencilIcon width="20" height="20" />
              </button>
            </Tooltip>
            </div>
          </div>
        </div>
        <div className="chat-page__header-blur" />
      </div>

      <div className="chat-page__content">
        <div className="chat-page__conversation" key={currentThreadId}>
          {hybridIndicator && (
            <div
              className="chat-page__hybrid-indicator"
              role="status"
              aria-live="polite"
              style={{
                fontSize: '0.85em',
                opacity: 0.7,
                padding: '4px 12px',
                textAlign: 'right',
              }}
            >
              {hybridIndicator}
            </div>
          )}
          {/* Only rendered for people who can act on it: the endpoint returns
              null otherwise. Everyone else in the thread learns it is blocked
              from the status message the team posted into the conversation,
              which unlike this banner persists and reaches every viewer. */}
          {pendingApproval && (
            <HitlPendingIndicator
              onOpenReview={() =>
                navigate('/dashboard/review', { state: { selectedApprovalId: pendingApproval.approvalId } })
              }
              routedTo={pendingApproval.routedTo}
              routedToAdmins={pendingApproval.routedToAdmins}
              unassigned={pendingApproval.unassigned}
              canApprove={pendingApproval.canApprove}
              isForYou={pendingApproval.isForYou}
            />
          )}
          {/* One sticky slot in this column, and a stopped run outranks an
              offer, so this never renders alongside the approval indicator.
              Otherwise it shows whenever this browser has not granted
              permission: waiting for a reply would hide the offer from exactly
              the person who has not seen what notifications are for. */}
          {!pendingApproval && hasUserMessage && (
            <NotificationPromptBar
              replierName={agentName}
              onOpenHelp={() =>
                navigate('/dashboard/support/settings/unblock-browser-notifications')
              }
            />
          )}
          <ChatMessages
            messages={renderedMessages}
            streaming={chat.streaming ?? observedTurn}
            renderAssistantExtra={(msg) => {
              if (msg.messageType !== 'file_output' || !msg.attachments?.length) return null
              // Every attachment, not just the first. A file_output row can
              // carry more than one and index 0 silently dropped the rest.
              return (
                <>
                  {msg.attachments.map((attachment) => (
                    <FileOutputCard key={attachment.generatedFileId} attachment={attachment} />
                  ))}
                </>
              )
            }}
            // Status rows are written by the system about the conversation, not
            // said by the team, so they render as a status line rather than
            // speech. This is what every viewer sees when a gate stalls the
            // thread, and what survives a reload and stays in history.
            renderMessageOverride={(msg) =>
              // Background Liftoff forwarded when it brought this team into one
              // of its conversations. Its own row rather than the person's
              // words, which is how it used to arrive: fused onto their message
              // and stored as their turn.
              msg.messageType === FORWARDED_CONTEXT_MESSAGE_TYPE ? (
                <ForwardedContextRow content={msg.content} contributors={msg.contributors ?? undefined} />
              ) : isBrowserEventRow(msg.messageType) ? (
                // The person handed the browser back, or pointed at something
                // in it: their act, as a status line, never speech.
                <BrowserHandbackRow content={msg.content} />
              ) : msg.messageType === 'hitl_status' || msg.messageType === 'delegation_status' ? (
                <StatusRow text={msg.content}>
                  {/* A row about a DELEGATED team's approval offers the way to
                      the decision; the team's own gate rows do not, because the
                      banner above the composer already routes people who can
                      act. Keyed on the message TYPE the backend persists, so
                      rewording the sentence can never silently drop the
                      affordance. Navigates with no ids in the URL - the review
                      queue lists the pending approvals itself. */}
                  {msg.messageType === 'delegation_status' && (
                    <button
                      type="button"
                      className="chat-page__hitl-status__link"
                      onClick={() => navigate('/dashboard/review')}
                    >
                      Open Review Queue
                    </button>
                  )}
                </StatusRow>
              ) : null
            }
            // Chrome for a page with nothing on it. The greeting is not part
            // of it: a greeting is something the team says, so it renders as a
            // message above, and once it lands this block is gone. What is
            // left here is a draft team that cannot be talked to yet, and the
            // fallback for when the greeting never arrives.
            //
            // A transcript still loading is not a page with nothing on it. On
            // the mount after a refresh there IS a conversation, it just has
            // not arrived, and the empty state flashing over it says the
            // opposite of what is true. The query is disabled while there is
            // no thread, and a disabled query does not report loading, so this
            // stays false on a genuinely blank chat.
            header={
              renderedMessages.length === 0 && !chat.streaming && !messagesLoading ? (
                <div className="chat-page__empty">
                  <div className="chat-page__empty-icon">
                    <MessageCircleMoreIcon width="40" height="40" />
                  </div>
                  {isDraft ? (
                    <>
                      <h2 className="chat-page__empty-title">{agentName} is awaiting launch</h2>
                      {/* Launches in place. This used to navigate to
                          /dashboard/agents/update, which took the person out of
                          the conversation they were already in to do a thing
                          that needs no form. It also passed an INTERNAL team id
                          in the slot that page reads as an EXTERNAL agent id,
                          so it fetched /api/external-agents/<internal id>, got
                          a 404 and rendered "Something went wrong". */}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={startTeam.isPending}
                        onClick={() => {
                          if (!agentId) return
                          startTeam.mutate(
                            { internalAgentId: agentId, status: 'active' },
                            {
                              // `agent` is local state rather than a query, so
                              // the empty state only stops saying "awaiting
                              // launch" if we set it from the result.
                              onSuccess: (updated) => {
                                setAgent(updated)
                                showToast(`${agentName} is starting up`, 'success')
                              },
                              onError: () => {
                                showToast(`${agentName} could not be started. Please try again.`, 'error')
                              },
                            },
                          )
                        }}
                      >
                        Start Team
                      </Button>
                    </>
                  ) : (
                    <h2 className="chat-page__empty-title">Start a conversation with {agentName}</h2>
                  )}
                </div>
              ) : null
            }
          />
          <TypingIndicator viewers={presence.viewers} viewerAccountId={account!.id} />
        </div>
      </div>

      {isHistoryOpen && (
        <ChatHistoryModal
          currentThreadId={currentThreadId}
          {...(agentId ? { scope: { kind: 'agent' as const, agentId, name: agentName } } : {})}
          onSelectThread={chat.handleSelectThread}
          onClose={() => setIsHistoryOpen(false)}
          onMarkRead={id => markThreadRead(id, {
            onError: () => showToast('Could not mark the chat as read. Please try again.', 'error'),
          })}
          onMarkAllRead={() => markAllThreadsRead(undefined, {
            onError: () => showToast('Could not mark your chats as read. Please try again.', 'error'),
          })}
          hasUnread={hasUnreadThreads}
          threads={threadsResult}
        />
      )}

      {isReadOnlyThread ? (
        <div className="agent-chat-page__readonly-notice">
          {isMcpThread
            ? `This conversation is with ${currentThread?.sourceLabel || 'a connected app'}. View only.`
            : 'This conversation is on Slack. View only.'}
        </div>
      ) : (
        <ChatInput
          value={chat.inputValue}
          onChange={chat.setInputValue}
          onSend={handleSend}
          // The composer stays usable for the whole run: the only moments there
          // is nothing to type into are while the first message is creating its
          // thread and while a mid-run message is in flight.
          disabled={chat.creatingThread || chat.midRunSending}
          canSendDuringRun
          placeholder={voice.placeholder ?? `Message ${agentName}...`}
          attachments={chat.attachments}
          onRemoveAttachment={attaching.onRemoveAttachment}
          onFilesAdded={attaching.onFilesAdded}
          leftActions={
            <ChatInputActions
              attach={
                <FileUploadButton
                  onAttach={attaching.onAttach}
                  {...(attaching.mediaContext ? { mediaContext: attaching.mediaContext } : {})}
                  existingMediaCount={attaching.existingMediaCount}
                  onErrors={attaching.onErrors}
                />
              }
              browser={browserPaneToggleButton}
              voice={
                <VoiceInputButton
                  isListening={voice.isListening}
                  onToggle={voice.toggleListening}
                  levelRef={voice.levelRef}
                />
              }
            />
          }
          // Stop signals a thread, so it is offered only when there is one.
          // The greeting streams before any thread exists and claims no turn,
          // so there would be nothing on the other end of the button.
          onStop={chat.streaming !== null && currentThreadId ? handleStop : undefined}
        />
      )}

      {isBrowserPaneAvailable && isBrowserPaneOpen && (
        <BrowserPane
          session={browserSession.query.data?.session ?? null}
          // Non-null by construction: ProtectedRoute holds a loader until the account resolves.
          viewerAccountId={account!.id}
          ensureError={browserSession.isEnsureError}
          wasNewlyCreated={browserSession.ensureMutation.data?.wasNewlyCreated ?? false}
          lastUrlKey={lastUrlKey}
          pausedFrameUrl={browserSession.pausedFrameUrl}
          onClose={toggleBrowserPane}
          onResizeStart={handleRightPaneResizeStart}
          onResizeEnd={browserSession.onResizeEnd}
          onRetryEnsure={() => browserSession.ensureMutation.mutate()}
          onRestoreFromLastUrl={(sessionId, url) => browserSession.gotoMutation.mutate({ sessionId, url })}
          onTakeControl={() => {
            const sessionId = browserSession.query.data?.session?.id
            if (sessionId) browserSession.controlMutation.mutate({ sessionId, take: true })
          }}
          onReleaseControl={handleHandBack}
          onViewportChange={browserSession.reportViewport}
          controlPending={browserSession.controlMutation.isPending}
          agentName={agentName}
        />
      )}

      {isMorePaneOpen && (
        <MorePane
          agentId={agentId}
          agentName={agentName}
          {...(agent?.messagingNickname ? { nickname: agent.messagingNickname } : {})}
          onClose={toggleMorePane}
        />
      )}
      {/* Resize-drag event-capture overlay. See handleRightPaneResizeStart. */}
      {isResizingRightPane && (
        <div className="chat-page__right-pane-resize-overlay" aria-hidden="true" />
      )}
    </div>
  )
}

