import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { ChatMessageItem } from './ChatMessages'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const get = vi.fn()
vi.mock('../../services/api', () => ({ api: { get: (...args: unknown[]) => get(...args) } }))
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))

const ChatMessages = (await import('./ChatMessages')).default

const reply: ChatMessageItem = {
  id: 'm1',
  role: 'assistant',
  content: 'Here you go.',
  createdAt: '2026-08-30T10:00:00.000Z',
}

beforeEach(() => {
  get.mockReset()
  get.mockResolvedValue({ downloadUrl: 'https://storage.example/fresh', mimeType: 'image/png' })
})

describe('media in the transcript', () => {
  it('draws every item a message carries, not just the first', async () => {
    render(
      <ChatMessages
        messages={[{
          ...reply,
          content: '',
          messageType: 'media',
          media: [
            { mediaId: 'a', mimeType: 'image/png', filename: 'one.png', alt: 'first shot' },
            { mediaId: 'b', mimeType: 'image/png', filename: 'two.png', alt: 'second shot' },
          ],
        }]}
        streaming={null}
      />,
    )
    expect(await screen.findByAltText('first shot')).toBeInTheDocument()
    expect(await screen.findByAltText('second shot')).toBeInTheDocument()
  })

  it('renders a message with no media exactly as it did before', () => {
    // The whole no-change guarantee for the three platform surfaces: a message
    // without the field must not gain a node, a wrapper or a request.
    const { container } = render(<ChatMessages messages={[reply]} streaming={null} />)
    expect(container.querySelector('.chat-message__media')).not.toBeInTheDocument()
    expect(container.querySelector('img')).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })
})

describe('a markdown image in a reply', () => {
  const linked: ChatMessageItem = {
    ...reply,
    content: 'The chart is here:\n\n![Q3 revenue](https://cdn.example/chart.png)',
  }

  it('is drawn by the same component as an artifact, not as a bare tag', () => {
    // There was no components map before this, so a linked image rendered as an
    // unstyled <img> that overflowed the bubble.
    const { container } = render(<ChatMessages messages={[linked]} streaming={null} />)
    const img = screen.getByAltText('Q3 revenue')
    expect(img).toHaveClass('chat-media__image')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(container.querySelector('.chat-message__markdown')).toContainElement(img)
  })

  it('expands like an artifact image does', async () => {
    const user = userEvent.setup()
    render(<ChatMessages messages={[linked]} streaming={null} />)
    await user.click(screen.getByRole('button', { name: /Expand Q3 revenue/ }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('degrades to the link it always was when the URL will not load', async () => {
    render(<ChatMessages messages={[linked]} streaming={null} />)
    screen.getByAltText('Q3 revenue').dispatchEvent(new Event('error'))
    await waitFor(() => {
      const link = screen.getByRole('link', { name: 'Q3 revenue' })
      expect(link).toHaveAttribute('href', 'https://cdn.example/chart.png')
    })
    expect(screen.queryByAltText('Q3 revenue')).not.toBeInTheDocument()
  })

  it('draws the same way while the reply is still streaming', async () => {
    // The streaming bubble is a separate <Markdown> call site; before the
    // components map, only one of the two could have been fixed.
    render(
      <ChatMessages
        messages={[]}
        streaming={{
          userMessage: 'show me the chart',
          assistantText: '![Q3 revenue](https://cdn.example/chart.png)',
          currentTool: null,
          thinking: false,
        }}
      />,
    )
    // The streaming bubble reveals text word by word, so the image appears once
    // the smoothing catches up rather than on the first paint.
    const img = await screen.findByAltText('Q3 revenue', {}, { timeout: 3000 })
    expect(img).toHaveClass('chat-media__image')
  })
})
