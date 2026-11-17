import type { ReactNode } from 'react'
import { HostDeliveredFields } from './HostDeliveredFields'
import { useRef, useEffect, Fragment } from 'react'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { formatTime } from '../../utils/chat'
import { useSmoothedText } from '../../hooks/useSmoothedText'
import { CitationList } from './CitationList'
import { MarkdownImage, MediaCard } from './MediaCard'
import { FileOutputCard } from './FileOutputCard'
// The media contract, mirrored once for the frontend in types/. Re-exported
// here so a consumer holding a ChatMessageItem can name the type it carries.
import type { MediaRef } from '../../types/media'
import type { Contributor } from '../../types/contributors'
import Tooltip from '../Tooltip'
import { UserAvatar, type AvatarPerson } from '../UserAvatar'
import { GuestAvatar } from '../GuestAvatar'
import { getDisplayName } from '../../utils/avatar'
import { RunProgressRow } from './RunProgressRow'
import { RUN_NARRATION_MESSAGE_TYPES } from './runNarration'
import { BrowserHandbackRow } from './BrowserHandbackRow'
import { isBrowserEventRow } from './browserEventRows'
import { RunProgressGroup } from './RunProgressGroup'
import { groupRunProgress, collapsedLabel } from './runProgressGrouping'
import './ChatMessages.css'
import { activityLabel } from './activityLabel'

export type { MediaRef }

export interface FileAttachment {
  generatedFileId: string
  filename: string
  outputType: string
  version: number
  downloadUrl: string | null
  webViewUrl?: string
}

/** Something the person attached when they sent the message, as opposed to
 *  FileAttachment above, which is a file the team produced. Only what is needed
 *  to name it again on reload: the body of an upload is a one-turn input to the
 *  model and is deliberately never stored. */
export interface SentAttachment {
  kind: 'upload' | 'connector'
  name: string
  /** Present on connector references, naming the tool the record lives in. */
  connectorType?: string
}

export interface Citation {
  ref: number
  filename: string
  page?: number
  quote: string
}

export interface ChatMessageItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** What kind of row this is, when it is not ordinary speech: `hitl_status`,
   *  `delegation_status`, `forwarded_context`, `run_progress`, `run_failed`,
   *  `file_output`, `media`.
   *
   *  Nothing here dispatches on `media` — the transcript draws media from the
   *  `media` field below. The type exists so the backend can tell a row whose
   *  payload is a picture apart from an auto-greeting, which has the same
   *  structural signature otherwise.
   *
   *  Null as well as undefined because that is what the surfaces actually
   *  return. Every backend stores this column nullable and maps NULL through
   *  verbatim, so a page had to map `null` to `undefined` before handing
   *  messages here — which LiftoffPage does, and which the CAIO and Insights
   *  pages would each have had to repeat. Widened once instead. Consumers
   *  compare with `===` against a known type, and both absent forms miss. */
  messageType?: string | null
  attachments?: FileAttachment[]
  /** Images, video or audio the team produced for this message. Its own field
   *  rather than a member of `attachments`: that name means "files the team
   *  produced" on one surface and "files the person sent" on another, and media
   *  has to mean one thing everywhere. A message without it renders exactly as
   *  it does today. */
  media?: MediaRef[]
  /** Files SHOWN into this message: a document, a spreadsheet, a PDF. Its own
   *  field for the same reason media has one, and rendered here rather than
   *  through a page's renderAssistantExtra slot so a surface gains file cards
   *  by passing the field through its message mapper and nothing else. Team
   *  chat keeps its own separate `file_output` row, which predates this and
   *  every reader of it is already written. A message without it renders
   *  byte-identically to before. */
  files?: FileAttachment[]
  /** What the person attached when sending. Rendered under their own message so
   *  reopening a thread still shows what the reply was working from. */
  sentAttachments?: SentAttachment[]
  citations?: Citation[]
  /** Human who sent this message. Only present on user messages the backend
   *  could attribute to an account. */
  sender?: AvatarPerson | null
  /** A name and nothing else to key an account off: a Slack or Teams guest with
   *  no Liftoff account who sent a USER message. An unattributed message in a
   *  shared thread is worse than none, so we still show who it was. A reply's
   *  attribution is `contributors` below, never this field. */
  senderLabel?: string | null
  /** Colleagues, other than the assistant whose page this is, who had a hand
   *  in this reply: the one Liftoff handed the whole turn to, or every
   *  teammate a team delegated part of the work to. One chip each, in the
   *  footer, drawn from the same shape every surface stores and the
   *  `delegation_started` frame carries, so the live bubble and the stored
   *  row are attributed identically. Null as well as undefined for the
   *  reason messageType gives: it is what the surfaces actually return. */
  contributors?: Contributor[] | null
}

export interface ChatStreamingState {
  userMessage: string
  /** Media the person attached to the message being sent, drawn in their own
   *  bubble straight away. The persisted copy only reaches the transcript when
   *  the turn ends and the messages query refetches, which is a whole reply
   *  later — far too late for something they were already looking at in the
   *  composer. */
  userMedia?: MediaRef[]
  assistantText: string
  currentTool: string | null
  /** The phrase the backend authored for `currentTool`. */
  currentToolLabel?: string | null
  /** A whole activity phrase that outranks the tool-derived label, e.g.
   *  "Working with Security Review" while a delegated run works. Set by the
   *  streaming hook from the delegation_started frame and cleared when text
   *  resumes or the delegate pauses. The tool-name mapping cannot express this
   *  because the tool name says the mechanism ("delegate to agent"), not the
   *  teammate — and says "agent" to a user while doing it. */
  activityOverride?: string | null
  /** Values a tool returned that were delivered to the PERSON and kept out of
   *  the agent's context — a signed download link, a one-time token.
   *
   *  Live only, by design. Nothing persists them: writing them into the
   *  transcript would put them back into the context they were lifted out of,
   *  on the next turn that reads history. So they belong to the streaming
   *  bubble and disappear with it, which is the correct lifetime for a
   *  one-time value and the reason they are not a message. */
  hostDelivered?: Array<{ tool: string; fields: Array<{ path: string; value: unknown }> }>
  /** The person's browser event this turn started with (they handed the
   *  browser back, or pointed at something), drawn as a status row in their
   *  name until the persisted row replaces it. With it `userMessage` may be
   *  empty: an event alone has no bubble for the person. */
  browserEvent?: { kind: 'handback' | 'point'; text: string }
  thinking: boolean
  /** Whether the streaming assistant has extra content (e.g. blocks) — controls typing indicator visibility. */
  hasExtra?: boolean
  /** Who else is working on this reply: every colleague brought into the
   *  thread so far this turn, appended by the streaming hook as each
   *  `delegation_started` frame arrives and kept until the stream ends. Same
   *  question, and the same answer, as ChatMessageItem.contributors on the
   *  stored reply; this one is simply asked while the reply is still arriving. */
  contributors?: Contributor[]
}

/** One initials chip per contributor, in the footer of the bubble they had a
 *  hand in. The same element on the live bubble, the stored reply and the
 *  forwarded-context note, so "who else was here" is drawn one way. The chip
 *  is a GuestAvatar on purpose: a team has a name and nothing else to key an
 *  image off, and inside a thread the useful question is "who is this",
 *  which initials in a stable colour answer. Renders nothing for nobody. */
export function ContributorChips({ contributors }: { contributors?: Contributor[] | null }) {
  if (!contributors?.length) return null
  return (
    <>
      {contributors.map(contributor => (
        <GuestAvatar
          key={contributor.id}
          label={contributor.label}
          className="chat-message__sender-avatar"
        />
      ))}
    </>
  )
}

interface ChatMessagesProps {
  messages: ChatMessageItem[]
  streaming: ChatStreamingState | null
  /** Slot rendered inside each persisted assistant bubble, above the text. */
  renderAssistantExtra?: (message: ChatMessageItem) => ReactNode
  /** Replaces the whole bubble when it returns non-null. For rows that are not
   *  speech: a system status line about the conversation should not be dressed
   *  up as something the team said. Return null to render normally. */
  renderMessageOverride?: (message: ChatMessageItem) => ReactNode
  /** Slot rendered inside the live streaming assistant bubble, above the text. */
  renderStreamingExtra?: () => ReactNode
  /** Content rendered above the message list (report, empty state, etc.) */
  header?: ReactNode
}

// rehype-raw below turns the citation <sup> we injected into real markup, but it
// cannot tell that tag apart from anything else in the reply — and a reply is
// model output, which a poisoned document or a hostile tool result can steer.
// So the raw pass is paired with a sanitize pass that keeps the citation marker
// and drops everything the GitHub schema does not already vouch for.
//
// `sup` and `title` are permitted by defaultSchema; `className` is not, on any
// element, so without this extension the marker would render unstyled.
const citationSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    sup: [...(defaultSchema.attributes?.sup ?? []), ['className', 'citation-marker']],
  },
}

/**
 * How a markdown image is drawn, for every surface at once.
 *
 * There was no components map before this, so there was no interception point:
 * an image an agent wrote into its reply rendered as a bare `<img>` with no
 * sizing, no lazy loading and no error handling, and overflowed the bubble.
 * Routing it through MarkdownImage is what makes an image the agent LINKED and
 * an image it PRODUCED behave like the same thing — same sizing, same
 * click-to-expand, same degradation when the bytes will not load.
 *
 * `data:` URIs deliberately do not reach here: react-markdown's own
 * `safeProtocol` (`/^(https?|ircs?|mailto|xmpp)$/i`) blanks them, as does the
 * sanitize schema's `src: ['http','https']` on the citation path. A tool with
 * bytes uploads them and gets a MediaRef; it does not inline them.
 *
 * Markdown has no video syntax, and the renderer deliberately does not sniff
 * URL extensions to invent one: video takes the artifact path.
 */
const MARKDOWN_COMPONENTS = {
  // `width` and `height` from the markdown are deliberately ignored. They were
  // passed through to impose an aspect ratio, and an imposed ratio can only
  // ever be wrong: an author's attributes are a hint about a remote image
  // nothing here has measured. The image sizes itself from its own bytes.
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => {
    if (typeof src !== 'string' || !src) return null
    return <MarkdownImage src={src} alt={alt ?? ''} />
  },
  // A link in a reply opens in a new tab. Without this it inherits the
  // default, and following a citation or a source navigates the whole app
  // away in the same tab: the thread is gone, the scroll position with it,
  // and coming back is a reload. `rel` is not optional alongside
  // `target="_blank"` — it denies the opened page a handle on this one.
  //
  // The shared components/Markdown.tsx has done this since it was written;
  // chat imports react-markdown directly and never got it.
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
}

// Pre-process markdown text to convert [1] citation markers to HTML superscripts.
// This runs before the Markdown component so citation references render inline
// as styled superscripts while the rest of the message is still parsed as markdown.
function injectCitationSuperscripts(text: string, citations?: Citation[]): string {
  if (!citations?.length) return text
  return text.replace(/\[(\d+)\]/g, (match, num) => {
    const ref = parseInt(num)
    const citation = citations.find(c => c.ref === ref)
    const title = citation ? ` title="${citation.quote.replace(/"/g, '&quot;')}"` : ''
    return `<sup class="citation-marker"${title}>${match}</sup>`
  })
}

// Platform tools get a written label rather than one derived from their name.
// The phrase beside the pulse is authored in platform-backend and arrives on the
// frame (activityLabel.ts). It used to be derived here from the tool's own name,
// which produced the internal name almost verbatim ("Using Get_config") on every
// surface that is explicitly not supposed to show a person one.

// Activity indicator — always visible while the agent is working.
// `inline` = shown beneath existing text/extra content (compact form).
// `inline = false` = shown alone before any content (full-size form).
function AgentActivity({
  streaming,
  inline,
}: {
  streaming: ChatStreamingState
  inline: boolean
}) {
  if (streaming.activityOverride || streaming.currentTool) {
    return (
      <div className={`chat-message__activity${inline ? ' chat-message__activity--inline' : ''}`}>
        <span className="chat-message__activity-pulse" />
        <span className="chat-message__activity-label">
          {streaming.activityOverride ?? activityLabel(streaming.currentTool!, streaming.currentToolLabel)}
        </span>
      </div>
    )
  }
  return (
    <div className={`chat-message__typing${inline ? ' chat-message__typing--inline' : ''}`}>
      <span className="chat-message__dot" />
      <span className="chat-message__dot" />
      <span className="chat-message__dot" />
    </div>
  )
}

// Extracted so the useSmoothedText hook can be called unconditionally
// (hooks can't be inside conditionals). Renders the streaming assistant
// bubble with word-by-word adaptive pacing instead of raw bursty chunks.
function StreamingAssistantBubble({
  streaming,
  renderStreamingExtra,
}: {
  streaming: ChatStreamingState
  renderStreamingExtra?: () => ReactNode
}) {
  const smoothedText = useSmoothedText(streaming.assistantText, false)
  const displayText = smoothedText.trimEnd()

  const isWorking = streaming.thinking || !!streaming.currentTool || !!streaming.activityOverride
  // Inline = activity is shown below existing content rather than alone.
  const hasContent = !!displayText || !!streaming.hasExtra

  return (
    <div className="chat-message chat-message--assistant" aria-live="polite" aria-busy="true">
      <div className="chat-message__bubble chat-message__bubble--assistant">
        {renderStreamingExtra?.()}
        {displayText && (
          <div className="chat-message__text chat-message__markdown">
            <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{displayText}</Markdown>
          </div>
        )}
        {streaming.hostDelivered?.map((entry, i) => (
          <HostDeliveredFields
            key={`${entry.tool}-${i}`}
            toolName={entry.tool}
            fields={entry.fields}
          />
        ))}
        {isWorking && <AgentActivity streaming={streaming} inline={hasContent} />}
        {/* Fallback dots for the brief gap between state transitions */}
        {!isWorking && !hasContent && (
          <div className="chat-message__typing">
            <span className="chat-message__dot" />
            <span className="chat-message__dot" />
            <span className="chat-message__dot" />
          </div>
        )}
      </div>
      {/* The same footer a stored reply gets, so a colleague's answer is
          attributed identically before and after it is persisted. No timestamp
          beside it: this message has no time until it is written down. */}
      {streaming.contributors?.length ? (
        <div className="chat-message__meta">
          <ContributorChips contributors={streaming.contributors} />
        </div>
      ) : null}
    </div>
  )
}

export default function ChatMessages({
  messages,
  streaming,
  renderAssistantExtra,
  renderMessageOverride,
  renderStreamingExtra,
  header,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const hasScrolledRef = useRef(false)

  // The transcript can already be holding the message this turn is still
  // streaming, and then the person sees themselves say it twice.
  //
  // The backend writes their row FIRST, before the reply starts, so any read of
  // the thread while the turn runs brings that row back while the live scaffold
  // is still showing the same sentence. The first message of a new conversation
  // hits it whenever it loses the race: creating the thread is what mounts the
  // transcript query, so its very first read lands either side of that write,
  // and when it lands after, the pair stays up for the whole reply. Steering a
  // run does it too, on that same first turn, because that path refetches on
  // purpose to show what was just delivered.
  //
  // A reply is what closes a question off: anything said above one has been
  // answered, and so cannot be what is being answered now. The stored copy is
  // therefore looked for from the bottom up, stopping at the first reply, which
  // is what lets somebody say the same short thing twice ("continue") and still
  // watch their new message appear.
  let userMessagePersisted = false
  if (streaming?.userMessage) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') break
      if (messages[i].content === streaming.userMessage) {
        userMessagePersisted = true
        break
      }
    }
  }
  // The person's browser event, on the same terms: the backend writes its row
  // before the turn runs, and the live copy stands down when that row is on
  // screen. The row is typed and stored with role assistant, so the walk stops
  // at the first assistant row that is SPEECH rather than at any assistant row.
  let browserEventPersisted = false
  if (streaming?.browserEvent) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (isBrowserEventRow(m.messageType) && m.content === streaming.browserEvent.text) {
        browserEventPersisted = true
        break
      }
      if (m.role === 'assistant' && !m.messageType) break
    }
  }

  const isStreaming = !!streaming
  useEffect(() => {
    if (messages.length === 0 && !isStreaming) return
    if (!hasScrolledRef.current) {
      hasScrolledRef.current = true
      messagesEndRef.current?.scrollIntoView()
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [
    messages,
    isStreaming,
    streaming?.assistantText,
    streaming?.thinking,
    streaming?.hasExtra,
  ])

  return (
    <>
      {header}

      {/* A run's own narration — its progress lines and the terminal row that
          says it stopped — is folded into one item before rendering. The rows
          are unchanged: the backend appends one per update on purpose, but a
          one-minute run left three of them in the transcript and an
          eleven-minute one left fourteen. */}
      {groupRunProgress(messages, RUN_NARRATION_MESSAGE_TYPES).map(item => {
        if (item.kind === 'progress') {
          // A page that renders these rows itself still wins. Folding is a
          // default for the surfaces that do not, and silently overriding an
          // override would be this component deciding it knows better than the
          // page that asked.
          const overridden = item.rows.map(r => ({ row: r, node: renderMessageOverride?.(r) }))
          if (overridden.some(o => o.node)) {
            return (
              <Fragment key={item.rows[0].id}>
                {overridden.map(({ row, node }) => (
                  <div key={row.id}>{node ?? <RunProgressRow content={row.content} />}</div>
                ))}
              </Fragment>
            )
          }
          return (
            <RunProgressGroup
              key={item.rows[0].id}
              lines={item.rows.map(r => ({ id: r.id, content: r.content }))}
              label={collapsedLabel(item.rows)}
              answered={item.answered}
            />
          )
        }
        const msg = item.message
        // Some rows are not speech. Rendering them as a bubble would attribute
        // a system statement about the conversation to the team.
        const override = renderMessageOverride?.(msg)
        if (override) return <div key={msg.id}>{override}</div>
        return (
        <div key={msg.id} className={`chat-message ${msg.role === 'user' ? 'chat-message--user' : 'chat-message--assistant'}`}>
          <div className={`chat-message__bubble ${msg.role === 'user' ? 'chat-message__bubble--user' : 'chat-message__bubble--assistant'}`}>
            {msg.role === 'assistant' && renderAssistantExtra?.(msg)}
            {/* Media on this message — produced by the team, or SENT by the
                person. Rendered HERE rather than through a page's
                renderAssistantExtra slot, so a surface gains it by passing the
                field through its message mapper and nothing else, and so it
                draws for any role: a picture somebody attached shows as a
                picture inside their own bubble, which is what every chat
                product does and what a name-only pill would take away.
                A message with no media renders byte-identically to before. */}
            {msg.media?.length ? (
              <div className="chat-message__media">
                {msg.media.map(item => (
                  <MediaCard key={item.mediaId} media={item} />
                ))}
              </div>
            ) : null}
            {msg.files?.length ? (
              <div className="chat-message__files">
                {msg.files.map(file => (
                  <FileOutputCard key={file.generatedFileId} attachment={file} />
                ))}
              </div>
            ) : null}
            {msg.content && msg.role === 'assistant' && (
              <div className="chat-message__text chat-message__markdown">
                {/* NOTE, filed rather than fixed here: the raw + sanitize pair
                    runs only when the reply cites something, so a raw-HTML tag
                    in a reply renders as markup in a citing message and as text
                    in every other one. Making the pass unconditional would
                    change how existing non-media markup renders on all four
                    surfaces, which is outside adding media support. The
                    components map above does not depend on it — it intercepts
                    the markdown `img` node, which exists either way. */}
                <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS} rehypePlugins={msg.citations?.length ? [rehypeRaw, [rehypeSanitize, citationSchema]] : []}>{injectCitationSuperscripts(msg.content, msg.citations)}</Markdown>
              </div>
            )}
            {msg.content && msg.role === 'user' && (
              <p className="chat-message__text">{msg.content}</p>
            )}
            {msg.role === 'user' && msg.sentAttachments?.length ? (
              <ul className="chat-message__attachments">
                {msg.sentAttachments.map((attachment, index) => (
                  <li key={`${attachment.name}-${index}`} className="chat-message__attachment">
                    <span className="chat-message__attachment-name">{attachment.name}</span>
                    {attachment.connectorType && (
                      <span className="chat-message__attachment-source">
                        {attachment.connectorType}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {msg.role === 'assistant' && msg.citations?.length ? (
              <CitationList citations={msg.citations} />
            ) : null}
          </div>
          <div className="chat-message__meta">
            <span className="chat-message__time">{formatTime(msg.createdAt)}</span>
            {msg.role === 'user' && msg.sender && (
              <Tooltip text={getDisplayName(msg.sender)} position="top">
                <UserAvatar
                  person={msg.sender}
                  className="chat-message__sender-avatar"
                  iconSize={12}
                />
              </Tooltip>
            )}
            {/* A guest who sent a user message: a name and no account. */}
            {msg.role === 'user' && !msg.sender && msg.senderLabel && (
              <GuestAvatar label={msg.senderLabel} className="chat-message__sender-avatar" />
            )}
            {/* Who else had a hand in a reply: the colleague Liftoff handed the
                turn to, or each teammate a team delegated part of it to. Same
                element the live bubble drew while it streamed. */}
            {msg.role === 'assistant' && <ContributorChips contributors={msg.contributors} />}
          </div>
        </div>
        )
      })}

      {streaming && (
        <>
          {streaming.browserEvent && !browserEventPersisted && (
            <BrowserHandbackRow content={streaming.browserEvent.text} />
          )}
          {streaming.userMessage && !userMessagePersisted && (
            <div className="chat-message chat-message--user">
              <div className="chat-message__bubble chat-message__bubble--user">
                {/* Media above the text, matching the persisted bubble exactly
                    — the live copy and the stored one must not reshuffle
                    themselves when the turn ends and one replaces the other.
                    MediaCard reads the signed URL the composer already minted,
                    so this draws without a request. */}
                {streaming.userMedia?.length ? (
                  <div className="chat-message__media">
                    {streaming.userMedia.map(item => (
                      <MediaCard key={item.mediaId} media={item} />
                    ))}
                  </div>
                ) : null}
                <p className="chat-message__text">{streaming.userMessage}</p>
              </div>
            </div>
          )}
          <StreamingAssistantBubble
            streaming={streaming}
            renderStreamingExtra={renderStreamingExtra}
          />
        </>
      )}
      <div ref={messagesEndRef} />
    </>
  )
}
