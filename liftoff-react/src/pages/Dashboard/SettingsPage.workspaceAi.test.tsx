// Settings → Workspace → Workspace AI: the chosen provider's models and coding
// tool as chips.
//
// They show only while the card is being edited, follow the dropdown before
// anything is saved, and never appear for Liftoff Managed, whose models are
// not shown.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { within } from '@testing-library/react'

let mockRole: 'owner' | 'admin' | 'member' | 'viewer' = 'owner'
// One stable object: the page's effects depend on these function identities,
// and a fresh vi.fn() per render would rerun them forever.
const AUTH = {
  canManageMembers: () => mockRole === 'owner' || mockRole === 'admin',
  get currentRole() { return mockRole },
  currentTenant: { id: '11111111-1111-4111-8111-111111111111', name: 'Liftoff OS, Inc.' },
  account: { id: 'acc-1', email: 'person@example.com', firstName: 'Alex', lastName: 'Rivera', timezone: 'UTC', preferences: {} },
  user: { uid: 'u', email: 'person@example.com', providerData: [] },
  registerPasskey: vi.fn(), removePasskey: vi.fn(), getPasskeys: vi.fn(async () => []),
  isPasskeySupported: () => false, isPlatformAuthenticatorAvailable: async () => false,
  changePassword: vi.fn(), setupTotpMfa: vi.fn(), completeTotpEnrollment: vi.fn(), disableTotpMfa: vi.fn(),
  getTotpEnrollmentStatus: vi.fn(async () => ({ enrolled: false })), refreshAccount: vi.fn(), signOut: vi.fn(),
}
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => AUTH }))
const showToast = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }))
const track = vi.fn()
vi.mock('../../lib/analytics', () => ({ track: (...args: unknown[]) => track(...args) }))

// Stable objects: a hook that returned a fresh object on every render would
// retrigger every effect that depends on it and loop the page.
const IDLE_MUTATION = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, variables: undefined }
const IDLE_QUERY = { data: undefined, isLoading: false, isFetching: false, isError: false, error: null, refetch: vi.fn(async () => ({ data: undefined })) }
const idleMutation = () => IDLE_MUTATION
const idleQuery = () => IDLE_QUERY
const MEMBERS = { data: { pages: [{ members: [] }] }, isLoading: false, error: null }
const INVITATIONS = { data: [], isLoading: false, error: null }
vi.mock('../../hooks/useAccount', () => ({
  useUpdateAccount: () => idleMutation(), useInitiateEmailChange: () => idleMutation(),
  useCancelEmailChange: () => idleMutation(), useDeletionPreflight: () => idleQuery(),
}))
vi.mock('../../hooks/useBrowserNotifications', () => ({
  useEnableBrowserNotifications: () => idleMutation(), useDisableBrowserNotifications: () => idleMutation(),
}))
vi.mock('../../hooks/useTenantMembers', () => ({
  useTenantMembers: () => MEMBERS,
  useTenantInvitations: () => INVITATIONS,
  useInviteMember: () => idleMutation(), useRemoveMember: () => idleMutation(), useUpdateMemberRole: () => idleMutation(),
  useRevokeInvitation: () => idleMutation(), useUpdateInvitationRole: () => idleMutation(),
}))
vi.mock('../../hooks/useBilling', () => ({
  useInvoices: () => idleQuery(), useCurrentUsage: () => idleQuery(), usePaymentMethods: () => idleQuery(),
  useActiveSubscription: () => idleQuery(), useAutoReload: () => idleQuery(), useCancelSubscription: () => idleMutation(),
  useBillingOverview: () => idleQuery(),
}))
// The saved provider is Anthropic. The models read reports whether the editor
// asked for it, so the test can hold it to "only while editing".
const SAVED_VENDOR = { data: 'anthropic', isLoading: false }
const CATALOG = {
  models: {
    anthropic: ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5'],
    // Astra is Frontier and the large tier; a repeat must still be one chip.
    openai: ['GPT-6 Astra', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna'],
    qwen: ['Qwen 3.8 Max', 'Qwen 3.7 Plus', 'Qwen 3.7 Flash'],
  },
  coding: {
    anthropic: { tool: 'Claude Code' },
    openai: { tool: 'Codex' },
    qwen: { tool: 'OpenCode', model: 'Qwen 3.8 Max' },
  },
}
const modelsRequested = vi.fn()
vi.mock('../../hooks/useTenant', () => ({
  useRenameTenant: () => idleMutation(),
  useWorkspaceAiVendor: () => SAVED_VENDOR,
  useUpdateWorkspaceAiVendor: () => idleMutation(),
  useWorkspaceAiVendorCatalog: (_tenantId: string | undefined, enabled: boolean) => {
    modelsRequested(enabled)
    return { data: enabled ? CATALOG : undefined }
  },
}))
vi.mock('../../services/storage', () => ({ uploadProfilePhoto: vi.fn(), deleteProfilePhotoByUrl: vi.fn() }))
vi.mock('../../lib/pushNotifications', () => ({ getPushPermissionState: () => 'default' }))
vi.mock('./AiProviderKeysSection', () => ({
  default: () => <section className="settings-section"><h2 className="settings-section__title">AI Provider Keys</h2></section>,
}))

import SettingsPage from './SettingsPage'

function renderWorkspaceTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dashboard/settings/workspace']}>
        <Routes>
          <Route path="/dashboard/settings/:tab" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function workspaceAiCard() {
  return screen.getByRole('heading', { name: 'Workspace AI' }).closest('section') as HTMLElement
}

function chips(group: 'Models' | 'Coding' = 'Models') {
  const list = within(workspaceAiCard()).queryByRole('list', { name: group })
  return list ? within(list).getAllByRole('listitem').map((li) => li.textContent) : []
}

async function choose(user: ReturnType<typeof userEvent.setup>, provider: string) {
  await user.click(within(workspaceAiCard()).getByRole('button', { name: /Anthropic|OpenAI|Qwen|Liftoff Managed/ }))
  await user.click(screen.getByRole('option', { name: new RegExp(`^${provider}`) }))
}

beforeEach(() => {
  // jsdom has no scrollIntoView; the Dropdown calls it on the focused option.
  Element.prototype.scrollIntoView = vi.fn()
  modelsRequested.mockClear()
  mockRole = 'owner'
})
afterEach(() => {
  mockRole = 'owner'
})

describe('the Workspace AI model chips', () => {
  it('are not shown, or even read, while the card is at rest', () => {
    renderWorkspaceTab()
    expect(chips()).toEqual([])
    expect(chips('Coding')).toEqual([])
    expect(modelsRequested).toHaveBeenCalled()
    expect(modelsRequested.mock.calls.every(([enabled]) => enabled === false)).toBe(true)
  })

  it('show the saved provider\'s models once the card is being edited', async () => {
    const user = userEvent.setup()
    renderWorkspaceTab()
    await user.click(within(workspaceAiCard()).getByRole('button', { name: 'Edit' }))
    expect(chips()).toEqual(['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5'])
    expect(chips('Coding')).toEqual(['Claude Code'])
  })

  it('show the coding model beside the tool where Liftoff picks it', async () => {
    const user = userEvent.setup()
    renderWorkspaceTab()
    await user.click(within(workspaceAiCard()).getByRole('button', { name: 'Edit' }))
    await choose(user, 'Qwen')
    expect(chips('Coding')).toEqual(['OpenCode', 'Qwen 3.8 Max'])
  })

  it('follow the dropdown, and show none for Liftoff Managed', async () => {
    const user = userEvent.setup()
    renderWorkspaceTab()
    await user.click(within(workspaceAiCard()).getByRole('button', { name: 'Edit' }))
    await choose(user, 'OpenAI')
    expect(chips()).toEqual(['GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna'])
    expect(chips('Coding')).toEqual(['Codex'])
    await choose(user, 'Liftoff Managed')
    expect(chips()).toEqual([])
    expect(chips('Coding')).toEqual([])
  })

  it('go away when the edit is cancelled', async () => {
    const user = userEvent.setup()
    renderWorkspaceTab()
    await user.click(within(workspaceAiCard()).getByRole('button', { name: 'Edit' }))
    await user.click(within(workspaceAiCard()).getByRole('button', { name: 'Cancel' }))
    expect(chips()).toEqual([])
    expect(chips('Coding')).toEqual([])
  })
})
