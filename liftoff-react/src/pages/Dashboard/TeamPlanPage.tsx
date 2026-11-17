import { useChatAttachments } from '../../hooks/useChatAttachments'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { ChatSeedState } from '../../types/chatSeed'
import { isDrivingSession } from '../../types/browserSession'
import { Tooltip } from '../../components'
import ChatHistoryModal from '../../components/Chat/ChatHistoryModal'
import MorePane from '../../components/Chat/MorePane'
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
import ChatInput from '../../components/Chat/ChatInput'
import { ThreadPresence, TypingIndicator } from '../../components/Chat/ThreadPresence'
import VisualizationRenderer from '../../components/Insights/VisualizationRenderer'
import { useChatStreaming } from '../../hooks/useChatStreaming'
import { useCreateTeamPlanThread, useTeamPlanThreads } from '../../hooks/useTeamPlanThreads'
import { useTeamPlanMessages, TEAM_PLAN_MESSAGES_QUERY_KEY } from '../../hooks/useTeamPlanMessages'
import { useMarkTeamPlanThreadRead, useMarkAllTeamPlanThreadsRead, useTeamPlanUnreadCount } from '../../hooks/useTeamPlanUnread'
import { useTenant } from '../../hooks/useTenant'
import { useResumableThread, isThreadGone } from '../../hooks/useResumableThread'
import { consumeSeed } from '../../lib/chatNavState'
import { useVoiceChat } from '../../hooks/useVoiceChat'
import { VoiceInputButton, VoiceModeToggle } from '../../components/Chat/VoiceControls'
import { useThreadPresence } from '../../hooks/useThreadPresence'
import { useObservedTurn } from '../../hooks/useObservedTurn'
import { teamPlanPresenceTransport } from '../../hooks/chatPresenceTransports'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../contexts/ToastContext'
import {
  CAIO_AGENT_ID,
  streamTeamPlanChatMessage,
  stopTeamPlanChatTurn,
} from '../../services/teamPlanChat'
import type { TeamPlanChatMessage } from '../../services/teamPlanChat'
import { toChatMessageItem, type ChatMessageItemFrom } from '../../components/Chat/toChatMessageItem'
import { createChatShare } from '../../services/agentChat'
import type { VisualizationBlock } from '../../types/insights'
import { track } from '../../lib/analytics'
import ClipboardIcon from '../../assets/icons/clipboard.svg?react'
import MessageCircleMoreIcon from '../../assets/icons/message-circle-more.svg?react'
import EllipsisVerticalIcon from '../../assets/icons/ellipsis-vertical.svg?react'
import PencilIcon from '../../assets/icons/pencil.svg?react'
import ShareIcon from '../../assets/icons/share.svg?react'
import { FileUploadButton } from '../../components/FileAttach'
import { NotificationPromptBar } from '../../components/Chat/NotificationPromptBar'
import BrowserPane from '../../components/Chat/BrowserPane'
import { ChatInputActions, BrowserPaneToggleButton } from '../../components/Chat/ChatInputActions'
import { useAssistantBrowserPane } from '../../hooks/useAssistantBrowserPane'
import '../../components/Chat/ChatPage.css'
import '../../components/connectionModals.css'

/** Stable empty array, so memos reading the live blocks do not take a new
 *  dependency every render. */
const NO_BLOCKS: VisualizationBlock[] = []

/** A stored message as the transcript renders it, through the one mapping
 *  every platform assistant's page uses. */
type TeamPlanDisplayMessage = ChatMessageItemFrom<TeamPlanChatMessage>

const EMPTY_MESSAGES: TeamPlanDisplayMessage[] = []

export default function TeamPlanPage() {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  // Derived from the stream that produced them, as on Insights and Liftoff.
  const [streamedBlocks, setStreamedBlocks] = useState<VisualizationBlock[]>([])
  const createThreadMutation = useCreateTeamPlanThread()
  const threadsResult = useTeamPlanThreads()
  const { currentTenant: tenant } = useTenant()
  const { account } = useAuth()
  const { showToast } = useToast()
  const location = useLocation()
  const tenantId = tenant?.id

  // Unread state. Every path that opens a thread clears the marker, so the dot
  // on the teams page's Plan Workforce button and the row dots in the history
  // modal go out the moment the reply is actually read. Same funnel
  // AgentChatPage and LiftoffPage use.
  // The badge on the Chat History button reads the same count the teams
  // page's Plan Workforce dot reads, so the two indicators cannot disagree,
  // and every path that opens a thread clears the marker behind both of them.
  const { data: teamPlanUnreadCount } = useTeamPlanUnreadCount()
  const hasUnreadThreads = (teamPlanUnreadCount ?? 0) > 0
  const markThreadReadMutation = useMarkTeamPlanThreadRead()
  const markThreadRead = markThreadReadMutation.mutate
  const markAllThreadsRead = useMarkAllTeamPlanThreadsRead().mutate
  const markThreadReadIfPossible = useCallback(
    (threadId: string | null) => {
      if (!threadId || !tenantId) return
      markThreadRead(threadId)
    },
    [tenantId, markThreadRead],
  )

  // The thread this history entry is holding. Two ways it gets there, and the
  // same one line opens both: the /share/<id> resolver, which hands it over as
  // router state precisely so the id stays out of the address bar, and this
  // page itself, which puts the open conversation on the entry so a refresh
  // comes back to it.
  const sharedThreadId = useResumableThread(currentThreadId, {
    tenantId,
    scopeId: 'team-plan',
  })

  const viewedRef = useRef(false)
  const seedConsumedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('team_plan_viewed', {})
  }, [])

  const navigate = useNavigate()
  const seedState = location.state as ChatSeedState | null
  const hasSeed = !!seedState?.seedMessage

  const { data: messagesData, error: messagesError, isLoading: messagesLoading } =
    useTeamPlanMessages(currentThreadId)
  const messages: TeamPlanDisplayMessage[] = useMemo(() => {
    if (!messagesData) return EMPTY_MESSAGES
    return messagesData.pages
      .flatMap(p => p.messages)
      .slice()
      .reverse()
      .map(toChatMessageItem)
  }, [messagesData])

  // Opening a conversation is reading it. Every selection path funnels through
  // here, including the Chat History modal and the router-state deep link.
  // Re-selecting the thread already on screen is not an open, and anything that
  // arrived while it was on screen is handled by the reply-watcher effect below.
  const handleSetCurrentThreadId = useCallback(
    (id: string | null) => {
      if (id && id !== currentThreadId) markThreadReadIfPossible(id)
      setCurrentThreadId(id)
    },
    [currentThreadId, markThreadReadIfPossible],
  )

  // Newest persisted Chief AI Officer reply in the open thread. Scans the
  // PERSISTED list, never renderedMessages: the greeting is a synthetic
  // assistant row and must not read as a reply. Watching the id rather than
  // the count survives pagination and refetch reordering, and the marker is an
  // idempotent upsert, so marking a just-opened thread again costs one request.
  const newestAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return null
  }, [messages])

  const lastMarkedReplyRef = useRef<{ threadId: string; replyId: string } | null>(null)
  useEffect(() => {
    if (!currentThreadId || !newestAssistantMessageId) return
    const seen = lastMarkedReplyRef.current
    if (seen && seen.threadId === currentThreadId && seen.replyId === newestAssistantMessageId) return
    lastMarkedReplyRef.current = { threadId: currentThreadId, replyId: newestAssistantMessageId }
    markThreadReadIfPossible(currentThreadId)
  }, [currentThreadId, newestAssistantMessageId, markThreadReadIfPossible])

  const handleContentBlock = useCallback((block: unknown) => {
    setStreamedBlocks(prev => [...prev, block as VisualizationBlock])
  }, [])

  // Short indicator at the top of the conversation when a message went into the
  // running turn rather than starting a new one, or when a stop is on its way.
  // Same affordance agent chat got, so the two chats read the same.
  const [midRunIndicator, setMidRunIndicator] = useState<string | null>(null)
  useEffect(() => {
    if (!midRunIndicator) return
    const timer = setTimeout(() => setMidRunIndicator(null), 4000)
    return () => clearTimeout(timer)
  }, [midRunIndicator])

  const handleInterruptDelivered = useCallback(() => {
    setMidRunIndicator("Sent: delivered to the Chief AI Officer's current reply")
    track('team_plan_hybrid_event', { hybrid_event: 'interrupt_delivered' })
  }, [])

  const chat = useChatStreaming({
    streamMessage: streamTeamPlanChatMessage,
    viewerDisplayName: account ? getDisplayName(account) : null,
    // Same endpoint, no thread: the backend reads a request with no threadId
    // and no content as "introduce yourself", grounds it in the tenant's
    // connectors and existing agents, and writes nothing down.
    streamGreeting: streamTeamPlanChatMessage,
    createThreadMutation,
    messagesQueryKeyPrefix: TEAM_PLAN_MESSAGES_QUERY_KEY,
    threadsQueryKeyPrefix: ['team-plan-threads'],
    currentThreadId,
    setCurrentThreadId: handleSetCurrentThreadId,
    extraStreamingCallbacks: {
      onContentBlock: handleContentBlock,
      onInterruptDelivered: handleInterruptDelivered,
    },
  })

  // Diagrams belong to the turn that produced them; the persisted message
  // carries its own copy once the turn lands. Derived, so the frame the turn
  // ends on does not still draw the live copy beside the persisted one.
  const assistantBlocks = chat.streaming ? streamedBlocks : NO_BLOCKS

  const streamingWithExtra = useMemo(() => {
    if (!chat.streaming) return null
    return {
      ...chat.streaming,
      hasExtra: assistantBlocks.length > 0,
    }
  }, [chat.streaming, assistantBlocks.length])

  // Open the shared thread rather than starting a new one.
  const sharedOpenedRef = useRef(false)
  useEffect(() => {
    if (!sharedThreadId || sharedOpenedRef.current) return
    sharedOpenedRef.current = true
    // Through the funnel, not setCurrentThreadId: arriving by share link or
    // notification reads the reply, and leaving the marker lit would keep the
    // dot on the very conversation the person is looking at.
    handleSetCurrentThreadId(sharedThreadId)
  }, [sharedThreadId, handleSetCurrentThreadId])

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

  // The Chief AI Officer introduces itself, and landing here creates no thread.
  //
  // The greeting is a real turn: the backend reads the workspace (connected
  // apps, the agents already running) and the CAIO speaks to what is
  // actually there rather than reciting the time of day. It simply asks for it
  // with no threadId, so nothing is persisted and a visit nobody typed into
  // leaves no "Untitled chat" behind. handleSend creates the thread when there
  // is finally something to put in it.
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
    if (currentThreadId || sharedThreadId) return
    if (!tenant?.id) return
    void chat.startGreeting()
  }, [tenant?.id, currentThreadId, sharedThreadId, hasSeed]) // eslint-disable-line react-hooks/exhaustive-deps

  // The greeting at the front, then the transcript. Held apart from the
  // persisted list because nothing wrote it down: it belongs to this visit,
  // and reopening the thread from history starts at the first real message.
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

  const renderedMessages = useMemo<TeamPlanDisplayMessage[]>(() => {
    if (!chat.greeting) return messages
    return [{ ...chat.greeting, threadId: '', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, messageType: null }, ...messages]
  }, [chat.greeting, messages])

  // Consume the message handed over by the @mention router and send it.
  //
  // Deliberately NOT waiting on currentThreadId. handleSend creates the thread
  // when there is none, and the auto-greet effect above stands down while a
  // seed is pending, so gating on a thread is a deadlock: nothing else is left
  // to create one.
  useEffect(() => {
    if (hasSeed && !seedConsumedRef.current && tenant?.id) {
      seedConsumedRef.current = true
      // The seed only. An open thread on this entry has to survive being
      // handed a message, or consuming one would cost the person their
      // conversation on the next refresh.
      navigate(location.pathname, { replace: true, state: consumeSeed(location.state) })
      const displayAttachments = seedState.seedAttachments?.map((a, i) => ({
        ...a,
        id: `${Date.now()}-${i}`,
      })) ?? []
      void chat.handleSend(seedState.seedMessage, displayAttachments)
    }
  }, [hasSeed, tenant?.id, currentThreadId, chat, location.pathname, location.state, seedState, navigate])

  // Who else is on this thread, who is typing, and a nudge when somebody
  // else's message lands. Polls only while the tab is visible.
  // The browser the Chief AI Officer drives and the person watches. Its threads
  // live in workforce-service's database, so the surface tells platform-backend
  // to confirm the thread there rather than in a table it does not have.
  const browserPane = useAssistantBrowserPane({
    surface: 'team_plan',
    tenantId: tenant?.id,
    threadId: currentThreadId,
    assistantName: 'your Chief AI Officer',
    ensureThread: useCallback(async () => {
      const result = await createThreadMutation.mutateAsync({})
      setCurrentThreadId(result.thread.id)
      return result.thread.id
    }, [createThreadMutation]),
  })

  // Destructured rather than read as `browserPane.containerRef` in the JSX. A
  // ref reached through a property is a ref access during render, and the whole
  // returned object then reads as ref-like: 21 warnings on this page, all of
  // them property reads that are nothing of the sort.
  const { containerRef: browserPaneRef } = browserPane

  // The More pane (messaging options) shares the right-pane strip with the
  // browser live view, one at a time, exactly as on AgentChatPage. The browser
  // can open ITSELF off a tool call mid-turn, and the live view wins over the
  // static cards, so the effect below yields the slot rather than fighting it.
  const [isMorePaneOpen, setIsMorePaneOpen] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (browserPane.isOpen) setIsMorePaneOpen(false)
  }, [browserPane.isOpen])

  const toggleMorePane = useCallback(() => {
    if (browserPane.isOpen) return
    const opening = !isMorePaneOpen
    track('team_plan_more_pane_toggled', { open: opening })
    setIsMorePaneOpen(opening)
  }, [browserPane.isOpen, isMorePaneOpen])

  // Opening the pane off the tool call is the deterministic path: the session
  // event can be lost and the backstop refetch lands after the turn is over.
  useEffect(() => {
    const tool = chat.streaming?.currentTool
    if (tool) browserPane.noticeToolCall(tool)
  }, [chat.streaming?.currentTool, browserPane])

  const presence = useThreadPresence(teamPlanPresenceTransport, currentThreadId, {
    draft: chat.inputValue,
    isStreaming: chat.streaming !== null,
    // The driver's seat keeps the wheel: never released while they drive.
    holdSeat: isDrivingSession(browserPane.session.query.data?.session, account?.id),
  })

  // Somebody else's turn, replayed from the recorded execution events. The
  // sender is excluded — they hold the real SSE stream.
  const observedTurn = useObservedTurn(
    teamPlanPresenceTransport,
    currentThreadId,
    presence.liveTurnId,
    chat.streaming !== null,
  )

  // Stop the turn in flight. The signal is durable server-side, so this does
  // not race the SSE stream: the loop reads it between iterations and ends the
  // turn, keeping whatever it had written.
  const handleStop = useCallback(() => {
    if (!tenantId || !currentThreadId) return
    stopTeamPlanChatTurn({ tenantId, threadId: currentThreadId })
      .then(({ deliveredAs }) => {
        setMidRunIndicator(deliveredAs === 'abort' ? 'Stopping…' : null)
      })
      .catch(() => {
        // A failed stop used to be swallowed here, so pressing the button did
        // nothing and said nothing. The turn keeps streaming either way, but
        // the person needs to know the request did not land.
        showToast('Could not stop the response. Please try again.', 'error')
      })
  }, [tenantId, currentThreadId, showToast])

  // While a turn is streaming, sending delivers the message into that turn
  // instead of starting a second one on the same thread.
  const handleSend = useCallback(() => {
    track('team_plan_message_sent', { thread_id: currentThreadId ?? '' })
    // Delivering into a running turn needs a turn to deliver into, which means
    // a thread. Without one the only thing streaming is the greeting, and
    // typing over a greeting is not steering a reply — it is starting the
    // conversation. handleSend interrupts it and opens the thread.
    // An instruction sent while holding the browser hands it back first, so
    // the Chief AI Officer can act on what was just asked.
    void browserPane.session.handBackIfDriving(account?.id).then((holdId) => {
      if (chat.streaming !== null && currentThreadId) return chat.sendDuringRun()
      // The hand-back rides the turn beside the words; there is no second turn.
      return chat.handleSend(undefined, undefined, holdId ? { browserHandback: { holdId } } : undefined)
    })
  }, [chat, currentThreadId, browserPane.session, account])

  // The person handed the browser back with the button: the turn that
  // follows has no words of theirs, and the assistant continues from where
  // they left the browser. Only the driver's own hand-back is announced; a
  // hand-back the backend no longer honours is quiet.
  const handleHandBack = useCallback(() => {
    void browserPane.session.handBackIfDriving(account?.id).then((holdId) => {
      void chat.sendBrowserHandback(holdId)
    })
  }, [browserPane.session, account, chat])


  // Attaching, written once for all five composers. See useChatAttachments:
  // media needs a tenant, a surface, a per-message cap, a paste path, a drop
  // path and errors the person can read, and five hand-rolled copies of that
  // is five chances for one page to quietly do less than its neighbours.
  const attaching = useChatAttachments({
    surface: 'team_plan',
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
    if (!tenantId || !currentThreadId) return
    const threadId = currentThreadId
    try {
      const cached = shareUrlCacheRef.current
      if (cached && cached.threadId === threadId) {
        await navigator.clipboard.writeText(cached.url)
      } else {
        const urlPromise = createChatShare({
          tenantId,
          agentId: CAIO_AGENT_ID,
          threadId,
          threadKind: 'team_plan',
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
      track('team_plan_share_created', { thread_id: threadId })
      showToast(
        'Link copied to your clipboard. This link is only accessible to members of your workspace',
        'success',
      )
    } catch {
      showToast('Could not copy the share link. Please try again.', 'error')
    }
  }

  // Dictation, the same as the per-agent threads. The transcript lands in the
  // composer and is never auto-sent. `surface: 'team_plan'` is what tells the
  // backend this is a platform surface: the Chief AI Officer has an agent row,
  // so presence of an id cannot be what decides that its cost is absorbed.
  const voiceError = useCallback(
    (message: string) => showToast(message, 'error'),
    [showToast],
  )

  // Voice. The same hook and the same controls as the team chat and insights.
  // The Chief AI Officer keeps its agent id, so it speaks in its own voice from
  // the pool rather than the platform's — but the surface is still `team_plan`,
  // so the cost is absorbed.
  const voice = useVoiceChat({
    tenantId,
    surface: 'team_plan',
    agentId: CAIO_AGENT_ID,
    composerText: chat.inputValue,
    setComposerText: chat.setInputValue,
    assistantText: chat.streaming?.assistantText ?? null,
    activity: chat.streaming?.currentTool ? activityLabel(chat.streaming.currentTool, chat.streaming.currentToolLabel) : null,
    onSend: handleSend,
    onStopRun: handleStop,
    onError: voiceError,
  })


  return (
    <div
      className={`chat-page${browserPane.isOpen || isMorePaneOpen ? ' chat-page--right-pane-open' : ''}`}
      ref={browserPaneRef}
      style={browserPane.isOpen
        ? ({ '--right-pane-width': `${browserPane.paneWidth}px` } as React.CSSProperties)
        : undefined}
    >
      <div className="chat-page__top">
        <div className="chat-page__header">
          <div className="chat-page__title-group">
            <h1 className="chat-page__title">Plan</h1>
            <VoiceModeToggle enabled={voice.isVoiceMode} onToggle={voice.toggleVoiceMode} />
            {/* Beside Voice Mode rather than in the action cluster on the
                right, matching AgentChatPage: both change what this surface
                does, while Share, Chat History and New Chat act on the
                conversation itself. */}
            <Tooltip text="More">
              <button
                type="button"
                className="chat-page__icon-btn"
                aria-label={isMorePaneOpen ? 'Hide more pane' : 'Show more pane'}
                aria-pressed={isMorePaneOpen}
                // One pane at a time: close the browser first.
                disabled={browserPane.isOpen}
                onClick={toggleMorePane}
              >
                <EllipsisVerticalIcon width="20" height="20" />
              </button>
            </Tooltip>
          </div>
          <div className="chat-page__header-right">
            {account && (
              <ThreadPresence viewers={presence.viewers} viewerAccountId={account.id} />
            )}
            <div className="chat-page__actions">
              {tenantId && currentThreadId && (
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
                    // neither a screen reader nor a colour-blind reader, so
                    // the state rides on the control's accessible name too.
                    aria-label={hasUnreadThreads ? 'Chat History, unread replies' : 'Chat History'}
                    onClick={() => {
                      track('team_plan_history_opened', {})
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
                  onClick={() => {
                    track('team_plan_new_chat', {})
                    chat.handleNewChat()
                  }}
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
          {/* Same offer as every other chat surface: this is where being
              notified matters, because the reply arrives while the tab is not
              in front of you. Renders nothing once permission is granted. */}
          {hasUserMessage && (
          <NotificationPromptBar
            onOpenHelp={() =>
              navigate('/dashboard/support/settings/unblock-browser-notifications')
            }
          />
          )}
          {midRunIndicator && (
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
              {midRunIndicator}
            </div>
          )}
          <ChatMessages
            messages={renderedMessages}
            streaming={streamingWithExtra ?? observedTurn}
            // Background Liftoff forwarded when it brought the Chief AI Officer
            // into one of its conversations. It reports on the thread rather
            // than taking part in it, so it is not rendered as speech — and it
            // is emphatically not the person's message, which is how it used to
            // arrive here: fused onto their words and stored as their turn.
            renderMessageOverride={(msg) =>
              msg.messageType === FORWARDED_CONTEXT_MESSAGE_TYPE ? (
                <ForwardedContextRow content={msg.content} contributors={msg.contributors ?? undefined} />
              ) : isBrowserEventRow(msg.messageType) ? (
                // The person handed the browser back, or pointed at something
                // in it: their act, as a status line, never speech.
                <BrowserHandbackRow content={msg.content} />
              ) : msg.messageType === 'hitl_status' ? (
                // A colleague the Chief AI Officer brought in stopped to wait on a
                // person. Written by the system about the conversation, not
                // said by anyone in it, so it renders as the same status line
                // Liftoff and team chat draw for the same fact.
                <StatusRow text={msg.content} />
              ) : null
            }
            // Chrome for a page with nothing on it, and only that. The
            // greeting is something the Chief AI Officer says, so it renders
            // as a message above and this block goes with it. What is left is
            // the fallback for when the greeting never arrives.
            //
            // A transcript still loading is not a page with nothing on it. On
            // the mount after a refresh there IS a conversation, it just has
            // not arrived, and "Start a conversation" flashing over it says
            // the opposite of what is true. The query is disabled while there
            // is no thread, and a disabled query does not report loading, so
            // this stays false on a genuinely blank chat.
            header={
              renderedMessages.length === 0 && !chat.streaming && !messagesLoading ? (
                <div className="chat-page__empty">
                  <div className="chat-page__empty-icon">
                    <ClipboardIcon width="40" height="40" />
                  </div>
                  <h2 className="chat-page__empty-title">Plan Your AI Workforce</h2>
                  <p className="chat-page__empty-text">
                    Chat with your Chief AI Officer to build an AI workforce  tailored to your company.
                  </p>
                </div>
              ) : null
            }
            renderAssistantExtra={(msg) => {
              const planMsg = msg as unknown as TeamPlanChatMessage
              if (planMsg.visualizationBlocks && planMsg.visualizationBlocks.length > 0) {
                return <VisualizationRenderer blocks={planMsg.visualizationBlocks} />
              }
              return null
            }}
            renderStreamingExtra={() =>
              assistantBlocks.length > 0 ? (
                <VisualizationRenderer blocks={assistantBlocks} />
              ) : null
            }
          />
          {account && (
            <TypingIndicator viewers={presence.viewers} viewerAccountId={account.id} />
          )}
        </div>
      </div>

      {isHistoryOpen && (
        <ChatHistoryModal
          currentThreadId={currentThreadId}
          scope={{ kind: 'team_plan' }}
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

      <ChatInput
        value={chat.inputValue}
        onChange={chat.setInputValue}
        onSend={handleSend}
        disabled={chat.creatingThread || chat.midRunSending}
        // Stop signals a thread, so it is offered only when there is one. The
        // greeting streams before any thread exists and claims no turn, so
        // there would be nothing on the other end of the button.
        onStop={chat.streaming !== null && currentThreadId ? handleStop : undefined}
        canSendDuringRun
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
            browser={
              <BrowserPaneToggleButton
                available={browserPane.isAvailable}
                open={browserPane.isOpen}
                onToggle={() => { void browserPane.toggle() }}
                disabled={isMorePaneOpen}
              />
            }
            voice={
              <VoiceInputButton
                isListening={voice.isListening}
                onToggle={voice.toggleListening}
                levelRef={voice.levelRef}
              />
            }
          />
        }
        placeholder={voice.placeholder ?? 'Ask your Chief AI Officer...'}
      />
      {isMorePaneOpen && (
        <MorePane
          agentId={CAIO_AGENT_ID}
          agentName="your Chief AI Officer"
          onClose={toggleMorePane}
        />
      )}
      {browserPane.isOpen && (
        <BrowserPane
          session={browserPane.session.query.data?.session ?? null}
          viewerAccountId={account!.id}
          ensureError={browserPane.session.isEnsureError}
          wasNewlyCreated={browserPane.session.ensureMutation.data?.wasNewlyCreated ?? false}
          lastUrlKey={currentThreadId}
          pausedFrameUrl={browserPane.session.pausedFrameUrl}
          onClose={browserPane.close}
          onResizeStart={browserPane.onResizeStart}
          onResizeEnd={browserPane.session.onResizeEnd}
          onRetryEnsure={() => browserPane.session.ensureMutation.mutate()}
          onRestoreFromLastUrl={(sessionId, url) =>
            browserPane.session.gotoMutation.mutate({ sessionId, url })}
          onTakeControl={() => {
            const sessionId = browserPane.session.query.data?.session?.id
            if (sessionId) browserPane.session.controlMutation.mutate({ sessionId, take: true })
          }}
          onReleaseControl={handleHandBack}
          onViewportChange={browserPane.session.reportViewport}
          controlPending={browserPane.session.controlMutation.isPending}
          agentName={browserPane.assistantName}
        />
      )}

      {/* Above the live-view iframe during a drag: the iframe is a separate
          browsing context and would otherwise swallow mouseup. */}
      {browserPane.isResizing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, cursor: 'col-resize' }} />
      )}

    </div>
  )
}
