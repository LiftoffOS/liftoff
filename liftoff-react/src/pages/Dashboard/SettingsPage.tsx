import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams, useParams } from 'react-router'
import { track } from '../../lib/analytics'
import { Button, DateRangeInput, Dropdown, SegmentedControl, Toggle } from '../../components'
import { useAuth, type StoredPasskey, type TotpSecret } from '../../contexts/AuthContext'
import { displayIdentity } from '../../lib/displayIdentity'
import { EmailAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup, GoogleAuthProvider } from 'firebase/auth'
import { QRCodeSVG } from 'qrcode.react'
import { useToast } from '../../contexts/ToastContext'
import { useUpdateAccount, useInitiateEmailChange, useCancelEmailChange, useDeletionPreflight } from '../../hooks/useAccount'
import DeleteAccountModal from '../../components/DeleteAccountModal'
import AiProviderKeysSection from './AiProviderKeysSection'
import type { NotificationTypes, NotificationDelivery } from '../../services/account'
import { revokeAllSessions } from '../../services/account'
import { getPushPermissionState, type PushPermissionState } from '../../lib/pushNotifications'
import { useEnableBrowserNotifications, useDisableBrowserNotifications } from '../../hooks/useBrowserNotifications'
import {
  notificationTypeValue as readNotificationType,
  deliveryValue as readDelivery,
  withNotificationTypeToggled,
  withDeliveryToggled,
  DEFAULT_NOTIFICATION_TYPES,
  DEFAULT_NOTIFICATION_DELIVERY,
} from './notificationPreferences'
import { useTenantMembers, useTenantInvitations, useInviteMember, useRemoveMember, useUpdateMemberRole, useRevokeInvitation, useUpdateInvitationRole } from '../../hooks/useTenantMembers'
import { TENANT_ROLES, type TenantRole, getAuditEntries, reportAuditExportCompleted, downloadWorkspaceExport, type AuditEntry } from '../../services/tenants'
import { ApiError } from '../../services/api'
import { useInvoices, useCurrentUsage, usePaymentMethods, useActiveSubscription, useAutoReload, useCancelSubscription, useBillingOverview } from '../../hooks/useBilling'
import PaymentUpdateModal from '../../components/PaymentUpdateModal'
import AutoReloadModal from '../../components/AutoReloadModal'
import AddCreditModal from '../../components/AddCreditModal'
import ModalOverlay from '../../components/ModalOverlay'
import ModalActions from '../../components/ModalActions/ModalActions'
import { deleteProfilePhotoByUrl, uploadProfilePhoto } from '../../services/storage'
import XIcon from '../../assets/icons/x.svg?react'
import ImageIcon from '../../assets/icons/image.svg?react'
import PersonIcon from '../../assets/icons/person.svg?react'
import EyeIcon from '../../assets/icons/eye.svg?react'
import LockIcon from '../../assets/icons/lock.svg?react'
import ReceiptTextIcon from '../../assets/icons/receipt-text.svg?react'
import { useRenameTenant, useWorkspaceAiVendor, useWorkspaceAiVendorCatalog, useUpdateWorkspaceAiVendor } from '../../hooks/useTenant'
import WorkspaceAiModelGroups from '../../components/WorkspaceAiModelGroups'
import type { WorkspaceAiVendor } from '../../services/tenants'
import { WORKSPACE_AI_OPTIONS } from '../../constants/workspaceAi'
import CopyIcon from '../../assets/icons/copy.svg?react'
import { getInitialsFromName } from '../../utils/avatar'
import './SettingsPage.css'
import { useAutoFocus } from '../../hooks/useAutoFocus'

/** MM/DD/YYYY, the format both date inputs on this page read and write. At
 *  module scope so the state initialisers below can call it: they run during
 *  the first render, before anything declared in the component body exists. */
function toMmDdYyyy(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}/${day}/${date.getFullYear()}`
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

type SettingsTab = 'profile' | 'security' | 'communication' | 'billing' | 'account' | 'workspace'
type NotificationFrequency = 'realtime' | 'daily' | 'weekly' | 'none'

const BASE_SETTINGS_TABS: { value: SettingsTab; label: string }[] = [
  { value: 'profile', label: 'Profile' },
  { value: 'security', label: 'Security' },
  { value: 'communication', label: 'Communication' },
  { value: 'billing', label: 'Billing' },
  { value: 'account', label: 'Account' },
]

const WORKSPACE_TAB: { value: SettingsTab; label: string } = { value: 'workspace', label: 'Workspace' }

const notificationFrequencyLabels: Record<NotificationFrequency, string> = {
  realtime: 'Real-time',
  daily: 'Daily digest',
  weekly: 'Weekly digest',
  none: 'None',
}

const notificationFrequencyDescriptions: Record<NotificationFrequency, string> = {
  realtime: 'Get notified immediately when something happens',
  daily: 'Get a daily summary of all activity. Escalations and approvals arrive immediately.',
  weekly: 'Get a weekly summary of all activity. Escalations and approvals arrive immediately.',
  none: 'Do not send email notifications.',
}

const notificationTypeLabels: Record<keyof Required<NotificationTypes>, string> = {
  taskUpdates: 'Task updates',
  teamActivity: 'Team activity',
  escalations: 'Escalations and approvals',
  weeklyDigest: 'Weekly performance digest',
}

const timezones = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
]

const deliveryLabels: Record<keyof Required<NotificationDelivery>, string> = {
  email: 'Email',
  browser: 'This browser',
}

// Workspace Tab Content Component
interface WorkspaceTabContentProps {
  tenantId: string | undefined
  currentAccountId: string | undefined
  currentRole: TenantRole | null
  isManaging: boolean
  onStartManaging: () => void
  onStopManaging: () => void
}

function WorkspaceTabContent({ tenantId, currentAccountId, currentRole, isManaging, onStartManaging, onStopManaging }: WorkspaceTabContentProps) {
  const { showToast } = useToast()

  // Fetch members and invitations
  const { data: membersData, isLoading: membersLoading, error: membersError } = useTenantMembers(tenantId)
  const { data: invitations, isLoading: invitationsLoading, error: invitationsError } = useTenantInvitations(tenantId)

  // Mutations
  const inviteMutation = useInviteMember()
  const removeMutation = useRemoveMember()
  const updateRoleMutation = useUpdateMemberRole()
  const updateInvitationRoleMutation = useUpdateInvitationRole()
  const revokeMutation = useRevokeInvitation()

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<TenantRole>('member')

  // Flatten paginated members
  const members = membersData?.pages.flatMap(page => page.members) ?? []
  const pendingInvitations = invitations?.filter(inv => inv.status === 'pending') ?? []

  const handleInvite = async () => {
    if (!tenantId || !inviteEmail.trim()) return

    try {
      await inviteMutation.mutateAsync({ tenantId, email: inviteEmail.trim(), role: inviteRole })
      track('settings_workspace_member_invited', { tenant_id: tenantId, role: inviteRole })
      setInviteEmail('')
      setInviteRole('member')
      showToast('Invitation sent', 'success')
    } catch (err) {
      const error = err as Error
      if (error.message?.includes('already')) {
        showToast('This email has already been invited or is already a member', 'error')
      } else {
        showToast('Failed to send invitation', 'error')
      }
    }
  }

  const handleRemoveMember = async (accountId: string) => {
    if (!tenantId) return

    try {
      await removeMutation.mutateAsync({ tenantId, memberId: accountId })
      track('settings_workspace_member_removed', { tenant_id: tenantId })
      showToast('Member removed', 'success')
    } catch {
      showToast('Failed to remove member', 'error')
    }
  }

  const handleRoleChange = async (accountId: string, newRole: TenantRole) => {
    if (!tenantId) return

    try {
      await updateRoleMutation.mutateAsync({ tenantId, memberId: accountId, role: newRole })
      track('settings_workspace_member_role_changed', { tenant_id: tenantId, new_role: newRole })
      showToast('Role updated', 'success')
    } catch {
      showToast('Failed to update role', 'error')
    }
  }

  const handleInvitationRoleChange = async (invitationId: string, newRole: TenantRole) => {
    if (!tenantId) return

    try {
      await updateInvitationRoleMutation.mutateAsync({ tenantId, invitationId, role: newRole })
      track('settings_workspace_invitation_role_changed', { tenant_id: tenantId, new_role: newRole })
      showToast('Role updated', 'success')
    } catch {
      showToast('Failed to update role', 'error')
    }
  }

  const handleRevokeInvitation = async (invitationId: string) => {
    if (!tenantId) return

    try {
      await revokeMutation.mutateAsync({ tenantId, invitationId })
      track('settings_workspace_invitation_revoked', { tenant_id: tenantId })
      showToast('Invitation canceled', 'success')
    } catch (err) {
      console.error('Failed to revoke invitation:', err)
      showToast('Failed to cancel invitation', 'error')
    }
  }

  const isOwner = currentRole === 'owner'
  const isLoading = membersLoading || invitationsLoading
  const hasError = membersError || invitationsError

  useEffect(() => {
    if (hasError) {
      showToast('Unable to load workspace members.\nPlease try again.', 'error')
    }
  }, [hasError, showToast])

  // Basic email validation
  const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

  // Summary text for collapsed view
  const getSummaryText = () => {
    if (isLoading) return 'Loading...'
    if (hasError) return 'Error loading'
    if (members.length === 0) return 'No members'
    const memberText = members.length === 1 ? '1 member' : `${members.length} members`
    if (pendingInvitations.length > 0) {
      return `${memberText}, ${pendingInvitations.length} pending`
    }
    return memberText
  }

  return (
    <section className="settings-section">
      {isManaging ? (
        <div className="settings-section__edit-block">
          <div className="settings-section__header">
            <h2 className="settings-section__title">Workspace Members</h2>
            <p className="settings-section__helper">Manage who has access to this workspace</p>
          </div>

          {isLoading && (
            <div className="settings-loading">
              <div className="loading-spinner" role="status" aria-label="Loading workspace members" />
            </div>
          )}

          {!isLoading && !hasError && (
            <>
              {/* Combined list of members and pending invitations */}
              <div className="settings-members-list">
                {/* Active members */}
                {members.map((member) => {
                  const isCurrentUser = member.accountId === currentAccountId
                  const isMemberOwner = member.role === 'owner'
                  const canRemove = isOwner && !isMemberOwner && !isCurrentUser

                  return (
                    <div key={member.id} className="settings-member-row">
                      <div className="settings-member-row__email">
                        {member.account.email}
                        {isCurrentUser && <span className="settings-member-row__you">(you)</span>}
                      </div>
                      <div className="settings-member-row__role">
                        {isOwner && !isCurrentUser ? (
                          <Dropdown
                            value={member.role}
                            onChange={(value) => handleRoleChange(member.accountId, value as TenantRole)}
                            disabled={updateRoleMutation.isPending}
                            options={TENANT_ROLES.map(role => ({
                              value: role,
                              label: role.charAt(0).toUpperCase() + role.slice(1),
                            }))}
                          />
                        ) : (
                          <span className="settings-member-row__role-text">{member.role}</span>
                        )}
                      </div>
                      <div className="settings-member-row__action">
                        {canRemove && (
                          <button
                            className="settings-member-row__remove"
                            onClick={() => handleRemoveMember(member.accountId)}
                            disabled={removeMutation.isPending}
                            title="Remove member"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}

                {/* Pending invitations */}
                {pendingInvitations.map((invitation) => (
                  <div key={invitation.id} className="settings-member-row settings-member-row--pending">
                    <div className="settings-member-row__email">
                      {invitation.email}
                      <span className="settings-member-row__invite-status">(pending)</span>
                    </div>
                    <div className="settings-member-row__role">
                      <Dropdown
                        value={invitation.role}
                        onChange={(value) => handleInvitationRoleChange(invitation.id, value as TenantRole)}
                        disabled={updateInvitationRoleMutation.isPending}
                        options={TENANT_ROLES.filter(r => r !== 'owner').map(role => ({
                          value: role,
                          label: role.charAt(0).toUpperCase() + role.slice(1),
                        }))}
                      />
                    </div>
                    <div className="settings-member-row__action">
                      <button
                        className="settings-member-row__remove"
                        onClick={() => handleRevokeInvitation(invitation.id)}
                        disabled={revokeMutation.isPending}
                        title="Cancel invitation"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}

                {members.length === 0 && pendingInvitations.length === 0 && (
                  <p className="settings-section__placeholder">No workspace members yet.</p>
                )}

                {/* Invite form - inline as last row */}
                <div className="settings-member-invite">
                  <input
                    type="email"
                    className="settings-member-invite__email"
                    placeholder="colleague@company.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !inviteMutation.isPending && isValidEmail(inviteEmail) && handleInvite()}
                  />
                  <Dropdown
                    value={inviteRole}
                    onChange={(value) => setInviteRole(value as TenantRole)}
                    options={TENANT_ROLES.filter(r => r !== 'owner').map(role => ({
                      value: role,
                      label: role.charAt(0).toUpperCase() + role.slice(1),
                    }))}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleInvite}
                    disabled={inviteMutation.isPending || !isValidEmail(inviteEmail)}
                  >
                    {inviteMutation.isPending ? 'Sending...' : 'Send Invite'}
                  </Button>
                </div>
              </div>
            </>
          )}

          <div className="settings-section__actions">
            <Button variant="outline" size="sm" onClick={onStopManaging}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="settings-section__row">
          <div className="settings-section__left">
            <h2 className="settings-section__title">Workspace Members</h2>
            <p className="settings-section__helper">Manage who has access to this workspace.</p>
          </div>
          <div className="settings-section__right">
            <span className="settings-section__value">{getSummaryText()}</span>
            <Button variant="outline" size="sm" onClick={() => {
              track('settings_workspace_manage_clicked', {})
              onStartManaging()
            }}>Manage</Button>
          </div>
        </div>
      )}
    </section>
  )
}

// Workspace Name Section Component — Edit-button pattern matching the
// Profile-tab Name section.  Rename flows through useRenameTenant ->
// refreshTenants() so the sidebar workspace switcher updates immediately.
// Keep in sync with WORKSPACE_NAME_MAX in OnboardingPage.tsx; the backend
// validator allows up to 100, but we cap UX at 30 in both places so the
// workspace switcher in the sidebar stays compact.
const WORKSPACE_NAME_MAX = 30

interface WorkspaceNameSectionProps {
  tenantId: string | undefined
  currentName: string | undefined
}

function WorkspaceNameSection({ tenantId, currentName }: WorkspaceNameSectionProps) {
  const nameRef = useAutoFocus<HTMLInputElement>()
  const { showToast } = useToast()
  const { mutateAsync: doRename, isPending } = useRenameTenant()
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(currentName ?? '')

  // The draft is seeded where editing BEGINS, not kept in step by an effect.
  // It is only ever rendered inside the isEditing branch, so there is nothing
  // to keep in step while the row is closed, and the effect that did it fired
  // on every tenant load to write a value nobody could see.

  const trimmed = draft.trim()
  const canSave = !!tenantId && trimmed.length > 0 && trimmed !== currentName && !isPending

  const handleSave = async () => {
    if (!tenantId || !canSave) return
    try {
      await doRename({ tenantId, name: trimmed })
      track('settings_workspace_name_saved', { tenant_id: tenantId })
      showToast('Workspace name updated', 'success')
      setIsEditing(false)
    } catch {
      showToast('Could not save workspace name. Please try again.', 'error')
    }
  }

  const handleCancel = () => {
    setDraft(currentName ?? '')
    setIsEditing(false)
  }

  return (
    <section className="settings-section">
      {isEditing ? (
        <div className="settings-section__edit-block">
          <div className="settings-section__header">
            <h2 className="settings-section__title">Workspace Name</h2>
            <p className="settings-section__helper">Shown in the sidebar workspace switcher and on invitations.</p>
          </div>
          <div className="settings-form">
            <div className="settings-form__row settings-form__row--with-count">
              <input
                id="workspace-name-input"
                type="text"
                className="settings-form__input settings-form__input--with-count"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={WORKSPACE_NAME_MAX}
                ref={nameRef}
              />
              <span className="settings-form__count" aria-hidden="true">
                {draft.length}/{WORKSPACE_NAME_MAX}
              </span>
            </div>
          </div>
          <div className="settings-section__actions">
            <Button variant="outline" size="sm" onClick={handleCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={!canSave} loading={isPending}>
              {isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="settings-section__row">
          <div className="settings-section__left">
            <h2 className="settings-section__title">Workspace Name</h2>
            <p className="settings-section__helper">Shown in the sidebar workspace switcher and on invitations.</p>
          </div>
          <div className="settings-section__right">
            <span className="settings-section__value">{currentName ?? '—'}</span>
            <Button variant="outline" size="sm" onClick={() => { setDraft(currentName ?? ''); setIsEditing(true) }}>Edit</Button>
          </div>
        </div>
      )}
    </section>
  )
}

// Workspace AI Section Component — same Edit-button pattern as Workspace Name,
// with the shared Dropdown in place of the text input. The selection is SERVER
// state (the workspace's model routing policy, read/written via the tenant
// API), so every admin on every browser sees the same committed value.
// The option list itself lives in constants/workspaceAi so the per-AI-team
// override card on AgentUpdatePage can share it without importing this page.
const WORKSPACE_AI_DEFAULT: WorkspaceAiVendor = 'default'

// Re-exported so existing importers of this symbol keep working.
export { WORKSPACE_AI_OPTIONS }

interface WorkspaceAiSectionProps {
  tenantId: string | undefined
}

function WorkspaceAiSection({ tenantId }: WorkspaceAiSectionProps) {
  const { showToast } = useToast()
  const navigate = useNavigate()
  const [isEditing, setIsEditing] = useState(false)
  const { data: vendor, isLoading: vendorLoading } = useWorkspaceAiVendor(tenantId)
  const provider = vendor ?? WORKSPACE_AI_DEFAULT
  const [draft, setDraft] = useState<WorkspaceAiVendor>(provider)
  const { mutateAsync: doUpdateVendor, isPending } = useUpdateWorkspaceAiVendor()
  // The chips follow the dropdown, so they show the provider being considered
  // before it is saved. Liftoff Managed has none: what it routes to is not shown.
  const { data: catalog } = useWorkspaceAiVendorCatalog(tenantId, isEditing)

  // Seeded where editing begins, as in WorkspaceNameSection above.
  //
  // Switching workspace closes the editor. Compared during render rather than
  // in an effect: an effect would let one frame paint with the previous
  // workspace's editor still open before closing it.
  const [editorTenantId, setEditorTenantId] = useState(tenantId)
  if (tenantId !== editorTenantId) {
    setEditorTenantId(tenantId)
    setIsEditing(false)
  }

  // '—' until the committed server value arrives — mirrors WorkspaceNameSection's
  // `{currentName ?? '—'}` so the card never briefly claims a value it has not read.
  const selectedLabel = vendorLoading
    ? '—'
    : (WORKSPACE_AI_OPTIONS.find(opt => opt.value === provider)?.label ?? 'Liftoff Managed')
  const canSave = !!tenantId && draft !== provider && !isPending && !vendorLoading

  const handleSave = async () => {
    if (!tenantId || !canSave) return
    try {
      await doUpdateVendor({ tenantId, vendor: draft })
      track('settings_workspace_ai_saved', { tenant_id: tenantId, provider: draft })
      showToast('Workspace AI updated', 'success')
      setIsEditing(false)
    } catch {
      showToast('Could not update Workspace AI. Please try again.', 'error')
    }
  }

  const handleCancel = () => {
    setDraft(provider)
    setIsEditing(false)
  }

  return (
    <section className="settings-section">
      {isEditing ? (
        <div className="settings-section__edit-block">
          <div className="settings-section__header">
            <h2 className="settings-section__title">Workspace AI</h2>
            <p className="settings-section__helper">Choose the AI provider your agents prioritize</p>
          </div>
          <div className="settings-form">
            <div className="settings-form__row settings-form__row--inline">
              <Dropdown
                options={WORKSPACE_AI_OPTIONS}
                value={draft}
                onChange={(value) => setDraft(value as WorkspaceAiVendor)}
              />
              <button
                type="button"
                className="settings-section__link"
                onClick={() => navigate('/dashboard/support/settings/ai-providers')}
              >
                Learn More
              </button>
            </div>
            <WorkspaceAiModelGroups vendor={draft} catalog={catalog} />
          </div>
          <div className="settings-section__actions">
            <Button variant="outline" size="sm" onClick={handleCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={!canSave} loading={isPending}>
              {isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="settings-section__row">
          <div className="settings-section__left">
            <h2 className="settings-section__title">Workspace AI</h2>
            <p className="settings-section__helper">Choose the AI provider your agents prioritize</p>
          </div>
          <div className="settings-section__right">
            <span className="settings-section__value">{selectedLabel}</span>
            <Button variant="outline" size="sm" onClick={() => { setDraft(provider); setIsEditing(true) }}>Edit</Button>
          </div>
        </div>
      )}
    </section>
  )
}

// Audit Logs Section Component
interface AuditLogsSectionProps {
  tenantId: string | undefined
}

function AuditLogsSection({ tenantId }: AuditLogsSectionProps) {
  const { showToast } = useToast()
  const [isExpanded, setIsExpanded] = useState(false)
  // Seeded here, not by a mount effect. The effect version rendered two empty
  // date inputs on the first frame and filled them on the second.
  const [startDateInput, setStartDateInput] = useState(() => toMmDdYyyy(daysAgo(30)))
  const [endDateInput, setEndDateInput] = useState(() => toMmDdYyyy(new Date()))
  const [isDownloading, setIsDownloading] = useState(false)

  // Format date as MM/DD/YYYY

  // Parse MM/DD/YYYY to Date
  const parseDate = (str: string): Date | null => {
    const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (!match) return null
    const [, month, day, year] = match
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
    if (isNaN(date.getTime())) return null
    return date
  }


  // Client-side validation
  const validateDates = (): string | null => {
    if (!startDateInput || !endDateInput) return 'Please enter both dates'
    const start = parseDate(startDateInput)
    const end = parseDate(endDateInput)
    if (!start || !end) return 'Invalid date format (MM/DD/YYYY)'
    if (start > end) return 'Start date must be before end date'
    const days = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
    if (days > 90) return 'Date range cannot exceed 90 days'
    const endOfToday = new Date()
    endOfToday.setHours(23, 59, 59, 999)
    if (end > endOfToday) return 'End date cannot be in the future'
    return null
  }

  const validationError = validateDates()
  const isValid = !validationError && tenantId

  const handleDownload = async () => {
    if (!isValid) return

    setIsDownloading(true)

    try {
      // Fetch all pages
      const allEntries: AuditEntry[] = []
      let cursor: string | undefined
      const startDate = parseDate(startDateInput)!
      const endDate = parseDate(endDateInput)!
      // End of selected day, but never beyond now — backend rejects future timestamps.
      const endOfDay = endDate.getTime() + 86399999
      const effectiveEnd = new Date(Math.min(endOfDay, Date.now()))

      do {
        const response = await getAuditEntries(
          tenantId!,
          startDate.toISOString(),
          effectiveEnd.toISOString(),
          cursor
        )
        allEntries.push(...response.entries)
        cursor = response.nextCursor ?? undefined
      } while (cursor && allEntries.length < 5000)  // Safety cap

      if (allEntries.length === 0) {
        showToast('No audit entries found for this date range', 'error')
        return
      }

      // Convert to CSV with proper escaping
      const headers = ['Timestamp', 'Action', 'Actor ID', 'Account ID', 'Previous State', 'New State']
      const escapeCSV = (val: string) => `"${String(val).replace(/"/g, '""')}"`

      const rows = allEntries.map(entry => [
        escapeCSV(new Date(entry.createdAt).toISOString()),
        escapeCSV(entry.action),
        escapeCSV(entry.actorId || ''),
        escapeCSV(entry.accountId || ''),
        escapeCSV(entry.previousState ? JSON.stringify(entry.previousState) : ''),
        escapeCSV(entry.newState ? JSON.stringify(entry.newState) : ''),
      ].join(','))

      const csvContent = [headers.join(','), ...rows].join('\n')

      // Trigger download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `audit-log-${startDateInput.replace(/\//g, '-')}-to-${endDateInput.replace(/\//g, '-')}.csv`
      link.click()
      URL.revokeObjectURL(url)
      track('audit_log_csv_downloaded', {
        row_count: allEntries.length,
        start_date: startDate.toISOString(),
        end_date: effectiveEnd.toISOString(),
      })

      // Best-effort — don't block the success toast on this.
      try {
        await reportAuditExportCompleted(
          tenantId!,
          startDate.toISOString(),
          effectiveEnd.toISOString(),
          allEntries.length,
        )
      } catch (e) {
        console.warn('audit-export-completed report failed', e)
      }

      showToast(`Downloaded ${allEntries.length} audit entries`, 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to download audit log'
      showToast(message, 'error')
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <section className="settings-section">
      {isExpanded ? (
        <div className="settings-section__edit-block">
          <div className="settings-section__header">
            <h2 className="settings-section__title" id="audit-logs-title">Audit Logs</h2>
            <p className="settings-section__helper" id="audit-logs-desc">
              Download activity logs for compliance and review. Maximum 90-day range for each download.
            </p>
          </div>

          <DateRangeInput
            startDate={startDateInput}
            endDate={endDateInput}
            onStartDateChange={setStartDateInput}
            onEndDateChange={setEndDateInput}
          />
          {validationError && (
            <p className="settings-form__error" role="alert">{validationError}</p>
          )}

          <div className="settings-section__actions">
            <Button variant="outline" size="sm" onClick={() => setIsExpanded(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleDownload}
              disabled={isDownloading || !isValid}
              aria-busy={isDownloading}
            >
              {isDownloading ? 'Downloading...' : 'Download'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="settings-section__row">
          <div className="settings-section__left">
            <h2 className="settings-section__title">Audit Logs</h2>
            <p className="settings-section__helper">
              Download activity logs for compliance and review
            </p>
          </div>
          <div className="settings-section__right">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsExpanded(true)}
              aria-expanded={isExpanded}
              aria-controls="audit-logs-form"
            >
              Browse
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

// Helper to generate initials from name (matches Sidebar logic)
type EditingSection = 'name' | 'profilePhoto' | 'email' | 'timezone' | 'password' | 'passkey' | 'twoFactor' | 'notificationTypes' | 'notificationDelivery' | 'notificationFrequency' | 'workspaceMembers' | null

export default function SettingsPage() {
  const reauthPasswordRef = useAutoFocus<HTMLInputElement>()
  const totpCodeRef = useAutoFocus<HTMLInputElement>()
  const navigate = useNavigate()
  const { tab: tabParam } = useParams<{ tab: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { registerPasskey, removePasskey, getPasskeys, isPasskeySupported, isPlatformAuthenticatorAvailable, changePassword, user, account, currentTenant, currentRole, canManageMembers, setupTotpMfa, completeTotpEnrollment, disableTotpMfa, getTotpEnrollmentStatus, refreshAccount, signOut } = useAuth()
  const { showToast } = useToast()

  // TanStack Query mutations for account updates
  const updateAccountMutation = useUpdateAccount()
  const initiateEmailChangeMutation = useInitiateEmailChange()
  const cancelEmailChangeMutation = useCancelEmailChange()

  const activeTab: SettingsTab = (tabParam as SettingsTab) || 'profile'
  const setActiveTab = (tab: SettingsTab) => navigate(`/dashboard/settings/${tab}`)
  const lastTabRef = useRef<SettingsTab | null>(null)
  useEffect(() => {
    if (lastTabRef.current === null) {
      lastTabRef.current = activeTab
      track('settings_viewed', { tab: activeTab })
    } else if (lastTabRef.current !== activeTab) {
      track('settings_tab_changed', { from_tab: lastTabRef.current, to_tab: activeTab })
      lastTabRef.current = activeTab
    }
  }, [activeTab])

  const canManageBilling = currentRole === 'owner' || currentRole === 'admin'
  // Billing tab restricted to owner/admin; workspace tab visible to all
  const settingsTabs = [...BASE_SETTINGS_TABS.filter(t => t.value !== 'billing' || canManageBilling), WORKSPACE_TAB]

  // GlobalUnsubscribeHandler dispatches this when it successfully applies an
  // unsubscribe via an email link — refresh the local account so the toggles
  // reflect the new preference immediately.
  useEffect(() => {
    const handler = () => { void refreshAccount() }
    window.addEventListener('notification-preferences-changed', handler)
    return () => window.removeEventListener('notification-preferences-changed', handler)
  }, [refreshAccount])

  // Initialize editing section from URL params (e.g., ?tab=workspace&section=workspaceMembers)
  const initialSection = searchParams.get('section') as EditingSection
  const [editingSection, setEditingSection] = useState<EditingSection>(initialSection)
  // Profile state - initialized from account
  const [draftFirstName, setDraftFirstName] = useState(account?.firstName || '')
  const [draftLastName, setDraftLastName] = useState(account?.lastName || '')
  const [draftEmail, setDraftEmail] = useState(account?.email || '')
  const [draftTimezone, setDraftTimezone] = useState(account?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)
  // Profile photo state
  const [draftPhotoFile, setDraftPhotoFile] = useState<File | null>(null)
  const [draftPhotoPreview, setDraftPhotoPreview] = useState<string | null>(null)
  const [photoLoading, setPhotoLoading] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false)
  // Profile error state (loading states come from mutations)
  const [profileError, setProfileError] = useState<string | null>(null)
  // Email verification state
  const [emailVerificationSent, setEmailVerificationSent] = useState(false)
  // Read once from the URL that carried it. The effect below deletes the
  // parameter, so this cannot be derived on every render; capturing it in the
  // initialiser means the effect no longer sets state synchronously and the
  // banner does not appear a frame late.
  const [emailVerified] = useState<boolean | null>(() => {
    const v = new URLSearchParams(window.location.search).get('email_verified')
    return v === 'true' ? true : v === 'false' ? false : null
  })
  // No drafts for the two notification sections: they save on the toggle, so
  // the stored account IS the state. A local copy could only ever disagree
  // with it, and there is no Cancel for it to be reverted to.
  const [deliveryBusy, setDeliveryBusy] = useState(false)
  // This device's OS permission, which no preference can set. Re-read on focus
  // because it can change in browser settings while this page sits open.
  const [pushPermission, setPushPermission] = useState<PushPermissionState>(() => getPushPermissionState())
  const enableBrowserNotifications = useEnableBrowserNotifications()
  const disableBrowserNotifications = useDisableBrowserNotifications()
  useEffect(() => {
    const refresh = () => setPushPermission(getPushPermissionState())
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const [draftNotificationFrequency, setDraftNotificationFrequency] = useState<NotificationFrequency>(account?.preferences?.notificationFrequency ?? 'daily')
  const [draftCurrentPassword, setDraftCurrentPassword] = useState('')
  const [draftNewPassword, setDraftNewPassword] = useState('')
  const [draftConfirmPassword, setDraftConfirmPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  // Password change state
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  // Passkey state
  const [passkeys, setPasskeys] = useState<StoredPasskey[]>([])
  const [passkeySupported, setPasskeySupported] = useState(false)
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  // TOTP 2FA state
  const [totpSecret, setTotpSecret] = useState<TotpSecret | null>(null)
  const [totpVerificationCode, setTotpVerificationCode] = useState('')
  const [totpLoading, setTotpLoading] = useState(false)
  const [totpError, setTotpError] = useState<string | null>(null)
  const [totpSetupStep, setTotpSetupStep] = useState<'password' | 'qrcode'>('password')
  const [totpReauthPassword, setTotpReauthPassword] = useState('')

  // Billing data hooks
  const { data: invoicesData, isLoading: invoicesLoading, isError: invoicesError, refetch: refetchInvoices } = useInvoices()
  const { data: currentUsage, isLoading: usageLoading, isError: usageError, refetch: refetchUsage } = useCurrentUsage()
  // Plan Usage card scope: plan-bound consumption only. Reload-bucket
  // consumption is "above plan" — drained from the Credit Balance wallet,
  // shown separately in that card. Conflating the two would make the bar
  // exceed 100% with no signal that the user has crossed into the credit
  // wallet. ousConsumedThisPeriod is the aggregate; we clamp to the
  // allotment for the bar so it tops out cleanly when the plan is full.
  const allocatedOus = (currentUsage?.planIncludedOus ?? 0) + (currentUsage?.precommitExtraOus ?? 0);
  const totalUsedOus = currentUsage?.ousConsumedThisPeriod ?? 0;
  const usedOus      = Math.min(totalUsedOus, allocatedOus);
  const usagePct     = allocatedOus > 0 ? (usedOus / allocatedOus) * 100 : 0;
  const { data: paymentMethodsData, isLoading: pmLoading, isError: pmError, refetch: refetchPm } = usePaymentMethods()
  const { data: activeSubscription, isLoading: subLoading } = useActiveSubscription()
  // billing-overview carries cancel_at_period_end + currentPeriodEnd, the
  // signal we need to switch the Cancel Plan row into its post-cancel state
  // (button becomes "Subscribe Again", a small "Access ends on …" date sits
  // to the left of it). useActiveSubscription doesn't include the cancel
  // flag, so we read it from /overview instead.
  const { data: billingOverview } = useBillingOverview()
  const subscriptionCancelScheduled = billingOverview?.subscription?.cancelAtPeriodEnd === true
  const accessEndsAt = billingOverview?.subscription?.currentPeriodEnd ?? null
  const { data: autoReloadSettings } = useAutoReload()
  const cancelSubscriptionMutation = useCancelSubscription()
  // Opened straight away when the banner redirected here, for the same reason:
  // the effect below removes the parameter it would otherwise be derived from.
  const [showPaymentModal, setShowPaymentModal] = useState(
    () => new URLSearchParams(window.location.search).get('openPaymentModal') === 'true',
  )
  const [showAddCreditModal, setShowAddCreditModal] = useState(false)
  const [showAutoReloadModal, setShowAutoReloadModal] = useState(false)
  const [showCancelPlanModal, setShowCancelPlanModal] = useState(false)
  const [showLogoutAllModal, setShowLogoutAllModal] = useState(false)
  const [loggingOutAll, setLoggingOutAll] = useState(false)
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false)
  const { data: deletionPreflight, isFetching: deletionPreflightFetching, refetch: refetchDeletionPreflight } = useDeletionPreflight()
  const [isExportingWorkspace, setIsExportingWorkspace] = useState(false)

  async function handleWorkspaceExport(): Promise<void> {
    if (!currentTenant?.id || isExportingWorkspace) return
    setIsExportingWorkspace(true)
    let objectUrl: string | null = null
    try {
      const { blob, filename } = await downloadWorkspaceExport(currentTenant.id)
      objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = filename ?? 'workspace-export.zip'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      track('settings_workspace_export_downloaded', { bytes: blob.size })
    } catch (err) {
      // The backend's own sentence for the four states it names (another
      // export in progress, over the ceiling, too many this hour, a source
      // unavailable); anything else gets a plain line.
      const known = err instanceof ApiError && [409, 413, 429, 503].includes(err.status)
      showToast(known ? err.message : 'Failed to export workspace data', 'error')
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setIsExportingWorkspace(false)
    }
  }

  async function handleDeleteAccountClick(): Promise<void> {
    // Preflight may have failed silently or never fired. Force a fresh fetch
    // before opening the modal so we have current state.
    track('account_deletion_preflight_opened', {})
    track('settings_account_delete_modal_opened', {})
    const result = await refetchDeletionPreflight()
    if (result.data) {
      setShowDeleteAccountModal(true)
    } else {
      showToast('We are having trouble loading account details. Please try again later.', 'error')
    }
  }

  // One-time localStorage cleanup for stale PII
  useEffect(() => { localStorage.removeItem('liftoff_settings') }, [])

  // Seed the drafts from the account, during render rather than after it.
  //
  // The comparison is on the account OBJECT, which is what the effect's own
  // dependency was, so this re-seeds on exactly the same occasions: the first
  // load, and any later change of identity. Doing it in render means the
  // fields never paint empty first.
  const [seededAccount, setSeededAccount] = useState(account)
  if (account && account !== seededAccount) {
    setSeededAccount(account)
    setDraftFirstName(account.firstName)
    setDraftLastName(account.lastName)
    setDraftEmail(account.email)
    setDraftTimezone(account.timezone)
    setDraftNotificationFrequency(account.preferences?.notificationFrequency ?? 'daily')
  }

  // Clear the parameter and say what happened. The value itself was captured
  // in the initialiser above, so nothing is set here.
  useEffect(() => {
    if (emailVerified === null) return
    setSearchParams({}, { replace: true })
    showToast(
      emailVerified ? 'Email verified successfully' : 'Email verification failed. The link may have expired.',
      emailVerified ? 'success' : 'error',
    )
  }, [emailVerified, setSearchParams, showToast])

  // Record it and tidy the URL. The modal is already open from the initialiser.
  useEffect(() => {
    if (searchParams.get('openPaymentModal') === 'true') {
      track('settings_billing_payment_modal_opened', { trigger: 'banner' })
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.delete('openPaymentModal')
        return next
      }, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    const loadPasskeys = async () => {
      const keys = await getPasskeys()
      setPasskeys(keys)
    }
    loadPasskeys()
    const checkSupport = async () => {
      const supported = isPasskeySupported() && await isPlatformAuthenticatorAvailable()
      setPasskeySupported(supported)
    }
    checkSupport()
  }, [getPasskeys, isPasskeySupported, isPlatformAuthenticatorAvailable])

  const startEditing = (section: EditingSection) => {
    setProfileError(null)
    if (section === 'password') {
      track('settings_security_password_change_started', {})
    }
    if (section === 'name') {
      setDraftFirstName(account?.firstName || '')
      setDraftLastName(account?.lastName || '')
    } else if (section === 'profilePhoto') {
      setDraftPhotoFile(null)
      setDraftPhotoPreview(null)
      setPhotoError(null)
    } else if (section === 'email') {
      setDraftEmail(account?.email || '')
    } else if (section === 'timezone') {
      setDraftTimezone(account?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)
    } else if (section === 'password') {
      setDraftCurrentPassword('')
      setDraftNewPassword('')
      setDraftConfirmPassword('')
    } else if (section === 'notificationFrequency') {
      setDraftNotificationFrequency(account?.preferences?.notificationFrequency ?? 'daily')
    }
    setEditingSection(section)
  }

  const cancelEditing = () => {
    setEditingSection(null)
    // Clean up photo preview URL
    if (draftPhotoPreview) {
      URL.revokeObjectURL(draftPhotoPreview)
      setDraftPhotoPreview(null)
      setDraftPhotoFile(null)
    }
  }

  // Photo upload handlers
  const handlePhotoSelect = (file: File) => {
    // Validate file type
    if (!file.type.startsWith('image/')) {
      setPhotoError('Please select an image file')
      return
    }
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setPhotoError('Image must be less than 5MB')
      return
    }
    setPhotoError(null)
    setDraftPhotoFile(file)
    // Create preview URL
    const previewUrl = URL.createObjectURL(file)
    setDraftPhotoPreview(previewUrl)
  }

  const handlePhotoDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDraggingPhoto(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      track('settings_profile_photo_drag_drop', {})
      handlePhotoSelect(file)
    }
  }

  const handlePhotoDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDraggingPhoto(true)
  }

  const handlePhotoDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDraggingPhoto(false)
  }

  const savePhoto = async () => {
    if (!draftPhotoFile || !user?.uid) return
    setPhotoLoading(true)
    setPhotoError(null)
    // Read before the write, so the object being superseded is known even though
    // the mutation replaces the account in context.
    const supersededAvatarUrl = account?.avatarUrl ?? null
    try {
      // Upload to Firebase Storage. A new object each time, so this URL is the
      // only one naming it and nothing already stored is invalidated.
      const avatarUrl = await uploadProfilePhoto(user.uid, draftPhotoFile)
      // Save URL to backend - onSuccess callback updates AuthContext directly
      // with the returned account data (includes new avatarUrl)
      await updateAccountMutation.mutateAsync({ avatarUrl })
      // Strictly after the account names the new object. Not awaited: the photo
      // is already changed, and a stale object is not the person's problem.
      void deleteProfilePhotoByUrl(supersededAvatarUrl)
      track('settings_profile_photo_uploaded', { size_bytes: draftPhotoFile.size })
      showToast('Profile photo updated', 'success')
      setEditingSection(null)
      // Clean up
      if (draftPhotoPreview) {
        URL.revokeObjectURL(draftPhotoPreview)
      }
      setDraftPhotoFile(null)
      setDraftPhotoPreview(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload photo'
      setPhotoError(message)
    } finally {
      setPhotoLoading(false)
    }
  }

  // Derive loading state from mutations
  const profileLoading = updateAccountMutation.isPending || initiateEmailChangeMutation.isPending || cancelEmailChangeMutation.isPending

  const saveName = () => {
    setProfileError(null)
    updateAccountMutation.mutate(
      { firstName: draftFirstName, lastName: draftLastName },
      {
        onSuccess: () => {
          track('settings_profile_name_saved', {})
          setEditingSection(null)
          showToast('Name updated successfully', 'success')
        },
        onError: (err) => {
          console.error('Failed to update name:', err)
          setProfileError('Failed to save name. Please try again.')
        },
      }
    )
  }

  const saveEmail = () => {
    setProfileError(null)
    initiateEmailChangeMutation.mutate(draftEmail, {
      onSuccess: () => {
        track('settings_profile_email_change_initiated', {})
        setEditingSection(null)
        setEmailVerificationSent(true)
        showToast('Verification email sent', 'success')
      },
      onError: (err) => {
        console.error('Failed to initiate email change:', err)
        if (err instanceof Error && err.message.includes('already in use')) {
          setProfileError('This email address is already in use.')
        } else if (err instanceof Error && err.message.includes('company domain')) {
          setProfileError('Email must use a company domain.')
        } else {
          setProfileError('Failed to send verification email. Please try again.')
        }
      },
    })
  }

  const handleCancelEmailChange = () => {
    cancelEmailChangeMutation.mutate(undefined, {
      onSuccess: () => {
        track('settings_profile_email_change_canceled', {})
        setEmailVerificationSent(false)
      },
      onError: (err) => {
        console.error('Failed to cancel email change:', err)
      },
    })
  }

  const saveTimezone = () => {
    setProfileError(null)
    updateAccountMutation.mutate(
      { timezone: draftTimezone },
      {
        onSuccess: () => {
          track('settings_profile_timezone_saved', { timezone: draftTimezone })
          setEditingSection(null)
          showToast('Timezone updated successfully', 'success')
        },
        onError: (err) => {
          console.error('Failed to update timezone:', err)
          setProfileError('Failed to save timezone. Please try again.')
        },
      }
    )
  }

  // ── The two notification sections save on the toggle ───────────────────
  // No drafts and no Save button, so these read the stored account directly.
  // The complete-object rule (the backend's JSONB merge is shallow) lives in
  // notificationPreferences.ts, where it is tested.
  const notificationTypeValue = (key: keyof Required<NotificationTypes>) =>
    readNotificationType(account?.preferences?.notificationTypes, key)

  const deliveryValue = (key: keyof Required<NotificationDelivery>) =>
    readDelivery(account?.preferences?.notificationDelivery, key)

  const toggleNotificationType = (key: keyof Required<NotificationTypes>) => {
    const next = withNotificationTypeToggled(account?.preferences?.notificationTypes, key)
    updateAccountMutation.mutate(
      { preferences: { notificationTypes: next } },
      {
        onSuccess: () => {
          track('settings_communication_notification_types_saved', {
            types_enabled: Object.values(next).filter(Boolean).length,
          })
        },
        onError: () => { showToast('Failed to save notification preferences', 'error') },
      }
    )
  }

  // Browser is not a preference this page can write. Turning it on needs the
  // OS permission, which Safari only grants from a direct user interaction, and
  // the register endpoint owns the preference so the token and the setting
  // cannot disagree. Email is an ordinary preference write.
  const toggleDelivery = (key: keyof Required<NotificationDelivery>) => {
    if (key === 'browser') {
      const turningOn = !deliveryValue('browser')
      setDeliveryBusy(true)
      void (async () => {
        try {
          if (turningOn) {
            setPushPermission(await enableBrowserNotifications())
          } else {
            await disableBrowserNotifications()
          }
          track('settings_communication_notification_delivery_saved', {
            email: deliveryValue('email'),
            browser: turningOn,
          })
        } catch {
          showToast('Failed to update notification delivery', 'error')
        } finally {
          setDeliveryBusy(false)
        }
      })()
      return
    }

    const next = withDeliveryToggled(account?.preferences?.notificationDelivery, 'email')
    updateAccountMutation.mutate(
      { preferences: { notificationDelivery: next } },
      {
        onSuccess: () => {
          track('settings_communication_notification_delivery_saved', {
            email: next.email,
            browser: next.browser,
          })
        },
        onError: () => { showToast('Failed to update notification delivery', 'error') },
      }
    )
  }

  const saveNotificationFrequency = () => {
    updateAccountMutation.mutate(
      { preferences: { notificationFrequency: draftNotificationFrequency } },
      {
        onSuccess: () => {
          track('settings_communication_notification_frequency_saved', { frequency: draftNotificationFrequency })
          setEditingSection(null); showToast('Notification frequency updated', 'success')
        },
        onError: () => { showToast('Failed to save notification frequency', 'error') },
      }
    )
  }

  const getPasswordErrors = (password: string): string[] => {
    const errors: string[] = []
    if (password.length < 8) errors.push('8+ characters')
    if (!/[A-Z]/.test(password)) errors.push('uppercase')
    if (!/[a-z]/.test(password)) errors.push('lowercase')
    if (!/[0-9]/.test(password)) errors.push('number')
    return errors
  }

  const passwordErrors = draftNewPassword ? getPasswordErrors(draftNewPassword) : []
  const isPasswordValid = passwordErrors.length === 0

  const savePassword = async () => {
    if (!user?.email) {
      setPasswordError('You must be signed in with email to change password')
      return
    }
    setPasswordError(null)
    setPasswordLoading(true)
    try {
      await changePassword(draftCurrentPassword, draftNewPassword)
      track('settings_security_password_changed', {})
      setDraftCurrentPassword('')
      setDraftNewPassword('')
      setDraftConfirmPassword('')
      setEditingSection(null)
      showToast('Password updated successfully', 'success')
    } catch (err: unknown) {
      console.error('Password change error:', err)
      const firebaseError = err as { code?: string }
      switch (firebaseError.code) {
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
          setPasswordError('Current password is incorrect')
          break
        case 'auth/weak-password':
          setPasswordError('New password is too weak')
          break
        case 'auth/requires-recent-login':
          setPasswordError('Please sign out and sign in again before changing your password')
          break
        default:
          setPasswordError('Failed to change password')
      }
    } finally {
      setPasswordLoading(false)
    }
  }

  const handleRegisterPasskey = async () => {
    track('settings_security_passkey_register_started', {})
    setPasskeyError(null)
    setPasskeyLoading(true)
    try {
      await registerPasskey()
      const keys = await getPasskeys()
      setPasskeys(keys)
      track('passkey_registered', {})
      track('settings_security_passkey_registered', {})
      showToast('Passkey registered successfully', 'success')
    } catch (err) {
      console.error('Passkey registration error:', err)
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          setPasskeyError('Passkey registration was canceled')
        } else if (err.message === 'Failed to fetch' || err.message.includes('NetworkError')) {
          setPasskeyError('Unable to connect to server. Please check your connection and try again.')
        } else {
          setPasskeyError(err.message)
        }
      } else {
        setPasskeyError('Failed to register passkey')
      }
    } finally {
      setPasskeyLoading(false)
    }
  }

  const handleRemovePasskey = async (passkeyId: string) => {
    try {
      await removePasskey(passkeyId)
      track('passkey_removed', { passkey_id: passkeyId })
      track('settings_security_passkey_removed', { passkey_id: passkeyId })
      const keys = await getPasskeys()
      setPasskeys(keys)
    } catch (err) {
      console.error('Failed to remove passkey:', err)
      setPasskeyError('Failed to remove passkey')
    }
  }

  // TOTP 2FA handlers
  // Check if user has password provider (vs OAuth only)
  const hasPasswordProvider = user?.providerData?.some(p => p.providerId === 'password') ?? false
  const hasGoogleProvider = user?.providerData?.some(p => p.providerId === 'google.com') ?? false

  const handleStartTwoFactorSetup = () => {
    track('mfa_totp_enroll_started', {})
    track('settings_security_2fa_setup_started', {})
    setTotpError(null)
    setTotpSetupStep('password')
    setTotpReauthPassword('')
    startEditing('twoFactor')
  }

  const handleReauthWithPassword = async () => {
    if (!totpReauthPassword || !user?.email) return
    track('settings_security_2fa_reauth_method_chosen', { method: 'password' })
    setTotpError(null)
    setTotpLoading(true)
    try {
      // Re-authenticate with password
      const credential = EmailAuthProvider.credential(user.email, totpReauthPassword)
      await reauthenticateWithCredential(user, credential)
      // Now setup TOTP
      const secret = await setupTotpMfa()
      setTotpSecret(secret)
      track('settings_security_2fa_qr_shown', {})
      setTotpSetupStep('qrcode')
      setTotpReauthPassword('')
    } catch (err: unknown) {
      console.error('Failed to setup 2FA:', err)
      const firebaseError = err as { code?: string }
      if (firebaseError.code === 'auth/wrong-password' || firebaseError.code === 'auth/invalid-credential') {
        setTotpError('Incorrect password. Please try again.')
      } else if (firebaseError.code === 'auth/requires-recent-login') {
        setTotpError('Session expired. Please try again.')
      } else {
        setTotpError('Failed to start 2FA setup')
      }
    } finally {
      setTotpLoading(false)
    }
  }

  const handleReauthWithGoogle = async () => {
    if (!user) return
    track('settings_security_2fa_reauth_method_chosen', { method: 'google' })
    setTotpError(null)
    setTotpLoading(true)
    try {
      // Re-authenticate with Google popup
      const provider = new GoogleAuthProvider()
      await reauthenticateWithPopup(user, provider)
      // Now setup TOTP
      const secret = await setupTotpMfa()
      setTotpSecret(secret)
      track('settings_security_2fa_qr_shown', {})
      setTotpSetupStep('qrcode')
    } catch (err: unknown) {
      console.error('Failed to setup 2FA:', err)
      const firebaseError = err as { code?: string }
      if (firebaseError.code === 'auth/popup-closed-by-user') {
        setTotpError('Sign-in was cancelled. Please try again.')
      } else if (firebaseError.code === 'auth/requires-recent-login') {
        setTotpError('Session expired. Please try again.')
      } else {
        setTotpError('Failed to start 2FA setup')
      }
    } finally {
      setTotpLoading(false)
    }
  }

  const handleVerifyTotpSetup = async () => {
    if (!totpSecret || !totpVerificationCode) return
    setTotpError(null)
    setTotpLoading(true)
    try {
      await completeTotpEnrollment(totpSecret, totpVerificationCode)
      track('mfa_totp_enroll_completed', {})
      track('settings_security_2fa_verified', {})
      setTotpSecret(null)
      setTotpVerificationCode('')
      setEditingSection(null)
      showToast('Two-factor authentication enabled', 'success')
    } catch (err) {
      console.error('Failed to verify 2FA:', err)
      setTotpError('Invalid code. Please try again.')
    } finally {
      setTotpLoading(false)
    }
  }

  const handleDisableTwoFactor = async () => {
    setTotpError(null)
    setTotpLoading(true)
    try {
      await disableTotpMfa()
      track('mfa_totp_disabled', {})
      track('settings_security_2fa_disabled', {})
      setEditingSection(null)
      showToast('Two-factor authentication disabled', 'success')
    } catch (err) {
      console.error('Failed to disable 2FA:', err)
      setTotpError('Failed to disable 2FA')
    } finally {
      setTotpLoading(false)
    }
  }

  const getEnabledNotifications = () => {
    const current = { ...DEFAULT_NOTIFICATION_TYPES, ...account?.preferences?.notificationTypes }
    return Object.entries(current)
      .filter(([, enabled]) => enabled)
      .map(([key]) => notificationTypeLabels[key as keyof Required<NotificationTypes>])
  }

  // Names the channels rather than counting them. There are only two, and the
  // names carry the whole answer where "1 of 2" would not.
  const getDeliverySummary = () => {
    const delivery = { ...DEFAULT_NOTIFICATION_DELIVERY, ...account?.preferences?.notificationDelivery }
    const on = (Object.keys(deliveryLabels) as (keyof Required<NotificationDelivery>)[])
      .filter((key) => delivery[key])
      .map((key) => deliveryLabels[key].toLowerCase())
    if (on.length === 0) return 'No delivery methods'
    if (on.length === 1) return on[0].charAt(0).toUpperCase() + on[0].slice(1)
    return `${on[0].charAt(0).toUpperCase()}${on[0].slice(1)} and ${on.slice(1).join(' and ')}`
  }

  return (
    <div className="settings-page">
      <div className="settings-page__header">
        <h1 className="settings-page__title">Settings</h1>
      </div>

      <SegmentedControl
        options={settingsTabs}
        value={activeTab}
        onChange={setActiveTab}
        className="settings-page__tabs"
      />

      <div className="settings-page__content">
        {activeTab === 'profile' && (
          <section className="settings-section">
            {/* Name */}
            {editingSection === 'name' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Name</h2>
                  <p className="settings-section__helper">Your display name</p>
                </div>
                {profileError && (
                  <div className="settings-passkey-error">{profileError}</div>
                )}
                <div className="settings-form">
                  <div className="settings-form__row">
                    <label className="settings-form__label" htmlFor="settingspage-first-name">First Name</label>
                    <input id="settingspage-first-name"
                      type="text"
                      className="settings-form__input"
                      value={draftFirstName}
                      onChange={(e) => setDraftFirstName(e.target.value)}
                    />
                  </div>
                  <div className="settings-form__row">
                    <label className="settings-form__label" htmlFor="settingspage-last-name">Last Name</label>
                    <input id="settingspage-last-name"
                      type="text"
                      className="settings-form__input"
                      value={draftLastName}
                      onChange={(e) => setDraftLastName(e.target.value)}
                    />
                  </div>
                </div>
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={cancelEditing} disabled={profileLoading}>Cancel</Button>
                  <Button variant="primary" size="sm" onClick={saveName} disabled={profileLoading}>
                    {profileLoading ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Name</h2>
                  <p className="settings-section__helper">Your display name</p>
                </div>
                <div className="settings-section__right">
                  <span className="settings-section__value">
                    {account?.firstName || ''} {account?.lastName || ''}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => startEditing('name')}>Edit</Button>
                </div>
              </div>
            )}

            {/* Profile Photo */}
            {editingSection === 'profilePhoto' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Profile Photo</h2>
                  <p className="settings-section__helper">Upload a photo to personalize your profile</p>
                </div>
                {photoError && (
                  <div className="settings-passkey-error">{photoError}</div>
                )}
                <div className="settings-form">
                  <div className="settings-form__row">
                    <div
                      className={`settings-photo-upload ${isDraggingPhoto ? 'settings-photo-upload--dragging' : ''}`}
                      onDrop={handlePhotoDrop}
                      onDragOver={handlePhotoDragOver}
                      onDragLeave={handlePhotoDragLeave}
                    >
                      {draftPhotoPreview ? (
                        <div className="settings-photo-upload__preview">
                          <img src={draftPhotoPreview} alt="Preview" className="settings-photo-upload__image" />
                          <button
                            className="settings-photo-upload__remove"
                            onClick={() => {
                              if (draftPhotoPreview) URL.revokeObjectURL(draftPhotoPreview)
                              setDraftPhotoPreview(null)
                              setDraftPhotoFile(null)
                            }}
                            type="button"
                          >
                            <XIcon width="16" height="16" />
                          </button>
                        </div>
                      ) : (
                        <label className="settings-photo-upload__dropzone">
                          <input
                            type="file"
                            accept="image/*"
                            className="settings-photo-upload__input"
                            onChange={(e) => {
                              const file = e.target.files?.[0]
                              if (file) handlePhotoSelect(file)
                            }}
                          />
                          <ImageIcon width="32" height="32" className="settings-photo-upload__icon" />
                          <span className="settings-photo-upload__text">
                            Drag and drop an image here, or click to browse
                          </span>
                          <span className="settings-photo-upload__hint">PNG, JPG up to 5MB</span>
                        </label>
                      )}
                    </div>
                  </div>
                </div>
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={cancelEditing} disabled={photoLoading}>Cancel</Button>
                  <Button variant="primary" size="sm" onClick={savePhoto} disabled={photoLoading || !draftPhotoFile}>
                    {photoLoading ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Profile Photo</h2>
                  <p className="settings-section__helper">Your profile picture</p>
                </div>
                <div className="settings-section__right">
                  <div className="settings-photo-current">
                    {(() => {
                      // Only use actual names for initials, never email.
                      // Resolved identity: under a support delegation session
                      // this is the CUSTOMER, never the operator.
                      const identity = displayIdentity(account, user)
                      const initials = getInitialsFromName(identity.fullName)

                      if (identity.avatarUrl) {
                        return <img src={identity.avatarUrl} alt="" className="settings-photo-current__image" referrerPolicy="no-referrer" />
                      } else if (initials) {
                        return <div className="settings-photo-current__avatar">{initials}</div>
                      } else {
                        return (
                          <div className="settings-photo-current__avatar settings-photo-current__avatar--icon">
                            <PersonIcon width="20" height="20" />
                          </div>
                        )
                      }
                    })()}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => startEditing('profilePhoto')}>Edit</Button>
                </div>
              </div>
            )}

            {/* Email Verification Success/Error Messages */}
            {emailVerified === true && (
              <div className="settings-section__success">
                Email verified successfully! Your email has been updated.
              </div>
            )}
            {emailVerified === false && (
              <div className="settings-passkey-error">
                Email verification failed. The link may have expired. Please try again.
              </div>
            )}

            {/* Email */}
            {editingSection === 'email' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Email</h2>
                  <p className="settings-section__helper">We will send a verification link to your new email.</p>
                </div>
                {profileError && (
                  <div className="settings-passkey-error">{profileError}</div>
                )}
                <div className="settings-form">
                  <div className="settings-form__row">
                    <label className="settings-form__label" htmlFor="settingspage-new-email">New Email</label>
                    <input id="settingspage-new-email"
                      type="email"
                      className="settings-form__input"
                      value={draftEmail}
                      onChange={(e) => setDraftEmail(e.target.value)}
                    />
                  </div>
                </div>
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={cancelEditing} disabled={profileLoading}>Cancel</Button>
                  <Button variant="primary" size="sm" onClick={saveEmail} disabled={profileLoading || draftEmail === account?.email}>
                    {profileLoading ? 'Sending...' : 'Send Verification'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Email</h2>
                  <p className="settings-section__helper">Your account email address.</p>
                </div>
                <div className="settings-section__right">
                  <div className="settings-section__value-group">
                    <span className="settings-section__value">{account?.email || ''}</span>
                    {(account?.pendingEmail || emailVerificationSent) && (
                      <span className="settings-section__pending">
                        Verification sent to {account?.pendingEmail || draftEmail}
                        <button
                          className="settings-section__cancel-link"
                          onClick={handleCancelEmailChange}
                          disabled={profileLoading}
                        >
                          Cancel
                        </button>
                      </span>
                    )}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => startEditing('email')}>Edit</Button>
                </div>
              </div>
            )}

            {/* Time Zone */}
            {editingSection === 'timezone' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Time Zone</h2>
                  <p className="settings-section__helper">Used for scheduling and notifications</p>
                </div>
                {profileError && (
                  <div className="settings-passkey-error">{profileError}</div>
                )}
                <div className="settings-form">
                  <div className="settings-form__row">
                    <label className="settings-form__label" htmlFor="settingspage-time-zone">Time Zone</label>
                    <Dropdown id="settingspage-time-zone"
                      value={draftTimezone}
                      onChange={(value) => setDraftTimezone(value)}
                      options={timezones.map((tz) => ({
                        value: tz,
                        label: tz.replace('_', ' '),
                      }))}
                    />
                  </div>
                </div>
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={cancelEditing} disabled={profileLoading}>Cancel</Button>
                  <Button variant="primary" size="sm" onClick={saveTimezone} disabled={profileLoading}>
                    {profileLoading ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Time Zone</h2>
                  <p className="settings-section__helper">Used for scheduling and notifications</p>
                </div>
                <div className="settings-section__right">
                  <span className="settings-section__value">{(account?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).replace('_', ' ')}</span>
                  <Button variant="outline" size="sm" onClick={() => startEditing('timezone')}>Edit</Button>
                </div>
              </div>
            )}
          </section>
        )}

        {activeTab === 'security' && (
          <section className="settings-section">
            {/* Password */}
            {editingSection === 'password' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Change Password</h2>
                  <p className="settings-section__helper">Enter your current password and choose a new one</p>
                </div>
                {passwordError && (
                  <div className="settings-passkey-error">{passwordError}</div>
                )}
                <div className="settings-form">
                  <div className="settings-form__row">
                    <label className="settings-form__label" htmlFor="settingspage-current-password">Current Password</label>
                    <input id="settingspage-current-password"
                      type="password"
                      className="settings-form__input"
                      value={draftCurrentPassword}
                      onChange={(e) => setDraftCurrentPassword(e.target.value)}
                      placeholder="Enter current password"
                    />
                  </div>
                  <div className="settings-form__row">
                    <label className="settings-form__label">
                      New Password
                      {draftNewPassword && !isPasswordValid && (
                        <span className="settings-form__error"> (needs {passwordErrors.join(', ')})</span>
                      )}
                    </label>
                    <div className="settings-form__input-wrapper">
                      <input
                        type={showNewPassword ? 'text' : 'password'}
                        className={`settings-form__input ${draftNewPassword && !isPasswordValid ? 'settings-form__input--error' : ''}`}
                        value={draftNewPassword}
                        onChange={(e) => setDraftNewPassword(e.target.value)}
                        placeholder="Enter new password"
                      />
                      <button
                        type="button"
                        className={`settings-form__toggle-visibility ${showNewPassword ? 'settings-form__toggle-visibility--active' : ''}`}
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                      >
                        <EyeIcon width="18" height="18" />
                      </button>
                    </div>
                  </div>
                  <div className="settings-form__row">
                    <label className="settings-form__label">
                      Confirm New Password
                      {draftConfirmPassword && draftNewPassword !== draftConfirmPassword && (
                        <span className="settings-form__error"> (passwords do not match)</span>
                      )}
                    </label>
                    <div className="settings-form__input-wrapper">
                      <input
                        type={showConfirmPassword ? 'text' : 'password'}
                        className={`settings-form__input ${draftConfirmPassword && draftNewPassword !== draftConfirmPassword ? 'settings-form__input--error' : ''}`}
                        value={draftConfirmPassword}
                        onChange={(e) => setDraftConfirmPassword(e.target.value)}
                        placeholder="Confirm new password"
                      />
                      <button
                        type="button"
                        className={`settings-form__toggle-visibility ${showConfirmPassword ? 'settings-form__toggle-visibility--active' : ''}`}
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                      >
                        <EyeIcon width="18" height="18" />
                      </button>
                    </div>
                  </div>
                </div>
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={cancelEditing} disabled={passwordLoading}>Cancel</Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={savePassword}
                    disabled={passwordLoading || !draftCurrentPassword || !isPasswordValid || draftNewPassword !== draftConfirmPassword}
                  >
                    {passwordLoading ? 'Updating...' : 'Update Password'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Password</h2>
                  <p className="settings-section__helper">Change your account password</p>
                </div>
                <div className="settings-section__right">
                  {user?.providerData[0]?.providerId === 'password' ? (
                    <Button variant="outline" size="sm" onClick={() => startEditing('password')}>Change Password</Button>
                  ) : (
                    <span className="settings-section__value settings-section__value--muted">
                      Signed in with {user?.providerData[0]?.providerId === 'google.com' ? 'Google' : 'passkey'}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Passkeys */}
            {editingSection === 'passkey' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Passkeys</h2>
                  <p className="settings-section__helper">
                    {passkeys.length > 0
                      ? 'Manage your registered passkeys.'
                      : 'Add a passkey for passwordless sign-in.'}
                  </p>
                </div>
                {passkeys.length > 0 ? (
                  <div className="settings-passkey">
                    {passkeys.map((passkey) => (
                      <div key={passkey.id} className="settings-passkey__item">
                        <LockIcon width="20" height="20" />
                        <div className="settings-passkey__info">
                          <span className="settings-passkey__name">{passkey.deviceName || 'Passkey'}</span>
                          <span className="settings-passkey__date">
                            Added {new Date(passkey.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="settings-button--danger"
                          onClick={() => handleRemovePasskey(passkey.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    {passkeySupported && (
                      <div className="settings-passkey__add">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleRegisterPasskey}
                          disabled={passkeyLoading}
                        >
                          {passkeyLoading ? 'Adding...' : 'Add Another Passkey'}
                        </Button>
                        {passkeyError && (
                          <p className="settings-passkey-setup__error">{passkeyError}</p>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="settings-passkey-setup">
                    {passkeySupported ? (
                      <>
                        <p className="settings-passkey-setup__text">
                          Passkeys let you sign in with your fingerprint, face, or screen lock instead of a password.
                        </p>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={handleRegisterPasskey}
                          disabled={passkeyLoading}
                        >
                          {passkeyLoading ? 'Setting up...' : 'Set Up Passkey'}
                        </Button>
                        {passkeyError && (
                          <p className="settings-passkey-setup__error">{passkeyError}</p>
                        )}
                      </>
                    ) : (
                      <p className="settings-passkey-setup__text">
                        Passkeys are not supported on this device or browser.
                      </p>
                    )}
                  </div>
                )}
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={cancelEditing}>Done</Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Passkeys</h2>
                  <p className="settings-section__helper">Sign in with fingerprint, face, or screen lock</p>
                </div>
                <div className="settings-section__right">
                  <span className="settings-section__value">
                    {passkeys.length > 0 ? `${passkeys.length} passkey${passkeys.length > 1 ? 's' : ''} registered` : 'None'}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => startEditing('passkey')}>
                    {passkeys.length > 0 ? 'Manage' : 'Add Passkey'}
                  </Button>
                </div>
              </div>
            )}

            {/* Two-Factor Authentication */}
            {editingSection === 'twoFactor' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Two-Factor Authentication</h2>
                  <p className="settings-section__helper">
                    {totpSetupStep === 'password'
                      ? (hasPasswordProvider ? 'Enter your password to continue' : 'Verify your identity to continue')
                      : 'Scan the QR code with your authenticator app'}
                  </p>
                </div>
                {totpError && (
                  <div className="settings-passkey-error">{totpError}</div>
                )}
                {totpSetupStep === 'password' && (
                  hasPasswordProvider ? (
                    <div className="settings-form">
                      <div className="settings-form__row">
                        <label className="settings-form__label" htmlFor="settingspage-current-password">Current password</label>
                        <input id="settingspage-current-password"
                          type="password"
                          className="settings-form__input"
                          value={totpReauthPassword}
                          onChange={(e) => setTotpReauthPassword(e.target.value)}
                          placeholder="Enter your password"
                          ref={reauthPasswordRef}
                        />
                      </div>
                    </div>
                  ) : hasGoogleProvider ? (
                    <div className="settings-form">
                      <div className="settings-form__row">
                        <button
                          type="button"
                          className="settings-google-button"
                          onClick={handleReauthWithGoogle}
                          disabled={totpLoading}
                        >
                          <svg width="20" height="20" viewBox="0 0 18 18" fill="none">
                            <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
                            <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                          </svg>
                          {totpLoading ? 'Verifying...' : 'Continue with Google'}
                        </button>
                      </div>
                    </div>
                  ) : null
                )}
                {totpSetupStep === 'qrcode' && totpSecret && (
                  <div className="settings-form">
                    <div className="settings-form__row">
                      <QRCodeSVG
                        value={totpSecret.generateQrCodeUrl(account?.email || '', 'Liftoff')}
                        size={120}
                      />
                    </div>
                    <div className="settings-form__row">
                      <label className="settings-form__hint" htmlFor="settingspage-scan-the-qr-code-above-or-enter-this-cod">Scan the QR code above, or enter this code in your authenticator app</label>
                      <input id="settingspage-scan-the-qr-code-above-or-enter-this-cod"
                        type="text"
                        className="settings-form__input settings-totp-secret-input"
                        value={totpSecret.secretKey.match(/.{1,4}/g)?.join(' ') || ''}
                        readOnly
                        onClick={(e) => {
                          track('settings_security_qr_secret_copied', {})
                          ;(e.target as HTMLInputElement).select()
                        }}
                      />
                    </div>
                    <div className="settings-form__row settings-totp-code-row">
                      <label className="settings-form__hint" htmlFor="settingspage-enter-the-6-digit-code-from-your-app">Enter the 6-digit code from your app</label>
                      <input id="settingspage-enter-the-6-digit-code-from-your-app"
                        type="text"
                        className="settings-form__input settings-totp-code-input"
                        value={totpVerificationCode}
                        onChange={(e) => setTotpVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="000000"
                        maxLength={6}
                        ref={totpCodeRef}
                      />
                    </div>
                  </div>
                )}
                <div className="settings-section__actions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setTotpSecret(null)
                      setTotpVerificationCode('')
                      setTotpReauthPassword('')
                      setTotpError(null)
                      setTotpSetupStep('password')
                      cancelEditing()
                    }}
                    disabled={totpLoading}
                  >
                    Cancel
                  </Button>
                  {totpSetupStep === 'password' ? (
                    hasPasswordProvider ? (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleReauthWithPassword}
                        disabled={totpLoading || !totpReauthPassword}
                      >
                        {totpLoading ? 'Verifying...' : 'Continue'}
                      </Button>
                    ) : null
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleVerifyTotpSetup}
                      disabled={totpLoading || totpVerificationCode.length !== 6}
                    >
                      {totpLoading ? 'Verifying...' : 'Verify'}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Two-Factor Authentication</h2>
                  <p className="settings-section__helper">Add an extra layer of security</p>
                </div>
                <div className="settings-section__right">
                  <span className="settings-section__value">
                    {getTotpEnrollmentStatus() ? 'Enabled' : 'Not enabled'}
                  </span>
                  {getTotpEnrollmentStatus() ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDisableTwoFactor}
                      disabled={totpLoading}
                    >
                      {totpLoading ? 'Disabling...' : 'Disable'}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleStartTwoFactorSetup}
                      disabled={totpLoading}
                    >
                      {totpLoading ? 'Setting up...' : 'Enable'}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {activeTab === 'communication' && (
          <section className="settings-section">
            {/* Notification Types */}
            {editingSection === 'notificationTypes' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Notification Types</h2>
                  <p className="settings-section__helper">Choose which notifications you want to receive</p>
                </div>
                <div className="settings-toggles">
                  {(Object.keys(notificationTypeLabels) as (keyof Required<NotificationTypes>)[]).map((key) => (
                    <div key={key} className="settings-toggle-row">
                      <span className="settings-toggle-row__label">{notificationTypeLabels[key]}</span>
                      {/* Reads the saved account, not a draft: with no Save
                          button the stored value IS the state, and a local copy
                          could only ever disagree with it. */}
                      <Toggle
                        label={notificationTypeLabels[key]}
                        checked={notificationTypeValue(key)}
                        disabled={updateAccountMutation.isPending}
                        onChange={() => toggleNotificationType(key)}
                      />
                    </div>
                  ))}
                </div>
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={() => setEditingSection(null)}>Done</Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Notification Types</h2>
                  <p className="settings-section__helper">Choose which notifications you want to receive</p>
                </div>
                <div className="settings-section__right">
                  {getEnabledNotifications().length > 0 ? (
                    <ul className="settings-section__list">
                      {getEnabledNotifications().map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="settings-section__empty">No notifications enabled</span>
                  )}
                  <Button variant="outline" size="sm" onClick={() => startEditing('notificationTypes')}>Manage</Button>
                </div>
              </div>
            )}

            {/* Notification Delivery */}
            {editingSection === 'notificationDelivery' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Notification Delivery</h2>
                  <p className="settings-section__helper">Where your notifications are sent</p>
                </div>
                {/* The preference and the permission are different things. The
                    toggle records what you want and is true on every device;
                    this line reports what THIS browser will allow, which no
                    preference can change. */}
                {deliveryValue('browser') && pushPermission === 'denied' && (
                  <p className="settings-section__helper">
                    Your browser is blocking notifications from Liftoff.{' '}
                    <button
                      type="button"
                      className="settings-inline-link"
                      onClick={() => navigate('/dashboard/support/settings/unblock-browser-notifications')}
                    >
                      How to fix this
                    </button>
                  </p>
                )}
                {deliveryValue('browser') && pushPermission === 'unavailable' && (
                  <p className="settings-section__helper">
                    This browser cannot show notifications.
                  </p>
                )}
                <div className="settings-toggles">
                  {(Object.keys(deliveryLabels) as (keyof Required<NotificationDelivery>)[]).map((key) => (
                    <div key={key} className="settings-toggle-row">
                      <span className="settings-toggle-row__label">{deliveryLabels[key]}</span>
                      <Toggle
                        label={deliveryLabels[key]}
                        checked={deliveryValue(key)}
                        disabled={deliveryBusy}
                        onChange={() => toggleDelivery(key)}
                      />
                    </div>
                  ))}
                </div>
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={() => setEditingSection(null)}>Done</Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Notification Delivery</h2>
                  <p className="settings-section__helper">Where your notifications are sent</p>
                </div>
                <div className="settings-section__right">
                  <span className="settings-section__value">{getDeliverySummary()}</span>
                  <Button variant="outline" size="sm" onClick={() => startEditing('notificationDelivery')}>Manage</Button>
                </div>
              </div>
            )}

            {/* Notification Frequency */}
            {editingSection === 'notificationFrequency' ? (
              <div className="settings-section__edit-block">
                <div className="settings-section__header">
                  <h2 className="settings-section__title">Notification Frequency</h2>
                  <p className="settings-section__helper">How often you want to receive notifications</p>
                </div>
                <div className="settings-segmented">
                  {(['realtime', 'daily', 'weekly', 'none'] as NotificationFrequency[]).map((freq) => (
                    <button
                      key={freq}
                      className={`settings-segmented__option ${draftNotificationFrequency === freq ? 'settings-segmented__option--active' : ''}`}
                      onClick={() => setDraftNotificationFrequency(freq)}
                    >
                      <span className="settings-segmented__label">{notificationFrequencyLabels[freq]}</span>
                      <span className="settings-segmented__description">{notificationFrequencyDescriptions[freq]}</span>
                    </button>
                  ))}
                </div>
                <div className="settings-section__actions">
                  <Button variant="outline" size="sm" onClick={cancelEditing} disabled={updateAccountMutation.isPending}>Cancel</Button>
                  <Button variant="primary" size="sm" onClick={saveNotificationFrequency} disabled={updateAccountMutation.isPending}>
                    {updateAccountMutation.isPending ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Notification Frequency</h2>
                  <p className="settings-section__helper">How often you want to receive notifications</p>
                </div>
                <div className="settings-section__right">
                  <span className="settings-section__value">{notificationFrequencyLabels[account?.preferences?.notificationFrequency ?? 'daily']}</span>
                  <Button variant="outline" size="sm" onClick={() => startEditing('notificationFrequency')}>Edit</Button>
                </div>
              </div>
            )}

            {/* Newsletter */}
            <div className="settings-section__row">
              <div className="settings-section__left">
                <h2 className="settings-section__title">Liftoff Newsletter</h2>
                <p className="settings-section__helper">Product updates and tips</p>
              </div>
              <div className="settings-section__right">
                <Toggle
                  label="Liftoff Newsletter"
                  checked={account?.preferences?.newsletter ?? true}
                  disabled={updateAccountMutation.isPending}
                  onChange={() => {
                    const newValue = !(account?.preferences?.newsletter ?? true)
                    updateAccountMutation.mutate(
                      { preferences: { newsletter: newValue } },
                      {
                        onSuccess: () => { showToast(newValue ? 'Newsletter subscribed' : 'Newsletter unsubscribed', 'success') },
                        onError: () => { showToast('Failed to update newsletter preference', 'error') },
                      }
                    )
                  }}
                />
              </div>
            </div>
          </section>
        )}

        {activeTab === 'billing' && canManageBilling && (
          <>
          <section className="settings-section">
            {/* Plan */}
            <div className="settings-section__row">
              <div className="settings-section__left">
                <h2 className="settings-section__title">Plan</h2>
                <p className="settings-section__helper">Your current subscription</p>
              </div>
              <div className="settings-section__right">
                {(subLoading || usageLoading) ? (
                  <span className="settings-section__skeleton" style={{ width: 120 }} />
                ) : activeSubscription ? (
                  <>
                    <span className="settings-section__value">
                      {activeSubscription.planId.charAt(0).toUpperCase() + activeSubscription.planId.slice(1)}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => navigate('/dashboard/pricing')}>Change Plan</Button>
                  </>
                ) : currentUsage?.billingTier === 'enterprise' ? (
                  <>
                    <span className="settings-section__value">Enterprise</span>
                    <Button variant="outline" size="sm" onClick={() => navigate('/dashboard/pricing')}>Change Plan</Button>
                  </>
                ) : currentUsage?.billingMode === 'pre_pay' && currentUsage.planType ? (
                  <>
                    <span className="settings-section__value">
                      {currentUsage.planType.charAt(0).toUpperCase() + currentUsage.planType.slice(1)}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => navigate('/dashboard/pricing')}>Change Plan</Button>
                  </>
                ) : (
                  /* Pre-pay says how the workspace pays, not that it bought a
                     plan: a workspace funding itself with credit is pre-pay with
                     no plan_type, and so is one whose billing was initialised
                     before activation. Both fall through here rather than
                     claiming a plan that does not exist. */
                  <>
                    <span className="settings-section__value settings-section__value--muted">No active plan</span>
                    <Button variant="outline" size="sm" onClick={() => navigate('/dashboard/pricing')}>Change Plan</Button>
                  </>
                )}
              </div>
            </div>

            {/* Plan Usage Meter */}
            <div className="settings-section__row settings-section__row--top">
              <div className="settings-section__left">
                <h2 className="settings-section__title">Plan Usage</h2>
                <p className="settings-section__helper">Accrued usage this billing period</p>
              </div>
              <div className="settings-section__right settings-section__right--meter">
                {usageLoading ? (
                  <>
                    <span className="settings-section__skeleton" style={{ width: 220, height: 8, borderRadius: 999 }} />
                    <span className="settings-section__skeleton" style={{ width: 140, height: 10, marginTop: 4 }} />
                  </>
                ) : usageError ? (
                  <Button variant="outline" size="sm" onClick={() => refetchUsage()}>Retry</Button>
                ) : allocatedOus > 0 ? (
                  <>
                    <div className="settings-section__plan-meter">
                      <div className="settings-section__plan-meter-track">
                        <div
                          className="settings-section__plan-meter-fill"
                          style={{ width: `${Math.min(usagePct, 100)}%` }}
                          role="progressbar"
                          aria-valuenow={Math.round(usagePct)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        />
                      </div>
                      <span className="settings-section__plan-meter-label">{Math.round(usagePct)}% used</span>
                    </div>
                    <span className="settings-section__value--muted" style={{ fontSize: 'var(--text-xs)' }}>
                      {usedOus.toFixed(1)} / {allocatedOus.toLocaleString()} Operating Units
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            {/* Payment Method */}
            <div className="settings-section__row">
              <div className="settings-section__left">
                <h2 className="settings-section__title">Payment Method</h2>
                <p className="settings-section__helper">Used for billing charges</p>
              </div>
              <div className="settings-section__right">
                {pmLoading ? (
                  <span className="settings-section__skeleton" style={{ width: 160 }} />
                ) : pmError ? (
                  <>
                    <span className="settings-section__value settings-section__value--muted">Failed to load</span>
                    <Button variant="outline" size="sm" onClick={() => refetchPm()}>Retry</Button>
                  </>
                ) : paymentMethodsData && paymentMethodsData.paymentMethods.length > 0 ? (
                  <>
                    <span className="settings-section__value">
                      {(() => {
                        const pm = paymentMethodsData.paymentMethods.find(p => p.isDefault) ?? paymentMethodsData.paymentMethods[0]
                        const brand = pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1)
                        return <>{brand} ····{' '}{pm.last4}</>
                      })()}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        track('settings_billing_payment_modal_opened', { trigger: 'update' })
                        track('payment_method_modal_opened', { surface: 'settings_billing' })
                        setShowPaymentModal(true)
                      }}
                    >
                      Update
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="settings-section__value settings-section__value--muted">No card on file</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        track('settings_billing_payment_modal_opened', { trigger: 'no_payment' })
                        track('payment_method_modal_opened', { surface: 'settings_billing' })
                        setShowPaymentModal(true)
                      }}
                    >
                      Add Payment Method
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Credit Balance — pre-pay only */}
            {currentUsage?.billingMode === 'pre_pay' && (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Credit Balance</h2>
                  <p className="settings-section__helper">Your credit balance covers extra Operating Units beyond your plan</p>
                </div>
                <div className="settings-section__right">
                  {usageLoading ? (
                    <span className="settings-section__skeleton" style={{ width: 60 }} />
                  ) : (
                    <span className="settings-section__value">
                      ${(currentUsage?.creditBalanceUsd ?? 0).toFixed(2)}
                    </span>
                  )}
                  <Button variant="outline" size="sm" onClick={() => {
                    track('settings_billing_add_credit_modal_opened', {})
                    setShowAddCreditModal(true)
                  }}>Add to Balance</Button>
                </div>
              </div>
            )}

            {/* Auto Reload — pre-pay only */}
            {currentUsage?.billingMode === 'pre_pay' && (
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Auto Reload</h2>
                  <p className="settings-section__helper">Automatically add credit when your balance runs low</p>
                </div>
                <div className="settings-section__right">
                  {autoReloadSettings?.enabled && (
                    <span className="settings-section__value--muted" style={{ fontSize: 'var(--text-sm)' }}>
                      When balance drops to ${autoReloadSettings.thresholdUsd}, add ${autoReloadSettings.reloadAmountUsd}
                    </span>
                  )}
                  <Button variant="outline" size="sm" onClick={() => {
                    track('settings_billing_auto_reload_modal_opened', {})
                    setShowAutoReloadModal(true)
                  }}>Manage</Button>
                </div>
              </div>
            )}

            {/* Invoices */}
            <div className="settings-section__row settings-section__row--top">
              <div className="settings-section__left">
                <h2 className="settings-section__title">Invoices</h2>
                <p className="settings-section__helper">Download past invoices and receipts</p>
              </div>
              <div className="settings-section__right settings-section__right--column">
                {invoicesLoading ? (
                  <div className="settings-invoices">
                    {[0, 1, 2].map(i => (
                      <div key={i} className="settings-invoice settings-invoice--skeleton">
                        <span className="settings-section__skeleton" style={{ width: 100 }} />
                        <span className="settings-section__skeleton" style={{ width: 80 }} />
                        <span className="settings-section__skeleton" style={{ width: 60 }} />
                      </div>
                    ))}
                  </div>
                ) : invoicesError ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    <span className="settings-section__value settings-section__value--muted">Failed to load invoices</span>
                    <Button variant="outline" size="sm" onClick={() => refetchInvoices()}>Retry</Button>
                  </div>
                ) : invoicesData && invoicesData.invoices.length > 0 ? (
                  <div className="settings-invoices">
                    {invoicesData.invoices.map((invoice) => {
                      // Link to Stripe's hosted invoice page (invoice.stripe.com/i/...)
                      // rather than the raw PDF: that page lets the user download
                      // both the invoice and the associated receipt. Fall back to
                      // the PDF only if the hosted URL is unavailable.
                      const href = invoice.hostedInvoiceUrl ?? invoice.invoicePdf ?? '#'
                      const date = new Date(invoice.created * 1000).toLocaleDateString()
                      const amount = `$${(invoice.amountDue / 100).toFixed(2)}`
                      return (
                        <a
                          key={invoice.id}
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="settings-invoice"
                          onClick={() => {
                            track('invoice_downloaded', { invoice_id: invoice.id })
                            track('settings_billing_invoice_downloaded', { invoice_id: invoice.id })
                          }}
                        >
                          <span className="settings-invoice__date">{date}</span>
                          <span className="settings-invoice__amount">{amount}</span>
                          <ReceiptTextIcon width="16" height="16" />
                        </a>
                      )
                    })}
                  </div>
                ) : (
                  <p className="settings-section__value settings-section__value--muted">No invoices yet</p>
                )}
              </div>
            </div>

            {/* Cancel Plan — collapses post-cancel into a "Subscribe Again"
                affordance with the user's last day of access displayed inline
                so they don't have to dig for it. cancel_at_period_end +
                currentPeriodEnd come from /billing/overview (see
                billingOverview hook above). */}
            <div className="settings-section__row">
              <div className="settings-section__left">
                <h2 className="settings-section__title">
                  {subscriptionCancelScheduled ? 'Subscription Ending' : 'Cancel Plan'}
                </h2>
                <p className="settings-section__helper">
                  {subscriptionCancelScheduled
                    ? 'Your subscription is scheduled to end. Subscribe again to keep access.'
                    : 'End your current subscription'}
                </p>
              </div>
              <div className="settings-section__right">
                {subscriptionCancelScheduled ? (
                  <>
                    {accessEndsAt && (
                      <span className="settings-section__value">
                        Access ends on {new Date(accessEndsAt).toLocaleDateString(undefined, {
                          year: 'numeric', month: 'long', day: 'numeric',
                        })}
                      </span>
                    )}
                    <Button variant="primary" size="sm" onClick={() => {
                      track('settings_billing_change_plan_clicked', {})
                      navigate('/dashboard/pricing')
                    }}>
                      Subscribe Again
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => {
                    track('settings_billing_cancel_plan_modal_opened', {})
                    setShowCancelPlanModal(true)
                  }}>Cancel</Button>
                )}
              </div>
            </div>

          </section>

          {showPaymentModal && currentTenant?.id && (
            <PaymentUpdateModal
              tenantId={currentTenant.id}
              chargeOutstandingOnSave={
                (currentUsage?.executionBlocked ?? false) &&
                (currentUsage?.outstandingBalanceUsd ?? 0) > 0
              }
              onClose={() => setShowPaymentModal(false)}
            />
          )}

          {showAddCreditModal && currentTenant?.id && (() => {
            const pm = paymentMethodsData?.paymentMethods.find(p => p.isDefault) ?? paymentMethodsData?.paymentMethods[0]
            return (
              <AddCreditModal
                tenantId={currentTenant.id}
                paymentMethod={pm ? { brand: pm.brand, last4: pm.last4 } : null}
                onClose={() => setShowAddCreditModal(false)}
              />
            )
          })()}

          {showAutoReloadModal && (() => {
            const pm = paymentMethodsData?.paymentMethods.find(p => p.isDefault) ?? paymentMethodsData?.paymentMethods[0]
            return (
              <AutoReloadModal
                cardLast4={pm?.last4 ?? null}
                currentSettings={autoReloadSettings ?? null}
                onClose={() => setShowAutoReloadModal(false)}
              />
            )
          })()}

          {showCancelPlanModal && (
            <ModalOverlay onClose={() => setShowCancelPlanModal(false)} ariaLabelledBy="cancel-plan-title" disableClose={cancelSubscriptionMutation.isPending}>
              <div className="rollback-modal">
                <div className="modal-header">
                  <h2 id="cancel-plan-title" className="rollback-modal__title">Cancel subscription?</h2>
                </div>
                <p className="rollback-modal__description">
                  Your subscription will remain active until the end of your current billing period. After that, your workspace will lose access to paid features.
                </p>
                <ModalActions>
                  <Button variant="outline" onClick={() => setShowCancelPlanModal(false)} disabled={cancelSubscriptionMutation.isPending}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={cancelSubscriptionMutation.isPending}
                    onClick={() => {
                      cancelSubscriptionMutation.mutate(undefined, {
                        onSuccess: () => {
                          track('settings_billing_cancel_plan_confirmed', {})
                          setShowCancelPlanModal(false)
                          showToast('Your subscription has been cancelled. It will remain active until the end of the current billing period.', 'success')
                        },
                        onError: () => {
                          showToast('Failed to cancel subscription. Please try again.', 'error')
                        },
                      })
                    }}
                  >
                    {cancelSubscriptionMutation.isPending ? 'Cancelling…' : 'Confirm'}
                  </Button>
                </ModalActions>
              </div>
            </ModalOverlay>
          )}
          </>
        )}

        {activeTab === 'account' && (
          <>
            <section className="settings-section">
              {/* Log Out Everywhere */}
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Log Out Everywhere</h2>
                  <p className="settings-section__helper">Sign out of all devices and sessions</p>
                </div>
                <div className="settings-section__right">
                  <Button variant="outline" size="sm" onClick={() => {
                    track('settings_account_logout_all_modal_opened', {})
                    setShowLogoutAllModal(true)
                  }}>Log Out All Devices</Button>
                </div>
              </div>

              {/* Delete Account */}
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Delete Account</h2>
                  <p className="settings-section__helper">To delete your account, please cancel your subscription first</p>
                </div>
                <div className="settings-section__right">
                  <Button variant="outline" size="sm" onClick={handleDeleteAccountClick} loading={deletionPreflightFetching}>
                    Delete Account
                  </Button>
                </div>
              </div>
            </section>

            {showDeleteAccountModal && deletionPreflight && (
              <DeleteAccountModal
                open={showDeleteAccountModal}
                onClose={() => setShowDeleteAccountModal(false)}
                preflight={deletionPreflight}
              />
            )}

            {showLogoutAllModal && (
              <ModalOverlay onClose={() => setShowLogoutAllModal(false)} ariaLabelledBy="logout-all-title" disableClose={loggingOutAll}>
                <div className="rollback-modal">
                  <div className="modal-header">
                    <h2 id="logout-all-title" className="rollback-modal__title">Log out of all devices?</h2>
                  </div>
                  <p className="rollback-modal__description">
                    This will sign you out of every browser and device where you&rsquo;re currently logged in, including this one. You&rsquo;ll need to sign in again.
                  </p>
                  <ModalActions>
                    <Button variant="outline" onClick={() => setShowLogoutAllModal(false)} disabled={loggingOutAll}>Cancel</Button>
                    <Button
                      variant="primary"
                      disabled={loggingOutAll}
                      onClick={async () => {
                        setLoggingOutAll(true)
                        try {
                          await revokeAllSessions()
                          track('logout_all_devices', {})
                          track('settings_account_logout_all_confirmed', {})
                          await signOut()
                          navigate('/login', { replace: true })
                        } catch {
                          setLoggingOutAll(false)
                          showToast('Failed to log out of all devices. Please try again.', 'error')
                        }
                      }}
                    >
                      {loggingOutAll ? 'Signing out…' : 'Log out everywhere'}
                    </Button>
                  </ModalActions>
                </div>
              </ModalOverlay>
            )}
          </>
        )}

        {/* Workspace Tab */}
        {activeTab === 'workspace' && (
          <>
            {/* Admin sections - owner/admin only */}
            {canManageMembers() && (
            <>
            <WorkspaceNameSection
              tenantId={currentTenant?.id}
              currentName={currentTenant?.name}
            />
            <WorkspaceTabContent
              tenantId={currentTenant?.id}
              currentAccountId={account?.id}
              currentRole={currentRole}
              isManaging={editingSection === 'workspaceMembers'}
              onStartManaging={() => startEditing('workspaceMembers')}
              onStopManaging={cancelEditing}
            />

            </>
            )}

            {/* Audit Logs - Enterprise plan, owner/admin only */}
            {canManageMembers() && currentUsage?.billingTier === 'enterprise' && (
              <AuditLogsSection tenantId={currentTenant?.id} />
            )}

            {/* Workspace AI, then the customer's own provider keys - owner/admin
                only, same gate as Workspace Name. Workspace AI picks the
                provider; the keys card picks whose account it bills to. */}
            {canManageMembers() && (
              <>
                <WorkspaceAiSection tenantId={currentTenant?.id} />
                {/* Keyed on the tenant so a workspace switch remounts the card:
                    it collapses and drops any half-typed key rather than
                    carrying it into a save against the new workspace. */}
                <AiProviderKeysSection key={currentTenant?.id} tenantId={currentTenant?.id} />
                {/* Export Workspace Data: one archive of what the workspace holds. */}
                <section className="settings-section">
                  <div className="settings-section__row">
                    <div className="settings-section__left">
                      <h2 className="settings-section__title">Export Workspace Data</h2>
                      <p className="settings-section__helper">
                        Export a copy of all the content added to this workspace
                      </p>
                    </div>
                    <div className="settings-section__right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleWorkspaceExport}
                        loading={isExportingWorkspace}
                        disabled={!currentTenant?.id}
                      >
                        Download
                      </Button>
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* Workspace ID */}
            <section className="settings-section">
              <div className="settings-section__row">
                <div className="settings-section__left">
                  <h2 className="settings-section__title">Workspace ID</h2>
                  <p className="settings-section__helper">Your unique workspace identifier</p>
                </div>
                <div className="settings-section__right">
                  <code className="settings-section__code">{currentTenant?.id ?? 'Loading...'}</code>
                  <button
                    className="settings-section__copy"
                    onClick={() => {
                      if (currentTenant?.id) {
                        navigator.clipboard.writeText(currentTenant.id)
                        showToast('Copied to clipboard', 'success')
                      }
                    }}
                    aria-label="Copy workspace ID"
                    disabled={!currentTenant?.id}
                  >
                    <CopyIcon width="16" height="16" />
                  </button>
                </div>
              </div>
            </section>

          </>
        )}
      </div>
    </div>
  )
}
