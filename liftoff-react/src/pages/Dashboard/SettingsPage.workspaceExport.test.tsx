// Settings → Workspace → Export Workspace Data.
//
// The row renders for an owner and an admin and for nobody else; the button
// downloads the archive through the blob helper, names the file the way the
// backend named it, revokes the object URL, and shows the backend's own
// sentence when the export is refused.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ApiError } from '../../services/api'

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
vi.mock('../../hooks/useTenant', () => ({
  useRenameTenant: () => idleMutation(), useWorkspaceAiVendor: () => idleQuery(), useUpdateWorkspaceAiVendor: () => idleMutation(),
  useWorkspaceAiVendorCatalog: () => idleQuery(),
}))
vi.mock('../../services/storage', () => ({ uploadProfilePhoto: vi.fn(), deleteProfilePhotoByUrl: vi.fn() }))
vi.mock('../../lib/pushNotifications', () => ({ getPushPermissionState: () => 'default' }))
vi.mock('./AiProviderKeysSection', () => ({
  default: () => <section className="settings-section"><h2 className="settings-section__title">AI Provider Keys</h2></section>,
}))

const downloadWorkspaceExport = vi.fn()
vi.mock('../../services/tenants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/tenants')>()
  return { ...actual, downloadWorkspaceExport: (...args: unknown[]) => downloadWorkspaceExport(...args) }
})

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

const createObjectURL = vi.fn(() => 'blob:liftoff/export')
const revokeObjectURL = vi.fn()

beforeEach(() => {
  showToast.mockClear()
  track.mockClear()
  downloadWorkspaceExport.mockReset()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  Object.assign(URL, { createObjectURL, revokeObjectURL })
})
afterEach(() => {
  mockRole = 'owner'
})

describe('the Export Workspace Data row', () => {
  it('renders for an owner and an admin with the card copy', () => {
    for (const role of ['owner', 'admin'] as const) {
      mockRole = role
      const { unmount } = renderWorkspaceTab()
      expect(screen.getByRole('heading', { name: 'Export Workspace Data' })).toBeInTheDocument()
      expect(screen.getByText('Export a copy of all the content added to this workspace')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
      unmount()
    }
  })

  it('sits below the AI Provider Keys card', () => {
    renderWorkspaceTab()
    const keys = screen.getByRole('heading', { name: 'AI Provider Keys' })
    const exportRow = screen.getByRole('heading', { name: 'Export Workspace Data' })
    // DOCUMENT_POSITION_FOLLOWING: the export heading comes after the keys heading.
    expect(keys.compareDocumentPosition(exportRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders for nobody else', () => {
    for (const role of ['member', 'viewer'] as const) {
      mockRole = role
      const { unmount } = renderWorkspaceTab()
      expect(screen.queryByRole('heading', { name: 'Export Workspace Data' })).not.toBeInTheDocument()
      unmount()
    }
  })

  it('downloads the archive under the name the backend gave it, and revokes the object URL', async () => {
    const user = userEvent.setup()
    const blob = new Blob(['zip'], { type: 'application/zip' })
    downloadWorkspaceExport.mockResolvedValueOnce({ blob, filename: 'acme-inc-export-2025-01-15.zip' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    renderWorkspaceTab()

    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:liftoff/export'))
    expect(downloadWorkspaceExport).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('acme-inc-export-2025-01-15.zip')
    expect(track).toHaveBeenCalledWith('settings_workspace_export_downloaded', { bytes: 3 })
    expect(showToast).not.toHaveBeenCalled()
    click.mockRestore()
  })

  it("shows the backend's own message when the export is refused, and revokes nothing it never created", async () => {
    const user = userEvent.setup()
    for (const [status, message] of [
      [409, 'An export of this workspace is already in progress'],
      [413, 'The workspace holds more than this export can carry'],
      [429, 'Too many exports; try again later'],
      [503, 'A part of the workspace could not be read; try again shortly'],
    ] as const) {
      downloadWorkspaceExport.mockRejectedValueOnce(new ApiError(message, status, undefined, 'X'))
      const { unmount } = renderWorkspaceTab()
      await user.click(screen.getByRole('button', { name: 'Download' }))
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, 'error'))
      unmount()
      showToast.mockClear()
    }
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalledWith('settings_workspace_export_downloaded', expect.anything())
  })
})
