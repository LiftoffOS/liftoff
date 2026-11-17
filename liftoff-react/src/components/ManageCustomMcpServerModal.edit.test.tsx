// A customer-hosted MCP server used to be unrepairable. Endpoint URL and auth
// were fixed at create time, so a moved endpoint or a rotated token left
// remove-and-add-again as the only remedy — and removing takes the connector id
// with it, so every agent bound to that server had to be bound again by hand.
// Editing in place keeps the id, which is what lets every bound team recover at
// once, the same property an OAuth reconnect relies on.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ManageCustomMcpServerModal from './ManageCustomMcpServerModal'

const mockUpdate = vi.fn()
const mockShowToast = vi.fn()

let mockServer: Record<string, unknown> | undefined
let mockConnectors: Array<Record<string, unknown>> = []

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
vi.mock('../hooks/useTunnels', () => ({ useTunnelRoutes: () => ({ data: [] }) }))
vi.mock('../hooks/useConnectors', () => ({
  useConnectors: () => ({ data: mockConnectors, isPending: false }),
  useDeleteConnector: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('../hooks/useCustomMcpServers', () => ({
  useCustomMcpServers: () => ({ data: [mockServer].filter(Boolean), isPending: false }),
  useCustomMcpServer: () => ({ data: mockServer, isLoading: false }),
  useDeleteCustomMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRediscoverCustomMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateCustomMcpServer: () => ({ mutateAsync: mockUpdate, isPending: false }),
}))

function renderModal() {
  return render(
    <ManageCustomMcpServerModal
      connectorId="conn-1"
      displayName="Help Center MCP"
      onClose={vi.fn()}
    />,
  )
}

// jsdom doesn't implement scrollIntoView, which Dropdown calls to keep the
// focused option in view.
Element.prototype.scrollIntoView = vi.fn()

// The auth control is the shared Dropdown (trigger button + listbox), so
// picking a value is two clicks rather than selectOptions.
async function selectAuthType(label: string) {
  await userEvent.click(screen.getByRole('button', { expanded: false }))
  await userEvent.click(screen.getByRole('option', { name: label }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdate.mockResolvedValue({})
  mockConnectors = [{ id: 'conn-1', type: 'custom_mcp_server', name: 'Help Center MCP', status: 'active' }]
  mockServer = {
    id: 'srv-1',
    connectorId: 'conn-1',
    name: 'Help Center MCP',
    deliveryMode: 'public_url',
    endpointUrl: 'https://old.example.com/mcp',
    authType: 'bearer_token',
    authSecretName: 'secret-1',
    tunnelRouteId: null,
    rawMcpTools: [],
  }
})

describe('ManageCustomMcpServerModal editing', () => {
  it('opens read-only so a glance cannot become an edit', () => {
    renderModal()
    expect(screen.getByText('https://old.example.com/mcp')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  // Four footer buttons do not fit the default 400px modal and the row is not
  // allowed to wrap, so the box has to be the one that grows.
  it('sizes the modal to its footer instead of clipping it', () => {
    renderModal()
    expect(screen.getByRole('dialog')).toHaveClass('modal-overlay__content--fit')
  })

  it('saves a moved endpoint without touching the stored credential', async () => {
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const field = screen.getByDisplayValue('https://old.example.com/mcp')
    await userEvent.clear(field)
    await userEvent.type(field, 'https://new.example.com/mcp')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(mockUpdate).toHaveBeenCalledWith({
      id: 'srv-1',
      data: { endpointUrl: 'https://new.example.com/mcp' },
    })
  })

  // The stored secret is write-only, so the box opens empty and an empty box
  // has to mean "keep what is saved" rather than "clear it".
  it('does not send a credential when the box is left blank', async () => {
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const field = screen.getByDisplayValue('https://old.example.com/mcp')
    await userEvent.clear(field)
    await userEvent.type(field, 'https://new.example.com/mcp')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(mockUpdate.mock.calls[0][0].data.bearerToken).toBeUndefined()
    expect(mockUpdate.mock.calls[0][0].data.apiKey).toBeUndefined()
  })

  it('sends a rotated token when one is entered', async () => {
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

    await userEvent.type(screen.getByPlaceholderText(/Leave blank/i), 'rotated-token')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(mockUpdate.mock.calls[0][0].data.bearerToken).toBe('rotated-token')
  })

  it('keeps save disabled until something actually changes', async () => {
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  // Switching to a new auth type has nothing stored to fall back on, so the
  // credential is mandatory there and only there.
  it('blocks a save that switches auth type with no credential', async () => {
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

    await selectAuthType('API key')

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  // The auth control is the shared Dropdown, the same one the connect flow
  // uses — a listbox of buttons, not a native <select>.
  it('edits authentication through the shared dropdown, not a native select', async () => {
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(screen.queryByRole('combobox')).toBeNull()
    const trigger = screen.getByRole('button', { expanded: false, name: /Bearer token/ })
    await userEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('option', { name: 'API key' }))
    expect(screen.getByRole('button', { name: /API key/ })).toHaveAttribute('aria-haspopup', 'listbox')
  })

  it('reports a server the probe could not reach', () => {
    mockConnectors = [{ id: 'conn-1', type: 'custom_mcp_server', name: 'Help Center MCP', status: 'error' }]
    renderModal()

    expect(screen.getByText('Not responding')).toBeInTheDocument()
    expect(screen.getByText(/did not answer the last checks/i)).toBeInTheDocument()
  })

  // A tunnel resolves its own address from the tunnel route, so there is
  // nothing here for the customer to edit.
  it('offers no endpoint field for a tunneled server', async () => {
    mockServer = { ...mockServer, deliveryMode: 'tunneled', tunnelRouteId: 'route-1' }
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(screen.queryByPlaceholderText('https://mcp.example.com/sse')).toBeNull()
  })
})
