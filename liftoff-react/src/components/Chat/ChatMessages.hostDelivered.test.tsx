import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import ChatMessages, { type ChatStreamingState } from './ChatMessages'
import { dispatchSseEvent } from '../../services/agentChat'

// The JOIN between the two ends of the side channel.
//
// `agentChat.hostDelivered.test.ts` proves the SSE frame is parsed into an
// event, and `HostDeliveredFields.test.tsx` proves the component draws one it
// is handed. Nothing tested that the event the parser produces is the thing
// ChatMessages draws — the same shape a person would see if they were looking
// at the streaming bubble when a connector returned a field kept out of the
// agent's context. That gap is how a channel ships with a producer at one
// end and a renderer at the other and no traffic between them.
//
// So this feeds a parsed `host_delivered` frame through the parser, hands
// what it produced to ChatMessages the way the streaming hook does (appended
// onto the live bubble), and reads the rendered result.

vi.mock('./MediaCard', () => ({
  MediaCard: () => null,
  ChatImage: () => null,
  MarkdownImage: () => null,
}))

// jsdom has no layout engine, so the auto-scroll effect needs a stub.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

/** What the streaming hook does with a parsed frame: append it to the live
 *  bubble's hostDelivered list, and nowhere else. */
function parseAndAttach(
  frames: Array<Record<string, unknown>>,
  base: ChatStreamingState,
): ChatStreamingState {
  let streaming = base
  for (const frame of frames) {
    dispatchSseEvent('host_delivered', frame, {
      onHostDelivered: (event) => {
        streaming = { ...streaming, hostDelivered: [...(streaming.hostDelivered ?? []), event] }
      },
    })
  }
  return streaming
}

const live: ChatStreamingState = {
  userMessage: 'Send me the latest invoice.',
  assistantText: 'Here is the invoice you asked for.',
  currentTool: null,
  thinking: false,
}

describe('ChatMessages renders a parsed host_delivered event', () => {
  it('draws the field the frame carried, on the live bubble, as a link', () => {
    const streaming = parseAndAttach(
      [{ tool: 'drive__get_file', fields: [{ path: 'data.downloadUrl', value: 'https://example.com/f/abc' }] }],
      live,
    )

    const { container } = render(<ChatMessages messages={[]} streaming={streaming} />)

    // Inside the assistant's streaming bubble, beside the text.
    const bubble = container.querySelector('.chat-message__bubble--assistant')
    const delivered = screen.getByTestId('host-delivered-fields')
    expect(bubble?.contains(delivered)).toBe(true)
    // Says which tool it came from and that the agent did not get it.
    expect(delivered).toHaveTextContent('drive__get_file')
    expect(delivered).toHaveTextContent(/not shared with your agent/i)
    // The path, and the value offered as a link.
    expect(delivered).toHaveTextContent('data.downloadUrl')
    const link = screen.getByRole('link', { name: 'https://example.com/f/abc' })
    expect(link).toHaveAttribute('href', 'https://example.com/f/abc')
  })

  it('keeps every delivery a turn produced — the second does not take the first off the screen', () => {
    const streaming = parseAndAttach(
      [
        { tool: 'drive__get_file', fields: [{ path: 'data.downloadUrl', value: 'https://example.com/f/abc' }] },
        { tool: 'stripe__create_link', fields: [{ path: 'url', value: 'https://pay.example.com/x' }] },
      ],
      live,
    )

    render(<ChatMessages messages={[]} streaming={streaming} />)

    expect(screen.getAllByTestId('host-delivered-fields')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'https://example.com/f/abc' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://pay.example.com/x' })).toBeInTheDocument()
  })

  it('a frame the parser refuses reaches the screen as nothing', () => {
    // No path means no label a person can act on; the parser drops it, and the
    // component is never handed it.
    const streaming = parseAndAttach([{ tool: 'drive__get_file', fields: [{ value: 'https://example.com/f/abc' }] }], live)

    render(<ChatMessages messages={[]} streaming={streaming} />)

    expect(screen.queryByTestId('host-delivered-fields')).not.toBeInTheDocument()
  })

  it('renders nothing of the kind when no frame arrived', () => {
    render(<ChatMessages messages={[]} streaming={live} />)
    expect(screen.queryByTestId('host-delivered-fields')).not.toBeInTheDocument()
  })
})
