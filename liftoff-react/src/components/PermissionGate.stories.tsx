// NOTE: PermissionGate reads currentRole from AuthContext via useAuth.
// These stories wrap the component in a minimal AuthContext.Provider with a
// mocked value so no Firebase/backend connection is required.

import type { Meta, StoryObj } from '@storybook/react'
import { PermissionGate } from './PermissionGate'
import { AuthContext, type AuthContextType } from '../contexts/AuthContext'
import { mockAuthValue } from '../../.storybook/authFixture'
import type { TenantRole } from '../contexts/AuthContext'

function makeAuthValue(role: TenantRole | null): AuthContextType {
  const privileged = role === 'owner' || role === 'admin'
  return {
    ...mockAuthValue,
    user: null,
    account: null,
    tenants: [],
    currentTenant: null,
    currentRole: role,
    canManageMembers: () => privileged,
    canInviteMembers: () => privileged,
    canManageSettings: () => privileged,
    isOwner: () => role === 'owner',
  }
}

const ProtectedContent = () => (
  <div style={{ padding: '1rem', background: '#d1fae5', borderRadius: '8px', color: '#065f46' }}>
    Protected content — visible to authorized roles only.
  </div>
)

const FallbackContent = () => (
  <div style={{ padding: '1rem', background: '#fee2e2', borderRadius: '8px', color: '#991b1b' }}>
    Access denied fallback.
  </div>
)

const meta: Meta<typeof PermissionGate> = {
  title: 'Components/PermissionGate',
  component: PermissionGate,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof PermissionGate>

export const OwnerCanManageMembers: Story = {
  render: () => (
    <AuthContext.Provider value={makeAuthValue('owner')}>
      <PermissionGate permission="manage_members" fallback={<FallbackContent />}>
        <ProtectedContent />
      </PermissionGate>
    </AuthContext.Provider>
  ),
}

export const ViewerCannotManageMembers: Story = {
  render: () => (
    <AuthContext.Provider value={makeAuthValue('viewer')}>
      <PermissionGate permission="manage_members" fallback={<FallbackContent />}>
        <ProtectedContent />
      </PermissionGate>
    </AuthContext.Provider>
  ),
}

export const MemberCanEditTeams: Story = {
  render: () => (
    <AuthContext.Provider value={makeAuthValue('member')}>
      <PermissionGate permission="edit_teams" fallback={<FallbackContent />}>
        <ProtectedContent />
      </PermissionGate>
    </AuthContext.Provider>
  ),
}

export const NoRoleShowsFallback: Story = {
  render: () => (
    <AuthContext.Provider value={makeAuthValue(null)}>
      <PermissionGate permission="view_teams" fallback={<FallbackContent />}>
        <ProtectedContent />
      </PermissionGate>
    </AuthContext.Provider>
  ),
}

export const NoFallback: Story = {
  render: () => (
    <AuthContext.Provider value={makeAuthValue('viewer')}>
      <div style={{ padding: '1rem' }}>
        <p style={{ marginBottom: '0.5rem' }}>Below this text, nothing should render (no fallback):</p>
        <PermissionGate permission="manage_members">
          <ProtectedContent />
        </PermissionGate>
      </div>
    </AuthContext.Provider>
  ),
}
