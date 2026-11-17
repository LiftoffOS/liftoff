import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import MorePane from './MorePane'

// The pane is the messaging options in the chat page's right slot. Everything
// behind the cards (OAuth, tenant, the connector catalog) is somebody else's
// tested code, so it is mocked down to what the pane actually renders.
const navigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => navigate }
})
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))
const connect = vi.fn()
vi.mock('../../hooks/useIntegrationConnect', () => ({
  useIntegrationConnect: () => ({ connect, connecting: false }),
}))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

const renderPane = (over: Partial<Parameters<typeof MorePane>[0]> = {}) =>
  render(
    <MemoryRouter>
      <MorePane
        agentId="agent-1"
        agentName="Claude Coder"
        onClose={vi.fn()}
        {...over}
      />
    </MemoryRouter>,
  )

describe('MorePane', () => {
  it('offers the ways to reach the team outside Liftoff', () => {
    renderPane()
    expect(screen.getByText('Add to Slack')).toBeInTheDocument()
    expect(screen.getByText('Add to Microsoft Teams')).toBeInTheDocument()
    expect(screen.getByText('Add to AI Coding Tool')).toBeInTheDocument()
    expect(screen.getByText('More Ways to Connect')).toBeInTheDocument()
  })

  it('does not offer to open the chat it is rendered in', () => {
    // The old /dashboard/agents/message page led with a "Message Directly"
    // card. In the pane that card would point at the conversation behind it,
    // which is why the card, and then the page, went away.
    renderPane()
    expect(screen.queryByText('Message Directly')).not.toBeInTheDocument()
    expect(screen.queryByText('Open')).not.toBeInTheDocument()
  })

  it('names the team in the @Liftoff copy, preferring the messaging nickname', () => {
    renderPane({ nickname: 'Coder' })
    expect(
      screen.getAllByText(/Your team can use @Liftoff anywhere to chat with Coder directly/),
    ).toHaveLength(2)
  })

  it('closes on the close button', () => {
    const onClose = vi.fn()
    renderPane({ onClose })
    fireEvent.click(screen.getByLabelText('Close more pane'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders for a platform assistant with no agent id at all', () => {
    // Liftoff and the Insights Manager have no internal_agents row. The MCP
    // card still works: the destination page reads its router-state agentId
    // as null-tolerant analytics, nothing more.
    renderPane({ agentId: undefined, agentName: 'the Insights Manager' })
    expect(screen.getByText('Add to AI Coding Tool')).toBeInTheDocument()
    expect(
      screen.getAllByText(
        /Your team can use @Liftoff anywhere to chat with the Insights Manager directly/,
      ),
    ).toHaveLength(2)

    const mcpCard = screen
      .getByText('Add to AI Coding Tool')
      .closest('.agent-message-options__card') as HTMLElement
    fireEvent.click(within(mcpCard).getByRole('button', { name: 'Set Up' }))
    expect(navigate).toHaveBeenCalledWith('/dashboard/agents/mcp', {
      state: { agentId: undefined, agentName: 'the Insights Manager' },
    })
  })

  it('shares the right pane shell with the browser view, but has no resizer', () => {
    // Same shell and close position as BrowserPane. The drag handle is
    // deliberately absent: this pane has a fixed width, so there is nothing
    // to trade conversation width for.
    const { container } = renderPane()
    expect(container.querySelector('.chat-page__right-pane')).toBeInTheDocument()
    expect(container.querySelector('.chat-page__right-pane-close')).toBeInTheDocument()
    expect(container.querySelector('.chat-page__right-pane-resizer')).not.toBeInTheDocument()
  })
})
