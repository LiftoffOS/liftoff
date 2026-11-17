import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import IntegrationsSelector, { type SelectedIntegration } from './IntegrationsSelector'

vi.mock('../components/icons/integrationIconRegistry', () => ({
  getIntegrationIcon: () => null,
}))

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

// Provide a single connected Outlook integration so the modal can be opened.
vi.mock('../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    connected: [
      {
        id: 'c-outlook-1',
        name: 'Outlook Mail',
        type: 'Communications',
        icon: null,
        status: 'connected',
        objectsCovered: ['Emails'],
        connectorType: 'microsoft_outlook_mail',
        connector: {
          id: 'c-outlook-1',
          type: 'microsoft_outlook_mail',
          config: { email: 'user@tenant.onmicrosoft.com' },
        },
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

describe('IntegrationsSelector — Outlook more-options accordion', () => {
  it('renders the more-options panel after selecting an Outlook chip and emits config in the selection', () => {
    let captured: SelectedIntegration[] = []
    const onChange = (s: SelectedIntegration[]) => {
      captured = s
    }

    render(<IntegrationsSelector selected={[]} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /Outlook Mail/i }))

    // Reveal the disclosure before interacting with the inputs.
    fireEvent.click(screen.getByRole('button', { name: /More options/i }))
    expect(screen.getByRole('button', { name: /Hide options/i })).toBeTruthy()

    const filterInput = screen.getByPlaceholderText(/from:work@acme.com/i) as HTMLInputElement
    const sendAsInput = screen.getByPlaceholderText('e.g. amy@acme.com') as HTMLInputElement

    // User types AQS in the UI; we translate to Graph OData for storage.
    act(() => {
      fireEvent.change(filterInput, { target: { value: 'from:a@b.com' } })
      fireEvent.change(sendAsInput, { target: { value: 'support@example.com' } })
    })

    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      id: 'c-outlook-1',
      config: {
        outlookFilter: "from/emailAddress/address eq 'a@b.com'",
        sendAs: 'support@example.com',
      },
    })
  })

  it('clicking a selected Outlook chip deselects it without opening a modal', () => {
    const preExisting: SelectedIntegration[] = [
      {
        id: 'c-outlook-1',
        integrationId: 'microsoft_outlook_mail',
        name: 'Outlook Mail',
        type: 'Communications',
        selectedObjects: [],
        config: {
          outlookFilter: "from/emailAddress/address eq 'a@b.com'",
          sendAs: 'support@example.com',
        },
      },
    ]
    let captured: SelectedIntegration[] = preExisting
    const onChange = (s: SelectedIntegration[]) => {
      captured = s
    }

    render(<IntegrationsSelector selected={preExisting} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Outlook Mail/i }))

    // No modal opened — Confirm button must not exist.
    expect(screen.queryByRole('button', { name: /Confirm/i })).toBeNull()
    expect(captured).toHaveLength(0)
  })
})
