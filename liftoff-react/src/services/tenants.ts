// Tenant Service
// Fetches tenant information for the current user's account

import { api, apiBlob } from './api'
import type { Account } from './account'
import type {
  OnboardingPath,
  OnboardingStepId,
} from '../pages/Dashboard/Onboarding/types'

// [FE-002] Use const assertion for type safety
export const TENANT_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type TenantRole = typeof TENANT_ROLES[number];

// Role hierarchy for permission checks
export const ROLE_HIERARCHY = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1
} as const;

export interface Tenant {
  id: string
  accountId: string
  name: string
  status: 'pending' | 'provisioning' | 'active' | 'suspended'
  gcpProjectId: string | null
  databaseName: string | null
  migrationStatus: string
  hasCreatedInternalAgent: boolean
  // Onboarding wizard progress for /onboarding. Persisted per tenant so a
  // user can resume mid-flow and so the dashboard knows whether to gate the
  // full sidebar / route surface. Persona moved to accounts.persona — it's
  // a per-user signal, not per-workspace.
  onboardingStep: number
  onboardingCompletedAt: string | null
  // Fused-onboarding fields (migration 260). NULL on legacy completed tenants.
  onboardingPath: OnboardingPath | null
  onboardingStepId: OnboardingStepId | null
  createdAt: string
  updatedAt: string
}

export interface UpdateTenantInput {
  name?: string
  /** @deprecated use onboardingStepId */
  onboardingStep?: number
  onboardingCompleted?: boolean
  onboardingPath?: OnboardingPath
  onboardingStepId?: OnboardingStepId
}

export interface TenantWithRole extends Tenant {
  role: TenantRole
}

// [FE-010] Reference Account interface for consistency
export interface TenantMember {
  id: string
  accountId: string
  account: Pick<Account, 'firstName' | 'lastName' | 'email' | 'avatarUrl'>
  role: TenantRole
  joinedAt: string
}

export interface TenantInvitation {
  id: string
  tenantId: string
  tenantName: string
  email: string
  role: TenantRole
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  invitedBy: Pick<Account, 'id' | 'firstName' | 'lastName'>
  expiresAt: string
}

interface PaginatedMembers {
  members: TenantMember[]
  nextCursor: string | null
  hasMore: boolean
}

// Get all tenants for an account
export async function getTenantsByAccountId(accountId: string): Promise<Tenant[]> {
  return await api.get<Tenant[]>(`/api/tenants/account/${accountId}`)
}

// Get a single tenant by ID
export async function getTenantById(tenantId: string): Promise<Tenant> {
  return await api.get<Tenant>(`/api/tenants/${tenantId}`)
}

// Provision a new tenant for an account. `name` is optional — when omitted,
// the backend derives it from onboardingPath + the account's firstName so the
// client never has to encode the naming convention.
export async function provisionTenant(
  accountId: string,
  options?: { name?: string; onboardingPath?: 'A' | 'B' },
): Promise<Tenant> {
  return await api.post<Tenant>('/api/tenants', { accountId, ...options })
}

// Rename an existing tenant (owner/admin only). The new name flows through to
// the sidebar workspace switcher on the next refreshTenants() call.
export async function renameTenant(tenantId: string, name: string): Promise<Tenant> {
  return await api.patch<Tenant>(`/api/tenants/${tenantId}`, { name })
}

// Generic tenant update — handles name + onboarding progress in a single call.
// Backend PATCH /api/tenants/:id accepts any subset of these fields.
export async function updateTenant(tenantId: string, input: UpdateTenantInput): Promise<Tenant> {
  return await api.patch<Tenant>(`/api/tenants/${tenantId}`, input)
}

// Workspace AI vendor selection (owner/admin only). Wire values are UI vendor
// names; the backend maps them onto the tenant's model routing policy.
export type WorkspaceAiVendor =
  | 'default' | 'anthropic' | 'openai' | 'google'
  | 'deepseek' | 'glm' | 'grok' | 'kimi' | 'minimax' | 'qwen' | 'xiaomi'

// Read the current selection. 'default' = Liftoff Managed.
export async function getWorkspaceAiVendor(tenantId: string): Promise<WorkspaceAiVendor> {
  const res = await api.get<{ vendor: WorkspaceAiVendor }>(`/api/tenants/${tenantId}/workspace-ai`)
  return res.vendor
}

// What each named provider brings, read from the same endpoint as the
// selection. The backend builds both from the live model registry, so a newly
// approved model shows without a frontend change. Liftoff Managed ('default')
// has no entry in either: what it routes to is not shown.
//   models: display names, the Frontier model first where there is one.
//   coding: the coding tool, and the model it codes with where Liftoff picks it
//           (the tool picks its own for Anthropic, OpenAI and Google).
export type WorkspaceAiVendorModels = Partial<Record<WorkspaceAiVendor, string[]>>
export interface WorkspaceAiCodingTool { tool: string; model?: string }
export type WorkspaceAiVendorCoding = Partial<Record<WorkspaceAiVendor, WorkspaceAiCodingTool>>
export interface WorkspaceAiVendorCatalog {
  models: WorkspaceAiVendorModels
  coding: WorkspaceAiVendorCoding
}

export async function getWorkspaceAiVendorCatalog(tenantId: string): Promise<WorkspaceAiVendorCatalog> {
  const res = await api.get<{ vendorModels?: WorkspaceAiVendorModels; vendorCoding?: WorkspaceAiVendorCoding }>(
    `/api/tenants/${tenantId}/workspace-ai`,
  )
  return { models: res.vendorModels ?? {}, coding: res.vendorCoding ?? {} }
}

// Apply a selection. The body goes through the same PATCH /api/tenants/:id the
// rename flow uses — the field is passed through verbatim, not rebuilt.
export async function updateWorkspaceAiVendor(
  tenantId: string,
  vendor: WorkspaceAiVendor,
): Promise<Tenant> {
  return await api.patch<Tenant>(`/api/tenants/${tenantId}`, { workspaceAiVendor: vendor })
}

// Get all tenants the current user is a member of
export async function getMyTenants(): Promise<TenantWithRole[]> {
  return await api.get<TenantWithRole[]>('/api/tenant-members/my-memberships')
}

// Get members of a tenant (paginated)
export async function getTenantMembers(
  tenantId: string,
  options?: { cursor?: string | null; limit?: number }
): Promise<PaginatedMembers> {
  const params = new URLSearchParams()
  if (options?.cursor) params.set('cursor', options.cursor)
  if (options?.limit) params.set('limit', options.limit.toString())
  const query = params.toString()
  return await api.get<PaginatedMembers>(
    `/api/tenant-members/${tenantId}${query ? `?${query}` : ''}`
  )
}

interface PaginatedInvitations {
  invitations: TenantInvitation[]
  nextCursor: string | null
  hasMore: boolean
}

// Get pending invitations for a tenant
export async function getTenantInvitations(tenantId: string): Promise<TenantInvitation[]> {
  const response = await api.get<PaginatedInvitations>(`/api/tenant-members/${tenantId}/invitations`)
  return response.invitations
}

// Invite a user to a tenant
export async function inviteToTenant(
  tenantId: string,
  email: string,
  role: TenantRole
): Promise<TenantInvitation> {
  return await api.post<TenantInvitation>(`/api/tenant-members/${tenantId}/invite`, { email, role })
}

// Remove a member from a tenant
export async function removeMember(tenantId: string, accountId: string): Promise<void> {
  await api.delete(`/api/tenant-members/${tenantId}/members/${accountId}`)
}

// Update a member's role
export async function updateMemberRole(
  tenantId: string,
  accountId: string,
  role: TenantRole
): Promise<TenantMember> {
  return await api.patch<TenantMember>(
    `/api/tenant-members/${tenantId}/members/${accountId}/role`,
    { role }
  )
}

// Revoke a pending invitation
export async function revokeInvitation(tenantId: string, invitationId: string): Promise<void> {
  await api.delete(`/api/tenant-members/${tenantId}/invitations/${invitationId}`)
}

// Update invitation role
export async function updateInvitationRole(tenantId: string, invitationId: string, role: TenantRole): Promise<TenantInvitation> {
  return await api.patch<TenantInvitation>(`/api/tenant-members/${tenantId}/invitations/${invitationId}/role`, { role })
}

// Get invitation details by token
export async function getInvitationByToken(token: string): Promise<TenantInvitation> {
  return await api.get<TenantInvitation>(`/api/tenant-members/invitations/${token}`)
}

// Accept an invitation
export async function acceptInvitation(token: string): Promise<{ tenantId: string }> {
  return await api.post<{ tenantId: string }>('/api/tenant-members/accept-invite', { token })
}

// Audit log types
export interface AuditEntry {
  id: string
  tenantId: string
  accountId: string | null
  action: string
  actorId: string | null
  previousState: Record<string, unknown> | null
  newState: Record<string, unknown> | null
  createdAt: string
}

export interface PaginatedAuditResponse {
  entries: AuditEntry[]
  nextCursor: string | null
  hasMore: boolean
}

// Get audit entries for a tenant
export async function getAuditEntries(
  tenantId: string,
  startDate: string,
  endDate: string,
  cursor?: string
): Promise<PaginatedAuditResponse> {
  const params = new URLSearchParams({ startDate, endDate })
  if (cursor) params.append('cursor', cursor)

  return api.get<PaginatedAuditResponse>(
    `/api/audit/${tenantId}/events?${params}`
  )
}

export async function reportAuditExportCompleted(
  tenantId: string,
  startDate: string,
  endDate: string,
  totalRows: number,
): Promise<void> {
  await api.post(`/api/audit/${tenantId}/events/export-completed`, {
    startDate,
    endDate,
    totalRows,
  })
}

/**
 * Download a copy of the workspace: every conversation on every surface, the
 * agents, the knowledge library, the connections, the review record, the
 * members, and the files the teams produced, as one zip. Owner and admin only;
 * the backend answers 409 while one is already running, 413 when the
 * workspace is over the export ceiling, 429 after five in an hour, and 503
 * when a part of it could not be read.
 */
export async function downloadWorkspaceExport(
  tenantId: string,
): Promise<{ blob: Blob; filename: string | null }> {
  return apiBlob(`/api/workspace-export?tenantId=${encodeURIComponent(tenantId)}`)
}
