/**
 * The order of the chat input's left-hand controls.
 *
 * This test exists because the order was previously unwritable-down. `ChatInput`
 * takes `leftActions` as an opaque ReactNode, so five pages each composed their
 * own fragment and nothing compared them — no type, no test, no lint rule could
 * see a divergence. One eventually happened: the three platform assistants
 * shipped with the browser button first while agent chat had it second.
 *
 * Now the order is a component, so it is assertable.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ChatInputActions, BrowserPaneToggleButton } from './ChatInputActions'

vi.mock('..', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../../assets/icons/monitor.svg?react', () => ({
  default: () => <svg data-testid="monitor-icon" />,
}))

describe('ChatInputActions', () => {
  it('renders attachment, then browser, then voice', () => {
    render(
      <ChatInputActions
        attach={<button>attach</button>}
        browser={<button>browser</button>}
        voice={<button>voice</button>}
      />,
    )
    expect(screen.getAllByRole('button').map(b => b.textContent))
      .toEqual(['attach', 'browser', 'voice'])
  })

  it('closes the gap when a surface has no browser', () => {
    // HomePage has no thread to hang a session on. It passes nothing rather
    // than restating the order without that slot.
    render(
      <ChatInputActions attach={<button>attach</button>} voice={<button>voice</button>} />,
    )
    expect(screen.getAllByRole('button').map(b => b.textContent))
      .toEqual(['attach', 'voice'])
  })
})

describe('BrowserPaneToggleButton', () => {
  it('renders nothing when no browser is available', () => {
    // So a caller can pass it unconditionally instead of each page deciding.
    const { container } = render(
      <BrowserPaneToggleButton available={false} open={false} onToggle={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('tells a screen reader what pressing it will do, in both states', () => {
    // The reason this button is a component rather than four copies of markup:
    // a sighted person sees the same icon either way, so these two attributes
    // are the whole of the state for anyone who cannot.
    const { rerender } = render(
      <BrowserPaneToggleButton available open={false} onToggle={() => {}} />,
    )
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Show browser pane')
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false')

    rerender(<BrowserPaneToggleButton available open onToggle={() => {}} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Hide browser pane')
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  })

  it('can be disabled while another pane holds the slot', () => {
    // Every chat surface shares the slot with its More pane and disables the
    // toggle while that one holds it.
    render(<BrowserPaneToggleButton available open={false} onToggle={() => {}} disabled />)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('is enabled by default everywhere else', () => {
    render(<BrowserPaneToggleButton available open={false} onToggle={() => {}} />)
    expect(screen.getByRole('button')).toBeEnabled()
  })
})
