/**
 * A file shown into a message draws on every surface.
 *
 * Team chat has always had file cards, as a separate `file_output` row its page
 * renders through a slot of its own. The three assistant surfaces had no way to
 * draw one at all, so a file they showed would have been stored and invisible.
 * Rendering here rather than through each page's slot is what the media beside
 * it already does, and for the same reason: a surface gains file cards by
 * passing the field through its message mapper and nothing else.
 */
import { render as rawRender, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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

/** A file card links into the dashboard, so it needs a router around it. */
const render = (ui: React.ReactElement) => rawRender(<MemoryRouter>{ui}</MemoryRouter>)

const reply: ChatMessageItem = {
  id: 'm1',
  role: 'assistant',
  content: '',
  createdAt: '2026-09-24T10:00:00.000Z',
}

beforeEach(() => {
  get.mockReset()
  get.mockResolvedValue({ downloadUrl: 'https://storage.example/fresh', mimeType: 'application/pdf' })
})

describe('files shown into a message', () => {
  it('draws every file a message carries, not just the first', () => {
    render(
      <ChatMessages
        messages={[{
          ...reply,
          messageType: 'file_output',
          files: [
            { generatedFileId: 'f1', filename: 'invoice_v1.pdf', outputType: 'pdf', version: 1, downloadUrl: null },
            { generatedFileId: 'f2', filename: 'summary_v1.xlsx', outputType: 'xlsx', version: 1, downloadUrl: null },
          ],
        }]}
        streaming={null}
      />,
    )
    expect(screen.getByText('invoice_v1.pdf')).toBeInTheDocument()
    expect(screen.getByText('summary_v1.xlsx')).toBeInTheDocument()
  })

  it('renders a message with no files exactly as it did before', () => {
    const { container } = render(
      <ChatMessages messages={[{ ...reply, content: 'Just words.' }]} streaming={null} />,
    )
    expect(container.querySelector('.chat-message__files')).toBeNull()
    expect(screen.getByText('Just words.')).toBeInTheDocument()
  })

  it('keeps a file a person SENT out of the produced-file block', () => {
    // `sentAttachments` is what the person attached and has always rendered as
    // a chip. A produced file is a different thing and must not borrow it.
    const { container } = render(
      <ChatMessages
        messages={[{
          ...reply,
          role: 'user',
          content: 'Have a look at this.',
          sentAttachments: [{ kind: 'upload', name: 'mine.pdf' }],
        }]}
        streaming={null}
      />,
    )
    expect(container.querySelector('.chat-message__files')).toBeNull()
  })
})
