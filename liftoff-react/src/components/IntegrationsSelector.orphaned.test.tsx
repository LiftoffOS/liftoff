// A binding survives its connector being disconnected, so the Teams page can
// name the capability an agent lost. The cost landed here: this list is
// built from live connectors, so a selection whose connector is gone rendered
// nothing at all. It stayed in the array, was resubmitted on every save, and
// could not be removed because there was no chip to click.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import IntegrationsSelector, { type SelectedIntegration } from './IntegrationsSelector'

vi.mock('./icons/integrationIconRegistry', () => ({ getIntegrationIcon: () => null }))
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }))

let mockConnected: Array<Record<string, unknown>> = []
vi.mock('../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    connected: mockConnected,
    available: [],
    planned: [],
    integrations: [],
    isPending: false,
  }),
}))
vi.mock('../hooks/useExternalAgents', () => ({
  useExternalAgents: () => ({ data: { agents: [] }, isPending: false }),
}))
vi.mock('../hooks/useInternalAgents', () => ({
  useInternalAgents: () => ({
    data: { pages: [{ internalAgents: [] }] },
    isPending: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
  }),
}))

function liveConnector(over: Record<string, unknown>) {
  return {
    id: 'c-live',
    name: 'Gmail',
    type: 'Communications',
    icon: null,
    status: 'connected',
    objectsCovered: [],
    connectorType: 'google_mail',
    connector: { id: 'c-live', type: 'google_mail', name: 'Gmail', status: 'active' },
    ...over,
  }
}

function selection(over: Partial<SelectedIntegration>): SelectedIntegration {
  return {
    id: 'c-gone',
    integrationId: 'google_slides',
    name: 'Google Slides',
    type: 'Storage',
    selectedObjects: [],
    ...over,
  }
}

beforeEach(() => {
  mockConnected = []
})

describe('IntegrationsSelector orphaned selections', () => {
  it('surfaces a selection whose connector no longer exists', () => {
    render(<IntegrationsSelector selected={[selection({})]} onChange={vi.fn()} />)

    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(
      screen.getAllByText(
        'Google Slides is no longer connected. Reconnect it, or remove it from this agent.',
      ).length,
    ).toBeGreaterThan(0)
  })

  it('removes the binding when the chip is clicked', async () => {
    const onChange = vi.fn()
    const keep = selection({ id: 'c-keep', integrationId: 'github', name: 'GitHub' })
    render(<IntegrationsSelector selected={[selection({}), keep]} onChange={onChange} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Google Slides from this agent' }),
    )

    expect(onChange).toHaveBeenCalledWith([keep])
  })

  // Same rule the runtime and the Teams badge use: a stale id with exactly one
  // live connector of that type is a reconnect under a new id, not a fault.
  it('does not flag a stale id when one live connector of that type exists', () => {
    mockConnected = [liveConnector({})]
    render(
      <IntegrationsSelector
        selected={[selection({ id: 'c-old', integrationId: 'google_mail', name: 'Gmail' })]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryByText('Needs attention')).toBeNull()
  })

  it('flags a stale id when two live connectors of that type exist', () => {
    mockConnected = [liveConnector({}), liveConnector({ id: 'c-live-2' })]
    render(
      <IntegrationsSelector
        selected={[selection({ id: 'c-old', integrationId: 'google_mail', name: 'Gmail' })]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Needs attention')).toBeInTheDocument()
  })

  it('leaves a healthy selection alone', () => {
    mockConnected = [liveConnector({})]
    render(
      <IntegrationsSelector
        selected={[selection({ id: 'c-live', integrationId: 'google_mail', name: 'Gmail' })]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryByText('Needs attention')).toBeNull()
  })

  it('shows nothing when there are no selections at all', () => {
    render(<IntegrationsSelector selected={[]} onChange={vi.fn()} />)
    expect(screen.queryByText('Needs attention')).toBeNull()
  })
})
