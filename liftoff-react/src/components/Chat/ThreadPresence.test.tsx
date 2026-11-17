import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ThreadPresence, TypingIndicator } from './ThreadPresence'
import type { ThreadPresenceEntry } from '../../services/presence'

// Presence answers "who else is here". Both surfaces exclude the viewer: you
// know you are here, and a facepile of yourself is noise.

const person = (over: Partial<ThreadPresenceEntry> = {}): ThreadPresenceEntry => ({
  accountId: 'acc-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  avatarUrl: null,
  typing: false,
  ...over,
})

const ME = 'me-1'

describe('ThreadPresence facepile', () => {
  it('renders nothing when you are alone on the thread', () => {
    const { container } = render(
      <ThreadPresence viewers={[person({ accountId: ME })]} viewerAccountId={ME} />,
    )
    expect(container.querySelector('.thread-presence')).not.toBeInTheDocument()
  })

  it('renders nothing when the roster is empty', () => {
    const { container } = render(<ThreadPresence viewers={[]} viewerAccountId={ME} />)
    expect(container.querySelector('.thread-presence')).not.toBeInTheDocument()
  })

  it('shows the other people, excluding you', () => {
    const { container } = render(
      <ThreadPresence
        viewers={[person({ accountId: ME, firstName: 'Me' }), person()]}
        viewerAccountId={ME}
      />,
    )
    const avatars = container.querySelectorAll('.thread-presence__avatar')
    expect(avatars).toHaveLength(1)
    expect(avatars[0]).toHaveTextContent('AL')
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
  })

  it('caps the row and shows the remainder as a count', () => {
    const viewers = Array.from({ length: 7 }, (_, i) =>
      person({ accountId: `acc-${i}`, firstName: `P${i}`, lastName: 'X' }),
    )
    const { container } = render(<ThreadPresence viewers={viewers} viewerAccountId={ME} />)
    // Four faces plus the overflow chip, which shares the avatar class.
    expect(
      container.querySelectorAll('.thread-presence__avatar:not(.thread-presence__avatar--more)'),
    ).toHaveLength(4)
    expect(screen.getByText('+3')).toBeInTheDocument()
  })
})

describe('TypingIndicator', () => {
  it('renders nothing when nobody else is typing', () => {
    const { container } = render(
      <TypingIndicator viewers={[person({ typing: false })]} viewerAccountId={ME} />,
    )
    expect(container.querySelector('.thread-typing')).not.toBeInTheDocument()
  })

  it('ignores your own typing', () => {
    const { container } = render(
      <TypingIndicator viewers={[person({ accountId: ME, typing: true })]} viewerAccountId={ME} />,
    )
    expect(container.querySelector('.thread-typing')).not.toBeInTheDocument()
  })

  it('draws the dots in a bubble with the avatar beneath, like a real message', () => {
    const { container } = render(
      <TypingIndicator viewers={[person({ typing: true })]} viewerAccountId={ME} />,
    )
    expect(container.querySelector('.chat-message__bubble--user .chat-message__typing'))
      .toBeInTheDocument()
    const avatar = container.querySelector('.chat-message__meta .chat-message__sender-avatar')
    expect(avatar).toHaveTextContent('AL')
    // Hovering the avatar is how you learn who it is; no prose in the row.
    expect(screen.getByLabelText('Ada Lovelace')).toBeInTheDocument()
  })

  it('shows one avatar per person typing', () => {
    const viewers = Array.from({ length: 3 }, (_, i) =>
      person({ accountId: `acc-${i}`, firstName: `P${i}`, lastName: 'X', typing: true }),
    )
    const { container } = render(<TypingIndicator viewers={viewers} viewerAccountId={ME} />)
    expect(container.querySelectorAll('.chat-message__sender-avatar')).toHaveLength(3)
  })

  it('falls back to the email address when a typist has no name', () => {
    render(
      <TypingIndicator
        viewers={[person({ firstName: null, lastName: null, typing: true })]}
        viewerAccountId={ME}
      />,
    )
    expect(screen.getByLabelText('ada@example.com')).toBeInTheDocument()
  })
})
