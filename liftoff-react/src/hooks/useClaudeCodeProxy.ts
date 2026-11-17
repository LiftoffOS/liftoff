// Developer Proxy Credential Management Hooks
// Routes through platform-backend's /api/claude-code-proxy front door (which
// forwards to the IAM-gated developer-proxy over OIDC), the same path MCP
// collab tokens use. The browser never talks to developer-proxy directly.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import { auth } from '../config/firebase'
import { api } from '../services/api'
import { WORKFORCE_QUERY_KEY } from './useWorkforce'

// === Types ===

export type ClaudeCodeProxyKeyStatus = 'active' | 'revoked'

// Shape returned by developer-proxy credential endpoints (before mapping)
interface RawCredential {
  id: string
  tenantId: string
  userId: string
  vendor: string
  keyPrefix: string
  keyHint: string
  label: string
  status: string
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ClaudeCodeProxyKey {
  id: string
  tenantId: string
  userId: string
  accountId: string        // alias for userId (backward compat)
  keyPrefix: string
  keyHint: string
  label: string
  name: string             // alias for label (backward compat)
  vendor: string
  description: string | null
  planType: null
  costPerMonth: null
  costPerMillionInputTokens: null
  costPerMillionOutputTokens: null
  status: ClaudeCodeProxyKeyStatus
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
  keyType?: 'developer_proxy' | 'mcp'   // 'developer_proxy' = proxy key, 'mcp' = collab-only token
}

export type DeveloperProxyVendor = 'anthropic' | 'openai'

export interface CreateProxyKeyInput {
  tenantId: string
  vendor?: DeveloperProxyVendor
  apiKey?: string
  /** @deprecated use apiKey + vendor */
  anthropicApiKey?: string
  label?: string
}

export interface CreateProxyKeyResponse extends ClaudeCodeProxyKey {
  key: string
  setupToken: string
  proxyBaseUrl: string
  setupInstructions: {
    baseUrl: string
    envCommand: string
  }
}

// === Query Keys ===

// Query keys for claude-code-proxy credentials. Every key includes the
// tenantId so React Query never shares a cache slot across workspaces —
// the same convention used by useExternalAgents and useInternalAgents.
export const claudeCodeProxyQueryKeys = {
  all: ['claude-code-proxy'] as const,
  lists: () => [...claudeCodeProxyQueryKeys.all, 'list'] as const,
  list: (tenantId: string) => [...claudeCodeProxyQueryKeys.lists(), tenantId] as const,
  details: () => [...claudeCodeProxyQueryKeys.all, 'detail'] as const,
  detail: (tenantId: string, id: string) => [...claudeCodeProxyQueryKeys.details(), tenantId, id] as const,
}

// === Helpers ===

function mapCredential(raw: RawCredential): ClaudeCodeProxyKey {
  return {
    id: raw.id,
    tenantId: raw.tenantId,
    userId: raw.userId,
    accountId: raw.userId,
    keyPrefix: raw.keyPrefix,
    keyHint: raw.keyHint,
    label: raw.label,
    name: raw.label,
    vendor: raw.vendor,
    description: null,
    planType: null,
    costPerMonth: null,
    costPerMillionInputTokens: null,
    costPerMillionOutputTokens: null,
    status: raw.status as ClaudeCodeProxyKeyStatus,
    lastUsedAt: raw.lastUsedAt ?? null,
    revokedAt: raw.revokedAt ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
}

// === Service Functions ===

async function listClaudeCodeProxyKeys(tenantId: string): Promise<ClaudeCodeProxyKey[]> {
  const data = await api.get<{ keys: RawCredential[] }>(
    `/api/claude-code-proxy/keys?tenantId=${encodeURIComponent(tenantId)}`,
  )
  return (data.keys ?? []).map(mapCredential)
}

async function getClaudeCodeProxyKey(keyId: string, tenantId: string): Promise<ClaudeCodeProxyKey> {
  const raw = await api.get<RawCredential>(
    `/api/claude-code-proxy/keys/${encodeURIComponent(keyId)}?tenantId=${encodeURIComponent(tenantId)}`,
  )
  return mapCredential(raw)
}

async function createClaudeCodeProxyKey(input: CreateProxyKeyInput): Promise<CreateProxyKeyResponse> {
  const data = await api.post<{
    credential: RawCredential
    fullKey: string
    setupToken: string
    proxyBaseUrl: string
  }>('/api/claude-code-proxy/keys', {
    tenantId: input.tenantId,
    vendor: input.vendor ?? 'anthropic',
    apiKey: input.apiKey ?? input.anthropicApiKey,
    label: input.label,
  })
  return {
    ...mapCredential(data.credential),
    key: data.fullKey,
    setupToken: data.setupToken,
    proxyBaseUrl: data.proxyBaseUrl,
    setupInstructions: {
      baseUrl: data.proxyBaseUrl,
      envCommand: `ANTHROPIC_BASE_URL=${data.proxyBaseUrl} ANTHROPIC_API_KEY=${data.fullKey}`,
    },
  }
}

async function deleteClaudeCodeProxyKey(keyId: string, tenantId: string): Promise<void> {
  await api.delete(
    `/api/claude-code-proxy/keys/${encodeURIComponent(keyId)}?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

// === Hooks ===

export function useClaudeCodeProxyKeys() {
  const { currentTenant } = useTenant()

  return useQuery({
    queryKey: claudeCodeProxyQueryKeys.list(currentTenant?.id ?? ''),
    queryFn: () => listClaudeCodeProxyKeys(currentTenant!.id),
    enabled: !!currentTenant?.id && !!auth.currentUser,
    staleTime: 30_000,
  })
}

export function useClaudeCodeProxyKey(keyId: string | undefined) {
  const { currentTenant } = useTenant()

  return useQuery({
    queryKey: claudeCodeProxyQueryKeys.detail(currentTenant?.id ?? '', keyId ?? ''),
    queryFn: () => getClaudeCodeProxyKey(keyId!, currentTenant!.id),
    enabled: !!currentTenant?.id && !!keyId && !!auth.currentUser,
    staleTime: 30_000,
  })
}

export function useCreateClaudeCodeProxyKey() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createClaudeCodeProxyKey,
    onSuccess: (_, { tenantId }) => {
      queryClient.invalidateQueries({ queryKey: claudeCodeProxyQueryKeys.list(tenantId) })
    },
  })
}

// === Codex (OpenAI vendor) hooks ===
// Parallel Codex hooks over the same vendor-neutral credential API. Claude
// Code and Codex connection states are fully independent: both lists come
// from the same query cache but are filtered by credential vendor.

export function useCodexProxyKeys() {
  const query = useClaudeCodeProxyKeys()
  return {
    ...query,
    data: query.data?.filter((k) => k.vendor === 'openai'),
  }
}

export function useAnthropicProxyKeys() {
  const query = useClaudeCodeProxyKeys()
  return {
    ...query,
    data: query.data?.filter((k) => k.vendor !== 'openai'),
  }
}

export function useCreateCodexProxyKey() {
  const create = useCreateClaudeCodeProxyKey()
  return {
    ...create,
    mutateAsync: (input: { tenantId: string; openaiApiKey: string; label?: string }) =>
      create.mutateAsync({
        tenantId: input.tenantId,
        vendor: 'openai',
        apiKey: input.openaiApiKey,
        label: input.label,
      }),
  }
}

export function useDeleteClaudeCodeProxyKey() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (keyId: string) => deleteClaudeCodeProxyKey(keyId, currentTenant!.id),
    onSuccess: () => {
      // Tenant-scoped — broad `lists()` would invalidate other workspaces' caches too.
      queryClient.invalidateQueries({ queryKey: claudeCodeProxyQueryKeys.list(currentTenant?.id ?? '') })
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, currentTenant?.id ?? ''] })
    },
  })
}

// === MCP Token Hooks (liftoff collab — platform-backend) ===

interface RawMcpToken {
  id: string
  tenantId: string
  accountId: string
  name: string
  status: string
  tokenPrefix: string
  lastUsedAt: string | null
  expiresAt: string
  createdAt: string
}

function mapMcpToken(raw: RawMcpToken): ClaudeCodeProxyKey {
  return {
    id: raw.id,
    tenantId: raw.tenantId,
    userId: raw.accountId,
    accountId: raw.accountId,
    keyPrefix: raw.tokenPrefix,
    keyHint: '',
    label: raw.name,
    name: raw.name,
    vendor: 'claude_code_mcp',
    description: null,
    planType: null,
    costPerMonth: null,
    costPerMillionInputTokens: null,
    costPerMillionOutputTokens: null,
    status: raw.status as ClaudeCodeProxyKeyStatus,
    lastUsedAt: raw.lastUsedAt ?? null,
    revokedAt: null,
    createdAt: raw.createdAt,
    updatedAt: raw.createdAt,
    keyType: 'mcp',
  }
}

async function listMcpTokens(tenantId: string): Promise<ClaudeCodeProxyKey[]> {
  const data = await api.get<{ tokens: RawMcpToken[] }>(
    `/api/claude-code-proxy/mcp-tokens?tenantId=${tenantId}`
  )
  return data.tokens.map(mapMcpToken)
}

async function revokeMcpToken(tokenId: string, tenantId: string): Promise<void> {
  await api.delete(`/api/claude-code-proxy/mcp-tokens/${tokenId}?tenantId=${tenantId}`)
}

export const mcpTokenQueryKeys = {
  all: ['mcp-tokens'] as const,
  list: (tenantId: string) => [...mcpTokenQueryKeys.all, tenantId] as const,
}

export function useMcpTokens() {
  const { currentTenant } = useTenant()

  return useQuery({
    queryKey: mcpTokenQueryKeys.list(currentTenant?.id ?? ''),
    queryFn: () => listMcpTokens(currentTenant!.id),
    enabled: !!currentTenant?.id && !!auth.currentUser,
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// The name and description a person writes on a coding-tool connection
// (either family: a Switch-flow credential or an MCP anchor). The backend keeps
// them beside the connection and applies them over the derived values on the
// workforce read, which is the list the update page reads the row from.
// ---------------------------------------------------------------------------

export interface CodingToolConnectionProfile {
  name?: string | null
  description?: string | null
}

async function updateCodingToolConnection(
  connectionId: string,
  tenantId: string,
  profile: CodingToolConnectionProfile,
): Promise<{ id: string; name: string | null; description: string | null }> {
  return api.put(`/api/claude-code-proxy/keys/${encodeURIComponent(connectionId)}`, { tenantId, ...profile })
}

export function useUpdateCodingToolConnection() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ connectionId, ...profile }: CodingToolConnectionProfile & { connectionId: string }) =>
      updateCodingToolConnection(connectionId, currentTenant!.id, profile),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, currentTenant?.id ?? ''] })
    },
  })
}

export function useRevokeMcpToken() {
  const { currentTenant } = useTenant()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (tokenId: string) => revokeMcpToken(tokenId, currentTenant!.id),
    onSuccess: () => {
      // Tenant-scoped — broad `mcpTokenQueryKeys.all` would invalidate every
      // workspace's mcp-token cache, not just the one we just mutated.
      queryClient.invalidateQueries({ queryKey: mcpTokenQueryKeys.list(currentTenant?.id ?? '') })
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, currentTenant?.id ?? ''] })
    },
  })
}
