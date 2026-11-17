import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import IntegrationsSelector, { type SelectedIntegration } from './IntegrationsSelector'

vi.mock('../components/icons/integrationIconRegistry', () => ({
  getIntegrationIcon: () => null,
}))

const showToast = vi.fn()
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}))

beforeEach(() => {
  showToast.mockClear()
})

// Provide a single connected Gmail integration so the modal can be opened.
vi.mock('../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    connected: [
      {
        id: 'c-gmail-1',
        name: 'Gmail',
        type: 'Communications',
        icon: null,
        status: 'connected',
        objectsCovered: ['Email'],
        connectorType: 'google_mail',
        connector: { id: 'c-gmail-1', type: 'google_mail', config: { email: 'h@e.com' } },
      },
    ],
    available: [],
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
    fetchNextPage: () => {},
    hasNextPage: false,
  }),
}))

describe('IntegrationsSelector — Gmail more-options accordion', () => {
  it('renders the more-options panel after selecting a Gmail chip and emits config in the selection', () => {
    let captured: SelectedIntegration[] = []
    const onChange = (s: SelectedIntegration[]) => {
      captured = s
    }

    render(<IntegrationsSelector selected={[]} onChange={onChange} />)

    // Click the Gmail connected chip to open the Select Data modal.
    fireEvent.click(screen.getByRole('button', { name: /Gmail/i }))

    // Disclosure starts collapsed — click "More options" to reveal the accordion.
    fireEvent.click(screen.getByRole('button', { name: /More options/i }))
    expect(screen.getByRole('button', { name: /Hide options/i })).toBeTruthy()

    const queryInput = screen.getByPlaceholderText(/label:work/i) as HTMLInputElement
    const sendAsInput = screen.getByPlaceholderText('e.g. amy@acme.com') as HTMLInputElement

    act(() => {
      fireEvent.change(queryInput, { target: { value: 'label:support-agent' } })
      fireEvent.change(sendAsInput, { target: { value: 'support@example.com' } })
    })

    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      id: 'c-gmail-1',
      config: {
        gmailQuery: 'label:support-agent',
        sendAs: 'support@example.com',
      },
    })
  })

  it('omits config when both fields are blank', () => {
    let captured: SelectedIntegration[] = []
    const onChange = (s: SelectedIntegration[]) => {
      captured = s
    }

    render(<IntegrationsSelector selected={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Gmail/i }))
    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }))

    expect(captured).toHaveLength(1)
    expect(captured[0].config).toBeUndefined()
  })

  // ── Simple toggle ────────────────────────────────────────────────────
  // Clicking an already-selected Gmail chip deselects it immediately — no
  // edit modal, no Remove button. To change options the user removes and
  // re-adds. This matches every other connector's toggle behavior.
  it('clicking a selected Gmail chip deselects it without opening a modal', () => {
    const preExisting: SelectedIntegration[] = [
      {
        id: 'c-gmail-1',
        integrationId: 'google_mail',
        name: 'Gmail',
        type: 'Communications',
        selectedObjects: [],
        config: { gmailQuery: 'label:support-agent', sendAs: 'support@example.com' },
      },
    ]
    let captured: SelectedIntegration[] = preExisting
    const onChange = (s: SelectedIntegration[]) => {
      captured = s
    }

    render(<IntegrationsSelector selected={preExisting} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Gmail/i }))

    // No modal opened — Confirm button must not exist.
    expect(screen.queryByRole('button', { name: /Confirm/i })).toBeNull()
    expect(captured).toHaveLength(0)
  })

  // ── Filter validator ────────────────────────────────────────────────
  // Unsupported filter syntax fires a non-blocking toast on Confirm.
  // The filter still saves; only the event-routing predicate may skip
  // matches. No inline error is rendered.
  it('fires a toast on Confirm when the Gmail filter uses unsupported syntax', () => {
    let captured: SelectedIntegration[] = []
    render(<IntegrationsSelector selected={[]} onChange={(s) => { captured = s }} />)
    fireEvent.click(screen.getByRole('button', { name: /Gmail/i }))
    fireEvent.click(screen.getByRole('button', { name: /More options/i }))

    const queryInput = screen.getByPlaceholderText(/label:work/i) as HTMLInputElement
    act(() => {
      fireEvent.change(queryInput, { target: { value: 'is:unread' } })
    })

    // No inline error text rendered.
    expect(screen.queryByText(/Filter uses syntax outside the supported subset/i)).toBeNull()
    expect(screen.queryByText(/Invalid filter/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }))

    expect(showToast).toHaveBeenCalledWith('Invalid filter. Some matches may be skipped.', 'error')
    // Save still proceeds with the invalid filter — toast is advisory.
    expect(captured).toHaveLength(1)
    expect(captured[0].config).toMatchObject({ gmailQuery: 'is:unread' })
  })

  it('does not fire a toast when the Gmail filter is valid', () => {
    render(<IntegrationsSelector selected={[]} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Gmail/i }))
    fireEvent.click(screen.getByRole('button', { name: /More options/i }))

    const queryInput = screen.getByPlaceholderText(/label:work/i) as HTMLInputElement
    act(() => {
      fireEvent.change(queryInput, { target: { value: 'label:support' } })
    })
    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }))

    expect(showToast).not.toHaveBeenCalled()
  })
})
