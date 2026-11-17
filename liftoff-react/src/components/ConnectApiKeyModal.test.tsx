import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ConnectApiKeyModal from './ConnectApiKeyModal'
import type { Integration } from '../hooks/useIntegrations'

const mockConnect = vi.fn(() => Promise.resolve(true))

function makeHook() {
  return {
    connect: mockConnect,
    connecting: false,
    fetchFieldConfig: vi.fn(),
    fieldConfig: [
      { name: 'tenantHost', label: 'Tenant Host', type: 'text', required: true, placeholder: 'host', step: 0 },
      { name: 'tokenUrl', label: 'Token URL', type: 'text', required: true, placeholder: 'token', step: 0 },
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'id', step: 1 },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'secret', step: 1 },
    ],
    steps: [
      { title: 'Workday instance & endpoints' },
      { title: 'API credentials' },
    ],
    description: null as string | null,
    loadingConfig: false,
    tenantReady: true,
  }
}

let mockHook = makeHook()

vi.mock('../hooks/useApiKeyConnect', () => ({
  useApiKeyConnect: () => mockHook,
}))

const integration = { connectorType: 'workday', name: 'Workday', icon: null } as unknown as Integration

beforeEach(() => {
  mockConnect.mockClear()
  mockHook = makeHook()
})

describe('ConnectApiKeyModal multi-step', () => {
  it('gates step 1 → step 2 and swaps Continue for Save', () => {
    render(<ConnectApiKeyModal integration={integration} onClose={vi.fn()} />)

    // Step 1: title, only step-0 fields, Continue (no Save)
    expect(screen.getByText('Workday instance & endpoints')).toBeTruthy()
    expect(screen.getByLabelText('Tenant Host')).toBeTruthy()
    expect(screen.queryByLabelText('Client ID')).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()

    // Continue with empty required fields is blocked (error shown, still step 1)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Tenant Host is required')).toBeTruthy()
    expect(screen.getByText('Workday instance & endpoints')).toBeTruthy()

    // Fill the required step-1 fields, then Continue advances to step 2
    fireEvent.change(screen.getByLabelText('Tenant Host'), { target: { value: 'https://x.workday.com' } })
    fireEvent.change(screen.getByLabelText('Token URL'), { target: { value: 'https://x/token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // Step 2: step-1 fields, Save (no Continue)
    expect(screen.getByText('API credentials')).toBeTruthy()
    expect(screen.getByLabelText('Client ID')).toBeTruthy()
    expect(screen.queryByLabelText('Tenant Host')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('shows the connector\'s own sentence above the fields when the config carries one, else its own', () => {
    mockHook.steps = null as unknown as typeof mockHook.steps
    mockHook.fieldConfig = [
      { name: 'apiKey', label: 'Service Account Token', type: 'password', required: true, placeholder: 'ops_...' },
    ] as unknown as typeof mockHook.fieldConfig
    mockHook.description = 'Connect a 1Password service account to give your agents the logins in the vault you share with it. Paste your service account token to continue.'
    const onePassword = { connectorType: 'onepassword', name: '1Password', icon: null } as unknown as Integration
    const { unmount } = render(<ConnectApiKeyModal integration={onePassword} onClose={vi.fn()} />)
    expect(screen.getByText(/Paste your service account token to continue/)).toBeTruthy()
    expect(screen.queryByText(/Paste your API key to continue/)).toBeNull()
    expect(screen.getByLabelText('Service Account Token')).toBeTruthy()
    unmount()

    mockHook.description = null
    render(<ConnectApiKeyModal integration={integration} onClose={vi.fn()} />)
    expect(screen.getByText(/Connect your Workday account to give your agents access to this app. Paste your API key to continue./)).toBeTruthy()
  })

  it('renders a single step with Save when the config has no steps', () => {
    mockHook.steps = null as unknown as typeof mockHook.steps
    mockHook.fieldConfig = [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'key' },
    ] as unknown as typeof mockHook.fieldConfig
    render(<ConnectApiKeyModal integration={integration} onClose={vi.fn()} />)
    expect(screen.getByLabelText('API Key')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})
