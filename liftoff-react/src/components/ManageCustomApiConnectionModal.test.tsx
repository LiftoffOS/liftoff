// A custom API connection has FOUR controls and none of them implies another.
// That is only true if all four are reachable from the one place a person
// manages the connection, and if each does what its label says.
//
// The one that has to be reachable when things are worst is "Check Again": a
// connection that broke without its key changing — a rate limit, an endpoint
// briefly gone — is repaired by re-running the provider's own check, and
// sending a broken connection to the connect flow instead would hide the
// cheapest repair exactly when it is wanted. It changes nothing, so it sits on
// the front of the modal: asking what is wrong must not require entering a
// mode that says you are about to change something.
//
// "Rediscover Endpoints" sits behind Edit for the opposite reason. Applying it
// REPLACES the operations, so one the provider has dropped goes and any agent
// bound to it loses it. That belongs with the other changes a person is
// deciding to make.
//
// What NONE of them does is write into the modal body. Feedback from pressing
// something is a toast here as it is on every other connection modal; the
// inline line this used to carry said the same thing twice and carried the
// verification address, credential parameter and all.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ManageCustomApiConnectionModal from './ManageCustomApiConnectionModal'

const mockUpdate = vi.fn()
const mockReverify = vi.fn()
const mockSpecRefresh = vi.fn()
const mockDeleteConnector = vi.fn()
const mockShowToast = vi.fn()

let mockConnection: Record<string, unknown> | undefined
let mockConnectors: Array<Record<string, unknown>> = []

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
vi.mock('../hooks/useConnectors', () => ({
  useConnectors: () => ({ data: mockConnectors, isPending: false }),
  useDeleteConnector: () => ({ mutateAsync: mockDeleteConnector, isPending: false }),
}))
vi.mock('../hooks/useCustomApiConnection', () => ({
  useCustomApiConnection: () => ({ data: mockConnection, isLoading: false }),
  useUpdateCustomApiConnection: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useReverifyCustomApiConnection: () => ({ mutateAsync: mockReverify, isPending: false }),
  useRefreshCustomApiSpec: () => ({ mutateAsync: mockSpecRefresh, isPending: false }),
}))

function connection(over: Record<string, unknown> = {}) {
  return {
    connectorId: 'conn-1',
    name: 'Acme CRM',
    providerSlug: 'acme-crm',
    baseUrl: 'https://api.acme.example',
    apiHosts: ['api.acme.example'],
    auth: { scheme: 'bearer_header' },
    verification: { method: 'GET', path: '/v1/me' },
    operationCount: 3,
    operations: ['list_deals', 'get_deal', 'create_deal'],
    specDrifted: false,
    specDriftCheckedAt: '2026-09-23T00:00:00.000Z',
    specSourceUrl: 'https://api.acme.example/openapi.json',
    specHash: 'abc',
    specFetchedAt: '2026-09-23T00:00:00.000Z',
    verifiedAt: '2026-09-23T00:00:00.000Z',
    completedByAccountId: 'acct-1',
    updatedAt: '2026-09-23T00:00:00.000Z',
    version: 'v1',
    ...over,
  }
}

function renderModal() {
  return render(
    <ManageCustomApiConnectionModal connectorId="conn-1" displayName="Acme CRM" onClose={vi.fn()} />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConnection = connection()
  mockConnectors = [{ id: 'conn-1', type: 'custom_api_connector', status: 'active' }]
  vi.stubGlobal('confirm', vi.fn(() => true))
})

describe('the three controls', () => {
  it('offers all three, and shows what the connection actually is', async () => {
    renderModal()

    expect(screen.getByRole('button', { name: 'Check Again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    // The mutating one is not on the front of the modal. It is one click in,
    // asserted at the end so these read-only checks see the read-only view.
    expect(screen.queryByRole('button', { name: 'Rediscover Endpoints' })).toBeNull()
    // Removing the key is NOT offered. It revoked the credential and left the
    // connection in place, which is what Disconnect does too, minus the card:
    // two controls a person could not tell apart from their labels.
    expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull()

    expect(screen.getByText('https://api.acme.example')).toBeInTheDocument()
    expect(screen.getByText(/Bearer token in the Authorization header/)).toBeInTheDocument()
    // The endpoints are named, the way a custom MCP server's tools are: a
    // count alone says nothing about what the connection can do.
    expect(screen.getByText('Endpoints (3)')).toBeInTheDocument()
    expect(screen.getByText('list_deals')).toBeInTheDocument()
    expect(screen.getByText('create_deal')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Rediscover Endpoints' })).toBeInTheDocument()
  })

  it('checks again with the key already in custody, asking for nothing', async () => {
    mockReverify.mockResolvedValue({ ok: true })
    renderModal()

    await userEvent.click(screen.getByRole('button', { name: 'Check Again' }))

    expect(mockReverify).toHaveBeenCalledWith('conn-1')
    // Nothing else moved: the key was not asked for and the connection was not
    // rebuilt.
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockDeleteConnector).not.toHaveBeenCalled()
  })

  it('edits hosts and the check in place, keeping the connector id', async () => {
    mockUpdate.mockResolvedValue({ connection: connection(), verification: { ok: true } })
    renderModal()

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const hosts = screen.getByLabelText('Allowed Host')
    await userEvent.clear(hosts)
    await userEvent.type(hosts, 'api.acme.example, api-eu.acme.example')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(mockUpdate).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      changes: { apiHosts: ['api.acme.example', 'api-eu.acme.example'] },
    })
    // The connection was never removed and re-made: that is what "in place"
    // means, and it is what keeps every bound agent working.
    expect(mockDeleteConnector).not.toHaveBeenCalled()
  })

  it('says disconnecting revokes nothing at the provider, at the moment it is disconnected', async () => {
    renderModal()

    // Not standing in the body of the modal, where it was read by nobody and
    // pushed the actions down. It is said in the confirmation, which is the
    // moment a person can still act on it.
    expect(screen.queryByText(/does not revoke it at the provider/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('does not revoke the key at the provider'))
    expect(mockDeleteConnector).toHaveBeenCalledWith('conn-1')
  })

  // Reading the specification again is the only way a connection learns that
  // its provider changed. It is NOT part of Check Again: that call answers
  // whether the key still works, and a key is fine while an API moves.
  describe('reading the provider specification again', () => {
    it('says so and writes nothing when the provider has not changed', async () => {
      mockSpecRefresh.mockResolvedValue({
        changed: false, applied: false, added: [], removed: [], operationCount: 3,
        specHash: 'a', previousSpecHash: 'a',
      })
      renderModal()

      await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

      await userEvent.click(screen.getByRole('button', { name: 'Rediscover Endpoints' }))

      expect(mockSpecRefresh).toHaveBeenCalledTimes(1)
      expect(mockSpecRefresh).toHaveBeenCalledWith({ connectorId: 'conn-1' })
      expect(confirm).not.toHaveBeenCalled()
    })

    it('names what would be lost, and applies nothing until that is accepted', async () => {
      mockSpecRefresh.mockResolvedValue({
        changed: true, applied: false, added: ['get_thing'], removed: ['create_deal'],
        operationCount: 3, specHash: 'b', previousSpecHash: 'a',
      })
      vi.stubGlobal('confirm', vi.fn(() => false))
      renderModal()

      await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

      await userEvent.click(screen.getByRole('button', { name: 'Rediscover Endpoints' }))

      const asked = (confirm as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(asked).toContain('create_deal')
      expect(asked).toContain('get_thing')
      expect(asked).toMatch(/loses them/)
      // Declined, so the second call never happens and the operations stand.
      expect(mockSpecRefresh).toHaveBeenCalledTimes(1)
    })

    it('applies only on the second call, once it has been accepted', async () => {
      mockSpecRefresh
        .mockResolvedValueOnce({
          changed: true, applied: false, added: ['get_thing'], removed: [],
          operationCount: 4, specHash: 'b', previousSpecHash: 'a',
        })
        .mockResolvedValueOnce({
          changed: true, applied: true, added: ['get_thing'], removed: [],
          operationCount: 4, specHash: 'b', previousSpecHash: 'a',
        })
      renderModal()

      await userEvent.click(screen.getByRole('button', { name: 'Edit' }))

      await userEvent.click(screen.getByRole('button', { name: 'Rediscover Endpoints' }))

      expect(mockSpecRefresh).toHaveBeenNthCalledWith(1, { connectorId: 'conn-1' })
      expect(mockSpecRefresh).toHaveBeenNthCalledWith(2, { connectorId: 'conn-1', apply: true })
    })
  })

  // The drifted state is reported on the CARD, as a status beside Connected
  // and Needs Reconnect, not narrated here: a person who opened this modal has
  // already been told. What the modal owes them is the control.
  it('narrates nothing about a moved provider, and applies nothing on open', async () => {
    mockConnection = connection({ specDrifted: true })
    renderModal()

    expect(screen.queryByText(/API has changed/)).toBeNull()
    // The control is still owed, one click in, where the changing things are.
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Rediscover Endpoints' })).toBeInTheDocument()
    expect(mockSpecRefresh).not.toHaveBeenCalled()
  })

  it('keeps every repair available on a connection that is in error', async () => {
    mockConnectors = [{ id: 'conn-1', type: 'custom_api_connector', status: 'error' }]
    renderModal()

    expect(screen.getByText('Needs reconnect')).toBeInTheDocument()
    // The cheapest repair is still right there, and the page says what to do
    // when the key itself is the problem.
    expect(screen.getByRole('button', { name: 'Check Again' })).toBeEnabled()
    expect(screen.getByText(/ask Liftoff for a new connection link/)).toBeInTheDocument()
  })
})

describe('what a failed check says, and where', () => {
  // The defect: the outcome's own message was rendered into the modal body.
  // It is written for diagnosis and carries the verification address with the
  // credential parameter in it, so a person pressing Check Again read
  // "could not be reached at https://api.nasa.gov/planetary/apod?api_key=[REDACTED]"
  // — mechanics, in a product whose rule is that no surface shows a person its
  // inner workings, and in a place no other connection modal puts feedback.
  const UNREACHABLE = {
    ok: false,
    layer: 'unreachable',
    message: 'The provider could not be reached at https://api.acme.example/v1/me?api_key=%5BREDACTED%5D.',
  }

  it('puts the outcome in a toast and writes nothing into the modal', async () => {
    mockReverify.mockResolvedValue(UNREACHABLE)
    const { container } = renderModal()

    await userEvent.click(screen.getByRole('button', { name: 'Check Again' }))

    expect(mockShowToast).toHaveBeenCalledWith('Acme CRM could not be reached.', 'error')
    // Nothing about the check was written into the body.
    expect(container.textContent).not.toContain('could not be reached')
  })

  it('never puts the verification address in front of a person', async () => {
    mockReverify.mockResolvedValue(UNREACHABLE)
    const { container } = renderModal()

    await userEvent.click(screen.getByRole('button', { name: 'Check Again' }))

    const saidToThePerson = [
      container.textContent ?? '',
      ...mockShowToast.mock.calls.map((c) => String(c[0])),
    ].join(' ')
    expect(saidToThePerson).not.toContain('api_key')
    expect(saidToThePerson).not.toContain('REDACTED')
    expect(saidToThePerson).not.toContain('/v1/me')
  })

  it('says which layer answered, so the person knows what to do next', async () => {
    // A 401 is not proof the key is wrong, and the copy must not say it is.
    mockReverify.mockResolvedValue({ ok: false, layer: 'authentication', message: 'raw 401 prose' })
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Check Again' }))
    const [text] = mockShowToast.mock.calls[0]
    expect(text).toContain('did not accept the key')
    expect(text).not.toMatch(/the key is wrong|invalid key/i)

    mockShowToast.mockClear()
    mockReverify.mockResolvedValue({ ok: false, layer: 'rate_limit' })
    await userEvent.click(screen.getByRole('button', { name: 'Check Again' }))
    expect(mockShowToast.mock.calls[0][0]).toContain('rate limiting')
  })

  it('says it plainly when the check passes', async () => {
    mockReverify.mockResolvedValue({ ok: true })
    renderModal()
    await userEvent.click(screen.getByRole('button', { name: 'Check Again' }))
    expect(mockShowToast).toHaveBeenCalledWith('Acme CRM is working', 'success')
  })
})
