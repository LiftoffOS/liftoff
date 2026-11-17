import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import ChatMessages, {
  type ChatMessageItem,
  type ChatStreamingState,
} from './ChatMessages'

// MediaCard mints a signed URL and so needs the workspace context. This file
// tests what ChatMessages COMPOSES — whether media is drawn, and where — so the
// card is stubbed at that boundary. What it draws is MediaCard.test.tsx's
// subject, and duplicating it here would only mean two places to update.
vi.mock('./MediaCard', () => ({
  MediaCard: ({ media }: { media: { mediaId: string } }) => (
    <div data-testid={`media-${media.mediaId}`} />
  ),
  ChatImage: () => null,
  MarkdownImage: () => null,
}))

// jsdom has no layout engine, so the auto-scroll effect needs a stub.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// The sender avatar identifies the human behind a user message. Threads are
// tenant-wide and the Slack/Teams channels are multi-author, so "who sent
// this" is real information, not decoration.

const baseMessage: ChatMessageItem = {
  id: 'm1',
  role: 'user',
  content: 'Where are we on the payroll run?',
  createdAt: '2026-07-27T10:00:00.000Z',
}

const sender = {
  accountId: 'acc-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  avatarUrl: null,
}

function renderMessages(messages: ChatMessageItem[]) {
  return render(<ChatMessages messages={messages} streaming={null} />)
}

describe('ChatMessages sender avatar', () => {
  it('shows the sender initials beside the timestamp on a user message', () => {
    const { container } = renderMessages([{ ...baseMessage, sender }])

    const avatar = container.querySelector('.chat-message__sender-avatar')
    expect(avatar).toBeInTheDocument()
    expect(avatar).toHaveTextContent('AL')
    // Sits in the same footer row as the timestamp, after it.
    const meta = container.querySelector('.chat-message__meta')
    expect(meta?.querySelector('.chat-message__time')).toBeInTheDocument()
    expect(meta?.contains(avatar!)).toBe(true)
  })

  it('names the sender for assistive tech and for the hover tooltip', () => {
    renderMessages([{ ...baseMessage, sender }])

    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('falls back to the email address when the sender has no name', () => {
    renderMessages([
      {
        ...baseMessage,
        sender: { ...sender, firstName: null, lastName: null },
      },
    ])

    expect(screen.getByLabelText('ada@example.com')).toBeInTheDocument()
  })

  it('renders the uploaded photo when the sender has one', () => {
    const { container } = renderMessages([
      { ...baseMessage, sender: { ...sender, avatarUrl: 'https://cdn/ada.png' } },
    ])

    const image = container.querySelector('.chat-message__sender-avatar.user-avatar--image')
    expect(image).toHaveAttribute('src', 'https://cdn/ada.png')
    expect(container.querySelector('.chat-message__sender-avatar')).not.toHaveTextContent('AL')
  })

  // A Slack or Teams guest has no account, but we do know the name they sent
  // under. An anonymous message in a shared thread is worse than no feature.
  it('shows the guest name for a sender with no Liftoff account', () => {
    const { container } = renderMessages([
      { ...baseMessage, sender: null, senderLabel: 'Grace Hopper' },
    ])

    const avatar = container.querySelector('.chat-message__sender-avatar')
    expect(avatar).toHaveTextContent('GH')
    expect(screen.getByLabelText('Grace Hopper')).toBeInTheDocument()
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
  })

  it('prefers the resolved account over the guest label', () => {
    renderMessages([{ ...baseMessage, sender, senderLabel: 'stale handle' }])

    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.queryByLabelText('stale handle')).not.toBeInTheDocument()
  })

  it('shows no avatar when the message has no attributable sender', () => {
    const { container } = renderMessages([baseMessage])

    expect(container.querySelector('.chat-message__time')).toBeInTheDocument()
    expect(container.querySelector('.chat-message__sender-avatar')).not.toBeInTheDocument()
  })

  it('never attributes an assistant message to a human account', () => {
    const { container } = renderMessages([
      { ...baseMessage, id: 'm2', role: 'assistant', content: 'On track.', sender },
    ])

    expect(container.querySelector('.chat-message__sender-avatar')).not.toBeInTheDocument()
  })
})

// A reply is not always written by the assistant whose page you are on: Liftoff
// can bring a colleague into the thread, and a team can hand part of the work
// to a teammate. An unlabelled bubble reads as the page's own assistant
// answering alone, which is the wrong attribution rather than a missing one.
describe('ChatMessages reply attribution', () => {
  const reply: ChatMessageItem = {
    id: 'a1',
    role: 'assistant',
    content: 'Spend is down 12% week over week.',
    createdAt: '2026-07-27T10:02:00.000Z',
  }

  it('names the colleague who wrote the reply, in the same row as the timestamp', () => {
    const { container } = renderMessages([
      { ...reply, contributors: [{ id: 'insights', label: 'Insights Manager' }] },
    ])

    const avatar = container.querySelector('.chat-message__sender-avatar')
    expect(avatar).toHaveTextContent('IM')
    const meta = container.querySelector('.chat-message__meta')
    expect(meta?.querySelector('.chat-message__time')).toBeInTheDocument()
    expect(meta?.contains(avatar!)).toBe(true)
  })

  it('names that colleague for assistive tech and for the hover tooltip', () => {
    renderMessages([{ ...reply, contributors: [{ id: 'agent-7', label: 'Payroll Team' }] }])

    expect(screen.getByLabelText('Payroll Team')).toBeInTheDocument()
    expect(screen.getByText('Payroll Team')).toBeInTheDocument()
  })

  // A team can bring in more than one teammate on one reply, and every one of
  // them gets a chip, in the order they were brought in.
  it('draws one chip per contributor, in order', () => {
    const { container } = renderMessages([
      {
        ...reply,
        contributors: [
          { id: 'agent-7', label: 'Security Review' },
          { id: 'agent-8', label: 'Legal Counsel' },
        ],
      },
    ])

    const avatars = [...container.querySelectorAll('.chat-message__sender-avatar')]
    expect(avatars.map(a => a.textContent)).toEqual(['SR', 'LC'])
    expect(screen.getByLabelText('Security Review')).toBeInTheDocument()
    expect(screen.getByLabelText('Legal Counsel')).toBeInTheDocument()
  })

  // The list is optional and null and empty all mean "answered alone", which
  // is what every reply written before any of this existed reads back as, so
  // such a reply has to render exactly as it always did.
  it('leaves a reply with no contributors untouched', () => {
    for (const contributors of [undefined, null, []]) {
      const { container, unmount } = renderMessages([{ ...reply, contributors }])

      expect(screen.getByText('Spend is down 12% week over week.')).toBeInTheDocument()
      expect(container.querySelector('.chat-message__time')).toBeInTheDocument()
      expect(container.querySelector('.chat-message__sender-avatar')).not.toBeInTheDocument()
      unmount()
    }
  })

  // A colleague a team brought into its own chat (Liftoff, the Chief AI
  // Officer, the Insights Manager) answers as a row typed `colleague` that no
  // renderer dispatches on: it is an ordinary bubble whose words are the
  // colleague's verbatim, attributed the way every other reply is.
  it('attributes a colleague\'s reply in a team chat through the same chip', () => {
    const { container } = renderMessages([
      {
        ...reply,
        messageType: 'colleague',
        content: 'Here is what would change: the team gains a weekly digest. Apply it?',
        contributors: [{ id: 'caio', label: 'Chief AI Officer' }],
      },
    ])

    expect(container.querySelector('.chat-message__bubble--assistant')).toBeInTheDocument()
    expect(screen.getByText(/Here is what would change/)).toBeInTheDocument()
    expect(container.querySelector('.chat-message__sender-avatar')).toHaveTextContent('CO')
    expect(screen.getByLabelText('Chief AI Officer')).toBeInTheDocument()
  })

  // The guest chip is a USER row's: who sent it. A label on a reply is not an
  // attribution any surface writes any more, so the transcript does not draw
  // one from it.
  it('draws the guest chip only on user rows', () => {
    const { container } = renderMessages([{ ...reply, senderLabel: 'Somebody' }])

    expect(container.querySelector('.chat-message__sender-avatar')).not.toBeInTheDocument()
  })
})

// The same question, asked while the answer is still being written. A colleague
// brought into a thread mid-turn has to be named from its first word, or the
// person reads a long reply attributed to nobody and finds out who wrote it
// only once the turn is over.
describe('ChatMessages streaming attribution', () => {
  const live: ChatStreamingState = {
    userMessage: 'Where did the spend go?',
    assistantText: 'Spend is down 12% week over week.',
    currentTool: null,
    thinking: false,
  }

  function renderStreaming(streaming: ChatStreamingState) {
    return render(<ChatMessages messages={[]} streaming={streaming} />)
  }

  it('names the colleague writing the live reply, through the same avatar', () => {
    const { container } = renderStreaming({
      ...live,
      contributors: [{ id: 'insights', label: 'Insights Manager' }],
    })

    const avatar = container.querySelector('.chat-message__sender-avatar')
    expect(avatar).toHaveTextContent('IM')
    expect(screen.getByLabelText('Insights Manager')).toBeInTheDocument()
    // The assistant row's own footer, the one a stored reply already uses, not
    // a second treatment invented for the live case.
    const meta = container.querySelector('.chat-message--assistant .chat-message__meta')
    expect(meta?.contains(avatar!)).toBe(true)
  })

  it('keeps every chip on the live bubble as teammates are brought in', () => {
    const { container } = renderStreaming({
      ...live,
      contributors: [
        { id: 'agent-7', label: 'Security Review' },
        { id: 'agent-8', label: 'Legal Counsel' },
      ],
    })

    const avatars = [...container.querySelectorAll('.chat-message__sender-avatar')]
    expect(avatars.map(a => a.textContent)).toEqual(['SR', 'LC'])
  })

  // A streaming bubble with nobody else on it has to render exactly as it did
  // before any of this existed: bubble, no footer, no avatar.
  it('gives a streaming bubble with no contributors no footer at all', () => {
    for (const streaming of [live, { ...live, contributors: [] }]) {
      const { container, unmount } = renderStreaming(streaming)

      expect(container.querySelector('.chat-message__bubble--assistant')).toBeInTheDocument()
      expect(container.querySelector('.chat-message__meta')).not.toBeInTheDocument()
      expect(container.querySelector('.chat-message__sender-avatar')).not.toBeInTheDocument()
      unmount()
    }
  })
})

// A paused thread posts a status row so every viewer sees the stall, not just
// whoever tripped the gate. It is written about the conversation rather than
// said in it, so it must not be dressed up as speech.
describe('ChatMessages — non-speech rows', () => {
  const statusRow: ChatMessageItem = {
    id: 's1',
    role: 'assistant',
    content: 'Waiting on Ada Lovelace to approve before continuing.',
    createdAt: '2026-07-27T10:01:00.000Z',
    messageType: 'hitl_status',
  }

  function renderWithOverride(messages: ChatMessageItem[]) {
    return render(
      <ChatMessages
        messages={messages}
        streaming={null}
        renderMessageOverride={(msg) =>
          msg.messageType === 'hitl_status' ? (
            <div className="chat-page__hitl-status">{msg.content}</div>
          ) : null
        }
      />,
    )
  }

  it('renders a status row as status, not as a bubble', () => {
    const { container } = renderWithOverride([statusRow])

    expect(screen.getByText('Waiting on Ada Lovelace to approve before continuing.')).toBeInTheDocument()
    expect(container.querySelector('.chat-page__hitl-status')).toBeInTheDocument()
    // The giveaway that it is being attributed to the team.
    expect(container.querySelector('.chat-message__bubble')).not.toBeInTheDocument()
  })

  // A status row carries no author and no reply, so a timestamp and the bubble
  // furniture would imply a turn that never happened.
  it('gives a status row no message chrome', () => {
    const { container } = renderWithOverride([statusRow])

    expect(container.querySelector('.chat-message__time')).not.toBeInTheDocument()
    expect(container.querySelector('.chat-message__meta')).not.toBeInTheDocument()
  })

  it('leaves ordinary messages alone', () => {
    const { container } = renderWithOverride([
      { ...baseMessage, sender },
      statusRow,
    ])

    // The real message keeps its bubble and its timestamp...
    expect(container.querySelector('.chat-message__bubble')).toBeInTheDocument()
    expect(container.querySelector('.chat-message__time')).toBeInTheDocument()
    // ...and the status row still renders alongside it.
    expect(container.querySelector('.chat-page__hitl-status')).toBeInTheDocument()
  })

  it('renders normally when no override is supplied', () => {
    const { container } = renderMessages([statusRow])

    expect(container.querySelector('.chat-message__bubble')).toBeInTheDocument()
  })
})

// An assistant reply with citations is the one path that renders raw HTML
// (rehype-raw). Replies are model output, so a poisoned document or a hostile
// tool result can put markup in them. The sanitize pass has to keep the
// citation marker working while dropping everything else.
describe('assistant markup rendering', () => {
  const citations = [{ ref: 1, filename: 'policy.pdf', quote: 'net 30' }]

  it('keeps the citation superscript and its class', () => {
    const { container } = renderMessages([
      {
        ...baseMessage,
        role: 'assistant',
        content: 'Invoices are net 30 [1].',
        citations,
      },
    ])

    const marker = container.querySelector('sup.citation-marker')
    expect(marker).toBeInTheDocument()
    expect(marker).toHaveTextContent('[1]')
    // The quote tooltip is the point of the marker; it comes from the global
    // attribute allowlist, so a schema change that drops it would be silent.
    expect(marker).toHaveAttribute('title', 'net 30')
  })

  it('strips a script tag from a reply that also carries citations', () => {
    const { container } = renderMessages([
      {
        ...baseMessage,
        role: 'assistant',
        content: 'Done [1].<script>window.__pwned = true</script>',
        citations,
      },
    ])

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('sup.citation-marker')).toBeInTheDocument()
  })

  it('strips an embedded frame from a reply that also carries citations', () => {
    const { container } = renderMessages([
      {
        ...baseMessage,
        role: 'assistant',
        content: 'See [1]. <iframe src="https://evil.example/x"></iframe>',
        citations,
      },
    ])

    expect(container.querySelector('iframe')).toBeNull()
  })

  it('renders an apostrophe in a user message as a character, not an entity', () => {
    renderMessages([{ ...baseMessage, content: "What's the best beer garden in Berlin" }])

    expect(
      screen.getByText("What's the best beer garden in Berlin"),
    ).toBeInTheDocument()
  })
})

// The person's own message, on screen twice, for the whole length of a reply.
//
// The backend writes the user row BEFORE the reply starts, so any read of the
// thread while the turn runs brings that row back while the live scaffold is
// still showing the same sentence. The first message of a new conversation
// hits it every time it loses the race: creating the thread is what mounts the
// transcript query, and its very first read lands either side of that write.
describe('ChatMessages — the live message and its stored copy', () => {
  const live: ChatStreamingState = {
    userMessage: 'help me create an agent',
    assistantText: '',
    currentTool: null,
    thinking: true,
  }

  const stored = (id: string, role: 'user' | 'assistant', content: string): ChatMessageItem => ({
    id,
    role,
    content,
    createdAt: '2026-08-28T23:26:03.000Z',
  })

  function userBubbles(container: HTMLElement) {
    return container.querySelectorAll('.chat-message--user')
  }

  it('shows the live message while nothing is stored yet', () => {
    const { container } = render(<ChatMessages messages={[]} streaming={live} />)

    expect(userBubbles(container)).toHaveLength(1)
    expect(screen.getByText('help me create an agent')).toBeInTheDocument()
  })

  it('shows it once, not twice, when the stored copy arrives mid-turn', () => {
    const { container, rerender } = render(<ChatMessages messages={[]} streaming={live} />)
    expect(userBubbles(container)).toHaveLength(1)

    // What the transcript's first read returns once the write has landed.
    rerender(
      <ChatMessages
        messages={[stored('m1', 'user', 'help me create an agent')]}
        streaming={live}
      />,
    )

    expect(userBubbles(container)).toHaveLength(1)
    expect(screen.getAllByText('help me create an agent')).toHaveLength(1)
  })

  // Steering a run refetches on purpose, to show what was just delivered. That
  // read carries the turn's own message back with it, so it has to stand down
  // even though it is no longer the newest thing in the thread.
  it('stands down when a later message was delivered into the same turn', () => {
    const { container } = render(
      <ChatMessages
        messages={[
          stored('m1', 'user', 'help me create an agent'),
          stored('m2', 'user', 'actually, make it read-only'),
        ]}
        streaming={live}
      />,
    )

    expect(userBubbles(container)).toHaveLength(2)
    expect(screen.getAllByText('help me create an agent')).toHaveLength(1)
  })

  // Somebody who says the same short thing twice must still see the second
  // one. The reply to the first is what marks it as already answered.
  it('still shows the live message when an answered one says the same thing', () => {
    const { container } = render(
      <ChatMessages
        messages={[
          stored('m1', 'user', 'continue'),
          stored('m2', 'assistant', 'Done. Anything else?'),
        ]}
        streaming={{ ...live, userMessage: 'continue' }}
      />,
    )

    expect(screen.getAllByText('continue')).toHaveLength(2)
    expect(userBubbles(container)).toHaveLength(2)
  })

  it('leaves the live message alone when nothing stored matches it', () => {
    const { container } = render(
      <ChatMessages
        messages={[stored('m1', 'user', 'something else entirely')]}
        streaming={live}
      />,
    )

    expect(userBubbles(container)).toHaveLength(2)
    expect(screen.getByText('help me create an agent')).toBeInTheDocument()
  })

  // An observed turn — somebody watching a colleague's reply arrive — carries
  // no user message at all, so there is nothing here for it to suppress.
  it('renders no user bubble for a turn that carries no message', () => {
    const { container } = render(
      <ChatMessages
        messages={[stored('m1', 'user', 'help me create an agent')]}
        streaming={{ ...live, userMessage: '' }}
      />,
    )

    expect(userBubbles(container)).toHaveLength(1)
  })
})

// The live bubble is what the person looks at for the whole length of a reply.
// It used to carry their words and not their picture: the media only reached
// the transcript when the turn ended and the messages query refetched, so an
// image they were already looking at in the composer vanished on send and came
// back a reply later.
describe('the message being sent shows its own media', () => {
  const MEDIA = {
    mediaId: 'm-live',
    mimeType: 'image/png',
    filename: 'shot.png',
  }

  it('draws attached media in the live user bubble', () => {
    const { container } = render(
      <ChatMessages
        messages={[]}
        streaming={{
          userMessage: 'what can you see?',
          userMedia: [MEDIA],
          assistantText: '',
          currentTool: null,
          thinking: true,
        }}
      />,
    )
    expect(container.querySelector('.chat-message--user .chat-message__media')).toBeTruthy()
    expect(screen.getByText('what can you see?')).toBeInTheDocument()
  })

  // The live copy and the stored one replace each other when the turn ends, so
  // they must not reshuffle: media above the text in both.
  it('puts the media above the text, as the persisted bubble does', () => {
    const { container } = render(
      <ChatMessages
        messages={[]}
        streaming={{
          userMessage: 'what can you see?',
          userMedia: [MEDIA],
          assistantText: '',
          currentTool: null,
          thinking: true,
        }}
      />,
    )
    const bubble = container.querySelector('.chat-message--user .chat-message__bubble')!
    const kids = Array.from(bubble.children)
    const mediaAt = kids.findIndex(k => k.classList.contains('chat-message__media'))
    const textAt = kids.findIndex(k => k.classList.contains('chat-message__text'))
    expect(mediaAt).toBeGreaterThanOrEqual(0)
    expect(mediaAt).toBeLessThan(textAt)
  })

  it('renders no media container when nothing was attached', () => {
    const { container } = render(
      <ChatMessages
        messages={[]}
        streaming={{
          userMessage: 'just words',
          assistantText: '',
          currentTool: null,
          thinking: true,
        }}
      />,
    )
    expect(container.querySelector('.chat-message--user .chat-message__media')).toBeNull()
  })
})

// A run that works for minutes narrates itself into the thread. The row is
// written about the run, not said by the team, and it renders on every surface
// without that surface having to know about it.
describe('ChatMessages — run progress', () => {
  const progressRow: ChatMessageItem = {
    id: 'p1',
    role: 'assistant',
    content: 'This run is still working. So far: 12 web searches, 4 pages read.',
    createdAt: '2026-09-02T04:00:00.000Z',
    messageType: 'run_progress',
  }

  it('renders as status with NO page override supplied', () => {
    // The point of handling it here: a surface gains this by passing
    // messageType through, and nothing else.
    const { container } = render(<ChatMessages messages={[progressRow]} streaming={null} />)

    expect(screen.getByText(progressRow.content)).toBeInTheDocument()
    expect(container.querySelector('.chat-run-progress')).toBeInTheDocument()
    // The giveaway that it is being attributed to the team.
    expect(container.querySelector('.chat-message__bubble')).not.toBeInTheDocument()
  })

  it('keeps the dot inline with the text, so a long line cannot strand it', () => {
    // These lines grow — "Step 6 of 13. So far: 14 web searches, 18 pages read,
    // 1 document written, 14 actions in Liftoff Tool Gateway" — and on the
    // shared status row's flex layout the text wrapped to its own line and left
    // the dot floating above it.
    const { container } = render(<ChatMessages messages={[progressRow]} streaming={null} />)

    const row = container.querySelector('.chat-run-progress')!
    expect(row.querySelector('.chat-run-progress__dot')).toBeInTheDocument()
    // The dot is a child of the same box the text flows in, not a sibling item
    // in a wrapping row.
    expect(row.textContent).toContain('12 web searches')
  })

  it('is announced politely rather than as an alert', () => {
    // It is rewritten every twenty seconds while a run works; an assertive
    // region would interrupt a screen-reader user on every update.
    render(<ChatMessages messages={[progressRow]} streaming={null} />)

    expect(screen.getByRole('status')).toHaveTextContent('12 web searches')
  })

  it('still lets a page override the row', () => {
    const { container } = render(
      <ChatMessages
        messages={[progressRow]}
        streaming={null}
        renderMessageOverride={(msg) =>
          msg.messageType === 'run_progress' ? <div className="custom-row">{msg.content}</div> : null
        }
      />,
    )

    expect(container.querySelector('.custom-row')).toBeInTheDocument()
    expect(container.querySelector('.chat-run-progress')).not.toBeInTheDocument()
  })

  it('renders the TERMINAL row as status too, never as the team speaking', () => {
    // The row a run writes when it stops without an answer. It carries its own
    // type on the wire (`run_failed`) because the backend has to find it — the
    // turn after a failed run is told the run stopped. On screen it is the same
    // kind of row as the progress lines it closes.
    //
    // Missed here it falls through to the assistant BUBBLE, with an avatar and
    // a name, so the thread shows the team saying "This run stopped on an error
    // before it could answer." A failure attributed to the team is worse than
    // no row at all.
    const failedRow: ChatMessageItem = {
      id: 'f1',
      role: 'assistant',
      content: 'This run stopped on an error before it could answer. Work done before it stopped: 1 action in Google Docs.',
      createdAt: '2026-09-02T04:01:00.000Z',
      messageType: 'run_failed',
    }
    const { container } = render(<ChatMessages messages={[failedRow]} streaming={null} />)

    expect(screen.getByText(failedRow.content)).toBeInTheDocument()
    expect(container.querySelector('.chat-run-progress')).toBeInTheDocument()
    expect(container.querySelector('.chat-message__bubble')).not.toBeInTheDocument()
  })

  it('folds the terminal row into the run it closes', () => {
    const failedRow: ChatMessageItem = {
      id: 'f1',
      role: 'assistant',
      content: 'This run stopped on an error before it could answer.',
      createdAt: '2026-09-02T04:01:00.000Z',
      messageType: 'run_failed',
    }
    const { container } = render(
      <ChatMessages messages={[progressRow, failedRow]} streaming={null} />,
    )

    // ONE group — not a status row and a bubble — and no bubble anywhere.
    expect(container.querySelectorAll('.chat-message__bubble')).toHaveLength(0)
    expect(container.querySelectorAll('.chat-run-progress-group')).toHaveLength(1)
    expect(screen.getByText(progressRow.content)).toBeInTheDocument()
    // The terminal row is the group's last line, and also its folded label —
    // the same double-render an answered run's closing summary already gets.
    expect(screen.getAllByText(failedRow.content).length).toBeGreaterThan(0)
  })

  it('leaves ordinary speech alone', () => {
    const { container } = render(
      <ChatMessages
        messages={[{ ...progressRow, messageType: undefined, content: 'Here is the analysis.' }]}
        streaming={null}
      />,
    )

    expect(container.querySelector('.chat-message__bubble')).toBeInTheDocument()
    expect(container.querySelector('.chat-run-progress')).not.toBeInTheDocument()
  })
})

describe("ChatMessages — the person's browser event while its turn runs", () => {
  const streaming = (over: Partial<ChatStreamingState> = {}): ChatStreamingState => ({
    userMessage: '',
    assistantText: '',
    currentTool: null,
    thinking: true,
    ...over,
  })

  it('draws the event as a status row in the person\'s name, and no bubble for them', () => {
    const { container } = render(
      <ChatMessages messages={[]} streaming={streaming({ browserEvent: { kind: 'handback', text: 'Ada Lovelace handed the browser back' } })} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Ada Lovelace handed the browser back')
    expect(container.querySelector('.chat-message--user')).not.toBeInTheDocument()
  })

  it('stands the live row down once the persisted row is on screen, and draws the words beside a hand-back sent while driving', () => {
    const persisted: ChatMessageItem = {
      id: 'r1', role: 'assistant', content: 'Ada Lovelace handed the browser back', createdAt: '2026-09-21T10:00:00.000Z', messageType: 'browser_handback',
    }
    const { container } = render(
      <ChatMessages
        messages={[persisted]}
        streaming={streaming({ userMessage: 'now summarise it', browserEvent: { kind: 'handback', text: 'Ada Lovelace handed the browser back' } })}
        renderMessageOverride={(msg) => (msg.messageType === 'browser_handback' ? <div role="status">{msg.content}</div> : null)}
      />,
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(container.querySelector('.chat-message--user')).toHaveTextContent('now summarise it')
  })
})
