import { useChatAttachments } from '../../hooks/useChatAttachments'
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Tooltip } from '../../components'
import ChatHistoryModal from '../../components/Chat/ChatHistoryModal'
import MorePane from '../../components/Chat/MorePane'
import ChatMessages from '../../components/Chat/ChatMessages'
import { toChatMessageItem, type ChatMessageItemFrom } from '../../components/Chat/toChatMessageItem'
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
import { useThreadPresence } from '../../hooks/useThreadPresence'
import { liftoffPresenceTransport } from '../../hooks/chatPresenceTransports'
import {
  useCreateLiftoffThread,
  useLiftoffThreads,
  LIFTOFF_THREADS_QUERY_KEY,
} from '../../hooks/useLiftoffThreads'
import { useLiftoffMessages, LIFTOFF_MESSAGES_QUERY_KEY } from '../../hooks/useLiftoffMessages'
import { useThreadContinuation } from '../../hooks/useThreadContinuation'
import { useLiftoffUnreadCount, useMarkLiftoffThreadRead, useMarkAllLiftoffThreadsRead } from '../../hooks/useLiftoffUnread'
import {
  useLiftoffDelegations,
  LIFTOFF_DELEGATIONS_QUERY_KEY,
} from '../../hooks/useLiftoffDelegations'
import {
  stopLiftoffChatTurn,
  streamLiftoffChatMessage,
  type LiftoffChatMessage,
} from '../../services/liftoffChat'
import { useTenant } from '../../hooks/useTenant'
import { useResumableThread, isThreadGone } from '../../hooks/useResumableThread'
import { consumeSeed } from '../../lib/chatNavState'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../contexts/ToastContext'
import { useVoiceChat } from '../../hooks/useVoiceChat'
import { VoiceInputButton, VoiceModeToggle } from '../../components/Chat/VoiceControls'
import { createChatShare } from '../../services/agentChat'
import { track } from '../../lib/analytics'
import MessageCircleMoreIcon from '../../assets/icons/message-circle-more.svg?react'
import EllipsisVerticalIcon from '../../assets/icons/ellipsis-vertical.svg?react'
import PencilIcon from '../../assets/icons/pencil.svg?react'
import ShareIcon from '../../assets/icons/share.svg?react'
import { FileUploadButton } from '../../components/FileAttach'
import type { ChatSeedState, ChatHistoryState } from '../../types/chatSeed'
import { isDrivingSession } from '../../types/browserSession'
import type { VisualizationBlock } from '../../types/insights'
import { NotificationPromptBar } from '../../components/Chat/NotificationPromptBar'
import BrowserPane from '../../components/Chat/BrowserPane'
import { ChatInputActions, BrowserPaneToggleButton } from '../../components/Chat/ChatInputActions'
import { useAssistantBrowserPane } from '../../hooks/useAssistantBrowserPane'
import '../../components/Chat/ChatPage.css'
import '../../components/connectionModals.css'
// Where the block styles live. A delegated reply can draw a table or a chart,
// and every rule in here is .insights-report__ scoped, so it dresses those
// blocks and cannot reach anything else on this page.
import './InsightsReport.css'

/** Stable empty array: a fresh literal would give every memo that reads the
 *  live blocks a new dependency on every render. */
const NO_BLOCKS: VisualizationBlock[] = []

/** A stored message as the transcript renders it, through the one mapping
 *  every platform assistant's page uses. Attribution rides the row's own
 *  `contributors`, the field the transcript draws chips from on every
 *  surface; `author` / `authorLabel` survive the spread for this page's own
 *  affordances. */
type LiftoffDisplayMessage = ChatMessageItemFrom<LiftoffChatMessage>

const EMPTY_MESSAGES: LiftoffDisplayMessage[] = []

export default function LiftoffPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  // Live blocks belong to the stream that produced them, so they are DERIVED
  // from it rather than cleared afterwards. The persisted message carries its
  // own copy: clearing in an effect meant one frame after the stream ended
  // still drew the chart twice.
  const [streamedBlocks, setStreamedBlocks] = useState<VisualizationBlock[]>([])
  const seedConsumedRef = useRef(false)

  const createThreadMutation = useCreateLiftoffThread()
  const threadsResult = useLiftoffThreads()
  const { currentTenant: tenant } = useTenant()
  const { account } = useAuth()
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const { data: messagesData, error: messagesError, isLoading: messagesLoading } =
    useLiftoffMessages(currentThreadId)
  const tenantId = tenant?.id

  // Put the open conversation on the history entry so a refresh resumes it.
  // The URL is untouched and the id never reaches the address bar. What comes
  // back is the thread this entry is holding, opened by the effect below.
  const resumeThreadId = useResumableThread(currentThreadId, { tenantId, scopeId: 'liftoff' })

  // Unread state. Every path that opens a thread clears the marker, so the dot
  // on the home page's Resume button and the row dots in the history modal go
  // out the moment the reply is actually read. Same funnel AgentChatPage uses.
  // The badge on the Chat History button reads the same count the home page's
  // Resume button reads, so the two indicators cannot disagree, and every path
  // that opens a thread clears the marker behind both of them.
  const { data: liftoffUnreadCount } = useLiftoffUnreadCount()
  const hasUnreadThreads = (liftoffUnreadCount ?? 0) > 0
  const markThreadReadMutation = useMarkLiftoffThreadRead()
  const markThreadRead = markThreadReadMutation.mutate
  const markAllThreadsRead = useMarkAllLiftoffThreadsRead().mutate
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

  // Which thread this conversation uses with each colleague, keyed by the same
  // id a message stores in `author`. Read so a status row that says a team is
  // waiting on an approval can offer to open the conversation holding it.
  const delegations = useLiftoffDelegations(currentThreadId)
  const delegateThreads = useMemo(
    () => new Map(delegations.map(d => [d.targetId ?? d.targetKind, d.delegateThreadId])),
    [delegations],
  )

  const messages = useMemo(() => {
    if (!messagesData) return EMPTY_MESSAGES
    return messagesData.pages
      .flatMap(p => p.messages)
      .slice()
      .reverse()
      .map(toChatMessageItem)
  }, [messagesData])

  // Newest persisted Liftoff reply in the open thread. Watching the id rather
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

  const [midRunIndicator, setMidRunIndicator] = useState<string | null>(null)
  useEffect(() => {
    if (!midRunIndicator) return
    const timer = setTimeout(() => setMidRunIndicator(null), 4000)
    return () => clearTimeout(timer)
  }, [midRunIndicator])

  const handleInterruptDelivered = useCallback(() => {
    setMidRunIndicator('Sent: delivered to the reply in progress')
  }, [])

  // Blocks arrive on the stream only when the turn was handed to a colleague:
  // Liftoff draws none of its own. They are relayed frame by frame, so they are
  // collected here and drawn live rather than waiting for the persisted reply.
  const handleContentBlock = useCallback((block: unknown) => {
    setStreamedBlocks(prev => [...prev, block as VisualizationBlock])
  }, [])

  // The colleague stopped to wait on a person. Nothing to render here: the
  // sentence and the way to the decision are both on the status row the backend
  // persisted, which the stream hook's refetch brings in. What this DOES need is
  // the pairing, because on a conversation's first handover the row was created
  // moments ago, after this thread's delegations were last read.
  //
  // Invalidated by prefix rather than by thread, because that same first message
  // creates the thread inside the send: a callback naming `currentThreadId`
  // would name the null it closed over and match no query at all. Pauses are
  // rare and each row is tiny, so the wider key costs nothing.
  const handleDelegationPaused = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: LIFTOFF_DELEGATIONS_QUERY_KEY })
  }, [queryClient])

  const chat = useChatStreaming({
    streamMessage: streamLiftoffChatMessage,
    viewerDisplayName: account ? getDisplayName(account) : null,
    // Same endpoint, no thread: the backend reads a request carrying neither a
    // thread nor a message as "say hello", and writes nothing down.
    streamGreeting: streamLiftoffChatMessage,
    createThreadMutation,
    messagesQueryKeyPrefix: LIFTOFF_MESSAGES_QUERY_KEY,
    threadsQueryKeyPrefix: LIFTOFF_THREADS_QUERY_KEY,
    currentThreadId,
    setCurrentThreadId: handleSetCurrentThreadId,
    extraStreamingCallbacks: {
      onContentBlock: handleContentBlock,
      onDelegationPaused: handleDelegationPaused,
      onInterruptDelivered: handleInterruptDelivered,
    },
  })

  // The persisted message carries its own copy, so the live blocks are dropped
  // the moment the stream ends. Keeping them would draw the same chart twice.
  // Derived, so that happens on the same frame the stream ends rather than the
  // one after. Who the turn was handed to needs nothing here: the streaming
  // hook puts the colleague's chip on the live bubble itself, on every surface.
  const assistantBlocks = chat.streaming ? streamedBlocks : NO_BLOCKS

  const handleStop = useCallback(() => {
    if (!tenantId || !currentThreadId) return
    stopLiftoffChatTurn({ tenantId, threadId: currentThreadId })
      .then(({ deliveredAs }) => {
        setMidRunIndicator(deliveredAs === 'abort' ? 'Stopping…' : null)
      })
      .catch(() => {
        showToast('Could not stop the response. Please try again.', 'error')
      })
  }, [tenantId, currentThreadId, showToast])

  // Who else is on this thread, who is typing, and a nudge when somebody
  // else's message lands. Polls only while the tab is visible.
  //
  // No `useObservedTurn` counterpart, unlike team chat: this surface records no
  // per-turn execution events, so there is no cursor for a non-sender to
  // follow. They learn the reply landed when the heartbeat's `latestMessageAt`
  // moves and the transcript refetches.
  // The browser Liftoff drives, and the person watches. Same pane the team
  // agents use; the difference is that there is no agent, so availability is
  // just "does this workspace have a browser at all".
  const browserPane = useAssistantBrowserPane({
    surface: 'liftoff',
    tenantId: tenant?.id,
    threadId: currentThreadId,
    assistantName: 'Liftoff',
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
    track('liftoff_more_pane_toggled', { open: opening })
    setIsMorePaneOpen(opening)
  }, [browserPane.isOpen, isMorePaneOpen])

  // Opening the pane off the tool call is the deterministic path. The session
  // event can be lost and the backstop refetch lands after the turn is over, so
  // without this the person watches a blank panel while Liftoff reports it has
  // opened a page.
  useEffect(() => {
    const tool = chat.streaming?.currentTool
    if (tool) browserPane.noticeToolCall(tool)
  }, [chat.streaming?.currentTool, browserPane])

  const presence = useThreadPresence(liftoffPresenceTransport, currentThreadId, {
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
  const { isWorking: continuationWorking } = useThreadContinuation('liftoff', {
    tenantId,
    threadId: currentThreadId,
    isStreaming: chat.streaming !== null,
    onFinished: useCallback(() => {
      void queryClient.refetchQueries({
        queryKey: [...LIFTOFF_MESSAGES_QUERY_KEY, tenantId, currentThreadId],
      })
    }, [queryClient, tenantId, currentThreadId]),
  })

  const handleSend = useCallback(() => {
    // Delivering into a running turn needs a turn to deliver into, which means
    // a thread. Without one the only thing streaming is the greeting, and
    // typing over a greeting is not steering a reply — it is starting the
    // conversation. handleSend interrupts it and opens the thread.
    // An instruction sent while holding the browser hands it back first, so
    // the assistant can act on what was just asked.
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

  const voiceError = useCallback(
    (message: string) => showToast(message, 'error'),
    [showToast],
  )

  const voice = useVoiceChat({
    tenantId: tenant?.id,
    surface: 'liftoff',
    composerText: chat.inputValue,
    setComposerText: chat.setInputValue,
    assistantText: chat.streaming?.assistantText ?? null,
    activity: chat.streaming?.currentTool ? activityLabel(chat.streaming.currentTool, chat.streaming.currentToolLabel) : null,
    onSend: handleSend,
    onStopRun: handleStop,
    onError: voiceError,
  })

  // A message handed over by the home composer's @mention router. Consumed
  // once, then scrubbed from history so going back or refreshing never
  // re-sends it.
  const seedState = location.state as ChatSeedState | null
  const hasSeed = !!seedState?.seedMessage

  // Deliberately NOT waiting on currentThreadId. handleSend creates the thread
  // when there is none, so gating on one is a deadlock: the only call that
  // would produce a thread is the call being held back until it exists.
  useEffect(() => {
    if (!hasSeed || seedConsumedRef.current || !tenant?.id) return
    seedConsumedRef.current = true
    // The seed only. An open thread on this entry has to survive being handed
    // a message, or consuming one would cost the person their conversation on
    // the next refresh.
    navigate(location.pathname, { replace: true, state: consumeSeed(location.state) })
    // Anything attached in the home composer travels with the message, so
    // routing through the @mention picker does not quietly drop the file.
    const seeded = (seedState!.seedAttachments ?? []).map((attachment, index) => ({
      ...attachment,
      id: `seed-${index}`,
    }))
    void chat.handleSend(seedState!.seedMessage, seeded)
  }, [hasSeed, tenant?.id, currentThreadId, chat, location.pathname, location.state, seedState, navigate])

  // Arriving to resume something rather than to say something: the home page
  // opens this page with the history already up. Scrubbed like a seed, so
  // going back and forward does not reopen the modal over a live conversation.
  const wantsHistory = !!(location.state as ChatHistoryState | null)?.openHistory
  const historyOpenedRef = useRef(false)

  useEffect(() => {
    if (!wantsHistory || historyOpenedRef.current) return
    historyOpenedRef.current = true
    setIsHistoryOpen(true)
    navigate(location.pathname, { replace: true, state: consumeSeed(location.state) })
  }, [wantsHistory, location.pathname, location.state, navigate])

  // The thread this history entry is holding. Two ways it gets there, and the
  // same one line opens both:
  //
  //   - the /share/<id> resolver, which hands the thread over as router state
  //     precisely so the id stays out of the address bar, and
  //   - this page itself, via useResumableThread above, which puts the open
  //     conversation on the entry so a refresh comes back to it.
  //
  // Not scrubbed like the two above: this one opens a thread rather than
  // firing an action, and a refresh should land back on the same conversation.
  const sharedThreadId = resumeThreadId
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

  // Liftoff says hello, and landing here creates no thread.
  //
  // This page had no greeting at all: it opened on "Start a conversation with
  // Liftoff / Send a message to get started", which is the page describing
  // itself rather than the assistant speaking. Every other chat surface greets
  // the same way now, and somebody moving between them should not find this
  // one silent. The request carries no thread and nothing is persisted for it,
  // so a visit nobody typed into leaves no row behind.
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

  const renderedMessages = useMemo(
    () => (chat.greeting ? [chat.greeting, ...messages] : messages),
    [chat.greeting, messages],
  )

  // Attaching, written once for all five composers. See useChatAttachments:
  // media needs a tenant, a surface, a per-message cap, a paste path, a drop
  // path and errors the person can read, and five hand-rolled copies of that
  // is five chances for one page to quietly do less than its neighbours.
  const attaching = useChatAttachments({
    surface: 'liftoff',
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
          threadKind: 'liftoff',
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
      track('liftoff_share_created', { thread_id: threadId })
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
            <h1 className="chat-page__title">Liftoff</h1>
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
                    onClick={() => setIsHistoryOpen(true)}
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
                  onClick={() => chat.handleNewChat()}
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
              replierName="Liftoff"
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
            streaming={streamingWithExtra}
            // Chrome for a page with nothing on it, and only that. The
            // greeting is something Liftoff says, so it renders as a message
            // above and this block goes with it. What is left is the fallback
            // for when the greeting never arrives.
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
                    <MessageCircleMoreIcon width="40" height="40" />
                  </div>
                  <h2 className="chat-page__empty-title">Start a conversation with Liftoff</h2>
                  <p className="chat-page__empty-text">Send a message to get started.</p>
                </div>
              ) : null
            }
            renderAssistantExtra={(msg) => {
              const liftoffMsg = msg as unknown as LiftoffDisplayMessage
              if (liftoffMsg.visualizationBlocks?.length) {
                return <VisualizationRenderer blocks={liftoffMsg.visualizationBlocks} />
              }
              return null
            }}
            // Status rows are written by the system about the conversation, not
            // said by the colleague, so they render as a status line rather than
            // as speech. Same treatment, and the same class, team chat gives the
            // same fact.
            //
            // The one addition is the way out. A team that stopped for an
            // approval is waiting in its own conversation, and telling somebody
            // that in prose and leaving them to find it was the old behaviour;
            // this takes them there. The thread travels as router state, never
            // in the address bar, exactly as the share resolver hands a thread
            // over.
            renderMessageOverride={(msg) => {
              const liftoffMsg = msg as unknown as LiftoffDisplayMessage
              // Background a colleague forwarded when it brought Liftoff into
              // one of its conversations (the Insights Manager's or the Chief
              // AI Officer's). Its own row, attributed to whoever wrote it,
              // rather than the person's words.
              if (liftoffMsg.messageType === FORWARDED_CONTEXT_MESSAGE_TYPE) {
                return (
                  <ForwardedContextRow
                    content={liftoffMsg.content}
                    contributors={liftoffMsg.contributors}
                  />
                )
              }
              // The person handed the browser back, or pointed at something
              // in it: their act, as a status line, never speech.
              if (isBrowserEventRow(liftoffMsg.messageType)) {
                return <BrowserHandbackRow content={liftoffMsg.content} />
              }
              if (liftoffMsg.messageType !== 'hitl_status') return null
              const author = liftoffMsg.author
              const delegateThreadId = author ? delegateThreads.get(author) : undefined
              return (
                <StatusRow text={liftoffMsg.content}>
                  {author && delegateThreadId && (
                    <button
                      type="button"
                      className="chat-page__hitl-status__link"
                      onClick={() =>
                        navigate('/dashboard/agents/chat', {
                          state: { agentId: author, threadId: delegateThreadId },
                        })
                      }
                    >
                      {liftoffMsg.authorLabel
                        ? `Open ${liftoffMsg.authorLabel}`
                        : 'Open that conversation'}
                    </button>
                  )}
                </StatusRow>
              )
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
          scope={{ kind: 'liftoff' }}
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
        placeholder={voice.placeholder ?? 'Ask Liftoff anything...'}
      />

      {isMorePaneOpen && (
        <MorePane agentName="Liftoff" onClose={toggleMorePane} />
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

      {/* Sits above the live-view iframe during a drag. The iframe is a separate
          browsing context and would otherwise swallow mouseup, leaving the drag
          stuck with the cursor still showing col-resize. */}
      {browserPane.isResizing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, cursor: 'col-resize' }} />
      )}
    </div>
  )
}
