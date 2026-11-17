import type { MediaRef } from '../types/media'
import type { Contributor } from '../types/contributors'
import { useState, useRef, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import { useToast } from '../contexts/ToastContext'
import { ApiError } from '../services/api'
import { usePlanGate } from '../components/Dashboard/planGateContext'
import { deriveThreadTitle } from '../utils/chat'
import type { PendingAttachment, DisplayAttachment } from '../services/internalAgents'
import { handbackStatusLine } from '../components/Chat/browserEventRows'

export interface StreamingChatState {
  userMessage: string
  /** Media the person attached to the message in flight, so their own bubble
   *  shows the picture at the same moment as the words. The persisted copy
   *  arrives only when the turn ends and the messages query refetches. */
  userMedia?: MediaRef[]
  assistantText: string
  currentTool: string | null
  /** The phrase the backend authored for `currentTool`. The name is for
   *  matching (the browser pane opens off it); this is what a person reads. */
  currentToolLabel: string | null
  thinking: boolean
  /** Values a tool returned for the PERSON that the agent never saw. Live
   *  only — see the callback below for why nothing persists them. */
  hostDelivered?: Array<{ tool: string; fields: Array<{ path: string; value: unknown }> }>
  /** "Working with <name>" while a hand-over runs, outranking the tool-derived
   *  label; cleared when the reply's own text or a tool call shows what is
   *  happening. */
  activityOverride?: string | null
  /** Every colleague brought into this reply so far, in the order they were
   *  brought in. Live only: the persisted reply carries its own copy. */
  contributors?: Contributor[]
  /** The person's browser event this turn started with, drawn as a status
   *  row in their name while the turn runs: the persisted row takes its place
   *  when the turn ends. With it, `userMessage` may be empty and no bubble is
   *  drawn for the person. */
  browserEvent?: { kind: 'handback'; text: string }
  startedAt: number
}

/** What a send may carry beside, or instead of, the person's words: a
 *  browser event of theirs, naming the hold the runtime recorded. The status
 *  row drawn in their name while the turn runs is spelled here from
 *  `viewerDisplayName`, as the backend spells the persisted row. */
export interface SendOptions {
  /** They handed the browser back, ending this hold. */
  browserHandback?: { holdId: string } | null
}

/**
 * The greeting a chat surface opens with, after it has finished arriving.
 *
 * It is a real message — said by the team, in a bubble, in the transcript —
 * and it is the only message on the page that was never written down. A
 * greeting nobody answered is not a conversation, so it gets no thread: the
 * first thing the person sends is what creates one. That is also why this is
 * held here rather than merged into the messages query. There is no persisted
 * row for it to reconcile with, now or later, so it never stands down the way
 * the awaiting-input stand-in does; it simply belongs to this visit.
 *
 * The fields are the intersection of what every surface's message type needs
 * to render one assistant bubble. Pages widen it to their own message type.
 */
export interface GreetingMessage {
  id: string
  role: 'assistant'
  content: string
  createdAt: string
}

interface StreamError {
  code: string
  message: string
  status?: number
  retryAfter?: number
}

interface AwaitingInputPayload {
  question: string
  sessionId: string
}

interface HitlRequiredPayload {
  approvalId: string
  reason: string
}

/** The colleague Liftoff handed the turn to stopped to wait on a person.
 *
 *  Terminal, and NOT an error, which is the whole reason it has its own channel:
 *  routed through onError, it restored the person's message into the composer
 *  and toasted a failure over a turn where nothing failed. */
interface DelegationPausedPayload {
  author: string
  authorLabel: string
  delegateThreadId: string | null
  reason: string
}

interface StreamCallbacks {
  onThinking?: () => void
  /** `label` is the phrase the backend authored for this tool; the name is for
   *  matching only. */
  onToolCall?: (tool: string, label?: string) => void
  onTextDelta?: (text: string) => void
  /** End of one assistant message; where a paragraph break belongs. */
  onTextBreak?: () => void
  onContentBlock?: (block: unknown) => void
  /** A colleague was brought into the reply mid-turn: the one Liftoff hands
   *  the rest of the turn to, or a teammate a team delegates part of it to.
   *  Named so the live bubble can be attributed while it is still arriving.
   *  Same payload on every surface, so this is the one handler for it. */
  onDelegationStarted?: (contributor: Contributor) => void
  /** That colleague stopped and is waiting on a person. Terminal, not a
   *  failure. */
  onDelegationPaused?: (event: DelegationPausedPayload) => void
  /** Team chat only: a team the SPEAKING team delegated work to stopped for an
   *  approval. In-flight, NOT terminal — the turn keeps streaming and ends
   *  through its own complete event — so unlike onDelegationPaused above this
   *  must never settle. Distinct member precisely so the two cannot be wired
   *  into each other's semantics by sharing a name. */
  onDelegationPausedNotice?: (event: {
    agentName: string | null
    approvalId: string | null
    reason: string
  }) => void
  /** A tool returned something for the reader that the agent never saw. */
  onHostDelivered?: (event: { tool: string; fields: Array<{ path: string; value: unknown }> }) => void
  onComplete?: (message: unknown) => void
  onError?: (err: StreamError) => void
  onAwaitingInput?: (event: AwaitingInputPayload) => void
  /** A tool call was gated by HITL approval — the turn pauses until the
   *  operator approves/rejects in /dashboard/review, then the same run
   *  resumes. */
  onHitlRequired?: (event: HitlRequiredPayload) => void
  /** Hybrid execution engine: chat-turn-handler accepted the user message
   *  as the answer to a pending ask_user clarification; the autonomous run
   *  has been re-enqueued. */
  onClarificationAccepted?: () => void
  /** Hybrid execution engine: chat-turn-handler delivered the user message
   *  as an interrupt to an in-flight autonomous run. */
  onInterruptDelivered?: () => void
}

interface UseChatStreamingOptions {
  streamMessage: (
    input: {
      tenantId: string
      threadId: string
      content?: string
      attachments?: (PendingAttachment | DisplayAttachment)[]
      /** The person handed the browser back, ending this hold: beside the
       *  words they sent while driving, or on its own. */
      browserHandback?: { holdId: string }
    },
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ) => Promise<void>
  /**
   * Ask this surface's backend for its opening greeting, with no thread.
   *
   * Separate from `streamMessage` because having a greeting is a property of
   * the surface, not of the protocol: agent chat and the CAIO plan open with
   * one, Insights and Liftoff do not. Widening `streamMessage` to make the
   * thread optional would have told those two they could send a message with
   * nowhere to put it, which their backends refuse. Omit it and `startGreeting`
   * does nothing.
   */
  streamGreeting?: (
    input: { tenantId: string },
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ) => Promise<void>
  createThreadMutation: {
    mutateAsync: (args: { title?: string }) => Promise<{ thread: { id: string } }>
    isPending: boolean
  }
  messagesQueryKeyPrefix: readonly unknown[]
  threadsQueryKeyPrefix: readonly unknown[]
  /** Current thread ID — owned by the parent so messages hook can use it. */
  currentThreadId: string | null
  setCurrentThreadId: (id: string | null) => void
  /** The signed-in person's display name, for the status row drawn in their
   *  name while a browser event turn runs (sendBrowserHandback and
   *  sendBrowserHandback). The backend writes the persisted row with the same
   *  name. Absent until the account has loaded, when no event can be sent. */
  viewerDisplayName?: string | null
  extraStreamingCallbacks?: {
    onContentBlock?: (block: unknown) => void
    onDelegationPaused?: (event: DelegationPausedPayload) => void
    onDelegationPausedNotice?: (event: {
      agentName: string | null
      approvalId: string | null
      reason: string
    }) => void
    onHostDelivered?: (event: { tool: string; fields: Array<{ path: string; value: unknown }> }) => void
    onAwaitingInput?: (event: AwaitingInputPayload) => void
    onHitlRequired?: (event: HitlRequiredPayload) => void
    onClarificationAccepted?: () => void
    onInterruptDelivered?: () => void
    /** Fires for every tool the agent invokes. AgentChatPage subscribes
     *  to this to pre-open the browser pane the moment the agent commits
     *  to a browser-driving tool (run_browser_task / web_task / etc.),
     *  rather than waiting for the Anchor session to finish spawning
     *  (which can take 3–10s). The pane shows a "Starting…" state while
     *  the session comes up. */
    onToolCall?: (tool: string) => void
  }
}

export function useChatStreaming({
  streamMessage,
  streamGreeting,
  createThreadMutation,
  messagesQueryKeyPrefix,
  threadsQueryKeyPrefix,
  currentThreadId,
  setCurrentThreadId,
  viewerDisplayName,
  extraStreamingCallbacks,
}: UseChatStreamingOptions) {
  const [inputValue, setInputValue] = useState('')
  const [attachments, setAttachments] = useState<DisplayAttachment[]>([])
  const [streaming, setStreaming] = useState<StreamingChatState | null>(null)
  const [greeting, setGreeting] = useState<GreetingMessage | null>(null)
  // A greeting occupies the same scaffold a reply does, but it must not make
  // the composer act as though a turn is running: nobody has said anything
  // yet, there is no thread, and the mid-run path has nothing to deliver into.
  const [greetingStreaming, setGreetingStreaming] = useState(false)
  const [midRunSending, setMidRunSending] = useState(false)
  // One greeting per blank chat. Without it StrictMode's double-invoke asks
  // for two, and on the CAIO surface that is two LLM turns to say hello once.
  const greetingStartedRef = useRef(false)
  // Several paths can end one greeting stream — the `complete` frame, an
  // error, and the fall-through after it ends without either. First one wins.
  const greetingSettledRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  // Its own controller: delivering a mid-run message must never tear down the
  // stream the person is currently watching.
  const midRunAbortRef = useRef<AbortController | null>(null)
  const { currentTenant: tenant } = useTenant()
  // One binding for the id, so the callbacks below depend on the id rather
  // than on the whole tenant object.
  const tenantId = tenant?.id
  const tenantIdForGreeting = tenantId
  const { showToast } = useToast()
  const { openIfPaymentRequired } = usePlanGate()
  const queryClient = useQueryClient()

  // A greeting in flight is not a turn in flight: it is the team talking to an
  // empty room. Somebody who types over it is starting the conversation, and
  // handleSend below interrupts the greeting to let them.
  const sending =
    (streaming !== null && !greetingStreaming) || createThreadMutation.isPending

  // The scaffold used to be cleared by an effect watching the message list for
  // any persisted user message dated after the turn started. That predated
  // mid-run sending. Once sendDuringRun began refetching the thread to show the
  // mid-run message, that refetch matched the predicate and tore down the live
  // bubble at the exact moment somebody steered the run. Clearing is now the
  // job of whoever ends the stream — see settleIfUnsettled below.

  // Abort on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      midRunAbortRef.current?.abort()
    }
  }, [])

  /**
   * Turn whatever the greeting stream produced into the settled message, and
   * drop the live scaffold.
   *
   * Idempotent, because more than one path arrives here: the `complete` frame,
   * an error, and the fall-through after the stream ends without saying which.
   * The first one to bring text wins; the ones after it find the scaffold
   * already gone and do nothing. Empty text settles to no greeting at all,
   * which is what leaves the page on its empty state.
   */
  const settleGreeting = useCallback((text: string, controller: AbortController) => {
    if (greetingSettledRef.current) return
    greetingSettledRef.current = true
    setGreetingStreaming(false)
    const said = text.trim()
    if (said) {
      setGreeting({
        id: 'greeting',
        role: 'assistant',
        content: said,
        createdAt: new Date().toISOString(),
      })
    }
    // Only clear the scaffold if it is still the greeting's. Somebody who
    // types over a greeting aborts it and puts their own turn in there, and
    // this arriving late must not tear that down. Whatever the team had
    // managed to say is still kept above, as the greeting it was.
    if (abortControllerRef.current === controller) setStreaming(null)
  }, [])

  const handleStreamingError = useCallback(
    (err: StreamError, restoreInput: string) => {
      setInputValue(restoreInput)

      // A billing refusal is the one error here with a remedy, and the gate is
      // where that remedy is offered. Reported as a generic failure, it left the
      // person with nothing to act on — and chat is where a workspace paying by
      // the dollar runs out, because chat is where the work happens.
      //
      // StreamError is a plain shape rather than an ApiError, so the error the
      // gate matches on is constructed here. Safe on every surface: usePlanGate
      // answers false where no provider is mounted above it, and the chain below
      // still reports the failure.
      if (err.status === 402 && openIfPaymentRequired(new ApiError(err.message, 402))) {
        return
      }

      if (err.status === 429) {
        const retrySeconds = err.retryAfter ? ` (retry in ${err.retryAfter}s)` : ''
        showToast(
          `You are sending messages too quickly. Please wait a moment and try again${retrySeconds}.`,
          'error',
        )
      } else if (err.status === 404) {
        showToast('That conversation is no longer available.', 'error')
        setCurrentThreadId(null)
      } else if (err.status && err.status >= 500) {
        showToast('Something went wrong. Please try again.', 'error')
      } else if (err.code === 'NETWORK_ERROR') {
        showToast('Network error. Please check your connection and try again.', 'error')
      } else if (err.code === 'STREAM_TRUNCATED') {
        // The stream ended without the server saying it had finished writing.
        // The turn itself may well have completed, which is why this is said
        // plainly rather than claiming the work was lost: the refetch running
        // beside this picks up a reply written during the gap. What is NOT
        // acceptable is the old behaviour, where this resolved as a success and
        // the person was left watching an indicator with a dead socket behind
        // it.
        showToast('The connection dropped before the reply finished arriving.', 'error')
      } else if (err.code === 'NO_INSTRUCTION') {
        showToast(err.message || 'The agent is not ready yet. Please try again in a moment.', 'error')
      } else {
        // Defense in depth for any backend error message that leaks
        // internal terminology into the toast. The platform-backend now
        // sends user-facing copy directly, but older versions (and any
        // server we haven't rebuilt yet) still yield strings like "Chat
        // turn interrupted" which mean nothing to the user. Sniff and
        // remap to a clean fallback. Keep err.message for genuinely
        // user-friendly strings (and anything we haven't matched).
        const message = (err.message ?? '').trim();
        const looksInternal = /^chat turn/i.test(message);
        showToast(
          looksInternal || !message
            ? 'Failed to send message. Please try again.'
            : message,
          'error',
        )
      }
    },
    [showToast, setCurrentThreadId, openIfPaymentRequired],
  )

  const handleSend = useCallback(
    async (
      overrideText?: string,
      overrideAttachments?: DisplayAttachment[],
      /** A browser event riding the send: a hand-back beside the words the
       *  person typed while driving, or an event alone (sendBrowserHandback
       *  sendBrowserHandback below), which starts a turn with no words. */
      options?: SendOptions,
    ) => {
      // The row is drawn in the person's name; without the name (the account
      // has not loaded) there is nobody to attribute the event to, and no
      // hold can have been taken either.
      const browserEvent = options?.browserHandback && viewerDisplayName
        ? {
          kind: 'handback' as const,
          holdId: options.browserHandback.holdId,
          text: handbackStatusLine(viewerDisplayName),
        }
        : null
      const textToSend = overrideText ?? inputValue
      const trimmed = textToSend.trim()
      if ((!trimmed && !browserEvent) || sending) return
      // An event alone needs the thread the browser belongs to; it cannot open one.
      if (!trimmed && browserEvent && !currentThreadId) return

      // An event alone sends none of the composer: whatever the person was
      // typing stays where it was.
      if (trimmed) {
        setInputValue('')
        setAttachments([])
      }

    let threadId = currentThreadId
    if (!threadId) {
      try {
        const result = await createThreadMutation.mutateAsync({
          title: deriveThreadTitle(trimmed),
        })
        threadId = result.thread.id
        setCurrentThreadId(threadId)
      } catch (error) {
        handleStreamingError(
          {
            code: 'CREATE_THREAD_FAILED',
            message: error instanceof ApiError ? error.message : 'Failed to start chat',
            status: error instanceof ApiError ? error.status : undefined,
          },
          trimmed,
        )
        return
      }
    }

    if (!tenantId) {
      handleStreamingError({ code: 'NO_TENANT', message: 'No tenant selected' }, trimmed)
      return
    }

    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    const attachmentsForTurn = overrideAttachments ?? attachments

    setStreaming({
      userMessage: trimmed,
      // The media rides the live scaffold beside the text.
      //
      // Without it the person's own bubble showed their words immediately and
      // their picture only when `userMessagePersisted` flipped — which needs the
      // messages refetch, which runs when the ASSISTANT'S TURN ENDS. So the
      // image was arriving a whole reply late, and the wait had nothing to do
      // with fetching it.
      userMedia: attachmentsForTurn
        .filter((a): a is Extract<typeof a, { kind: 'media' }> => a.kind === 'media')
        .map(a => a.media),
      assistantText: '',
      currentTool: null, currentToolLabel: null,
      thinking: true,
      // The person's event, drawn as a status row in their name until the
      // persisted row replaces it.
      ...(browserEvent ? { browserEvent: { kind: browserEvent.kind, text: browserEvent.text } } : {}),
      startedAt: Date.now(),
    })

    const messagesQueryKey = [...messagesQueryKeyPrefix, tenantId, threadId] as const

    // Set by every branch that takes responsibility for clearing the scaffold.
    // What is left over is the paths that end the stream without saying so —
    // a HITL pause emits no `complete` — which settleIfUnsettled picks up.
    let settled = false

    await streamMessage(
      {
        tenantId,
        threadId,
        ...(trimmed ? { content: trimmed, attachments: attachmentsForTurn } : {}),
        ...(browserEvent?.kind === 'handback' ? { browserHandback: { holdId: browserEvent.holdId } } : {}),
      },
      {
        onThinking: () => {
          setStreaming(prev => (prev ? { ...prev, thinking: true } : prev))
        },
        onToolCall: (tool, label) => {
          setStreaming(prev =>
            // The hand-over status ends when the colleague's own activity is
            // visible: on Liftoff the colleague's tool calls are relayed, and
            // "Working with X" masking "Reading connectors" would hide what
            // it is doing. The chips stay; only the line moves on.
            prev ? { ...prev, currentTool: tool, currentToolLabel: label ?? null, thinking: false, activityOverride: null } : prev,
          )
          // Notify the parent (AgentChatPage uses this to pre-open the
          // browser pane the moment a browser-driving tool is invoked,
          // before the Anchor session finishes spawning).
          extraStreamingCallbacks?.onToolCall?.(tool)
        },
        onTextDelta: text => {
          setStreaming(prev => {
            if (!prev) return prev
            const separator = prev.currentTool !== null && prev.assistantText.length > 0 ? '\n\n' : ''
            return {
              ...prev,
              assistantText: prev.assistantText + separator + text,
              thinking: false,
              currentTool: null, currentToolLabel: null,
              // The hand-over status ends when the team speaks again: text
              // resuming means the delegated call returned and the parent is
              // narrating the outcome itself.
              activityOverride: null,
            }
          })
        },
        onContentBlock: extraStreamingCallbacks?.onContentBlock
          ? (block) => { extraStreamingCallbacks.onContentBlock!(block) }
          : undefined,
        // Terminal, and settled here rather than left to the fallback below:
        // the composer must be released without the message being restored into
        // it and without an error toast. What the colleague managed to say and
        // the status row saying it is waiting are both already persisted, so the
        // refetch is what puts them on screen, and only then is the live bubble
        // dropped.
        onDelegationPaused: (event) => {
          settled = true
          extraStreamingCallbacks?.onDelegationPaused?.(event)
          void queryClient.refetchQueries({ queryKey: messagesQueryKey })
            .finally(() => setStreaming(null))
          queryClient.invalidateQueries({
            queryKey: [...threadsQueryKeyPrefix, tenantId],
          })
        },
        // Pass-through plus one owned effect: the hand-over status line ends
        // when its subject stops. No settle — the delegating team keeps
        // narrating after its delegate pauses, and the stream ends through
        // complete.
        onDelegationPausedNotice: (event: { agentName: string | null; approvalId: string | null; reason: string }) => {
          setStreaming(prev => (prev ? { ...prev, activityOverride: null } : prev))
          extraStreamingCallbacks?.onDelegationPausedNotice?.(event)
        },
        // Attribution on hand-over, on the activity line the chat already has:
        // the person sees WHO is doing the delegated work, by the team's name,
        // instead of "Using delegate to agent" — which both named the mechanism
        // and said "agent" to a user.
        // Accumulated onto the live bubble, and nowhere else.
        //
        // Appended rather than replaced: a turn can call several tools and each
        // may deliver something, and the second one arriving must not take the
        // first one's link off the screen. They live exactly as long as the
        // streaming bubble does — nothing persists them, because writing them
        // into the transcript would return them to the context the runtime
        // lifted them out of.
        onHostDelivered: (event: { tool: string; fields: Array<{ path: string; value: unknown }> }) => {
          setStreaming(prev =>
            prev ? { ...prev, hostDelivered: [...(prev.hostDelivered ?? []), event] } : prev,
          )
          extraStreamingCallbacks?.onHostDelivered?.(event)
        },
        // Attribution on hand-over, owned here for every surface: the chip
        // goes on the live bubble, and the activity line names the colleague
        // by name rather than the mechanism ("Using delegate to agent", which
        // both named the mechanism and said "agent" to a user).
        //
        // Appended, deduplicated by id: a team can bring in two teammates in
        // one turn and both chips must show; it can also call the same one
        // twice and that is one chip. The chips live exactly as long as the
        // streaming bubble does — the persisted reply carries its own copy,
        // which the refetch on complete puts in their place.
        onDelegationStarted: (contributor: Contributor) => {
          setStreaming(prev =>
            prev
              ? {
                  ...prev,
                  thinking: false,
                  currentTool: null, currentToolLabel: null,
                  activityOverride: `Working with ${contributor.label}`,
                  contributors: (prev.contributors ?? []).some(c => c.id === contributor.id)
                    ? prev.contributors
                    : [...(prev.contributors ?? []), contributor],
                }
              : prev,
          )
        },
        onAwaitingInput: extraStreamingCallbacks?.onAwaitingInput
          ? (event) => { extraStreamingCallbacks.onAwaitingInput!(event) }
          : undefined,
        // A HITL pause is terminal for the SSE stream (no `complete` follows).
        // Deliberately does not settle here: the stream is about to end, and
        // settleIfUnsettled refetches then clears in the right order.
        onHitlRequired: (event) => {
          extraStreamingCallbacks?.onHitlRequired?.(event)
        },
        onClarificationAccepted: extraStreamingCallbacks?.onClarificationAccepted
          ? () => {
              settled = true
              extraStreamingCallbacks.onClarificationAccepted!()
              setStreaming(null)
            }
          : () => {
              settled = true
              setStreaming(null)
            },
        // Delivered into a turn somebody else is watching, so this request
        // produces no reply of its own. Refetch first for the same reason the
        // HITL branch does: the message is already persisted server-side, and
        // without this it vanishes from the thread the moment the scaffold goes.
        onInterruptDelivered: extraStreamingCallbacks?.onInterruptDelivered
          ? () => {
              settled = true
              extraStreamingCallbacks.onInterruptDelivered!()
              void queryClient.refetchQueries({ queryKey: messagesQueryKey })
                .finally(() => setStreaming(null))
            }
          : () => {
              settled = true
              void queryClient.refetchQueries({ queryKey: messagesQueryKey })
                .finally(() => setStreaming(null))
            },
        onComplete: () => {
          settled = true
          // `.finally`, not `.then`, and every sibling branch here already knew
          // that. This one clears the live scaffold only when the refetch
          // RESOLVES, and it also sets `settled`, which switches off the
          // post-await backstop below. So a refetch that rejects — an expired
          // token, a blip, a 5xx — leaves the typing indicator running with
          // nothing left able to stop it, on a turn that actually succeeded.
          void queryClient.refetchQueries({ queryKey: messagesQueryKey })
            .finally(() => setStreaming(null))
          queryClient.invalidateQueries({
            queryKey: [...threadsQueryKeyPrefix, tenantId],
          })
        },
        onError: err => {
          // Preserve partial assistant content on mid-stream errors.
          // Without this, setStreaming(null) blows away accumulated text
          // from the live bubble AND no messages refetch happens — so any
          // partial output the user was watching disappears at the
          // exact moment the error toast pops, which reads like "the
          // app ate my response". The backend may have persisted
          // partial content; refetching the messages query surfaces it
          // and keeps it on screen alongside the error toast.
          //
          // Order matters: refetch FIRST so the persisted partial is in
          // the messages list, THEN drop the streaming bubble so the
          // user never sees an empty gap. handleStreamingError fires
          // the toast in parallel; the partial content stays visible
          // because it's now part of the messages list, not the
          // ephemeral streaming state.
          settled = true
          void queryClient.refetchQueries({ queryKey: messagesQueryKey })
            .finally(() => setStreaming(null));
          // A browser event the backend would not honour (the hold is not
          // pending any more: a tab that woke after the window, a hand-back
          // already sent) is quiet: no error shown, and the composer stays as
          // it was. The next turn's Browser section carries what happened.
          if (browserEvent && (err as StreamError).status === 409) return
          handleStreamingError(err as StreamError, trimmed)
        },
      },
      abortControllerRef.current.signal,
    )

    // The stream is over by the time the await resolves. If nothing claimed
    // responsibility for the scaffold, this is a path that ended without a
    // terminal event — settle it rather than leaving the bubble up forever.
    // Refetch first, then clear, so the person's own message never blinks out.
    if (!settled) {
      void queryClient.refetchQueries({ queryKey: messagesQueryKey })
        .finally(() => setStreaming(null))
    }
    },
    [
      inputValue,
      attachments,
      sending,
      currentThreadId,
      tenantId,
      createThreadMutation,
      handleStreamingError,
      queryClient,
      streamMessage,
      messagesQueryKeyPrefix,
      threadsQueryKeyPrefix,
      extraStreamingCallbacks,
      setCurrentThreadId,
      viewerDisplayName,
    ],
  )

  /**
   * Deliver a message into the turn that is already running.
   *
   * The backend folds it into the live run and answers with a single
   * `interrupt_delivered` frame instead of a new turn, so this request is short
   * and carries no reply of its own. The live stream keeps rendering, which is
   * why this uses its own AbortController and never touches the streaming
   * scaffold: the answer to the redirect arrives on the stream the person is
   * already watching.
   */
  const sendDuringRun = useCallback(
    async (overrideText?: string, overrideAttachments?: DisplayAttachment[]) => {
      const textToSend = overrideText ?? inputValue
      const trimmed = textToSend.trim()
      if (!trimmed || midRunSending) return
      const threadId = currentThreadId
      if (!threadId) return
      if (!tenantId) {
        handleStreamingError({ code: 'NO_TENANT', message: 'No tenant selected' }, trimmed)
        return
      }

      setInputValue('')
      setAttachments([])
      setMidRunSending(true)
    midRunAbortRef.current?.abort()
    midRunAbortRef.current = new AbortController()

      const messagesQueryKey = [...messagesQueryKeyPrefix, tenantId, threadId] as const
      const attachmentsToSend = overrideAttachments ?? attachments

      try {
        await streamMessage(
          { tenantId, threadId, content: trimmed, attachments: attachmentsToSend },
          {
          onInterruptDelivered: () => {
            extraStreamingCallbacks?.onInterruptDelivered?.()
            // The message is persisted server-side before it is delivered;
            // refetch so it appears in the transcript under the live reply.
            void queryClient.refetchQueries({ queryKey: messagesQueryKey })
          },
          // The run finished between the person typing and pressing send, so
          // the backend ran this as a normal turn. Its reply is persisted;
          // refetching is what puts it on screen.
          onComplete: () => {
            void queryClient.refetchQueries({ queryKey: messagesQueryKey })
            queryClient.invalidateQueries({
              queryKey: [...threadsQueryKeyPrefix, tenantId],
            })
          },
          // Same case as onComplete: the run had finished, so this ran as a
          // normal turn, and that turn handed off to a colleague that paused.
          // Everything is persisted, so refetching is what shows it.
          onDelegationPaused: (event) => {
            extraStreamingCallbacks?.onDelegationPaused?.(event)
            void queryClient.refetchQueries({ queryKey: messagesQueryKey })
          },
          onError: err => {
            handleStreamingError(err as StreamError, trimmed)
          },
        },
        midRunAbortRef.current.signal,
      )
      } finally {
        setMidRunSending(false)
      }
    },
    [
      inputValue,
      attachments,
      midRunSending,
      currentThreadId,
      tenantId,
      handleStreamingError,
      queryClient,
      streamMessage,
      messagesQueryKeyPrefix,
      threadsQueryKeyPrefix,
      extraStreamingCallbacks,
    ],
  )

  /**
   * Ask the team to say hello, with no thread and nothing persisted.
   *
   * The request carries a tenant and nothing else. The backend reads that as
   * greeting mode and writes no row, so a visit nobody typed into leaves
   * nothing behind: no thread, no "Untitled chat" in the history, no unread
   * badge with nothing under it.
   *
   * It streams through the same scaffold a real turn uses, so the typing dots,
   * the activity line and the word-by-word pacing are the ones the surface
   * already has. The difference is what happens at the end: a normal turn
   * refetches the thread and hands over to the persisted row, and this one has
   * no row to hand over to, so the accumulated text becomes the greeting and
   * stays on screen for the rest of the visit.
   *
   * Failing is quiet on purpose. There is no message to restore to a composer
   * and nothing was lost, so the page falls back to its empty state rather
   * than raising a toast about a hello nobody asked for.
   */
  const startGreeting = useCallback(async () => {
    // Read off the tenant object before the closure so this callback depends
    // on the id and not on the whole tenant, which is what lets the React
    // Compiler keep the memoization it is given.
    const greetingTenantId = tenantIdForGreeting
    if (!streamGreeting || !greetingTenantId) return
    if (streaming || greetingStartedRef.current) return
    greetingStartedRef.current = true
    greetingSettledRef.current = false

    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    setGreetingStreaming(true)
    setStreaming({
      userMessage: '',
      assistantText: '',
      currentTool: null, currentToolLabel: null,
      thinking: true,
      startedAt: Date.now(),
    })

    // Accumulated alongside the scaffold rather than read back out of it:
    // `complete` needs the finished text, and reading it from a state updater
    // to set other state is how you get a render-phase update.
    let text = ''

    try {
      await streamGreeting(
      { tenantId: greetingTenantId },
        {
          onThinking: () => {
            setStreaming(prev => (prev ? { ...prev, thinking: true } : prev))
          },
          onToolCall: (tool, label) => {
            setStreaming(prev => (prev ? { ...prev, currentTool: tool, currentToolLabel: label ?? null, thinking: false } : prev))
          },
          onTextDelta: delta => {
            text += delta
            setStreaming(prev =>
              prev
                ? { ...prev, assistantText: text, thinking: false, currentTool: null, currentToolLabel: null }
                : prev,
            )
          },
          // Paragraph breaks come from real message boundaries on the wire;
          // token deltas carry no structure of their own.
          onTextBreak: () => {
            if (text.length === 0 || text.endsWith('\n\n')) return
            text += '\n\n'
            setStreaming(prev => (prev ? { ...prev, assistantText: text, currentTool: null, currentToolLabel: null } : prev))
          },
          onContentBlock: extraStreamingCallbacks?.onContentBlock
            ? block => { extraStreamingCallbacks.onContentBlock!(block) }
            : undefined,
          onComplete: () => { settleGreeting(text, controller) },
          onError: () => { settleGreeting('', controller) },
        },
        controller.signal,
      )
    } catch {
      // An aborted fetch rejects. Nothing was typed and nothing was lost, so
      // the finally below keeps whatever arrived and says no more about it.
    } finally {
      // The stream can also end without a terminal frame — a socket that
      // simply closed. Whatever arrived is what the team managed to say.
      settleGreeting(text, controller)
    }
  }, [tenantIdForGreeting, streaming, streamGreeting, settleGreeting, extraStreamingCallbacks])

  const handleNewChat = useCallback(() => {
    abortControllerRef.current?.abort()
    midRunAbortRef.current?.abort()
    setStreaming(null)
    setGreetingStreaming(false)
    // Leaving a conversation for a blank one earns a fresh greeting: clear the
    // old one and the guard, and let dropping the thread re-run the surface's
    // opening effect.
    //
    // Pressed on a chat that is ALREADY blank, this does nothing — there is no
    // thread to drop, so nothing would re-run, and clearing the greeting would
    // just blank the page the person is looking at.
    if (currentThreadId) {
      setGreeting(null)
      greetingStartedRef.current = false
      setCurrentThreadId(null)
    }
  }, [currentThreadId, setCurrentThreadId])

  const handleSelectThread = useCallback((threadId: string) => {
    abortControllerRef.current?.abort()
    midRunAbortRef.current?.abort()
    setCurrentThreadId(threadId)
    setStreaming(null)
    // Opening a conversation that already exists is not being greeted. The
    // guard stays set, so returning to a blank chat via New chat is the only
    // way back to a greeting.
    setGreeting(null)
  }, [setCurrentThreadId])

  /**
   * The person handed the browser back: a turn with no words of theirs, so
   * the assistant continues from where they left the browser. No person
   * bubble; a status row in their name while the turn runs. Nothing is sent
   * without a hold to name, and a hand-back the backend no longer honours
   * is quiet.
   */
  const sendBrowserHandback = useCallback(
    async (holdId: string | null | undefined) => {
      if (!holdId) return
      await handleSend('', undefined, { browserHandback: { holdId } })
    },
    [handleSend],
  )


  return {
    inputValue,
    setInputValue,
    attachments,
    setAttachments,
    streaming,
    sending,
    sendBrowserHandback,
    /** True only while a mid-run message is in flight. Pages use this rather
     *  than `sending` to decide whether the composer is busy, so the textarea
     *  stays usable for the whole run. */
    midRunSending,
    /** True while the first message of a new conversation is creating its
     *  thread — the one moment there is genuinely nothing to type into yet. */
    creatingThread: createThreadMutation.isPending,
    handleSend,
    sendDuringRun,
    handleNewChat,
    handleSelectThread,
    /** Ask the team to say hello. No thread, nothing persisted. */
    startGreeting,
    /** The greeting once it has finished arriving, for the surface to render
     *  ahead of the transcript. Null before it lands, and after any thread is
     *  opened. */
    greeting,
  }
}
