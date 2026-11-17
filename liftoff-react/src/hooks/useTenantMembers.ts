import { useMutation, useQueryClient, useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import { getTenantMembers, getTenantInvitations, inviteToTenant, removeMember, updateMemberRole, revokeInvitation, updateInvitationRole, type TenantRole, type TenantInvitation } from '../services/tenants';
import { useAuth } from '../contexts/AuthContext';
import { track } from '../lib/analytics';

// The two cache shapes these optimistic updates rewrite. Both are keyed off
// the service's own return types, so a change there fails here rather than
// silently reshaping the cache under the UI.
type MembersPage = Awaited<ReturnType<typeof getTenantMembers>>;
type MembersCache = InfiniteData<MembersPage, string | null>;

const MEMBERS_KEY = ['tenant-members'] as const;
const INVITATIONS_KEY = ['tenant-invitations'] as const;
const WORKSPACE_MEMBERS_KEY = ['workspace-members'] as const;

// [FE-005] Paginated members query
export function useTenantMembers(tenantId: string | undefined) {
  const { canManageMembers } = useAuth();

  return useInfiniteQuery({
    queryKey: [...MEMBERS_KEY, tenantId],
    queryFn: ({ pageParam = null }) => getTenantMembers(tenantId!, { cursor: pageParam, limit: 50 }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialPageParam: null as string | null,
    enabled: !!tenantId && canManageMembers(),
  });
}

// Workspace Members - visible to all members (for dashboard display)
export function useWorkspaceMembers(tenantId: string | undefined) {
  return useQuery({
    queryKey: [...WORKSPACE_MEMBERS_KEY, tenantId],
    queryFn: async () => {
      const result = await getTenantMembers(tenantId!, { limit: 20 });
      return result.members;
    },
    enabled: !!tenantId,
  });
}

// [FE-009] Optimistic updates for member removal
export function useRemoveMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ tenantId, memberId }: { tenantId: string; memberId: string }) =>
      removeMember(tenantId, memberId),
    onMutate: async ({ tenantId, memberId }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: [...MEMBERS_KEY, tenantId] });

      // Snapshot current state
      const previousMembers = queryClient.getQueryData([...MEMBERS_KEY, tenantId]);

      // Optimistically remove member
      queryClient.setQueryData<MembersCache>([...MEMBERS_KEY, tenantId], old =>
        old && {
          ...old,
          pages: old.pages.map(page => ({
            ...page,
            members: page.members.filter(m => m.id !== memberId)
          }))
        }
      );

      return { previousMembers };
    },
    onError: (_err, { tenantId }, context) => {
      // Rollback on error
      if (context?.previousMembers) {
        queryClient.setQueryData([...MEMBERS_KEY, tenantId], context.previousMembers);
      }
    },
    onSuccess: (_, { tenantId }) => {
      track('member_removed', { tenant_id: tenantId });
    },
    onSettled: (_, __, { tenantId }) => {
      queryClient.invalidateQueries({ queryKey: [...MEMBERS_KEY, tenantId] });
    },
  });
}

// Similar optimistic update pattern for role changes
export function useUpdateMemberRole() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ tenantId, memberId, role }: { tenantId: string; memberId: string; role: TenantRole }) => updateMemberRole(tenantId, memberId, role),
    onMutate: async ({ tenantId, memberId, role }) => {
      await queryClient.cancelQueries({ queryKey: [...MEMBERS_KEY, tenantId] });
      const previous = queryClient.getQueryData([...MEMBERS_KEY, tenantId]);

      // Optimistically update role
      queryClient.setQueryData<MembersCache>([...MEMBERS_KEY, tenantId], old =>
        old && {
          ...old,
          pages: old.pages.map(page => ({
            ...page,
            members: page.members.map(m =>
              m.id === memberId ? { ...m, role } : m
            )
          }))
        }
      );

      return { previous };
    },
    onError: (_err, { tenantId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData([...MEMBERS_KEY, tenantId], context.previous);
      }
    },
    onSuccess: (_, { tenantId, role }) => {
      track('member_role_changed', { tenant_id: tenantId, new_role: role });
    },
    onSettled: (_, __, { tenantId }) => {
      queryClient.invalidateQueries({ queryKey: [...MEMBERS_KEY, tenantId] });
    },
  });
}

// Invite a member
export function useInviteMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ tenantId, email, role }: { tenantId: string; email: string; role: TenantRole }) =>
      inviteToTenant(tenantId, email, role),
    onSuccess: (_, { tenantId, role }) => {
      track('member_invited', { tenant_id: tenantId, role });
      // Invalidate both members and invitations
      queryClient.invalidateQueries({ queryKey: [...MEMBERS_KEY, tenantId] });
      queryClient.invalidateQueries({ queryKey: [...INVITATIONS_KEY, tenantId] });
    },
  });
}

// Fetch pending invitations for a tenant
export function useTenantInvitations(tenantId: string | undefined) {
  const { canManageMembers } = useAuth();

  return useQuery({
    queryKey: [...INVITATIONS_KEY, tenantId],
    queryFn: () => getTenantInvitations(tenantId!),
    enabled: !!tenantId && canManageMembers(),
  });
}

// Revoke an invitation with optimistic update
export function useRevokeInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ tenantId, invitationId }: { tenantId: string; invitationId: string }) =>
      revokeInvitation(tenantId, invitationId),
    onMutate: async ({ tenantId, invitationId }) => {
      await queryClient.cancelQueries({ queryKey: [...INVITATIONS_KEY, tenantId] });
      const previous = queryClient.getQueryData([...INVITATIONS_KEY, tenantId]);

      // Optimistically remove invitation
      queryClient.setQueryData<TenantInvitation[]>([...INVITATIONS_KEY, tenantId], old =>
        old?.filter(inv => inv.id !== invitationId) ?? []
      );

      return { previous };
    },
    onError: (_err, { tenantId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData([...INVITATIONS_KEY, tenantId], context.previous);
      }
    },
    onSuccess: (_, { tenantId }) => {
      track('invitation_revoked', { tenant_id: tenantId });
    },
    onSettled: (_, __, { tenantId }) => {
      queryClient.invalidateQueries({ queryKey: [...INVITATIONS_KEY, tenantId] });
    },
  });
}

// Update invitation role with optimistic update
export function useUpdateInvitationRole() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ tenantId, invitationId, role }: { tenantId: string; invitationId: string; role: TenantRole }) =>
      updateInvitationRole(tenantId, invitationId, role),
    onMutate: async ({ tenantId, invitationId, role }) => {
      await queryClient.cancelQueries({ queryKey: [...INVITATIONS_KEY, tenantId] });
      const previous = queryClient.getQueryData([...INVITATIONS_KEY, tenantId]);

      // Optimistically update role
      queryClient.setQueryData<TenantInvitation[]>([...INVITATIONS_KEY, tenantId], old =>
        old?.map(inv => inv.id === invitationId ? { ...inv, role } : inv) ?? []
      );

      return { previous };
    },
    onError: (_err, { tenantId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData([...INVITATIONS_KEY, tenantId], context.previous);
      }
    },
    onSuccess: (_, { tenantId, role }) => {
      track('invitation_role_changed', { tenant_id: tenantId, new_role: role });
    },
    onSettled: (_, __, { tenantId }) => {
      queryClient.invalidateQueries({ queryKey: [...INVITATIONS_KEY, tenantId] });
    },
  });
}
