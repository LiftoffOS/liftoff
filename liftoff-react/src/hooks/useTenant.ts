import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import {
  renameTenant,
  updateTenant,
  getWorkspaceAiVendor,
  getWorkspaceAiVendorCatalog,
  updateWorkspaceAiVendor,
  type UpdateTenantInput,
  type WorkspaceAiVendor,
} from '../services/tenants'
import { track } from '../lib/analytics'

/**
 * Hook for renaming the active tenant. On success, calls refreshTenants()
 * from AuthContext so the sidebar workspace switcher and any consumer of
 * useTenant() / useAuth() get the new name immediately.
 */
export function useRenameTenant() {
  const { refreshTenants } = useAuth()
  return useMutation({
    mutationFn: ({ tenantId, name }: { tenantId: string; name: string }) =>
      renameTenant(tenantId, name),
    onSuccess: async (_data, { tenantId }) => {
      track('tenant_renamed', { tenant_id: tenantId })
      await refreshTenants()
    },
  })
}

/**
 * Hook for updating any subset of tenant fields (name + onboarding progress).
 * Same refreshTenants() pattern so onboardingCompletedAt / onboardingStep
 * propagate to the sidebar workspace switcher and downstream routing logic.
 */
export function useUpdateTenant() {
  const { refreshTenants } = useAuth()
  return useMutation({
    mutationFn: ({ tenantId, ...input }: UpdateTenantInput & { tenantId: string }) =>
      updateTenant(tenantId, input),
    onSuccess: async () => {
      await refreshTenants()
    },
  })
}

/**
 * Query hook for the workspace's current Workspace AI vendor selection.
 * Server state (model routing policy marker), NOT device state — every admin
 * on every browser sees the same value. Disabled until the tenant id resolves.
 */
export function useWorkspaceAiVendor(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-ai-vendor', tenantId],
    queryFn: () => getWorkspaceAiVendor(tenantId as string),
    enabled: !!tenantId,
  })
}

/**
 * The models and coding tool behind each named Workspace AI provider. Only the
 * Settings card's editor shows them, so the read waits until it opens
 * (`enabled`). They change when a model is approved, not per second.
 */
export function useWorkspaceAiVendorCatalog(tenantId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['workspace-ai-vendor-catalog', tenantId],
    queryFn: () => getWorkspaceAiVendorCatalog(tenantId as string),
    enabled: !!tenantId && enabled,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Mutation hook for applying a Workspace AI vendor selection. On success,
 * updates the query cache so the settings card reflects the committed value
 * without a refetch round-trip.
 */
export function useUpdateWorkspaceAiVendor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ tenantId, vendor }: { tenantId: string; vendor: WorkspaceAiVendor }) =>
      updateWorkspaceAiVendor(tenantId, vendor),
    onSuccess: (_data, { tenantId, vendor }) => {
      queryClient.setQueryData(['workspace-ai-vendor', tenantId], vendor)
    },
  })
}

/**
 * Hook for accessing tenant context.
 * Provides a cleaner abstraction for components that only need tenant info.
 */
export function useTenant() {
  const {
    currentTenant,
    currentRole,
    tenants,
    tenantLoading,
    switchTenant,
    refreshTenants,
    canManageMembers,
    canInviteMembers,
    canManageSettings,
    isOwner,
  } = useAuth()

  return {
    currentTenant,
    currentRole,
    tenants,
    tenantLoading,
    switchTenant,
    refreshTenants,
    canManageMembers,
    canInviteMembers,
    canManageSettings,
    isOwner,
  }
}
