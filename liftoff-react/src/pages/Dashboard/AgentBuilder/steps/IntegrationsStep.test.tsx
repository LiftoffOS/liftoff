// Tests for IntegrationsStep — the Continue gate is deliberately absent.
//
// Binding at least one connector was required here from the original agent-builder
// scaffold, but nothing downstream ever asked for it: the distill and create
// schemas both accept an empty array, the distiller renders "None specified",
// the runtime early-returns on empty bindings, and CompletionStep already hides
// its "Working with" block when there is nothing to show. The template flow
// gates on the template's own requirements and the update page lets you unbind
// everything, so the builder was the only place that blocked a state the rest
// of the product supports. These tests pin that.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import IntegrationsStep from './IntegrationsStep'
import type { SelectedIntegration } from '../../../../components/IntegrationsSelector'

vi.mock('../../../../components/icons/integrationIconRegistry', () => ({
  getIntegrationIcon: () => null,
}))

vi.mock('../../../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../../../../hooks/useIntegrations', () => ({
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

vi.mock('../../../../hooks/useExternalAgents', () => ({
  useExternalAgents: () => ({ data: { agents: [] }, isPending: false }),
}))

vi.mock('../../../../hooks/useInternalAgents', () => ({
  useInternalAgents: () => ({
    data: { pages: [{ internalAgents: [] }] },
    isPending: false,
    fetchNextPage: () => {},
    hasNextPage: false,
  }),
}))

describe('IntegrationsStep — Continue is never gated on a binding', () => {
  it('enables Continue with nothing selected and fires onContinue', () => {
    const onContinue = vi.fn()
    render(<IntegrationsStep selected={[]} onChange={() => {}} onContinue={onContinue} />)

    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).not.toBeDisabled()

    fireEvent.click(button)
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('still enables Continue with a binding selected', () => {
    const selected: SelectedIntegration[] = [
      { id: 'c-gmail-1', integrationId: 'google_mail', name: 'Gmail', type: 'integration', selectedObjects: [] },
    ]
    render(<IntegrationsStep selected={selected} onChange={() => {}} onContinue={() => {}} />)

    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
  })
})
