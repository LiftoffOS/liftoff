import { useChatAttachments } from '../../hooks/useChatAttachments'
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Tooltip } from '../../components'
import type { ChatSeedState } from '../../types/chatSeed'
import { isDrivingSession } from '../../types/browserSession'
import { track } from '../../lib/analytics'
import InsightsReport from './InsightsReport'
import TimeRangeSelector from '../../components/Insights/TimeRangeSelector'
import VisualizationRenderer from '../../components/Insights/VisualizationRenderer'
import ChatHistoryModal from '../../components/Chat/ChatHistoryModal'
import MorePane from '../../components/Chat/MorePane'
import ChatMessages from '../../components/Chat/ChatMessages'
import { activityLabel } from '../../components/Chat/activityLabel'
import { toChatMessageItem, type ChatMessageItemFrom } from '../../components/Chat/toChatMessageItem'
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
import { useChatStreaming } from '../../hooks/useChatStreaming'
import { useThreadPresence } from '../../hooks/useThreadPresence'
import { insightsPresenceTransport } from '../../hooks/chatPresenceTransports'
import { useInsightsReport } from '../../hooks/useInsightsReport'
import { useInsightsObservations } from '../../hooks/useInsightsObservations'
import { useInsightsIntro } from '../../hooks/useInsightsIntro'
import { useInsightsCounts } from '../../hooks/useInsightsCounts'
import { useLiftoffScore } from '../../hooks/useLiftoffScore'
import { useCreateInsightsThread, useInsightsThreads } from '../../hooks/useInsightsThreads'
import { useInsightsMessages, INSIGHTS_MESSAGES_QUERY_KEY } from '../../hooks/useInsightsMessages'
import { useThreadContinuation } from '../../hooks/useThreadContinuation'
import { useQueryClient } from '@tanstack/react-query'
import { useInsightsUnreadCount, useMarkInsightsThreadRead, useMarkAllInsightsThreadsRead } from '../../hooks/useInsightsUnread'
import { EMPTY_INSIGHTS_TEXT, type InsightsTimeRangePreset } from '../../services/insights'
import {
  stopInsightsChatTurn,
  streamInsightsChatMessage,
  type InsightsChatMessage,
} from '../../services/insightsChat'
import type { VisualizationBlock } from '../../types/insights'
import { useTenant } from '../../hooks/useTenant'
import { useResumableThread, isThreadGone } from '../../hooks/useResumableThread'
import { consumeSeed } from '../../lib/chatNavState'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../contexts/ToastContext'
import { useVoiceChat } from '../../hooks/useVoiceChat'
import { VoiceInputButton, VoiceModeToggle } from '../../components/Chat/VoiceControls'
import { createChatShare } from '../../services/agentChat'
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

/** Stable empty array: a fresh literal would give every memo that reads the
 *  live blocks a new dependency on every render. */
const NO_BLOCKS: VisualizationBlock[] = []

/** A stored message as the transcript renders it, through the one mapping
 *  every platform assistant's page uses. */
type InsightsDisplayMessage = ChatMessageItemFrom<InsightsChatMessage>

const EMPTY_MESSAGES: InsightsDisplayMessage[] = []

export default function InsightsPage() {
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [period, setPeriod] = useState<InsightsTimeRangePreset>('this_week')
  // Live blocks belong to the stream that produced them, so they are DERIVED
  // from it rather than cleared afterwards. The persisted message carries its
  // own copy: clearing in an effect meant one frame after the stream ended
  // still drew the chart twice.
  const [streamedBlocks, setStreamedBlocks] = useState<VisualizationBlock[]>([])
  const viewedRef = useRef(false)


  const seedConsumedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('insights_viewed', {})
  }, [])

  const location = useLocation()
  const navigate = useNavigate()
  const seedState = location.state as ChatSeedState | null
  const hasSeed = !!seedState?.seedMessage


  const createThreadMutation = useCreateInsightsThread()
  const threadsResult = useInsightsThreads()
  const { currentTenant: tenant } = useTenant()
  const { account } = useAuth()
  const { showToast } = useToast()
  const tenantId = tenant?.id
  const queryClient = useQueryClient()

  // The thread this history entry is holding. Two ways it gets there, and the
  // same one line opens both: the /share/<id> resolver, which hands it over as
  // router state precisely so the id stays out of the address bar, and this
  // page itself, which puts the open conversation on the entry so a refresh
  // comes back to it.
  const sharedThreadId = useResumableThread(currentThreadId, {
    tenantId,
    scopeId: 'insights',
  })

  // Unread state. Every path that opens a thread clears the marker, so the dot
  // on the sidebar's Insights icon and the row dots in the history modal go
  // out the moment the reply is actually read. Same funnel AgentChatPage and
  // LiftoffPage use.
  // The badge on the Chat History button reads the same count the sidebar's
  // Insights dot reads, so the two indicators cannot disagree, and every path
  // that opens a thread clears the marker behind both of them.
  const { data: insightsUnreadCount } = useInsightsUnreadCount()
  const hasUnreadThreads = (insightsUnreadCount ?? 0) > 0
  const markThreadReadMutation = useMarkInsightsThreadRead()
  const markThreadRead = markThreadReadMutation.mutate
  const markAllThreadsRead = useMarkAllInsightsThreadsRead().mutate
  const markThreadReadIfPossible = useCallback(
    (threadId: string | null) => {
      if (!threadId || !tenantId) return
      markThreadRead(threadId)
    },
    [tenantId, markThreadRead],
  )

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

  // Cheap all-time probe — gates the expensive report / intro / observations
  // fetches. On a brand-new workspace this returns isEmpty=true in ~50ms and
  // we render the onboarding text immediately instead of a 2-3s skeleton.
  const { counts, isLoading: countsLoading } = useInsightsCounts()
  const isEmpty = counts?.isEmpty === true
  const downstreamEnabled = counts !== undefined && !isEmpty

  // Report data (insights-specific)
  const { blocks, isLoading: reportLoading } = useInsightsReport(period, {
    enabled: downstreamEnabled,
  })
  const { observations: streamedObservations, isLoading: observationsLoading } =
    useInsightsObservations(period, { enabled: downstreamEnabled })
  const { intro: streamedIntro, isLoading: introLoading } = useInsightsIntro(
    period,
    { enabled: downstreamEnabled },
  )
  // LiftoffScore. The hook gates itself on the feature flag and on the caller
  // being an owner or admin, so this resolves to undefined for everyone else
  // and the section never renders.
  const { scores: liftoffScore, isLoading: liftoffScoreLoading } =
    useLiftoffScore(period, { enabled: downstreamEnabled })
  // Skeleton shows continuously from page mount through report load. For
  // empty-state tenants, this resolves to `false` once counts returns and
  // the EMPTY_INSIGHTS_TEXT block renders instead.
  const isLoading = !isEmpty && (countsLoading || reportLoading)
  const reportBlocksWithObservations = useMemo(() => {
    if (isEmpty) {
      return [{ type: 'text', content: EMPTY_INSIGHTS_TEXT } as VisualizationBlock]
    }
    const merged: VisualizationBlock[] = []
    if (streamedIntro) {
      merged.push({ type: 'text', content: streamedIntro })
    }
    merged.push(...blocks)
    if (streamedObservations.length > 0) {
      merged.push(...streamedObservations)
    }
    return merged
  }, [blocks, streamedObservations, streamedIntro, isEmpty])

  // Chat messages
  const { data: messagesData, error: messagesError } = useInsightsMessages(currentThreadId)
  const messages: InsightsDisplayMessage[] = useMemo(() => {
    if (!messagesData) return EMPTY_MESSAGES
    return messagesData.pages
      .flatMap(p => p.messages)
      .slice()
      .reverse()
      .map(toChatMessageItem)
  }, [messagesData])

  // Newest persisted Insights reply in the open thread. Watching the id rather
  // than the count survives pagination and refetch reordering. Deliberately not
  // skipping the transcript's first load: the marker is an idempotent upsert,
  // so the cost of marking a just-opened thread again is one request, while
  // skipping it would miss the first reply into a brand-new thread.
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

  const handleContentBlock = useCallback((block: unknown) => {
    setStreamedBlocks(prev => [...prev, block as VisualizationBlock])
  }, [])

  // Short indicator under the conversation when a message went into the running
  // turn rather than starting a new one, or when a stop is on its way. Same
  // affordance agent chat and the Chief AI Officer chat use.
  const [midRunIndicator, setMidRunIndicator] = useState<string | null>(null)
  useEffect(() => {
    if (!midRunIndicator) return
    const timer = setTimeout(() => setMidRunIndicator(null), 4000)
    return () => clearTimeout(timer)
  }, [midRunIndicator])

  const handleInterruptDelivered = useCallback(() => {
    setMidRunIndicator('Sent: delivered to the reply in progress')
    track('insights_hybrid_event', { hybrid_event: 'interrupt_delivered' })
  }, [])

  const chat = useChatStreaming({
    streamMessage: streamInsightsChatMessage,
    viewerDisplayName: account ? getDisplayName(account) : null,
    createThreadMutation,
    messagesQueryKeyPrefix: INSIGHTS_MESSAGES_QUERY_KEY,
    threadsQueryKeyPrefix: ['insights-threads'],
    currentThreadId,
    setCurrentThreadId: handleSetCurrentThreadId,
    extraStreamingCallbacks: {
      onContentBlock: handleContentBlock,
      onInterruptDelivered: handleInterruptDelivered,
    },
  })

  // Who else is on this thread, who is typing, and a nudge when somebody
  // else's message lands. Polls only while the tab is visible.
  //
  // No `useObservedTurn` counterpart, unlike team chat: this surface records no
  // per-turn execution events, so there is no cursor for a non-sender to
  // follow. They learn the reply landed when the heartbeat's `latestMessageAt`
  // moves and the transcript refetches.
  // The browser this assistant drives and the person watches. Same pane the
  // team agents use; there is no agent here, so availability is just "does this
  // workspace have a browser at all".
  const browserPane = useAssistantBrowserPane({
    surface: 'insights',
    tenantId: tenant?.id,
    threadId: currentThreadId,
    assistantName: 'the Insights Manager',
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
    track('insights_more_pane_toggled', { open: opening })
    setIsMorePaneOpen(opening)
  }, [browserPane.isOpen, isMorePaneOpen])

  // Opening the pane off the tool call is the deterministic path: the session
  // event can be lost and the backstop refetch lands after the turn is over.
  useEffect(() => {
    const tool = chat.streaming?.currentTool
    if (tool) browserPane.noticeToolCall(tool)
  }, [chat.streaming?.currentTool, browserPane])

  const presence = useThreadPresence(insightsPresenceTransport, currentThreadId, {
    draft: chat.inputValue,
    isStreaming: chat.streaming !== null,
    // The driver's seat keeps the wheel: never released while they drive.
    holdSeat: isDrivingSession(browserPane.session.query.data?.session, account?.id),
  })

  // Work that goes on after a reply. A turn a bound closed with work still to
  // do queues the rest, which runs on this conversation minutes later with no
  // stream open in between; without this the conversation reads as finished in
  // exactly the window where it is not. The same activity row a live turn
  // shows, and the transcript is refetched when the work ends, so its reply
  // appears without a reload.
  const { isWorking: continuationWorking } = useThreadContinuation('insights', {
    tenantId,
    threadId: currentThreadId,
    isStreaming: chat.streaming !== null,
    onFinished: useCallback(() => {
      void queryClient.refetchQueries({
        queryKey: [...INSIGHTS_MESSAGES_QUERY_KEY, tenantId, currentThreadId],
      })
    }, [queryClient, tenantId, currentThreadId]),
  })

  // Stop the turn in flight. The signal is durable server-side, so this does
  // not race the SSE stream: the loop reads it at its next boundary and ends the
  // turn, keeping whatever it had written.
  const handleStop = useCallback(() => {
    if (!tenantId || !currentThreadId) return
    stopInsightsChatTurn({ tenantId, threadId: currentThreadId })
      .then(({ deliveredAs }) => {
        setMidRunIndicator(deliveredAs === 'abort' ? 'Stopping…' : null)
      })
      .catch(() => {
        showToast('Could not stop the response. Please try again.', 'error')
      })
  }, [tenantId, currentThreadId, showToast])

  // While a turn is streaming, sending delivers the message into that turn
  // instead of starting a second one on the same thread.
  const handleSend = useCallback(() => {
    track('insights_message_sent', { thread_id: currentThreadId ?? '' })
    // An instruction sent while holding the browser hands it back first, so
    // the assistant can act on what was just asked.
    void browserPane.session.handBackIfDriving(account?.id).then((holdId) => {
      if (chat.streaming !== null) return chat.sendDuringRun()
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


  // Consume the message handed over by the @mention router and send it.
  //
  // Deliberately NOT waiting on currentThreadId. handleSend creates the thread
  // when there is none, and this page has no auto-create effect at all, so
  // gating on a thread means the send never happens.
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

  // Open the shared thread rather than the empty composer. The ref keeps a
  // StrictMode double-fire, or a later re-render, from reopening a thread the
  // reader has already switched away from.
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

  const assistantBlocks = chat.streaming ? streamedBlocks : NO_BLOCKS

  // Build streaming state with hasExtra for the typing indicator
  const streamingWithExtra = useMemo(() => {
    if (!chat.streaming) {
      // Nothing is streaming, but work queued from an earlier turn is still
      // going: the activity row alone, with no bubble of its own to write into.
      if (continuationWorking) {
        return {
          userMessage: '',
          assistantText: '',
          currentTool: null,
          activityOverride: 'Still working',
          thinking: true,
        }
      }
      return null
    }
    return {
      ...chat.streaming,
      hasExtra: assistantBlocks.length > 0,
    }
  }, [chat.streaming, assistantBlocks.length, continuationWorking])

  // Dictation, the same as the other two composers. Workspace insights is a
  // platform surface — `insights_chat` is already absorbed — so
  // `surface: 'insights'` says this transcription is absorbed with it rather
  // than becoming the one charged line on an otherwise free page.
  // (tenant and showToast are resolved once at the top of the component.)
  const voiceError = useCallback(
    (message: string) => showToast(message, 'error'),
    [showToast],
  )

  // Voice. The same hook and the same controls as the team chat and the plan —
  // this surface has no agent of its own, so it speaks in the platform voice and
  // its cost is absorbed rather than charged.
  const voice = useVoiceChat({
    tenantId: tenant?.id,
    surface: 'insights',
    composerText: chat.inputValue,
    setComposerText: chat.setInputValue,
    assistantText: chat.streaming?.assistantText ?? null,
    activity: chat.streaming?.currentTool ? activityLabel(chat.streaming.currentTool, chat.streaming.currentToolLabel) : null,
    onSend: handleSend,
    onStopRun: handleStop,
    onError: voiceError,
  })

  // Attaching, written once for all five composers. See useChatAttachments:
  // media needs a tenant, a surface, a per-message cap, a paste path, a drop
  // path and errors the person can read, and five hand-rolled copies of that
  // is five chances for one page to quietly do less than its neighbours.
  const attaching = useChatAttachments({
    surface: 'insights',
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
        // No agentId: this surface has no team behind it, and the backend
        // rejects the field outright for it.
        const urlPromise = createChatShare({
          tenantId,
          threadId,
          threadKind: 'insights',
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
      track('insights_share_created', { thread_id: threadId })
      showToast(
        'Link copied to your clipboard. This link is only accessible to members of your workspace',
        'success',
      )
    } catch {
      showToast('Could not copy the share link. Please try again.', 'error')
    }
  }

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
            <h1 className="chat-page__title">Insights</h1>
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
              <TimeRangeSelector value={period} onChange={(p) => {
                track('insights_period_changed', { period: p })
                setPeriod(p)
              }} />
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
                      track('insights_history_opened', {})
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
                    track('insights_new_chat', {})
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
              replierName="Insights"
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
            messages={messages}
            streaming={streamingWithExtra}
            // Background Liftoff forwarded when it brought the Insights Manager
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
                // A colleague the Insights Manager brought in stopped to wait on a
                // person. Written by the system about the conversation, not
                // said by anyone in it, so it renders as the same status line
                // Liftoff and team chat draw for the same fact.
                <StatusRow text={msg.content} />
              ) : null
            }
            header={
              <InsightsReport
                blocks={reportBlocksWithObservations}
                isLoading={isLoading}
                liftoffScore={liftoffScore}
                liftoffScoreLoading={liftoffScoreLoading}
                introLoading={introLoading}
                observationsLoading={observationsLoading}
              />
            }
            renderAssistantExtra={(msg) => {
              const insightsMsg = msg as unknown as InsightsChatMessage
              if (insightsMsg.visualizationBlocks && insightsMsg.visualizationBlocks.length > 0) {
                return (
                  <div>
                    <VisualizationRenderer blocks={insightsMsg.visualizationBlocks} />
                  </div>
                )
              }
              return null
            }}
            renderStreamingExtra={() =>
              assistantBlocks.length > 0 ? (
                <div>
                  <VisualizationRenderer blocks={assistantBlocks} />
                </div>
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
          scope={{ kind: 'insights' }}
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
        onStop={chat.streaming !== null ? handleStop : undefined}
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
        placeholder={voice.placeholder ?? 'Ask about your workspace...'}
      />
      {isMorePaneOpen && (
        <MorePane agentName="the Insights Manager" onClose={toggleMorePane} />
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
